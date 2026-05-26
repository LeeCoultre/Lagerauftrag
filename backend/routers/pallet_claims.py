"""Multi-user session endpoints for Marathon Focus.

One Auftrag can be worked on by several users in parallel — but each
pallet is owned by exactly one user at any time. This router adds:

  * /join, /leave             — manage session_users membership
  * /pallets/{idx}/claim      — atomic ownership grab (partial unique idx)
  * /pallets/{idx}/release    — release (optionally with completed=true)
  * /pallets/{idx}/takeover   — force-takeover stale claim (>5 min)
  * /heartbeat                — bulk ping caller's active claims

The load-bearing concurrency primitive is the partial unique index
`uq_active_claim ON pallet_claims (auftrag_id, pallet_idx) WHERE
state='active'`. Two parallel INSERT ... ON CONFLICT DO NOTHING
collide: only one returns a row.

The frontend polls GET /api/auftraege/{id} every 2-3s — the response
already embeds session_users, user_progress, and pallet_claims so
participants see each other's progress without a dedicated endpoint.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import and_, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.deps import get_current_user, load_work_schedule
from backend.orm import (
    AuditLog,
    Auftrag,
    AuftragStatus,
    PalletClaim,
    PalletClaimState,
    User,
)
from backend.schemas import (
    AuftragDetail,
    HeartbeatResponse,
    PalletClaimDTO,
    PalletReleaseBody,
)
from backend.work_time import effective_seconds

router = APIRouter(prefix="/api/auftraege", tags=["session"])

# A pallet whose claim hasn't heartbeat'd within this window can be
# taken over by another user. 30s heartbeat from the client, 10x slack
# to absorb network blips, browser idle, mid-pallet bathroom break.
STALE_AFTER = timedelta(minutes=5)
# Hard cap on parallel workers per Auftrag. Matches the warehouse team
# size; prevents pathological clusters of 20 users trying to share one
# Auftrag (would flood the polling layer).
MAX_SESSION_USERS = 5


# ─── helpers ─────────────────────────────────────────────────────────


def _audit(
    db: AsyncSession,
    user_id: UUID,
    action: str,
    auftrag_id: Optional[UUID] = None,
    meta: Optional[dict] = None,
) -> None:
    db.add(AuditLog(
        user_id=user_id,
        auftrag_id=auftrag_id,
        action=action,
        meta=meta or {},
    ))


async def _load_claims(
    db: AsyncSession, auftrag_id: UUID
) -> list[PalletClaimDTO]:
    """Fetch all non-released claims for the Auftrag, joined with user name.

    `released` rows are dropped — they're history (one row per claim
    lifecycle) and the UI only cares about who currently owns / has
    completed each pallet."""
    q = (
        select(PalletClaim, User.name)
        .join(User, User.id == PalletClaim.user_id)
        .where(
            PalletClaim.auftrag_id == auftrag_id,
            PalletClaim.state != PalletClaimState.released,
            PalletClaim.state != PalletClaimState.taken_over,
        )
        .order_by(PalletClaim.pallet_idx.asc(), PalletClaim.claimed_at.asc())
    )
    rows = (await db.execute(q)).all()
    now = datetime.now(timezone.utc)
    out: list[PalletClaimDTO] = []
    for claim, name in rows:
        hb = claim.heartbeat_at
        if hb.tzinfo is None:
            hb = hb.replace(tzinfo=timezone.utc)
        is_stale = (
            claim.state == PalletClaimState.active
            and (now - hb) > STALE_AFTER
        )
        out.append(PalletClaimDTO(
            pallet_idx=claim.pallet_idx,
            user_id=claim.user_id,
            user_name=name,
            state=claim.state,
            claimed_at=claim.claimed_at,
            heartbeat_at=claim.heartbeat_at,
            released_at=claim.released_at,
            is_stale=is_stale,
        ))
    return out


async def _serialize(
    db: AsyncSession,
    auftrag: Auftrag,
    schedule,
) -> AuftragDetail:
    """Build the full AuftragDetail wire payload incl. claims + member names."""
    name = None
    if auftrag.assigned_to_user_id:
        u = await db.get(User, auftrag.assigned_to_user_id)
        name = u.name if u else None
    claims = await _load_claims(db, auftrag.id)
    return AuftragDetail.from_orm_row(
        auftrag,
        assigned_to_user_name=name,
        schedule=schedule,
        pallet_claims=claims,
    )


def _session_member_index(
    session_users: list[dict[str, Any]], user_id: UUID
) -> int:
    """Find the position of `user_id` in session_users; -1 if absent."""
    for i, entry in enumerate(session_users or []):
        try:
            if UUID(str(entry.get("user_id"))) == user_id:
                return i
        except Exception:
            continue
    return -1


async def _user_has_other_active_session(
    db: AsyncSession, user_id: UUID, except_id: UUID,
) -> bool:
    """True if the user is primary OR participant in another in_progress
    Auftrag besides `except_id`. Used by /start and /join to keep workers
    focused on one Auftrag at a time."""
    rows = (
        await db.execute(
            select(Auftrag.id, Auftrag.assigned_to_user_id, Auftrag.session_users)
            .where(
                Auftrag.status == AuftragStatus.in_progress,
                Auftrag.id != except_id,
            )
        )
    ).all()
    for aid, assigned, members in rows:
        if assigned == user_id:
            return True
        if _session_member_index(members or [], user_id) >= 0:
            return True
    return False


async def _check_auto_complete(
    db: AsyncSession, auftrag: Auftrag, schedule, actor_id: UUID,
) -> None:
    """Flip status → completed when every pallet of the Auftrag has a
    'completed' claim row. Idempotent — re-running on an already-completed
    Auftrag is a no-op."""
    if auftrag.status != AuftragStatus.in_progress:
        return
    parsed = auftrag.parsed or {}
    total = len(parsed.get("pallets") or [])
    if total <= 0:
        return
    done = await db.scalar(
        text("""
            SELECT count(DISTINCT pallet_idx) FROM pallet_claims
            WHERE auftrag_id = :a AND state = 'completed'
        """),
        {"a": auftrag.id},
    )
    if (done or 0) < total:
        return
    now = datetime.now(timezone.utc)
    auftrag.status = AuftragStatus.completed
    auftrag.finished_at = now
    if auftrag.started_at:
        auftrag.duration_sec = effective_seconds(
            auftrag.started_at, now, schedule,
        )
    _audit(
        db, auftrag.assigned_to_user_id or actor_id, "auto_complete",
        auftrag_id=auftrag.id,
        meta={"duration_sec": auftrag.duration_sec, "via": "session"},
    )


# ─── session membership ──────────────────────────────────────────────


@router.post("/{auftrag_id}/join", response_model=AuftragDetail)
async def join_session(
    auftrag_id: UUID,
    me: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    schedule = Depends(load_work_schedule),
):
    """Add the caller to the Auftrag's session_users array.

    Refuses when:
      * Auftrag is not in_progress
      * caller already has another active session (primary or participant)
      * session is full (≥5 members)

    Idempotent: joining when already a member returns the current state
    without mutating session_users (the heartbeat path keeps last_seen_at
    fresh)."""
    a = await db.get(Auftrag, auftrag_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Auftrag not found")
    if a.status != AuftragStatus.in_progress:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Cannot join — status is {a.status.value}",
        )

    members = list(a.session_users or [])
    existing_idx = _session_member_index(members, me.id)
    if existing_idx >= 0:
        # Already in — just bump last_seen_at, no membership change.
        members[existing_idx] = {
            **members[existing_idx],
            "last_seen_at": datetime.now(timezone.utc).isoformat(),
        }
        a.session_users = members
        await db.commit()
        await db.refresh(a)
        return await _serialize(db, a, schedule)

    if await _user_has_other_active_session(db, me.id, auftrag_id):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "You already have another Auftrag in progress — finish or leave it first.",
        )
    if len(members) >= MAX_SESSION_USERS:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Session is full ({MAX_SESSION_USERS} workers max).",
        )

    now = datetime.now(timezone.utc).isoformat()
    members.append({
        "user_id": str(me.id),
        "name": me.name,
        "role": "primary" if a.assigned_to_user_id == me.id else "participant",
        "joined_at": now,
        "last_seen_at": now,
    })
    a.session_users = members
    _audit(db, me.id, "session_join", auftrag_id=auftrag_id)
    await db.commit()
    await db.refresh(a)
    return await _serialize(db, a, schedule)


@router.post("/{auftrag_id}/leave", response_model=AuftragDetail)
async def leave_session(
    auftrag_id: UUID,
    me: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    schedule = Depends(load_work_schedule),
):
    """Remove caller from session_users and release all their active claims.

    Primary cannot leave while participants are still present (their
    Auftrag would be orphaned). Participants can leave freely; the
    released pallets become available for others to pick up."""
    a = await db.get(Auftrag, auftrag_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Auftrag not found")

    members = list(a.session_users or [])
    idx = _session_member_index(members, me.id)
    if idx < 0:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "You are not in this session",
        )

    is_primary = a.assigned_to_user_id == me.id
    other_members = [
        m for i, m in enumerate(members) if i != idx
    ]
    if is_primary and other_members:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Primary cannot leave while other workers are still in the session.",
        )

    # Release every active claim the user owns on this Auftrag.
    now = datetime.now(timezone.utc)
    await db.execute(
        update(PalletClaim)
        .where(
            PalletClaim.auftrag_id == auftrag_id,
            PalletClaim.user_id == me.id,
            PalletClaim.state == PalletClaimState.active,
        )
        .values(state=PalletClaimState.released, released_at=now)
    )
    a.session_users = other_members
    _audit(db, me.id, "session_leave", auftrag_id=auftrag_id)
    await db.commit()
    await db.refresh(a)
    return await _serialize(db, a, schedule)


# ─── pallet claim / release / takeover ───────────────────────────────


def _validate_pallet_idx(a: Auftrag, idx: int) -> None:
    pallets = (a.parsed or {}).get("pallets") or []
    if idx < 0 or idx >= len(pallets):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"pallet_idx {idx} out of range (0..{len(pallets) - 1})",
        )


async def _ensure_session_member(
    db: AsyncSession, a: Auftrag, me: User,
) -> None:
    """Auto-join the caller if they're not yet in session_users.

    Frontend always /join's before /claim, but the network flake case
    (claim arrives before join) shouldn't 403 the worker. Treats claim
    as implicit join. Capacity guard still applies."""
    if _session_member_index(a.session_users or [], me.id) >= 0:
        return
    if await _user_has_other_active_session(db, me.id, a.id):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "You already have another Auftrag in progress.",
        )
    members = list(a.session_users or [])
    if len(members) >= MAX_SESSION_USERS:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Session is full ({MAX_SESSION_USERS} workers max).",
        )
    now = datetime.now(timezone.utc).isoformat()
    members.append({
        "user_id": str(me.id),
        "name": me.name,
        "role": "primary" if a.assigned_to_user_id == me.id else "participant",
        "joined_at": now,
        "last_seen_at": now,
    })
    a.session_users = members


@router.post("/{auftrag_id}/pallets/{pallet_idx}/claim", response_model=AuftragDetail)
async def claim_pallet(
    auftrag_id: UUID,
    pallet_idx: int,
    me: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    schedule = Depends(load_work_schedule),
):
    """Atomically grab ownership of a single pallet.

    The race-safe primitive: INSERT ... ON CONFLICT DO NOTHING against
    the partial unique index `uq_active_claim`. Two parallel /claim
    calls for the same pallet collide; the loser sees `row is None`
    and gets a 409."""
    a = await db.get(Auftrag, auftrag_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Auftrag not found")
    if a.status != AuftragStatus.in_progress:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Cannot claim — status is {a.status.value}",
        )
    _validate_pallet_idx(a, pallet_idx)
    await _ensure_session_member(db, a, me)

    # Race-safe insert. The partial unique index `uq_active_claim` is
    # the conflict target — describing it via index_elements + index_where
    # makes the ON CONFLICT clause match precisely that index (not any
    # other unique constraint on the table).
    stmt = (
        pg_insert(PalletClaim)
        .values(
            auftrag_id=auftrag_id,
            pallet_idx=pallet_idx,
            user_id=me.id,
        )
        .on_conflict_do_nothing(
            index_elements=[PalletClaim.auftrag_id, PalletClaim.pallet_idx],
            index_where=text("state = 'active'"),
        )
        .returning(PalletClaim.id)
    )
    res = await db.execute(stmt)
    inserted_id = res.scalar_one_or_none()
    if inserted_id is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Pallet already claimed",
        )
    _audit(
        db, me.id, "pallet_claim", auftrag_id=auftrag_id,
        meta={"pallet_idx": pallet_idx},
    )
    await db.commit()
    await db.refresh(a)
    return await _serialize(db, a, schedule)


@router.post(
    "/{auftrag_id}/pallets/{pallet_idx}/release",
    response_model=AuftragDetail,
)
async def release_pallet(
    auftrag_id: UUID,
    pallet_idx: int,
    payload: PalletReleaseBody,
    me: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    schedule = Depends(load_work_schedule),
):
    """Release a pallet I own.

    `completed=true` flips the claim row to state='completed' so it
    counts toward auto-complete; `completed=false` just frees it (the
    pallet can be picked up by anyone, the caller forfeits progress)."""
    a = await db.get(Auftrag, auftrag_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Auftrag not found")

    new_state = (
        PalletClaimState.completed if payload.completed
        else PalletClaimState.released
    )
    now = datetime.now(timezone.utc)
    res = await db.execute(
        update(PalletClaim)
        .where(
            PalletClaim.auftrag_id == auftrag_id,
            PalletClaim.pallet_idx == pallet_idx,
            PalletClaim.user_id == me.id,
            PalletClaim.state == PalletClaimState.active,
        )
        .values(state=new_state, released_at=now)
        .returning(PalletClaim.id)
    )
    if res.scalar_one_or_none() is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "You don't own an active claim on this pallet",
        )
    _audit(
        db, me.id,
        "pallet_complete" if payload.completed else "pallet_release",
        auftrag_id=auftrag_id,
        meta={"pallet_idx": pallet_idx},
    )

    # Auto-complete check ONLY fires on completed-release (otherwise
    # a release-for-handoff would prematurely mark the whole Auftrag
    # done if it happens to be the last unclaimed pallet).
    if payload.completed:
        await _check_auto_complete(db, a, schedule, me.id)

    await db.commit()
    await db.refresh(a)
    return await _serialize(db, a, schedule)


@router.post(
    "/{auftrag_id}/pallets/{pallet_idx}/takeover",
    response_model=AuftragDetail,
)
async def takeover_pallet(
    auftrag_id: UUID,
    pallet_idx: int,
    me: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    schedule = Depends(load_work_schedule),
):
    """Force-takeover a stale active claim (>5 min without heartbeat).

    Two-step:
      1. UPDATE the existing active claim to state='taken_over' AND
         heartbeat_at < now - 5min (so if someone heartbeats between
         our /takeover and the update, this fails gracefully and we
         return 409).
      2. INSERT a fresh active claim for the caller.
    """
    a = await db.get(Auftrag, auftrag_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Auftrag not found")
    if a.status != AuftragStatus.in_progress:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Cannot takeover — status is {a.status.value}",
        )
    _validate_pallet_idx(a, pallet_idx)
    await _ensure_session_member(db, a, me)

    cutoff = datetime.now(timezone.utc) - STALE_AFTER
    res = await db.execute(
        update(PalletClaim)
        .where(
            PalletClaim.auftrag_id == auftrag_id,
            PalletClaim.pallet_idx == pallet_idx,
            PalletClaim.state == PalletClaimState.active,
            PalletClaim.heartbeat_at < cutoff,
            PalletClaim.user_id != me.id,
        )
        .values(
            state=PalletClaimState.taken_over,
            released_at=datetime.now(timezone.utc),
        )
        .returning(PalletClaim.user_id)
    )
    prev_owner = res.scalar_one_or_none()
    if prev_owner is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Pallet is not stale (or already taken over)",
        )

    # Copy the previous owner's copied_keys for this pallet so the new
    # owner doesn't have to re-scan items the previous worker already
    # processed. Without this, takeover means double-work.
    prev_progress = (a.user_progress or {}).get(str(prev_owner)) or {}
    prev_copied = prev_progress.get("copied_keys") or {}
    if prev_copied:
        my_progress = dict((a.user_progress or {}).get(str(me.id)) or {})
        merged = dict(my_progress.get("copied_keys") or {})
        merged.update(prev_copied)
        my_progress["copied_keys"] = merged
        new_user_progress = dict(a.user_progress or {})
        new_user_progress[str(me.id)] = my_progress
        a.user_progress = new_user_progress

    db.add(PalletClaim(
        auftrag_id=auftrag_id,
        pallet_idx=pallet_idx,
        user_id=me.id,
        state=PalletClaimState.active,
    ))
    _audit(
        db, me.id, "pallet_takeover", auftrag_id=auftrag_id,
        meta={"pallet_idx": pallet_idx, "from_user_id": str(prev_owner)},
    )
    await db.commit()
    await db.refresh(a)
    return await _serialize(db, a, schedule)


# ─── heartbeat ───────────────────────────────────────────────────────


@router.post("/{auftrag_id}/heartbeat", response_model=HeartbeatResponse)
async def heartbeat(
    auftrag_id: UUID,
    me: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Refresh heartbeat_at on every active claim the caller owns for
    this Auftrag. Cheap path — single UPDATE, no joins. Frontend pings
    every 30s while the worker has a claim."""
    res = await db.execute(
        update(PalletClaim)
        .where(
            PalletClaim.auftrag_id == auftrag_id,
            PalletClaim.user_id == me.id,
            PalletClaim.state == PalletClaimState.active,
        )
        .values(heartbeat_at=datetime.now(timezone.utc))
        .returning(PalletClaim.id)
    )
    updated = len(res.fetchall())

    # Also bump last_seen_at on the session_users entry so peers' UIs
    # can show "active 12s ago" without inferring it from pallet_claims.
    a = await db.get(Auftrag, auftrag_id)
    if a is not None:
        members = list(a.session_users or [])
        idx = _session_member_index(members, me.id)
        if idx >= 0:
            members[idx] = {
                **members[idx],
                "last_seen_at": datetime.now(timezone.utc).isoformat(),
            }
            a.session_users = members
    await db.commit()
    return HeartbeatResponse(updated=updated)
