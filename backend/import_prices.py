"""Import VPE prices from Produktaufstellung_KWxx.xlsx → sku_dimensions.

Reads sheet "Preise + Infos", picks the EAN (col 2) and the
"Rollenpreis Total je VPE in €" (col 21), and writes
`price_per_einheit_eur` into every matching `sku_dimensions` row (joined
through the `eans` array column). Idempotent: re-running with a newer
xlsx overwrites the price.

Usage:
    .venv/bin/python -m backend.import_prices \\
        --source Produktaufstellung_KW14_-_Aktuel.xlsx

Header row index 0 (1-indexed: row 1); data starts at row index 2 (= row 3).
The xlsx allows the price column to be empty for some rows (legacy SKUs
without a measured cost) — those rows are silently skipped.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

import openpyxl
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import AsyncSessionLocal
from backend.orm import SkuDimension


SHEET = "Preise + Infos "  # trailing space is in the workbook
COL_EAN = 2
COL_DESCRIPTION = 5
COL_PRICE_PER_VPE = 21
DATA_FIRST_ROW = 3  # 1-indexed; row 1 = header, row 2 = blank


def _coerce_ean(raw: object) -> str | None:
    """Excel stores Interne Artikelnummer as integers (no leading zero) —
    cast to str without trailing '.0'. Returns None if blank/invalid."""
    if raw is None or raw == "":
        return None
    if isinstance(raw, float):
        if raw != raw:  # NaN
            return None
        return str(int(raw))
    return str(raw).strip() or None


def _coerce_price(raw: object) -> float | None:
    if raw is None or raw == "":
        return None
    if isinstance(raw, (int, float)):
        return float(raw) if raw >= 0 else None
    s = str(raw).replace(",", ".").strip()
    if not s:
        return None
    try:
        v = float(s)
        return v if v >= 0 else None
    except ValueError:
        return None


def _read_xlsx(path: Path) -> list[tuple[str, float, str | None]]:
    """Parse the sheet into [(ean, price, description), ...] tuples.

    Drops rows where EAN or price is missing. Description carried only
    for verbose logging / future audit metadata."""
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    if SHEET not in wb.sheetnames:
        raise SystemExit(
            f"Sheet '{SHEET}' not found. Available: {wb.sheetnames}"
        )
    ws = wb[SHEET]
    rows: list[tuple[str, float, str | None]] = []
    for r in range(DATA_FIRST_ROW, ws.max_row + 1):
        ean = _coerce_ean(ws.cell(row=r, column=COL_EAN + 1).value)
        price = _coerce_price(ws.cell(row=r, column=COL_PRICE_PER_VPE + 1).value)
        if ean is None or price is None:
            continue
        desc = ws.cell(row=r, column=COL_DESCRIPTION + 1).value
        rows.append((ean, price, str(desc).strip() if desc else None))
    return rows


async def _apply(db: AsyncSession, prices: list[tuple[str, float, str | None]]) -> tuple[int, int, list[str]]:
    """Apply prices to sku_dimensions rows. Returns (matched, missing, warnings)."""
    matched = 0
    missing: list[str] = []
    warnings: list[str] = []
    for ean, price, desc in prices:
        # `eans` is an array column — ANY('{ean}') = eans matches.
        result = await db.execute(
            update(SkuDimension)
            .where(SkuDimension.eans.any(ean))
            .values(price_per_einheit_eur=price)
        )
        if result.rowcount and result.rowcount > 0:
            matched += result.rowcount
            if result.rowcount > 1:
                warnings.append(
                    f"EAN {ean} matched {result.rowcount} rows — "
                    "duplicate SkuDimension rows share this EAN"
                )
        else:
            missing.append(f"{ean} ({desc or '?'})")
    await db.commit()
    return matched, len(missing), warnings + (
        [f"No sku_dimensions row matched: {m}" for m in missing[:10]]
    )


async def _main(path: Path) -> None:
    if not path.exists():
        raise SystemExit(f"File not found: {path}")
    print(f"Reading {path.name} sheet '{SHEET}' …")
    prices = _read_xlsx(path)
    print(f"Parsed {len(prices)} priced VPE rows.")
    if not prices:
        print("Nothing to import.")
        return
    async with AsyncSessionLocal() as db:
        matched, missing, warnings = await _apply(db, prices)
    print(f"Matched {matched} sku_dimensions rows, {missing} EANs without a target row.")
    for w in warnings[:20]:
        print(f"  · {w}")


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--source", required=True, help="Path to xlsx workbook")
    args = p.parse_args(argv)
    asyncio.run(_main(Path(args.source)))


if __name__ == "__main__":
    main(sys.argv[1:])
