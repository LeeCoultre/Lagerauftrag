"""Reports — aggregated analytics for the Berichte screen.

`GET /api/reports/aggregates?days=30&levels=1,2,3` returns the four
slices the Berichte analytics sections consume:

  • byLevel       — totals per physical level (1-7) for the radial chart
  • dailyByLevel  — units per (day × level) for the stacked-bar chart
  • rollenByDay   — rolls per (day × level) for the sparkline-grid
  • heatmap       — completed-Auftrag count + units per day (30-day grid)

Open to all authenticated users — five operators look at the same
warehouse data; no privacy reason to gate behind admin.

Why aggregate in Python instead of SQL JSONB:
  parseLagerauftrag stores items with `title` but only sometimes a
  pre-computed `level` field. SQL would need to either replicate the
  title regex (gnarly) or scan every JSON path. Python iteration over
  the lookback window (typically <500 rows × 5-50 items) is cheap and
  keeps the level rules colocated with backend/levels.py — the single
  source of truth shared with the frontend.

Network cost is bounded: pulling 90 days of completed rows is at most
~1-2 MB compressed (GZip middleware). Response is small (3 JSON
arrays + 30 heatmap cells).
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.deps import get_current_user, load_work_schedule
from backend.levels import LEVEL_COUNT, level_of
from backend.orm import Auftrag, AuftragStatus, SkuDimension, User
from backend.schemas import (
    DailyLevelBucket,
    HeatmapCell,
    LevelBucket,
    ReportsAggregates,
)
from backend.work_time import effective_seconds

router = APIRouter(prefix="/api/reports", tags=["reports"])

# Hard ceiling — Berichte never asks for more than 90 days. Beyond
# that the dashboard becomes useless (warehouse cadence is daily) and
# the in-memory scan grows unbounded.
_MAX_DAYS = 90
# How many days the sparkline-grid (rollenByDay) covers. Decoupled from
# the heatmap window because 14 days is a denser, more useful spark.
_ROLLEN_WINDOW_DAYS = 14
# Stacked-bar always shows last 7 days regardless of the overall
# lookback — that's the operational view the warehouse cares about.
_STACK_WINDOW_DAYS = 7


def _parse_level_filter(raw: Optional[str]) -> Optional[set[int]]:
    """Parse `?levels=1,3,7` into a set of ints. Returns None for empty/
    invalid input (= no filter). Silently drops out-of-range values
    rather than 400-ing — the dashboard's chip selector might send
    stale levels after an SOP update."""
    if not raw:
        return None
    out: set[int] = set()
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        try:
            n = int(chunk)
        except ValueError:
            continue
        if 1 <= n <= LEVEL_COUNT:
            out.add(n)
    return out or None


def _iter_items(parsed: Optional[dict[str, Any]]):
    """Yield every item across all pallets + Einzelne-SKU section of one
    Auftrag. Defensive against malformed parsed blobs from old uploads —
    silently skips anything that isn't a dict-shaped item."""
    if not isinstance(parsed, dict):
        return
    pallets = parsed.get("pallets")
    if isinstance(pallets, list):
        for p in pallets:
            if not isinstance(p, dict):
                continue
            items = p.get("items")
            if isinstance(items, list):
                for it in items:
                    if isinstance(it, dict):
                        yield it
    esku = parsed.get("einzelneSkuItems") or parsed.get("einzelne_sku_items")
    if isinstance(esku, list):
        for it in esku:
            if isinstance(it, dict):
                yield it


def _int_field(item: dict[str, Any], key: str) -> int:
    """Read an int-coerceable field from an item, clamping non-numeric
    to 0. `rollen` is `int | null` in the parser; `units` is always set
    but warehouse uploads occasionally have stray strings — protect."""
    v = item.get(key)
    if isinstance(v, bool):
        return 0
    if isinstance(v, (int, float)):
        return int(v)
    if isinstance(v, str):
        try:
            return int(float(v))
        except ValueError:
            return 0
    return 0


