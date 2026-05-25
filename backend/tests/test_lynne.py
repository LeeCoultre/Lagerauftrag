"""Tests for /api/lynne/products.

Catalog endpoint groups lynne_products rows by ASIN and returns one
entry per ASIN with its variants nested. Independent of Marathon's
operational tables.
"""

import pytest

from backend.database import AsyncSessionLocal
from backend.orm import LynneProduct


async def _seed(rows: list[dict]) -> None:
    async with AsyncSessionLocal() as s:
        for r in rows:
            asin = r["asin"]
            sku = r["sku"]
            s.add(LynneProduct(
                id=f"{asin}__{sku}",
                asin=asin,
                channel=r.get("channel", "PRIME"),
                sku=sku,
                ean=r.get("ean"),
                description=r.get("description", ""),
                brand=r.get("brand", ""),
                weekly_sales=r.get("weekly_sales", 0),
                graz_stock=r.get("graz_stock", 0),
                per_pallet=r.get("per_pallet", 0),
                source="test",
            ))
        await s.commit()


@pytest.mark.asyncio
async def test_empty_catalog(client, user, as_user):
    as_user(user)
    resp = await client.get("/api/lynne/products")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {
        "items": [],
        "totalAsins": 0,
        "totalBrands": 0,
        "totalGrazStock": 0,
    }


@pytest.mark.asyncio
async def test_single_asin_two_variants(client, user, as_user):
    await _seed([
        {
            "asin": "B0AAAAAAAA", "sku": "PRM-1", "channel": "PRIME",
            "description": "Widget 57mm", "brand": "LYNNE",
            "weekly_sales": 1000, "graz_stock": 25000, "per_pallet": 560,
            "ean": "9120107000001",
        },
        {
            "asin": "B0AAAAAAAA", "sku": "EV-1", "channel": "EV",
            "description": "Widget 57mm", "brand": "LYNNE",
            "weekly_sales": 50, "graz_stock": 5000, "per_pallet": 560,
            "ean": "9120107000001",
        },
    ])
    as_user(user)
    resp = await client.get("/api/lynne/products")
    assert resp.status_code == 200
    body = resp.json()

    assert body["totalAsins"] == 1
    assert body["totalBrands"] == 1
    assert body["totalGrazStock"] == 30000

    items = body["items"]
    assert len(items) == 1
    group = items[0]
    assert group["asin"] == "B0AAAAAAAA"
    assert group["description"] == "Widget 57mm"
    assert group["brand"] == "LYNNE"
    assert group["variantCount"] == 2
    assert group["totalWeeklySales"] == 1050
    assert group["totalGrazStock"] == 30000
    assert group["perPallet"] == 560

    variants = group["variants"]
    assert [v["channel"] for v in variants] == ["PRIME", "EV"]
    assert variants[0]["sku"] == "PRM-1"
    assert variants[0]["grazStock"] == 25000
    assert variants[1]["sku"] == "EV-1"
    assert variants[1]["grazStock"] == 5000


@pytest.mark.asyncio
async def test_two_asins_sorted_by_stock(client, user, as_user):
    await _seed([
        {
            "asin": "B0AAAAAAAA", "sku": "X-A", "channel": "PRIME",
            "description": "A", "brand": "LYNNE",
            "graz_stock": 100, "per_pallet": 500,
        },
        {
            "asin": "B0BBBBBBBB", "sku": "X-B1", "channel": "PRIME",
            "description": "B", "brand": "TK",
            "graz_stock": 800, "per_pallet": 400,
        },
        {
            "asin": "B0BBBBBBBB", "sku": "X-B2", "channel": "EV",
            "description": "B", "brand": "TK",
            "graz_stock": 200, "per_pallet": 400,
        },
    ])
    as_user(user)
    resp = await client.get("/api/lynne/products")
    body = resp.json()

    assert body["totalAsins"] == 2
    assert body["totalBrands"] == 2
    assert body["totalGrazStock"] == 1100

    items = body["items"]
    assert len(items) == 2
    # Sorted by totalGrazStock desc: B0BBBBBBBB (1000) before B0AAAAAAAA (100)
    assert items[0]["asin"] == "B0BBBBBBBB"
    assert items[0]["variantCount"] == 2
    assert items[0]["totalGrazStock"] == 1000
    assert items[1]["asin"] == "B0AAAAAAAA"
    assert items[1]["variantCount"] == 1


@pytest.mark.asyncio
async def test_unauthenticated_rejected(client):
    # No as_user → get_current_user not overridden → 401
    resp = await client.get("/api/lynne/products")
    assert resp.status_code in (401, 403)


