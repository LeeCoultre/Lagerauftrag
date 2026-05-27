"""Status-transition guards (409s for invalid actions on wrong state)."""

from .conftest import make_payload


async def test_start_completed_returns_409(client, admin, as_user):
    as_user(admin)
    r = await client.post("/api/auftraege", json=make_payload())
    a_id = r.json()["id"]
    await client.post(f"/api/auftraege/{a_id}/start")
    await client.post(f"/api/auftraege/{a_id}/complete")

    r = await client.post(f"/api/auftraege/{a_id}/start")
    assert r.status_code == 409
    assert "completed" in r.json()["detail"].lower()


async def test_start_nonexistent_returns_404(client, admin, as_user):
    as_user(admin)
    r = await client.post(
        "/api/auftraege/00000000-0000-0000-0000-000000000000/start"
    )
    assert r.status_code == 404


async def test_delete_in_progress_by_owner_succeeds(client, admin, as_user):
    """The assigned worker may permanently delete their in_progress Auftrag
    (Verlassen = wipe row + cascade pallet_claims). Audit log entries
    survive via ON DELETE SET NULL."""
    as_user(admin)
    r = await client.post("/api/auftraege", json=make_payload())
    a_id = r.json()["id"]
    await client.post(f"/api/auftraege/{a_id}/start")

    r = await client.delete(f"/api/auftraege/{a_id}")
    assert r.status_code == 204

    r = await client.get(f"/api/auftraege/{a_id}")
    assert r.status_code == 404


async def test_progress_on_queued_returns_409(client, admin, as_user):
    as_user(admin)
    r = await client.post("/api/auftraege", json=make_payload())
    a_id = r.json()["id"]

    r = await client.patch(
        f"/api/auftraege/{a_id}/progress", json={"step": "focus"}
    )
    assert r.status_code == 409


async def test_complete_queued_returns_409(client, admin, as_user):
    as_user(admin)
    r = await client.post("/api/auftraege", json=make_payload())
    a_id = r.json()["id"]

    r = await client.post(f"/api/auftraege/{a_id}/complete")
    assert r.status_code == 409


async def test_delete_history_nonexistent_returns_404(client, admin, as_user):
    as_user(admin)
    r = await client.delete(
        "/api/history/00000000-0000-0000-0000-000000000000"
    )
    assert r.status_code == 404