async def _price_index(db: AsyncSession) -> dict[str, float]:
    """Build a {fnsku|sku|ean → price_per_einheit_eur} lookup for the
    Warenwert aggregation. One SELECT over the full `sku_dimensions`
    table (small — hundreds of rows). Returns `{}` if the column does
    not exist yet (pre-migration deploy window), so the rest of the
    report still renders with `items_value_eur = 0`."""
    from sqlalchemy.exc import ProgrammingError
    try:
        rows = (await db.execute(select(SkuDimension))).scalars().all()
    except ProgrammingError:
        await db.rollback()
        return {}
    out: dict[str, float] = {}
    for sd in rows:
        price = sd.price_per_einheit_eur
        if price is None or price <= 0:
            continue
        p = float(price)
        for k in (sd.fnskus or []):
            out[str(k)] = p
        for k in (sd.skus or []):
            out[str(k)] = p
        for k in (sd.eans or []):
            out[str(k)] = p
    return out


def _item_price(it: dict[str, Any], price_by_key: dict[str, float]) -> Optional[float]:
    """First-key-wins lookup mirroring the distributor's waterfall:
    fnsku → sku → ean. Returns None if no key resolved to a row with a
    known price."""
    for key in ("fnsku", "sku", "ean"):
        v = it.get(key)
        if v is None or v == "":
            continue
        p = price_by_key.get(str(v))
        if p is not None:
            return p
    return None


