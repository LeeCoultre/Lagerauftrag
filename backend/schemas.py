"""Pydantic DTOs for the Marathon HTTP API.

ORM models live in backend/orm.py. These classes are the wire format —
what the frontend sends and receives. Keep them serializable, derive
view-only fields (fba_code, counts) here rather than in endpoints.

Note: backend/models.py holds Pydantic DTOs for the pallet packer
(pre-existing, unrelated). New Marathon code lives here.
"""

from __future__ import annotations

from datetime import datetime, time, timezone as dt_timezone
from typing import Any, Generic, Optional, TypeVar
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from backend.orm import (
    Auftrag,
    AuftragStatus,
    PalletClaimState,
    User,
    UserRole,
    WorkflowStep,
)
from backend.work_time import WorkSchedule as WorkScheduleCfg, effective_seconds

T = TypeVar("T")


class Paginated(BaseModel, Generic[T]):
    """Generic page wrapper for list endpoints."""
    items: list[T]
    total: int
    limit: int
    offset: int


class APIModel(BaseModel):
    """Common base — enables building from ORM objects via from_attributes."""
    model_config = ConfigDict(from_attributes=True)


# ─── Users ───────────────────────────────────────────────────────────

class UserResponse(APIModel):
    id: UUID
    email: str
    name: str
    role: UserRole


class UserListItem(APIModel):
    """Compact form for the GET /api/users dropdown — no email/role."""
    id: UUID
    name: str


class HistoryPage(BaseModel):
    """Paginated history response."""
    items: list[AuftragSummary]
    total: int
    limit: int
    offset: int


# ─── Admin schemas (Sprint 2.8 – 2.11) ───────────────────────────────

class AdminUserDetail(APIModel):
    id: UUID
    clerk_id: Optional[str] = None
    email: str
    name: str
    role: UserRole
    created_at: datetime
    last_login_at: Optional[datetime] = None
    auftraege_completed: int = 0

    @classmethod
    def from_orm_row(cls, u: User, completed: int = 0) -> AdminUserDetail:
        return cls(
            id=u.id,
            clerk_id=u.clerk_id,
            email=u.email,
            name=u.name,
            role=u.role,
            created_at=u.created_at,
            last_login_at=u.last_login_at,
            auftraege_completed=completed,
        )


class RoleUpdate(BaseModel):
    role: UserRole


class AuditLogEntry(APIModel):
    id: UUID
    action: str
    created_at: datetime
    user_id: UUID
    user_name: Optional[str] = None
    auftrag_id: Optional[UUID] = None
    auftrag_file_name: Optional[str] = None  # joined; falls back to meta.file_name
    meta: dict[str, Any] = Field(default_factory=dict)


class AdminStats(BaseModel):
    total_auftraege: int
    queued_now: int
    in_progress_now: int
    completed_total: int
    completed_today: int
    completed_this_week: int
    avg_duration_sec: Optional[float] = None
    top_users: list[dict[str, Any]] = Field(default_factory=list)
    # 7-day rolling: [{date: 'YYYY-MM-DD', count: int}, ...] (oldest first)
    completed_per_day: list[dict[str, Any]] = Field(default_factory=list)


# ─── Auftraege — request payloads ────────────────────────────────────

class AuftragCreate(BaseModel):
    """POST /api/auftraege — frontend already parsed the .docx in browser."""
    file_name: str
    raw_text: Optional[str] = None
    parsed: Optional[dict[str, Any]] = None
    validation: Optional[dict[str, Any]] = None
    error_message: Optional[str] = None  # set when frontend parsing failed


class WorkflowProgress(BaseModel):
    """PATCH /api/auftraege/{id}/progress — only fields actually being updated.

    `copied_keys` is per-user (multi-user Focus session). Server merges
    into auftraege.user_progress[<user_id>].copied_keys instead of the
    shared completed_keys dict. Classic single-user frontend keeps the
    chip state in localStorage and doesn't send this field — the path
    is opt-in for beta.
    """
    step: Optional[WorkflowStep] = None
    current_pallet_idx: Optional[int] = None
    current_item_idx: Optional[int] = None
    completed_keys: Optional[dict[str, Any]] = None
    pallet_timings: Optional[dict[str, Any]] = None
    copied_keys: Optional[dict[str, Any]] = None


