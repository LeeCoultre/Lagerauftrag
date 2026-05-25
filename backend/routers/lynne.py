"""LYNNE product catalog.

Independent of Marathon's operational tables (auftraege/history) —
backed by `lynne_products`, populated from the weekly
Produktaufstellung_KWxx.xlsx via `python -m backend.import_lynne`.

`GET /products` is open to any signed-in user. The `/admin/*` family
under this prefix is gated by `require_admin` and writes AuditLog
entries for every mutation.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, update, delete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.deps import get_current_user, require_admin
from backend.orm import AuditLog, LynneProduct, User
from backend.schemas import (
    LynneAsinBatchPatch,
    LynneAsinGroup,
    LynneAsinRename,
    LynneCatalog,
    LynneProductCreate,
    LynneProductRead,
    LynneVariant,
    LynneVariantPatch,
)


router = APIRouter(prefix="/api/lynne", tags=["lynne"])


# ─── Helpers ──────────────────────────────────────────────────────


CHANNEL_ORDER = {"PRIME": 0, "EV": 1, "EV-PRIME": 2, "OTHER": 3}
ALLOWED_CHANNELS = set(CHANNEL_ORDER.keys())


def _row_to_read(row: LynneProduct) -> LynneProductRead:
    return LynneProductRead(
        id=row.id,
        asin=row.asin,
        sku=row.sku,
        channel=row.channel,
        ean=row.ean,
        description=row.description or "",
        brand=row.brand or "",
        perPallet=row.per_pallet,
        weeklySales=row.weekly_sales,
        grazStock=row.graz_stock,
    )


def _validate_channel(ch: str) -> None:
    if ch not in ALLOWED_CHANNELS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"channel must be one of {sorted(ALLOWED_CHANNELS)}",
        )


async def _build_asin_group(db: AsyncSession, asin: str) -> LynneAsinGroup:
    """Reload the entire group fresh from the DB. Used as PATCH response."""
    rows = (
        await db.execute(
            select(LynneProduct)
            .where(LynneProduct.asin == asin)
            .order_by(LynneProduct.sku)
        )
    ).scalars().all()
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"ASIN {asin} not found")
    rows.sort(key=lambda r: (CHANNEL_ORDER.get(r.channel, 99), r.sku))
    head = rows[0]
    return LynneAsinGroup(
        asin=asin,
        description=head.description or "",
        brand=head.brand or "",
        variantCount=len(rows),
        totalWeeklySales=sum(v.weekly_sales for v in rows),
        totalGrazStock=sum(v.graz_stock for v in rows),
        perPallet=head.per_pallet,
        variants=[
            LynneVariant(
                sku=v.sku,
                ean=v.ean,
                channel=v.channel,
                weeklySales=v.weekly_sales,
                grazStock=v.graz_stock,
            )
            for v in rows
        ],
    )


def _audit(admin: User, action: str, meta: dict[str, Any]) -> AuditLog:
    return AuditLog(user_id=admin.id, auftrag_id=None, action=action, meta=meta)


# ─── Public ──────────────────────────────────────────────────────


@router.get("/products", response_model=LynneCatalog)
async def list_lynne_products(
    _user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LynneCatalog:
    """Catalog grouped by ASIN.

    `description`, `brand`, `per_pallet` of the group come from the
    first variant encountered (they don't vary across an ASIN's
    variants by business rule — same product, different sales channels).
    Variants are sorted by channel (PRIME first, then EV, EV-PRIME, OTHER).
    """
    rows = (
        await db.execute(
            select(LynneProduct).order_by(LynneProduct.asin, LynneProduct.sku)
        )
    ).scalars().all()

    grouped: dict[str, list[LynneProduct]] = {}
    for r in rows:
        grouped.setdefault(r.asin, []).append(r)

    items: list[LynneAsinGroup] = []
    brands: set[str] = set()
    total_graz = 0

    for asin, variants in grouped.items():
        variants.sort(key=lambda r: (CHANNEL_ORDER.get(r.channel, 99), r.sku))
        head = variants[0]
        group_total_sales = sum(v.weekly_sales for v in variants)
        group_total_graz = sum(v.graz_stock for v in variants)
        total_graz += group_total_graz
        if head.brand:
            brands.add(head.brand)

        items.append(LynneAsinGroup(
            asin=asin,
            description=head.description or "",
            brand=head.brand or "",
            variantCount=len(variants),
            totalWeeklySales=group_total_sales,
            totalGrazStock=group_total_graz,
            perPallet=head.per_pallet,
            variants=[
                LynneVariant(
                    sku=v.sku,
                    ean=v.ean,
                    channel=v.channel,
                    weeklySales=v.weekly_sales,
                    grazStock=v.graz_stock,
                )
                for v in variants
            ],
        ))

    items.sort(key=lambda g: (-g.totalGrazStock, g.asin))

    return LynneCatalog(
        items=items,
        totalAsins=len(items),
        totalBrands=len(brands),
        totalGrazStock=total_graz,
    )


# ─── Admin CRUD ──────────────────────────────────────────────────


@router.post(
    "/admin/products",
    response_model=LynneProductRead,
    status_code=status.HTTP_201_CREATED,
)
async def admin_create_lynne_product(
    payload: LynneProductCreate,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> LynneProductRead:
    """Insert a new SKU row. The composite id (`<asin>__<sku>`) must be
    unique; collisions yield 409."""
    _validate_channel(payload.channel)
    row_id = f"{payload.asin}__{payload.sku}"
    existing = await db.get(LynneProduct, row_id)
    if existing is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"ASIN+SKU combination already exists: {row_id}",
        )

    row = LynneProduct(
        id=row_id,
        asin=payload.asin,
        sku=payload.sku,
        channel=payload.channel,
        ean=payload.ean,
        description=payload.description,
        brand=payload.brand,
        per_pallet=payload.perPallet,
        weekly_sales=payload.weeklySales,
        graz_stock=payload.grazStock,
        source="manual",
    )
    db.add(row)
    db.add(_audit(admin, "lynne_product_create", {
        "id": row_id, "asin": payload.asin, "sku": payload.sku,
        "channel": payload.channel,
    }))
    await db.commit()
    await db.refresh(row)
    return _row_to_read(row)


@router.patch(
    "/admin/asins/{asin}",
    response_model=LynneAsinGroup,
)
async def admin_patch_asin(
    asin: str,
    payload: LynneAsinBatchPatch,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> LynneAsinGroup:
    """Batch update description / brand / per_pallet for every variant
    under one ASIN. Fields not in the payload are left untouched."""
    rows = (
        await db.execute(
            select(LynneProduct).where(LynneProduct.asin == asin)
        )
    ).scalars().all()
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"ASIN {asin} not found")

    changes: dict[str, Any] = {}
    if payload.description is not None:
        changes["description"] = payload.description
    if payload.brand is not None:
        changes["brand"] = payload.brand
    if payload.perPallet is not None:
        changes["per_pallet"] = payload.perPallet

    if changes:
        await db.execute(
            update(LynneProduct)
            .where(LynneProduct.asin == asin)
            .values(**changes, source="manual")
        )
    db.add(_audit(admin, "lynne_product_asin_batch", {
        "asin": asin, "rows": len(rows), "changes": changes,
    }))
    await db.commit()
    return await _build_asin_group(db, asin)


@router.patch(
    "/admin/products/{row_id}",
    response_model=LynneProductRead,
)
async def admin_patch_lynne_product(
    row_id: str,
    payload: LynneVariantPatch,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> LynneProductRead:
    """Per-row update. If `asin` or `sku` change, the row is deleted and
    re-inserted with a new id (PG won't UPDATE PK reliably in one shot)."""
    row = await db.get(LynneProduct, row_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Row {row_id} not found")

    if payload.channel is not None:
        _validate_channel(payload.channel)

    new_asin = payload.asin if payload.asin is not None else row.asin
    new_sku = payload.sku if payload.sku is not None else row.sku
    new_id = f"{new_asin}__{new_sku}"

    before = {
        "id": row.id, "asin": row.asin, "sku": row.sku, "channel": row.channel,
        "ean": row.ean, "description": row.description, "brand": row.brand,
        "per_pallet": row.per_pallet, "weekly_sales": row.weekly_sales,
        "graz_stock": row.graz_stock,
    }

    needs_recreate = new_id != row.id
    if needs_recreate:
        conflict = await db.get(LynneProduct, new_id)
        if conflict is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Target id already exists: {new_id}",
            )

    # Apply scalar changes to the in-memory row first.
    if payload.asin is not None:
        row.asin = payload.asin
    if payload.sku is not None:
        row.sku = payload.sku
    if payload.channel is not None:
        row.channel = payload.channel
    if payload.ean is not None:
        row.ean = payload.ean or None
    if payload.description is not None:
        row.description = payload.description
    if payload.brand is not None:
        row.brand = payload.brand
    if payload.perPallet is not None:
        row.per_pallet = payload.perPallet
    if payload.weeklySales is not None:
        row.weekly_sales = payload.weeklySales
    if payload.grazStock is not None:
        row.graz_stock = payload.grazStock
    row.source = "manual"

    if needs_recreate:
        # Detach old row, build new one with the new id; both happen in
        # the same transaction so external reads never see a gap.
        clone = LynneProduct(
            id=new_id,
            asin=row.asin,
            sku=row.sku,
            channel=row.channel,
            ean=row.ean,
            description=row.description,
            brand=row.brand,
            per_pallet=row.per_pallet,
            weekly_sales=row.weekly_sales,
            graz_stock=row.graz_stock,
            source="manual",
        )
        await db.delete(row)
        await db.flush()
        db.add(clone)
        row = clone

    db.add(_audit(admin, "lynne_product_update", {
        "before": before, "after_id": new_id,
    }))
    await db.commit()
    await db.refresh(row)
    return _row_to_read(row)


@router.delete(
    "/admin/products/{row_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def admin_delete_lynne_product(
    row_id: str,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> None:
    row = await db.get(LynneProduct, row_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Row {row_id} not found")
    snapshot = {
        "id": row.id, "asin": row.asin, "sku": row.sku, "channel": row.channel,
    }
    await db.delete(row)
    db.add(_audit(admin, "lynne_product_delete", snapshot))
    await db.commit()
    return None


@router.patch(
    "/admin/asins/{asin}/rename",
    response_model=LynneAsinGroup,
)
async def admin_rename_asin(
    asin: str,
    payload: LynneAsinRename,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> LynneAsinGroup:
    """Re-key every variant of an ASIN. Because `id = <asin>__<sku>` is
    the primary key, we must DELETE+INSERT each row inside one
    transaction. Conflicts with the target ASIN → 409."""
    new_asin = payload.newAsin
    if new_asin == asin:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "newAsin equals current asin")

    src_rows = (
        await db.execute(
            select(LynneProduct).where(LynneProduct.asin == asin)
        )
    ).scalars().all()
    if not src_rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"ASIN {asin} not found")

    conflicts = (
        await db.execute(
            select(LynneProduct.id).where(LynneProduct.asin == new_asin)
        )
    ).scalars().all()
    if conflicts:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Target ASIN {new_asin} already has rows — merge required manually",
        )

    snapshots = []
    clones = []
    for r in src_rows:
        snapshots.append({"old_id": r.id, "new_id": f"{new_asin}__{r.sku}"})
        clones.append(LynneProduct(
            id=f"{new_asin}__{r.sku}",
            asin=new_asin,
            sku=r.sku,
            channel=r.channel,
            ean=r.ean,
            description=r.description,
            brand=r.brand,
            per_pallet=r.per_pallet,
            weekly_sales=r.weekly_sales,
            graz_stock=r.graz_stock,
            source="manual",
        ))

    # DELETE first, then re-INSERT, then flush — keeps PK consistent.
    await db.execute(delete(LynneProduct).where(LynneProduct.asin == asin))
    await db.flush()
    for c in clones:
        db.add(c)

    db.add(_audit(admin, "lynne_product_asin_rename", {
        "old_asin": asin, "new_asin": new_asin, "moved": snapshots,
    }))
    await db.commit()
    return await _build_asin_group(db, new_asin)