@router.get("/aggregates", response_model=ReportsAggregates)
async def get_aggregates(
    days: int = Query(30, ge=1, le=_MAX_DAYS),
    levels: Optional[str] = Query(
        None,
        description="Comma-separated level filter, e.g. '1,3,7'. "
                    "Omit for all levels.",
    ),
    _me: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    schedule = Depends(load_work_schedule),
):
    """Aggregate completed Aufträge over the lookback window.

    The four slices share a single pass over the parsed blobs:
      • by_level         keyed by level
      • daily_by_level   keyed by (date, level), date ∈ last 7 days
      • rollen_by_day    keyed by (date, level), date ∈ last 14 days
      • heatmap          keyed by date, full lookback window
    Empty entries are filled at the end so the frontend can render a
    fixed-grid heatmap / 7-day stack without holes.
    """
    level_filter = _parse_level_filter(levels)

    # UTC date boundaries. We bucket by the UTC date of finished_at;
    # the warehouse is a single timezone (Europe/Berlin) so DST drift
    # is at most an hour at the edges — acceptable for daily granularity.
    now = datetime.now(timezone.utc)
    today_utc: date = now.date()
    earliest_dt = datetime.combine(
        today_utc - timedelta(days=days - 1), datetime.min.time(),
        tzinfo=timezone.utc,
    )

    rows = (
        await db.execute(
            select(Auftrag).where(
                Auftrag.status == AuftragStatus.completed,
                Auftrag.finished_at.is_not(None),
                Auftrag.finished_at >= earliest_dt,
            )
        )
    ).scalars().all()

    # Price lookup — built once per request from sku_dimensions. Same
    # waterfall as the distributor (fnsku → sku → ean).
    price_by_key = await _price_index(db)

    # KPI roll-ups for the v2.4 Berichte redesign.
    articles_total = 0
    units_total = 0
    items_with_price = 0
    items_value_eur = 0.0
    cost_per_level: dict[int, float] = defaultdict(float)
    effective_hours_total = 0.0

    # Per-level running totals — distinct-auftrag count needs a set so
    # the same Auftrag with 3 Thermo items only counts once for L1.
    units_per_level: dict[int, int] = defaultdict(int)
    rollen_per_level: dict[int, int] = defaultdict(int)
    auftraege_per_level: dict[int, set] = defaultdict(set)

    # (date_iso, level) → metric
    daily_units: dict[tuple[str, int], int] = defaultdict(int)
    daily_rollen: dict[tuple[str, int], int] = defaultdict(int)

    # date_iso → (count, total_units)
    heatmap_count: dict[str, int] = defaultdict(int)
    heatmap_units: dict[str, int] = defaultdict(int)

    stack_cutoff = today_utc - timedelta(days=_STACK_WINDOW_DAYS - 1)
    rollen_cutoff = today_utc - timedelta(days=_ROLLEN_WINDOW_DAYS - 1)

    for row in rows:
        finished_at = row.finished_at
        if finished_at is None:
            continue
        date_iso = finished_at.astimezone(timezone.utc).date().isoformat()
        row_date = finished_at.astimezone(timezone.utc).date()

        heatmap_count[date_iso] += 1
        # Units snapshot — prefer parsed.meta.totalUnits (canonical), fall
        # back to summing items if missing. Old parser versions sometimes
        # left totalUnits out.
        total_units = 0
        meta = (row.parsed or {}).get("meta") or {} if isinstance(row.parsed, dict) else {}
        meta_total = meta.get("totalUnits")
        if isinstance(meta_total, (int, float)) and meta_total > 0:
            total_units = int(meta_total)

        # Single pass over items.
        item_units_sum = 0
        for it in _iter_items(row.parsed):
            lvl = level_of(it)
            if level_filter is not None and lvl not in level_filter:
                continue
            u = _int_field(it, "units")
            r = _int_field(it, "rollen")
            # rollen is per-Einheit, total rolls = units × rollen-per-Einheit.
            r_total = u * r if r > 0 else 0

            units_per_level[lvl] += u
            rollen_per_level[lvl] += r_total
            auftraege_per_level[lvl].add(row.id)
            item_units_sum += u

            # KPI accumulators.
            articles_total += 1
            units_total += u
            unit_price = _item_price(it, price_by_key)
            if unit_price is not None:
                items_with_price += 1
                line_cost = u * unit_price
                items_value_eur += line_cost
                cost_per_level[lvl] += line_cost

            if row_date >= stack_cutoff:
                daily_units[(date_iso, lvl)] += u
            if row_date >= rollen_cutoff and r_total > 0:
                daily_rollen[(date_iso, lvl)] += r_total

        # Productivity uses EFFECTIVE working seconds — lunch and
        # non-working hours don't inflate the denominator.
        if row.started_at is not None:
            effective_hours_total += effective_seconds(
                row.started_at, finished_at, schedule,
            ) / 3600.0

        # Fallback if parser didn't populate totalUnits.
        if total_units <= 0:
            total_units = item_units_sum
        heatmap_units[date_iso] += total_units

    # ── Shape the response ───────────────────────────────────────────

    by_level = [
        LevelBucket(
            level=lvl,
            units=units_per_level.get(lvl, 0),
            rollen=rollen_per_level.get(lvl, 0),
            auftrag_count=len(auftraege_per_level.get(lvl, set())),
            cost_eur=round(cost_per_level.get(lvl, 0.0), 2),
        )
        for lvl in range(1, LEVEL_COUNT + 1)
        if (level_filter is None or lvl in level_filter)
    ]

    coverage_pct = (
        (items_with_price / articles_total * 100.0)
        if articles_total > 0 else 0.0
    )
    productivity = (
        (units_total / effective_hours_total)
        if effective_hours_total > 0 else 0.0
    )

    # Fixed-grid heatmap — fill every day in the window so the frontend
    # renders a uniform grid without conditional cells.
    heatmap = []
    for i in range(days):
        d = today_utc - timedelta(days=days - 1 - i)  # oldest → newest
        iso = d.isoformat()
        heatmap.append(HeatmapCell(
            date=iso,
            count=heatmap_count.get(iso, 0),
            units=heatmap_units.get(iso, 0),
        ))

    # Stacked bar — exactly _STACK_WINDOW_DAYS days, oldest first, every
    # day present (zero-filled where there's no data).
    daily_by_level = []
    for i in range(_STACK_WINDOW_DAYS):
        d = today_utc - timedelta(days=_STACK_WINDOW_DAYS - 1 - i)
        iso = d.isoformat()
        values: dict[int, int] = {}
        for lvl in range(1, LEVEL_COUNT + 1):
            if level_filter is not None and lvl not in level_filter:
                continue
            v = daily_units.get((iso, lvl), 0)
            if v > 0:
                values[lvl] = v
        daily_by_level.append(DailyLevelBucket(date=iso, values=values))

    rollen_by_day = []
    for i in range(_ROLLEN_WINDOW_DAYS):
        d = today_utc - timedelta(days=_ROLLEN_WINDOW_DAYS - 1 - i)
        iso = d.isoformat()
        values = {}
        for lvl in range(1, LEVEL_COUNT + 1):
            if level_filter is not None and lvl not in level_filter:
                continue
            v = daily_rollen.get((iso, lvl), 0)
            if v > 0:
                values[lvl] = v
        rollen_by_day.append(DailyLevelBucket(date=iso, values=values))

    return ReportsAggregates(
        by_level=by_level,
        daily_by_level=daily_by_level,
        rollen_by_day=rollen_by_day,
        heatmap=heatmap,
        days=days,
        articles_total=articles_total,
        units_total=units_total,
        items_value_eur=round(items_value_eur, 2),
        items_value_coverage_pct=round(coverage_pct, 1),
        productivity_units_per_hour=round(productivity, 1),
    )