class WorkflowAbortItem(BaseModel):
    """One flagged article in a Stornierung. `pallet_id` references
    parsed.pallets[].id so the Historie expand can highlight the row
    even after pallet reorder. `code` is whatever identifier the
    frontend pinned at storno time (fnsku → sku → ean) — pure display."""
    pallet_id: Optional[str] = None
    item_idx: Optional[int] = None
    code: Optional[str] = None
    title: Optional[str] = None
    reason: Optional[str] = None


class WorkflowAbort(BaseModel):
    """POST /api/auftraege/{id}/abort body. Both fields are optional —
    a worker can storno without flagging any specific article."""
    items: list[WorkflowAbortItem] = Field(default_factory=list)
    note: Optional[str] = None


class AuftragReorderItem(BaseModel):
    """One row of PATCH /api/auftraege/reorder body."""
    id: UUID
    queue_position: int


# ─── Auftraege — response shapes ─────────────────────────────────────

class AuftragSummary(APIModel):
    """Compact row for list views (queue + history). No JSONB blobs."""
    id: UUID
    file_name: str
    fba_code: Optional[str] = None       # derived from parsed.meta
    status: AuftragStatus
    pallet_count: int = 0                # derived from parsed.pallets
    article_count: int = 0               # derived from parsed.pallets[].items
    units_count: int = 0                 # derived from parsed.meta.totalUnits
    esku_count: int = 0                  # derived from parsed.einzelneSkuItems
    error_message: Optional[str] = None
    created_at: datetime
    queue_position: Optional[int] = None
    assigned_to_user_id: Optional[UUID] = None
    assigned_to_user_name: Optional[str] = None  # JOIN convenience for UI
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    duration_sec: Optional[int] = None
    pallet_timings: dict[str, Any] = Field(default_factory=dict)  # used by Historie row expand
    # Per-pallet effective seconds — keyed by pallet.id. Populated only
    # when a `schedule` is passed into `from_orm_row`; empty `{}` for
    # endpoints that don't need it (saves the iteration cost on hot
    # paths like /api/admin/auftraege).
    pallet_effective_seconds: dict[str, int] = Field(default_factory=dict)

    @classmethod
    def from_orm_row(
        cls,
        row: Auftrag,
        assigned_to_user_name: Optional[str] = None,
        schedule: Optional[WorkScheduleCfg] = None,
    ) -> AuftragSummary:
        parsed = row.parsed or {}
        meta = parsed.get("meta") or {}
        pallets = parsed.get("pallets") or []
        esku_items = parsed.get("einzelneSkuItems") or []
        total_units = meta.get("totalUnits")
        pal_eff: dict[str, int] = {}
        if schedule is not None and isinstance(row.pallet_timings, dict):
            for pid, t in row.pallet_timings.items():
                if not isinstance(t, dict):
                    continue
                started = t.get("startedAt")
                finished = t.get("finishedAt")
                if not isinstance(started, (int, float)):
                    continue
                if not isinstance(finished, (int, float)):
                    finished = datetime.now(dt_timezone.utc).timestamp() * 1000
                s_dt = datetime.fromtimestamp(started / 1000, tz=dt_timezone.utc)
                f_dt = datetime.fromtimestamp(finished / 1000, tz=dt_timezone.utc)
                pal_eff[str(pid)] = effective_seconds(s_dt, f_dt, schedule)
        return cls(
            id=row.id,
            file_name=row.file_name,
            fba_code=meta.get("sendungsnummer") or meta.get("fbaCode"),
            status=row.status,
            pallet_count=len(pallets),
            article_count=sum(len(p.get("items") or []) for p in pallets),
            units_count=int(total_units) if isinstance(total_units, (int, float)) else 0,
            esku_count=len(esku_items),
            error_message=row.error_message,
            created_at=row.created_at,
            queue_position=row.queue_position,
            assigned_to_user_id=row.assigned_to_user_id,
            assigned_to_user_name=assigned_to_user_name,
            started_at=row.started_at,
            finished_at=row.finished_at,
            duration_sec=row.duration_sec,
            pallet_timings=row.pallet_timings or {},
            pallet_effective_seconds=pal_eff,
        )


