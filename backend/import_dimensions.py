"""CLI wrapper around the /admin/sku-dimensions/import endpoint logic.

Reuses the same parsing helpers and upsert algorithm from
backend.routers.sku_dimensions so behaviour matches the Admin →
Dimensions xlsx upload exactly. Reads `wb.active` (the Main sheet of
Dimensional_list.xlsx); no multi-sheet merge, no fallback source.

Companion to backend.seed_produktion_dims, which seeds the L4-Produktion
ESKU items (Big Bags / Klebeband / Holzwolle) not present in the xlsx.

Usage:
    .venv/bin/python -m backend.import_dimensions <path-to-xlsx>            # dry-run
    .venv/bin/python -m backend.import_dimensions <path-to-xlsx> --apply    # commit
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime, timezone
from pathlib import Path

import openpyxl
from sqlalchemy import select

from backend.database import AsyncSessionLocal
from backend.orm import SkuDimension
from backend.routers.sku_dimensions import (
    _FNSKU_ALIASES, _SKU_ALIASES, _EAN_ALIASES, _TITLE_ALIASES,
    _L_ALIASES, _B_ALIASES, _H_ALIASES, _WEIGHT_ALIASES,
    _PALLET_LOAD_ALIASES,
    _find_col, _parse_float, _parse_int, _parse_keys, _str_or_none,
)


async def run(path: Path, apply: bool) -> None:
    if not path.exists():
        raise SystemExit(f"File not found: {path}")

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.values)
    wb.close()

    # Detect header row (first with L+B+H+Weight columns).
    header_idx: int | None = None
    cols: dict[str, int | None] = {}
    for idx, row in enumerate(rows):
        if not row:
            continue
        headers = [str(c or "").strip().lower() for c in row]
        c_l = _find_col(headers, _L_ALIASES)
        c_b = _find_col(headers, _B_ALIASES)
        c_h = _find_col(headers, _H_ALIASES)
        c_w = _find_col(headers, _WEIGHT_ALIASES)
        if all(c is not None for c in (c_l, c_b, c_h, c_w)):
            header_idx = idx
            cols = {
                "fnsku": _find_col(headers, _FNSKU_ALIASES),
                "sku": _find_col(headers, _SKU_ALIASES),
                "ean": _find_col(headers, _EAN_ALIASES),
                "title": _find_col(headers, _TITLE_ALIASES),
                "l": c_l, "b": c_b, "h": c_h, "weight": c_w,
                "pallet_load": _find_col(headers, _PALLET_LOAD_ALIASES),
            }
            break

    if header_idx is None:
        raise SystemExit(
            "No header row detected. Required: L (cm), B (cm), H (cm), "
            "Gewicht (kg) — plus at least one of FNSKU/SKU/EAN."
        )

    print(f"File:        {path.name}")
    print(f"Active sheet: {ws.title}  (header row {header_idx + 1})")
    print()

    stats = {"inserted": 0, "updated": 0, "skipped": 0, "warned": 0}
    warnings: list[str] = []
    now = datetime.now(timezone.utc)

    async with AsyncSessionLocal() as session:
        existing = (await session.execute(select(SkuDimension))).scalars().all()
        by_fnsku: dict[str, SkuDimension] = {}
        by_sku: dict[str, SkuDimension] = {}
        by_ean: dict[str, SkuDimension] = {}
        for r in existing:
            for k in r.fnskus or []: by_fnsku[k] = r
            for k in r.skus or []:   by_sku[k] = r
            for k in r.eans or []:   by_ean[k] = r

        for row_idx in range(header_idx + 1, len(rows)):
            row = rows[row_idx]
            if not row or all(c is None for c in row):
                continue

            def cell(key: str):
                i = cols.get(key)
                if i is None or i >= len(row):
                    return None
                return row[i]

            fnskus_in = _parse_keys(cell("fnsku"))
            skus_in   = _parse_keys(cell("sku"))
            eans_in   = _parse_keys(cell("ean"), ean_only=True)
            title     = _str_or_none(cell("title"))
            l_val     = _parse_float(cell("l"))
            b_val     = _parse_float(cell("b"))
            h_val     = _parse_float(cell("h"))
            w_val     = _parse_float(cell("weight"))
            pallet_load = _parse_int(cell("pallet_load"))

            if not (fnskus_in or skus_in or eans_in):
                stats["skipped"] += 1
                continue
            if any(v is None or v <= 0 for v in (l_val, b_val, h_val, w_val)):
                stats["skipped"] += 1
                label = (fnskus_in or skus_in or eans_in)[0]
                warnings.append(
                    f"Row {row_idx + 1} '{label}': missing/non-positive L/B/H/weight — skipped"
                )
                continue

            # Find existing row sharing any key (first hit wins).
            target = None
            for k in fnskus_in:
                if k in by_fnsku: target = by_fnsku[k]; break
            if target is None:
                for k in skus_in:
                    if k in by_sku: target = by_sku[k]; break
            if target is None:
                for k in eans_in:
                    if k in by_ean: target = by_ean[k]; break

            if target is not None:
                # Accumulate keys, replace lists (SQLAlchemy ARRAY identity).
                for k in fnskus_in:
                    if k not in (target.fnskus or []):
                        target.fnskus = [*(target.fnskus or []), k]
                        by_fnsku[k] = target
                for k in skus_in:
                    if k not in (target.skus or []):
                        target.skus = [*(target.skus or []), k]
                        by_sku[k] = target
                for k in eans_in:
                    if k not in (target.eans or []):
                        target.eans = [*(target.eans or []), k]
                        by_ean[k] = target
                target.title = title or target.title
                target.length_cm = l_val
                target.width_cm = b_val
                target.height_cm = h_val
                target.weight_kg = w_val
                if pallet_load is not None:
                    target.pallet_load_max = pallet_load
                target.source = "xlsx_import"
                target.updated_by = "import_dimensions.py"
                target.updated_at = now
                stats["updated"] += 1
            else:
                new_row = SkuDimension(
                    fnskus=fnskus_in,
                    skus=skus_in,
                    eans=eans_in,
                    title=title,
                    length_cm=l_val,
                    width_cm=b_val,
                    height_cm=h_val,
                    weight_kg=w_val,
                    pallet_load_max=pallet_load,
                    source="xlsx_import",
                    updated_by="import_dimensions.py",
                )
                session.add(new_row)
                for k in fnskus_in: by_fnsku[k] = new_row
                for k in skus_in:   by_sku[k] = new_row
                for k in eans_in:   by_ean[k] = new_row
                stats["inserted"] += 1

        if apply:
            await session.commit()
        else:
            await session.rollback()

    print(f"Inserted: {stats['inserted']}")
    print(f"Updated:  {stats['updated']}")
    print(f"Skipped:  {stats['skipped']}")
    if warnings:
        print()
        print(f"Warnings ({len(warnings)}):")
        for w in warnings[:20]:
            print(f"  {w}")
        if len(warnings) > 20:
            print(f"  … and {len(warnings) - 20} more")
    print()
    print("Committed." if apply else "(dry-run — pass --apply to commit)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("xlsx", help="Path to Dimensional_list xlsx")
    parser.add_argument("--apply", action="store_true",
                        help="Commit changes (default: dry-run)")
    args = parser.parse_args()
    asyncio.run(run(Path(args.xlsx), apply=args.apply))
