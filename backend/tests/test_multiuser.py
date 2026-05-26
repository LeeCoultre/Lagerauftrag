"""Multi-user Focus session — pallet_claims race, takeover, auto-complete."""

import asyncio
from datetime import datetime, timedelta, timezone

import pytest_asyncio
from sqlalchemy import text

from backend.database import AsyncSessionLocal, engine
from backend.deps import get_current_user
from backend.main import app
from backend.orm import User, UserRole

from .conftest import make_payload


def _multi_payload(file_name="multi.docx", pallet_count=3, items_per_pallet=2):
    """Build an AuftragCreate payload with N pallets, each with K items."""
    pallets = [
        {
            "id": f"P{i + 1}",
            "items": [
                {"sku": f"SKU-{i + 1}-{j + 1}"} for j in range(items_per_pallet)
            ],
        }
        for i in range(pallet_count)
    ]
    return make_payload(file_name=file_name, pallets=pallets)


async def _start_auftrag(client, primary, *, payload=None):
    """Upload as `primary` and atomically claim it; return Auftrag id."""
    app.dependency_overrides[get_current_user] = lambda: primary
    r = await client.post("/api/auftraege", json=payload or _multi_payload())
    a_id = r.json()["id"]
    r = await client.post(f"/api/auftraege/{a_id}/start")
    assert r.status_code == 200, r.text
    return a_id


@pytest_asyncio.fixture
async def user3():
    """Sixth-seat fixture for the session-capacity test (5 max)."""
    async with AsyncSessionLocal() as s:
        u = User(
            email="user3@test", name="TestUser3", role=UserRole.user,
            clerk_id="user_test_user3",
        )
        s.add(u)
        await s.commit()
        await s.refresh(u)
        return u


# ─── 1. atomic claim race ─────────────────────────────────────────────


async def test_two_users_race_claim_same_pallet(client, admin, user, as_user):
    """Two users hit /claim on the same pallet — exactly one 200, one 409."""
    a_id = await _start_auftrag(client, admin)

    as_user(user)
    await client.post(f"/api/auftraege/{a_id}/join")

    async def claim_as(u):
        app.dependency_overrides[get_current_user] = lambda: u
        return await client.post(f"/api/auftraege/{a_id}/pallets/1/claim")

    r1, r2 = await asyncio.gather(claim_as(admin), claim_as(user))
    statuses = sorted([r1.status_code, r2.status_code])
    assert statuses == [200, 409]

    # The DB should hold exactly one active claim row for (auftrag, 1).
    async with engine.begin() as conn:
        n = await conn.scalar(text(
            "SELECT count(*) FROM pallet_claims "
            "WHERE auftrag_id = :a AND pallet_idx = 1 AND state = 'active'"
        ), {"a": a_id})
    assert n == 1


# ─── 2. takeover only after stale ─────────────────────────────────────


async def test_takeover_only_after_stale(client, admin, user, as_user):
    """A fresh claim cannot be taken over; only one >5 min idle can."""
    a_id = await _start_auftrag(client, admin)

    as_user(admin)
    r = await client.post(f"/api/auftraege/{a_id}/pallets/0/claim")
    assert r.status_code == 200

    as_user(user)
    await client.post(f"/api/auftraege/{a_id}/join")
    # Immediate takeover → 409 (claim is fresh, not stale).
    r = await client.post(f"/api/auftraege/{a_id}/pallets/0/takeover")
    assert r.status_code == 409

    # Backdate admin's heartbeat by 6 min and retry.
    async with engine.begin() as conn:
        await conn.execute(text(
            "UPDATE pallet_claims SET heartbeat_at = now() - interval '6 minutes' "
            "WHERE auftrag_id = :a AND pallet_idx = 0 AND state = 'active'"
        ), {"a": a_id})

    r = await client.post(f"/api/auftraege/{a_id}/pallets/0/takeover")
    assert r.status_code == 200, r.text
    # admin's claim row is now state='taken_over'; user has a fresh active one.
    async with engine.begin() as conn:
        rows = (await conn.execute(text(
            "SELECT user_id, state FROM pallet_claims "
            "WHERE auftrag_id = :a AND pallet_idx = 0 ORDER BY claimed_at"
        ), {"a": a_id})).all()
    assert len(rows) == 2
    assert rows[0][1] == "taken_over"
    assert rows[1][1] == "active"
    assert str(rows[1][0]) == str(user.id)


async def test_self_takeover_refused(client, admin, as_user):
    """A user cannot takeover their own claim (would be a noop / bug)."""
    a_id = await _start_auftrag(client, admin)
    as_user(admin)
    await client.post(f"/api/auftraege/{a_id}/pallets/0/claim")
    async with engine.begin() as conn:
        await conn.execute(text(
            "UPDATE pallet_claims SET heartbeat_at = now() - interval '10 minutes' "
            "WHERE auftrag_id = :a AND pallet_idx = 0"
        ), {"a": a_id})
    r = await client.post(f"/api/auftraege/{a_id}/pallets/0/takeover")
    assert r.status_code == 409