# ─── SKU Dimensions ──────────────────────────────────────────────────

class SkuDimensionRead(APIModel):
    """Row as returned to admin/list and to lookup callers.

    Each key type is a list because one physical product (one row) often
    ships under multiple Amazon FNSKUs / merchant SKUs (different
    sales channels, regions, PRIME vs EV)."""
    id: int
    fnskus: list[str] = Field(default_factory=list)
    skus: list[str] = Field(default_factory=list)
    eans: list[str] = Field(default_factory=list)
    title: Optional[str] = None
    length_cm: float
    width_cm: float
    height_cm: float
    weight_kg: float
    pallet_load_max: Optional[int] = None
    price_per_einheit_eur: Optional[float] = None
    source: Optional[str] = None
    updated_at: datetime
    updated_by: Optional[str] = None


class SkuDimensionLookup(BaseModel):
    """Compact form embedded in the lookup response. Includes the row's
    `id` (so the distributor can group same-format items even when they
    share dims but ship under different SKUs) and `pallet_load_max` (the
    empirical capacity used by the normalised-fraction algorithm)."""
    id: int
    length_cm: float
    width_cm: float
    height_cm: float
    weight_kg: float
    pallet_load_max: Optional[int] = None
    price_per_einheit_eur: Optional[float] = None
    source: Optional[str] = None


class SkuDimensionLookupResponse(BaseModel):
    """Batch lookup result: { lookups: { "<key>": dim, ... }, missing: [...] }.

    A single physical-product row can be reachable through several keys —
    the response binds the SAME compact dim under each requested key
    that hit it. So callers can probe with whichever identifier they
    have and always get back the dimensions."""
    lookups: dict[str, SkuDimensionLookup] = Field(default_factory=dict)
    missing: list[str] = Field(default_factory=list)


class SkuDimensionUpsert(BaseModel):
    """POST/PATCH input. At least one of (fnskus, skus, eans) must be non-empty.

    Dimensions must be > 0 (a row without size is meaningless for the
    distributor). Weight may be 0 as a "not measured yet" placeholder —
    edit later via UI when the scale data arrives. `pallet_load_max` is
    optional; when null the distributor falls back to the volume soft
    limit (1.59 m³)."""
    fnskus: list[str] = Field(default_factory=list)
    skus: list[str] = Field(default_factory=list)
    eans: list[str] = Field(default_factory=list)
    title: Optional[str] = None
    length_cm: float = Field(gt=0)
    width_cm: float = Field(gt=0)
    height_cm: float = Field(gt=0)
    weight_kg: float = Field(ge=0)
    pallet_load_max: Optional[int] = Field(default=None, ge=1)
    price_per_einheit_eur: Optional[float] = Field(default=None, ge=0)


class SkuDimensionImportResult(BaseModel):
    imported: int = 0
    updated: int = 0
    skipped: int = 0
    warnings: list[str] = Field(default_factory=list)


# ─── Search (Phase 1 — globale Suche) ────────────────────────────────

class SearchHit(APIModel):
    """One row in /api/search results.

    `matched_field` and `matched_value` describe WHERE the query hit so
    the UI can highlight context. Computed in Python after the SQL pull
    because PostgreSQL ILIKE %query% returns rows but doesn't tell you
    which field of the JSONB matched.
    """
    id: UUID
    file_name: str
    fba_code: Optional[str] = None
    status: AuftragStatus
    pallet_count: int = 0
    article_count: int = 0
    created_at: datetime
    finished_at: Optional[datetime] = None
    duration_sec: Optional[int] = None
    assigned_to_user_name: Optional[str] = None
    matched_field: Optional[str] = None  # 'fnsku' | 'sku' | 'ean' | 'sendungsnummer' | 'file_name'
    matched_value: Optional[str] = None


class SearchResults(BaseModel):
    items: list[SearchHit]
    total: int
    limit: int
    offset: int
    query: str


# ─── Activity feed (Phase 1 — Live-Aktivität) ────────────────────────