# ─── Admin CRUD ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_admin_can_patch_asin_batch(client, admin, as_user):
    """PATCH /admin/asins/{asin} updates description/brand/perPallet
    across every variant under that ASIN in a single batch query."""
    await _seed([
        {
            "asin": "B0PATCHASIN", "sku": "S1", "channel": "PRIME",
            "description": "Alt", "brand": "OldBrand",
            "weekly_sales": 10, "graz_stock": 100, "per_pallet": 200,
        },
        {
            "asin": "B0PATCHASIN", "sku": "S2", "channel": "EV",
            "description": "Alt", "brand": "OldBrand",
            "weekly_sales": 20, "graz_stock": 200, "per_pallet": 200,
        },
    ])
    as_user(admin)
    resp = await client.patch(
        "/api/lynne/admin/asins/B0PATCHASIN",
        json={"description": "Neu", "brand": "NewBrand", "perPallet": 999},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["description"] == "Neu"
    assert body["brand"] == "NewBrand"
    assert body["perPallet"] == 999
    assert body["variantCount"] == 2

    # Both variants are updated in DB
    from sqlalchemy import select
    async with AsyncSessionLocal() as s:
        rows = (await s.execute(
            select(LynneProduct).where(LynneProduct.asin == "B0PATCHASIN")
        )).scalars().all()
        assert all(r.description == "Neu" for r in rows)
        assert all(r.brand == "NewBrand" for r in rows)
        assert all(r.per_pallet == 999 for r in rows)

    # Audit log written
    from backend.orm import AuditLog
    async with AsyncSessionLocal() as s:
        logs = (await s.execute(
            select(AuditLog).where(AuditLog.action == "lynne_product_asin_batch")
        )).scalars().all()
        assert len(logs) == 1
        assert logs[0].meta["asin"] == "B0PATCHASIN"


@pytest.mark.asyncio
async def test_non_admin_gets_403(client, user, as_user):
    """All 5 admin endpoints reject non-admin users."""
    await _seed([{
        "asin": "B0DENY", "sku": "S1", "channel": "PRIME",
        "description": "x", "brand": "y",
    }])
    as_user(user)

    r1 = await client.post("/api/lynne/admin/products", json={
        "asin": "B0NEW", "sku": "NEW", "channel": "PRIME",
    })
    r2 = await client.patch("/api/lynne/admin/asins/B0DENY", json={"description": "x"})
    r3 = await client.patch("/api/lynne/admin/products/B0DENY__S1", json={"brand": "z"})
    r4 = await client.delete("/api/lynne/admin/products/B0DENY__S1")
    r5 = await client.patch("/api/lynne/admin/asins/B0DENY/rename", json={"newAsin": "B0OTHER"})

    for resp in (r1, r2, r3, r4, r5):
        assert resp.status_code == 403, f"got {resp.status_code} expected 403"


@pytest.mark.asyncio
async def test_create_rejects_duplicate_id(client, admin, as_user):
    await _seed([{
        "asin": "B0DUP", "sku": "S1", "channel": "PRIME",
        "description": "exists", "brand": "x",
    }])
    as_user(admin)
    resp = await client.post("/api/lynne/admin/products", json={
        "asin": "B0DUP", "sku": "S1", "channel": "EV",
    })
    assert resp.status_code == 409
    assert "exists" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_patch_with_sku_rename_recomputes_id(client, admin, as_user):
    """When sku changes, backend DELETEs the old row and INSERTs a new
    row with the new composite id. Old id must be gone."""
    await _seed([{
        "asin": "B0REN", "sku": "OLD", "channel": "PRIME",
        "description": "x", "brand": "y", "weekly_sales": 42,
    }])
    as_user(admin)
    resp = await client.patch(
        "/api/lynne/admin/products/B0REN__OLD",
        json={"sku": "NEW", "weeklySales": 99},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == "B0REN__NEW"
    assert body["sku"] == "NEW"
    assert body["weeklySales"] == 99

    from sqlalchemy import select
    async with AsyncSessionLocal() as s:
        old = await s.get(LynneProduct, "B0REN__OLD")
        new = await s.get(LynneProduct, "B0REN__NEW")
        assert old is None
        assert new is not None
        assert new.weekly_sales == 99


@pytest.mark.asyncio
async def test_delete_returns_404_if_missing(client, admin, as_user):
    as_user(admin)
    resp = await client.delete("/api/lynne/admin/products/B0NONEXIST__X")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_asin_rename_moves_all_variants(client, admin, as_user):
    await _seed([
        {"asin": "B0OLD", "sku": "A", "channel": "PRIME"},
        {"asin": "B0OLD", "sku": "B", "channel": "EV"},
        {"asin": "B0OLD", "sku": "C", "channel": "EV-PRIME"},
    ])
    as_user(admin)
    resp = await client.patch(
        "/api/lynne/admin/asins/B0OLD/rename",
        json={"newAsin": "B0FRESH"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["asin"] == "B0FRESH"
    assert body["variantCount"] == 3

    from sqlalchemy import select
    async with AsyncSessionLocal() as s:
        old_rows = (await s.execute(
            select(LynneProduct).where(LynneProduct.asin == "B0OLD")
        )).scalars().all()
        new_rows = (await s.execute(
            select(LynneProduct).where(LynneProduct.asin == "B0FRESH")
        )).scalars().all()
        assert old_rows == []
        assert len(new_rows) == 3
        assert sorted(r.id for r in new_rows) == [
            "B0FRESH__A", "B0FRESH__B", "B0FRESH__C",
        ]


@pytest.mark.asyncio
async def test_asin_rename_rejects_conflict(client, admin, as_user):
    """If the target ASIN already has rows, rename fails with 409 — no
    automatic merge."""
    await _seed([
        {"asin": "B0SRC", "sku": "A", "channel": "PRIME"},
        {"asin": "B0DEST", "sku": "Z", "channel": "PRIME"},
    ])
    as_user(admin)
    resp = await client.patch(
        "/api/lynne/admin/asins/B0SRC/rename",
        json={"newAsin": "B0DEST"},
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_create_then_delete_roundtrip(client, admin, as_user):
    """Full POST → DELETE cycle: creates a brand-new ASIN+SKU, then
    removes it. Audit logs for both written."""
    as_user(admin)
    create_resp = await client.post("/api/lynne/admin/products", json={
        "asin": "B0FRESH", "sku": "F-1", "channel": "PRIME",
        "description": "Test", "brand": "T", "perPallet": 100,
    })
    assert create_resp.status_code == 201
    body = create_resp.json()
    assert body["id"] == "B0FRESH__F-1"

    delete_resp = await client.delete("/api/lynne/admin/products/B0FRESH__F-1")
    assert delete_resp.status_code == 204

    async with AsyncSessionLocal() as s:
        row = await s.get(LynneProduct, "B0FRESH__F-1")
        assert row is None