# ─── 3. release semantics + auto-complete ─────────────────────────────


async def test_auto_complete_on_last_release(client, admin, user, as_user):
    """When the last pallet is released with completed=true → status flips."""
    payload = _multi_payload(pallet_count=2)
    a_id = await _start_auftrag(client, admin, payload=payload)

    # admin takes P0, user takes P1, both finish.
    as_user(admin)
    r = await client.post(f"/api/auftraege/{a_id}/pallets/0/claim")
    assert r.status_code == 200
    as_user(user)
    await client.post(f"/api/auftraege/{a_id}/join")
    r = await client.post(f"/api/auftraege/{a_id}/pallets/1/claim")
    assert r.status_code == 200

    as_user(admin)
    r = await client.post(
        f"/api/auftraege/{a_id}/pallets/0/release",
        json={"completed": True},
    )
    assert r.status_code == 200
    # After admin's release, status should still be in_progress (1/2 pallets done).
    assert r.json()["status"] == "in_progress"

    as_user(user)
    r = await client.post(
        f"/api/auftraege/{a_id}/pallets/1/release",
        json={"completed": True},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "completed", body
    assert body["finishedAt"] is not None or body.get("finished_at") is not None
    assert (body.get("durationSec") or body.get("duration_sec") or 0) >= 0


async def test_release_without_completed_does_not_auto_complete(
    client, admin, as_user,
):
    """Single-pallet release(completed=false) just frees the pallet."""
    payload = _multi_payload(pallet_count=1)
    a_id = await _start_auftrag(client, admin, payload=payload)
    as_user(admin)
    await client.post(f"/api/auftraege/{a_id}/pallets/0/claim")

    r = await client.post(
        f"/api/auftraege/{a_id}/pallets/0/release",
        json={"completed": False},
    )
    assert r.status_code == 200
    assert r.json()["status"] == "in_progress"

    # Re-claim should succeed (the released slot is open again).
    r = await client.post(f"/api/auftraege/{a_id}/pallets/0/claim")
    assert r.status_code == 200


# ─── 4. session membership + capacity ────────────────────────────────


async def test_join_rejects_busy_user(client, admin, user, as_user):
    """A user with another in_progress Auftrag cannot /join a second."""
    # admin starts A; user starts B; user tries to join A → 409.
    a_id_a = await _start_auftrag(client, admin)

    as_user(user)
    r = await client.post("/api/auftraege", json=make_payload("b.docx"))
    b_id = r.json()["id"]
    r = await client.post(f"/api/auftraege/{b_id}/start")
    assert r.status_code == 200

    r = await client.post(f"/api/auftraege/{a_id_a}/join")
    assert r.status_code == 409
    assert "another" in r.json()["detail"].lower()


async def test_session_capacity_five(
    client, admin, user, user2, user3, as_user,
):
    """Five members join successfully; the sixth gets 409."""
    a_id = await _start_auftrag(client, admin)

    # admin is implicit (primary). Add 4 more — fills to 5.
    extras: list[User] = []
    for i, email in enumerate(["a@test", "b@test", "c@test", "d@test"]):
        async with AsyncSessionLocal() as s:
            u = User(
                email=email, name=f"Extra{i}", role=UserRole.user,
                clerk_id=f"user_extra_{i}",
            )
            s.add(u)
            await s.commit()
            await s.refresh(u)
            extras.append(u)

    # admin /join's to register themselves in session_users.
    as_user(admin)
    await client.post(f"/api/auftraege/{a_id}/join")

    for u in extras:
        as_user(u)
        r = await client.post(f"/api/auftraege/{a_id}/join")
        assert r.status_code == 200, f"{u.email}: {r.text}"

    # 6th try → 409 capacity.
    as_user(user)  # fresh, has no active session
    r = await client.post(f"/api/auftraege/{a_id}/join")
    assert r.status_code == 409
    assert "full" in r.json()["detail"].lower()


async def test_primary_cannot_leave_with_participants(
    client, admin, user, as_user,
):
    """Primary leave is refused while a participant is still in session."""
    a_id = await _start_auftrag(client, admin)
    as_user(user)
    await client.post(f"/api/auftraege/{a_id}/join")

    as_user(admin)
    r = await client.post(f"/api/auftraege/{a_id}/leave")
    assert r.status_code == 409


async def test_participant_leave_releases_claims(
    client, admin, user, as_user,
):
    """When a participant leaves, all their active claims become released."""
    a_id = await _start_auftrag(client, admin)
    as_user(user)
    await client.post(f"/api/auftraege/{a_id}/join")
    r = await client.post(f"/api/auftraege/{a_id}/pallets/1/claim")
    assert r.status_code == 200

    r = await client.post(f"/api/auftraege/{a_id}/leave")
    assert r.status_code == 200

    async with engine.begin() as conn:
        states = (await conn.execute(text(
            "SELECT state FROM pallet_claims "
            "WHERE auftrag_id = :a AND user_id = :u"
        ), {"a": a_id, "u": user.id})).scalars().all()
    assert states == ["released"]


# ─── 5. heartbeat ─────────────────────────────────────────────────────


async def test_heartbeat_extends_claim(client, admin, as_user):
    """Heartbeat moves heartbeat_at forward; returns updated=1."""
    a_id = await _start_auftrag(client, admin)
    as_user(admin)
    await client.post(f"/api/auftraege/{a_id}/pallets/0/claim")

    # Backdate heartbeat to simulate elapsed time.
    async with engine.begin() as conn:
        before = await conn.scalar(text(
            "SELECT heartbeat_at FROM pallet_claims "
            "WHERE auftrag_id = :a AND pallet_idx = 0 AND state = 'active'"
        ), {"a": a_id})
        await conn.execute(text(
            "UPDATE pallet_claims SET heartbeat_at = now() - interval '30 seconds' "
            "WHERE auftrag_id = :a AND pallet_idx = 0"
        ), {"a": a_id})

    r = await client.post(f"/api/auftraege/{a_id}/heartbeat")
    assert r.status_code == 200
    assert r.json()["updated"] == 1

    async with engine.begin() as conn:
        after = await conn.scalar(text(
            "SELECT heartbeat_at FROM pallet_claims "
            "WHERE auftrag_id = :a AND pallet_idx = 0 AND state = 'active'"
        ), {"a": a_id})
    assert after > before


# ─── 6. validation ────────────────────────────────────────────────────


async def test_claim_out_of_range(client, admin, as_user):
    """pallet_idx beyond parsed.pallets length → 422."""
    payload = _multi_payload(pallet_count=2)
    a_id = await _start_auftrag(client, admin, payload=payload)
    as_user(admin)
    r = await client.post(f"/api/auftraege/{a_id}/pallets/99/claim")
    assert r.status_code == 422


async def test_release_not_owner(client, admin, user, as_user):
    """User trying to release someone else's claim → 403."""
    a_id = await _start_auftrag(client, admin)
    as_user(admin)
    await client.post(f"/api/auftraege/{a_id}/pallets/0/claim")

    as_user(user)
    await client.post(f"/api/auftraege/{a_id}/join")
    r = await client.post(
        f"/api/auftraege/{a_id}/pallets/0/release",
        json={"completed": True},
    )
    assert r.status_code == 403


# ─── 7. takeover copies copied_keys ───────────────────────────────────


async def test_takeover_copies_prev_owners_copied_keys(
    client, admin, user, as_user,
):
    """Takeover should merge previous owner's copied_keys to new owner."""
    a_id = await _start_auftrag(client, admin)

    # admin claims pallet 0 and writes copied_keys via /progress
    # (we'll write directly via SQL since /progress integration is step 3).
    as_user(admin)
    await client.post(f"/api/auftraege/{a_id}/pallets/0/claim")
    async with engine.begin() as conn:
        await conn.execute(text("""
            UPDATE auftraege
            SET user_progress = :up::jsonb,
                pallet_claims_dummy = pallet_claims_dummy
            WHERE id = :a
        """), {
            "a": a_id,
            "up": '{"' + str(admin.id) + '": {"copied_keys": {"P1|0|A": 1}}}',
        }) if False else await conn.execute(text("""
            UPDATE auftraege
            SET user_progress = :up::jsonb
            WHERE id = :a
        """), {
            "a": a_id,
            "up": '{"' + str(admin.id) + '": {"copied_keys": {"P1|0|A": 1}}}',
        })
        await conn.execute(text(
            "UPDATE pallet_claims SET heartbeat_at = now() - interval '6 minutes' "
            "WHERE auftrag_id = :a AND pallet_idx = 0"
        ), {"a": a_id})

    as_user(user)
    await client.post(f"/api/auftraege/{a_id}/join")
    r = await client.post(f"/api/auftraege/{a_id}/pallets/0/takeover")
    assert r.status_code == 200

    body = r.json()
    up = body.get("userProgress") or body.get("user_progress") or {}
    my_progress = up.get(str(user.id), {}) or {}
    copied = my_progress.get("copiedKeys") or my_progress.get("copied_keys") or {}
    assert "P1|0|A" in copied