class ActiveWorker(BaseModel):
    """Operator who currently has an in_progress Auftrag."""
    user_id: UUID
    user_name: str
    auftrag_id: UUID
    file_name: str
    fba_code: Optional[str] = None
    step: Optional[WorkflowStep] = None
    started_at: Optional[datetime] = None
    current_pallet_idx: Optional[int] = None
    pallet_count: int = 0


class ActivityEvent(BaseModel):
    """One audit_log row, joined with user + (optional) Auftrag file name."""
    id: UUID
    action: str
    created_at: datetime
    user_id: UUID
    user_name: Optional[str] = None
    auftrag_id: Optional[UUID] = None
    auftrag_file_name: Optional[str] = None
    fba_code: Optional[str] = None
    meta: dict[str, Any] = Field(default_factory=dict)


class ActivityFeed(BaseModel):
    active_workers: list[ActiveWorker] = Field(default_factory=list)
    events: list[ActivityEvent] = Field(default_factory=list)
    server_time: datetime  # UI computes "ago" against this for clock-skew safety


class ShiftInfo(BaseModel):
    """Working-day window for a single user, derived from audit_log.

    started_at is the first audit row of the local calendar day for that
    user; null means the operator hasn't done anything today yet.
    """
    started_at: Optional[datetime] = None
    duration_sec: int = 0
    completed_today: int = 0


# ─── Auftraege — full detail ─────────────────────────────────────────

class PalletClaimDTO(APIModel):
    """One row of pallet_claims — per-pallet ownership for multi-user Focus."""
    pallet_idx: int
    user_id: UUID
    user_name: str
    state: PalletClaimState
    claimed_at: datetime
    heartbeat_at: datetime
    released_at: Optional[datetime] = None
    is_stale: bool = False  # derived: now - heartbeat_at > 5 min, state='active'


class SessionUser(BaseModel):
    """Membership entry in auftraege.session_users JSONB array."""
    user_id: UUID
    name: str
    role: str  # 'primary' | 'participant'
    joined_at: datetime
    last_seen_at: datetime


class UserPalletProgress(BaseModel):
    """Per-user cursor + copied-chip state, value in user_progress JSONB map."""
    current_pallet_idx: Optional[int] = None
    current_item_idx: Optional[int] = None
    copied_keys: dict[str, Any] = Field(default_factory=dict)


class PalletReleaseBody(BaseModel):
    """POST /api/auftraege/{id}/pallets/{idx}/release body. completed=true
    marks the pallet done (counts toward auto-complete); completed=false
    just frees it for someone else to pick up."""
    completed: bool = False


class HeartbeatResponse(BaseModel):
    """POST /api/auftraege/{id}/heartbeat response — how many active claims
    the caller refreshed (0 means nothing to ping, harmless)."""
    updated: int


class AuftragDetail(AuftragSummary):
    """Full record incl. parsed payload, raw text, and workflow state."""
    raw_text: Optional[str] = None
    parsed: Optional[dict[str, Any]] = None
    validation: Optional[dict[str, Any]] = None
    step: Optional[WorkflowStep] = None
    current_pallet_idx: Optional[int] = None
    current_item_idx: Optional[int] = None
    completed_keys: dict[str, Any] = Field(default_factory=dict)
    pallet_timings: dict[str, Any] = Field(default_factory=dict)
    # Per-pallet effective seconds (= work seconds excluding lunch/non-
    # working hours). Computed from `pallet_timings` against the supplied
    # `schedule` — falls back to `{}` when no schedule is passed in (e.g.
    # tests that don't care about effective time).
    pallet_effective_seconds: dict[str, int] = Field(default_factory=dict)

    # Multi-user session fields (migration e7f8a9b0c1d2).
    session_users: list[SessionUser] = Field(default_factory=list)
    user_progress: dict[str, UserPalletProgress] = Field(default_factory=dict)
    pallet_claims: list[PalletClaimDTO] = Field(default_factory=list)

    @classmethod
    def from_orm_row(
        cls,
        row: Auftrag,
        assigned_to_user_name: Optional[str] = None,
        schedule: Optional[WorkScheduleCfg] = None,
        pallet_claims: Optional[list[PalletClaimDTO]] = None,
    ) -> AuftragDetail:
        base = AuftragSummary.from_orm_row(row, assigned_to_user_name, schedule)
        # session_users / user_progress live as raw JSONB; parse into typed
        # DTOs so the wire response is well-shaped. Tolerant of legacy rows
        # where the column is None or the entries are missing fields.
        session_users: list[SessionUser] = []
        for entry in (row.session_users or []):
            try:
                session_users.append(SessionUser(**entry))
            except Exception:
                continue
        user_progress: dict[str, UserPalletProgress] = {}
        for uid, val in (row.user_progress or {}).items():
            try:
                user_progress[str(uid)] = UserPalletProgress(**(val or {}))
            except Exception:
                user_progress[str(uid)] = UserPalletProgress()
        return cls(
            **base.model_dump(),
            raw_text=row.raw_text,
            parsed=row.parsed,
            validation=row.validation,
            step=row.step,
            current_pallet_idx=row.current_pallet_idx,
            current_item_idx=row.current_item_idx,
            completed_keys=row.completed_keys or {},
            session_users=session_users,
            user_progress=user_progress,
            pallet_claims=pallet_claims or [],
        )


