"""Tests for /api/reports/aggregates — the Berichte analytics endpoint.

Strategy mirrors test_admin.py: drive flows through the public API
(create → start → complete) rather than fabricating ORM rows. This
exercises the same parsed-blob path warehouse uploads take, so the
level classifier in backend/levels.py sees realistic payload shape.
"""

from backend.tests.conftest import make_payload  # noqa: F401 — keeps fixtures discoverable


def _items(*titles_units_rollen):
    """Build items[] for make_payload. Each arg is (title, units, rollen)."""
    return [
        {"title": t, "units": u, "rollen": r}
        for (t, u, r) in titles_units_rollen
    ]


def _payload(file_name, *titles_units_rollen, total_units=None):
    """Like conftest.make_payload but with a richer items[] for level
    aggregation. `total_units` defaults to sum(units) — letting the
    parser-canonical totalUnits field drive heatmap.units. Passing it
    explicitly lets us test the fallback (no totalUnits in meta)."""
    items = _items(*titles_units_rollen)
    if total_units is None:
        total_units = sum(it["units"] for it in items)
    return {
        "file_name": file_name,
        "parsed": {
            "meta": {"sendungsnummer": "T-1", "totalUnits": total_units},
            "pallets": [{"id": "P1", "items": items}],
        },
    }


async def test_aggregates_empty_db(client, user, as_user):
    """No Aufträge at all → all slices empty, heatmap has full grid of zeros."""
    as_user(user)
    r = await client.get("/api/reports/aggregates?days=14")
    assert r.status_code == 200
    body = r.json()

    assert body["days"] == 14
    # No completed Aufträge → every level bucket is zero across the board
    assert all(b["units"] == 0 and b["rollen"] == 0 and b["auftrag_count"] == 0
               for b in body["by_level"])
    assert len(body["by_level"]) == 7  # all 7 levels present, just zeroed
    # Heatmap still emits a full 14-day grid so the frontend renders cleanly
    assert len(body["heatmap"]) == 14
    assert all(c["count"] == 0 and c["units"] == 0 for c in body["heatmap"])
    # Stack window is fixed at 7 days, sparkline at 14 — regardless of `days`
    assert len(body["daily_by_level"]) == 7
    assert len(body["rollen_by_day"]) == 14


async def test_aggregates_mixed_levels(client, user, as_user):
    """Two completed Aufträge spanning L1, L4, L7 — verify per-level
    units/rolls totals and distinct auftrag_count."""
    as_user(user)

    # Auftrag #1 — Thermo (L1) + Klebeband (L4)
    a1 = (await client.post("/api/auftraege", json=_payload(
        "a1.docx",
        ("EC Thermorollen 80mm 50m phenolfrei", 10, 5),    # L1, 50 rolls
        ("Klebeband transparent 50mm",          4,  1),    # L4, 4 rolls
    ))).json()["id"]
    # Auftrag #2 — Thermo (L1) again + Tacho (L7)
    a2 = (await client.post("/api/auftraege", json=_payload(
        "a2.docx",
        ("ÖKO Thermorollen 80mm",  6, 2),                  # L3 (öko match)
        ("Tachorollen DTCO 4.0",   3, 4),                  # L7, 12 rolls
    ))).json()["id"]

    for aid in (a1, a2):
        await client.post(f"/api/auftraege/{aid}/start")
        await client.post(f"/api/auftraege/{aid}/complete")

    r = await client.get("/api/reports/aggregates?days=30")
    assert r.status_code == 200
    body = r.json()
    by_level = {b["level"]: b for b in body["by_level"]}

    # L1 Thermo — only the EC Thermorollen item from a1 (the ÖKO title in
    # a2 should classify as L3, not L1, because `öko` is checked before
    # the L1 default). Total units=10, rollen=10×5=50.
    assert by_level[1]["units"] == 10
    assert by_level[1]["rollen"] == 50
    assert by_level[1]["auftrag_count"] == 1

    # L3 ÖKO — 6 units from a2, rolls = 6×2 = 12
    assert by_level[3]["units"] == 6
    assert by_level[3]["rollen"] == 12
    assert by_level[3]["auftrag_count"] == 1

    # L4 Klebeband — 4 units, rolls = 4×1 = 4
    assert by_level[4]["units"] == 4
    assert by_level[4]["rollen"] == 4
    assert by_level[4]["auftrag_count"] == 1

    # L7 Tacho — 3 units, rolls = 3×4 = 12
    assert by_level[7]["units"] == 3
    assert by_level[7]["rollen"] == 12
    assert by_level[7]["auftrag_count"] == 1

    # Heatmap today cell should reflect 2 completed Aufträge with
    # totalUnits = (10+4) + (6+3) = 23 Einheiten
    today_cell = body["heatmap"][-1]  # newest is last
    assert today_cell["count"] == 2
    assert today_cell["units"] == 23

    # daily_by_level for today must include both L1 (10) and L3 (6) etc.
    today_iso = today_cell["date"]
    today_row = next(d for d in body["daily_by_level"] if d["date"] == today_iso)
    # values dict keys come back as strings via JSON
    vals = {int(k): v for k, v in today_row["values"].items()}
    assert vals.get(1) == 10
    assert vals.get(3) == 6
    assert vals.get(4) == 4
    assert vals.get(7) == 3