# ─── Reports — aggregates for the Berichte analytics sections ────────
# Filled by the in-memory aggregator that scans completed Aufträge in
# the lookback window. All counts are derived from parsed.pallets[].items
# (+ parsed.einzelneSkuItems), level mirrors the frontend's getLevel()
# title regex — see backend/levels.py.

class LevelBucket(BaseModel):
    """One row in the byLevel breakdown — total units/rolls/auftrag count
    per physical level (1=Thermo … 7=Tacho)."""
    level: int
    units: int
    rollen: int
    auftrag_count: int  # distinct Aufträge that contain ≥1 item of this level
    # Σ units × price_per_einheit_eur for items with a known price.
    # Sums to the level's share of `items_value_eur`; null-priced items
    # contribute 0 but still count against the global coverage_pct.
    cost_eur: float = 0.0


class DailyLevelBucket(BaseModel):
    """One day in dailyByLevel / rollenByDay. `values` maps level → metric
    (units or rollen depending on the field). Levels with zero value for
    the day are omitted to keep the payload tight."""
    date: str  # YYYY-MM-DD (UTC date of finished_at)
    values: dict[int, int] = Field(default_factory=dict)


class HeatmapCell(BaseModel):
    """One day cell in the 30-day calendar heatmap."""
    date: str  # YYYY-MM-DD
    count: int  # completed Aufträge on this date
    units: int  # total Einheiten processed on this date


class LynneVariant(BaseModel):
    """One SKU×channel row under an ASIN group."""
    sku: str
    ean: Optional[str] = None
    channel: str  # PRIME | EV | EV-PRIME | OTHER
    weeklySales: int = 0
    grazStock: int = 0


class LynneAsinGroup(BaseModel):
    """Aggregated catalog entry. One ASIN = several variants (SKU×channel).

    `description`, `brand`, `perPallet` are taken from the first variant —
    same product, those values don't vary across variants by business rule.
    """
    asin: str
    description: str
    brand: str
    variantCount: int
    totalWeeklySales: int
    totalGrazStock: int
    perPallet: int
    variants: list[LynneVariant] = Field(default_factory=list)


class LynneCatalog(BaseModel):
    """Top-level wrapper — gives the UI summary line totals for the
    sticky header without a second round-trip."""
    items: list[LynneAsinGroup] = Field(default_factory=list)
    totalAsins: int = 0
    totalBrands: int = 0
    totalGrazStock: int = 0


# ─── Admin CRUD DTOs for lynne_products ────────────────────────────
# Used by /api/lynne/admin/* endpoints. Frontend-facing field names stay
# camelCase to match the existing read schemas above.

class LynneProductRead(BaseModel):
    """Single row DTO — response shape for POST/PATCH on lynne_products."""
    id: str
    asin: str
    sku: str
    channel: str
    ean: Optional[str] = None
    description: str = ""
    brand: str = ""
    perPallet: int = 0
    weeklySales: int = 0
    grazStock: int = 0