async def test_aggregates_level_filter(client, user, as_user):
    """?levels=1,7 must restrict every slice to only those levels."""
    as_user(user)

    a1 = (await client.post("/api/auftraege", json=_payload(
        "a1.docx",
        ("Thermorollen 80mm",        5, 2),  # L1
        ("Klebeband paketband 50mm", 3, 1),  # L4 — filtered out
        ("Tachorollen DTCO",         2, 5),  # L7
    ))).json()["id"]

    await client.post(f"/api/auftraege/{a1}/start")
    await client.post(f"/api/auftraege/{a1}/complete")

    r = await client.get("/api/reports/aggregates?days=30&levels=1,7")
    assert r.status_code == 200
    body = r.json()

    # by_level must contain ONLY L1 and L7
    levels_returned = {b["level"] for b in body["by_level"]}
    assert levels_returned == {1, 7}

    by_level = {b["level"]: b for b in body["by_level"]}
    assert by_level[1]["units"] == 5
    assert by_level[1]["rollen"] == 10
    assert by_level[7]["units"] == 2
    assert by_level[7]["rollen"] == 10

    # The L4 Klebeband row contributes to heatmap.count (the Auftrag was
    # completed) but its 3 units do NOT show up in any per-level slice.
    # Heatmap units use parsed.meta.totalUnits (10) which IS the full
    # snapshot — the level filter only affects level-keyed slices, not
    # the Auftrag-level heatmap. That matches the dashboard UX: the
    # heatmap shows "how busy was this day", the stack shows "for the
    # levels you're focused on".
    today_cell = body["heatmap"][-1]
    assert today_cell["count"] == 1
    assert today_cell["units"] == 10

    # daily_by_level + rollen_by_day today should only contain L1 + L7 keys
    today_iso = today_cell["date"]
    today_stack = next(d for d in body["daily_by_level"] if d["date"] == today_iso)
    today_keys = {int(k) for k in today_stack["values"].keys()}
    assert today_keys.issubset({1, 7})
    assert 4 not in today_keys


async def test_aggregates_kpi_rollups(client, user, as_user):
    """v2.4 KPIs — articles/units totals + productivity. No prices in the
    DB, so items_value_eur stays 0 and coverage_pct = 0. The shape and
    Σ-correctness are what matter here."""
    as_user(user)

    a1 = (await client.post("/api/auftraege", json=_payload(
        "kpi-a.docx",
        ("Thermorollen 80mm", 10, 2),  # L1
        ("Klebeband 50mm",     5, 1),  # L4
    ))).json()["id"]
    a2 = (await client.post("/api/auftraege", json=_payload(
        "kpi-b.docx",
        ("Tachorollen DTCO",   3, 4),  # L7
    ))).json()["id"]

    for aid in (a1, a2):
        await client.post(f"/api/auftraege/{aid}/start")
        await client.post(f"/api/auftraege/{aid}/complete")

    body = (await client.get("/api/reports/aggregates?days=30")).json()

    # 3 items total across both Aufträge.
    assert body["articles_total"] == 3
    # Σ units = 10+5+3 = 18.
    assert body["units_total"] == 18
    # No prices yet → value/coverage zero.
    assert body["items_value_eur"] == 0.0
    assert body["items_value_coverage_pct"] == 0.0
    # Productivity needs the test to span observable working time. Both
    # /start and /complete fire within the same second, so effective time
    # may be 0 — only assert it's a non-negative number.
    assert body["productivity_units_per_hour"] >= 0


async def test_aggregates_items_value_eur(client, user, as_user):
    """When a sku_dimensions row carries `price_per_einheit_eur` and an
    Auftrag item references the same FNSKU, the cost rolls up into
    `items_value_eur` AND the per-level `cost_eur` field."""
    from backend.database import AsyncSessionLocal
    from backend.orm import SkuDimension

    async with AsyncSessionLocal() as s:
        s.add(SkuDimension(
            fnskus=["X0FAKE1234"], skus=[], eans=[],
            title="EC Thermorollen 80mm test",
            length_cm=10, width_cm=10, height_cm=10, weight_kg=1.0,
            price_per_einheit_eur=7.5,
        ))
        await s.commit()

    as_user(user)
    a_id = (await client.post("/api/auftraege", json={
        "file_name": "priced.docx",
        "parsed": {
            "meta": {"sendungsnummer": "T-1", "totalUnits": 20},
            "pallets": [{
                "id": "P1",
                "items": [
                    {"title": "EC Thermorollen 80mm", "units": 20, "rollen": 5,
                     "fnsku": "X0FAKE1234"},
                ],
            }],
        },
    })).json()["id"]
    await client.post(f"/api/auftraege/{a_id}/start")
    await client.post(f"/api/auftraege/{a_id}/complete")

    body = (await client.get("/api/reports/aggregates?days=30")).json()

    # 20 units × 7.5 EUR = 150.00
    assert body["items_value_eur"] == 150.0
    # 1 of 1 items had a price.
    assert body["items_value_coverage_pct"] == 100.0
    # L1 Thermo bucket carries the cost.
    by_level = {b["level"]: b for b in body["by_level"]}
    assert by_level[1]["cost_eur"] == 150.0
    assert by_level[1]["units"] == 20