class LynneProductCreate(BaseModel):
    """Create a new SKU row. asin/sku/channel are required; everything else
    defaults to empty/zero. Server builds the `<asin>__<sku>` id."""
    asin: str = Field(..., min_length=1, max_length=20)
    sku: str = Field(..., min_length=1, max_length=50)
    channel: str = Field(..., min_length=1, max_length=16)
    ean: Optional[str] = Field(default=None, max_length=20)
    description: str = ""
    brand: str = Field(default="", max_length=80)
    perPallet: int = Field(default=0, ge=0)
    weeklySales: int = Field(default=0, ge=0)
    grazStock: int = Field(default=0, ge=0)


class LynneVariantPatch(BaseModel):
    """Partial per-row update. If `asin` or `sku` are present, the server
    re-computes `id` via DELETE+INSERT (PostgreSQL doesn't accept UPDATE on
    a primary key in a single statement reliably)."""
    asin: Optional[str] = Field(default=None, min_length=1, max_length=20)
    sku: Optional[str] = Field(default=None, min_length=1, max_length=50)
    channel: Optional[str] = Field(default=None, min_length=1, max_length=16)
    ean: Optional[str] = Field(default=None, max_length=20)
    description: Optional[str] = None
    brand: Optional[str] = Field(default=None, max_length=80)
    perPallet: Optional[int] = Field(default=None, ge=0)
    weeklySales: Optional[int] = Field(default=None, ge=0)
    grazStock: Optional[int] = Field(default=None, ge=0)


class LynneAsinBatchPatch(BaseModel):
    """Batch update of group-level fields across every variant under
    one ASIN. Use for description / brand / per_pallet corrections."""
    description: Optional[str] = None
    brand: Optional[str] = Field(default=None, max_length=80)
    perPallet: Optional[int] = Field(default=None, ge=0)


class LynneAsinRename(BaseModel):
    """Move every variant from one ASIN to another. Conflicts (target ASIN
    already exists) → 409."""
    newAsin: str = Field(..., min_length=1, max_length=20)


class WorkScheduleRead(APIModel):
    """Current warehouse working schedule. Single-row config (id=1)."""
    work_start: time
    work_end: time
    break_start: time
    break_end: time
    working_days: list[int] = Field(default_factory=lambda: [1, 2, 3, 4, 5])
    timezone_name: str = "Europe/Berlin"
    updated_at: datetime
    updated_by_user_id: Optional[UUID] = None


class WorkSchedulePatch(BaseModel):
    """PATCH body — any subset of the schedule. `working_days` is the
    full replacement set (ISO Mon=1..Sun=7), not a delta."""
    work_start: Optional[time] = None
    work_end: Optional[time] = None
    break_start: Optional[time] = None
    break_end: Optional[time] = None
    working_days: Optional[list[int]] = Field(default=None)
    timezone_name: Optional[str] = Field(default=None, max_length=50)


class ReportsAggregates(BaseModel):
    """Server-side aggregates for the Berichte analytics widgets.
    The 4 sections (Format-Verteilung, Aktivität-Heatmap, Level-Stack,
    Rollen-Durchsatz) are derived from these slices."""
    by_level: list[LevelBucket] = Field(default_factory=list)
    daily_by_level: list[DailyLevelBucket] = Field(default_factory=list)
    rollen_by_day: list[DailyLevelBucket] = Field(default_factory=list)
    heatmap: list[HeatmapCell] = Field(default_factory=list)
    # Lookback window the server actually applied (clamped to ≤90).
    days: int
    # KPI roll-ups for the v2.4 Berichte redesign. `articles_total` is
    # Σ len(items) across completed Aufträge; `units_total` is Σ units;
    # `items_value_eur` is Σ units × price_per_einheit_eur for the items
    # that have a price; `items_value_coverage_pct` is the percentage of
    # items that contributed (price was known). `productivity_units_per_hour`
    # is units_total / Σ effective_seconds(started_at, finished_at,
    # schedule) — uses the warehouse schedule so non-working hours are
    # excluded.
    articles_total: int = 0
    units_total: int = 0
    items_value_eur: float = 0.0
    items_value_coverage_pct: float = 0.0
    productivity_units_per_hour: float = 0.0
