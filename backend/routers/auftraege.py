"""Marathon Auftrag CRUD + workflow endpoints.

Concurrency model: a row's lifecycle is queued → in_progress → completed.
The 'start' endpoint claims a queued row atomically via
UPDATE ... WHERE status='queued' RETURNING — only one user wins the race.
Subsequent workflow calls (progress / cancel / complete) verify
assigned_to_user_id matches the caller.

Audit log: start, complete, cancel, upload, delete are recorded.
"""

from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, text, update
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
    WorkflowStep,
)
from backend.routers.pallet_claims import (
    _check_auto_complete,
    _load_claims,
    _session_member_index,
    _user_has_other_active_session,
)
from backend.schemas import (
    AuftragCreate,
    AuftragDetail,
    AuftragReorderItem,
    AuftragSummary,
    WorkflowAbort,
    WorkflowProgress,
)
from backend.work_time import effective_seconds

router = APIRouter(prefix="/api/auftraege", tags=["auftraege"])


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


async def _name_lookup(
    db: AsyncSession, user_ids: set[UUID]
) -> dict[UUID, str]:
    if not user_ids:
        return {}
    rows = (
        await db.execute(select(User).where(User.id.in_(user_ids)))
    ).scalars().all()
    return {u.id: u.name for u in rows}


# ─── List + create ───────────────────────────────────────────────────

@router.get("", response_model=list[AuftragDetail])
async def list_auftraege(
    me: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    schedule = Depends(load_work_schedule),
):
    """Queue + every in_progress Auftrag (caller's own with full payload,
    others as peek-only for the "Beitreten" affordance in Warteschlange).

    The peek payload for not-mine rows carries only the fields the queue
    needs (summary counts, pallet_claims so the frontend knows how many
    pallets are free, session_users so it can hide the row if I'm
    already a member). parsed / raw_text / validation are stripped to
    keep the payload small (~30-80 KB savings per non-active row, which
    matters with 5-10 queued + a few active Aufträge in flight).

    Why every in_progress instead of just-mine: multi-user discovery.
    A second worker arriving at Warteschlange needs to SEE the active
    Auftrag to be able to click "Beitreten" → auto-claim a free pallet.
    Backend guards (/progress, /claim) ensure peek can't write anything.
    """
    member_token = [{"user_id": str(me.id)}]
    q = (
        select(Auftrag)
        .where(
            (Auftrag.status == AuftragStatus.queued)
            | (Auftrag.status == AuftragStatus.in_progress)
            | (Auftrag.status == AuftragStatus.error)
        )
        .order_by(
            Auftrag.queue_position.asc().nulls_last(),
            Auftrag.created_at.asc(),
        )
    )
    rows = (await db.execute(q)).scalars().all()
    name_map = await _name_lookup(
        db, {r.assigned_to_user_id for r in rows if r.assigned_to_user_id}
    )

    # Batch-load all pallet_claims for the in-progress rows in one query
    # so polling doesn't fan out to N round-trips.
    active_ids = [
        r.id for r in rows if r.status == AuftragStatus.in_progress
    ]
    claims_by_auftrag: dict[UUID, list] = {}
    for aid in active_ids:
        claims_by_auftrag[aid] = await _load_claims(db, aid)

    def _is_mine(r: Auftrag) -> bool:
        if r.status != AuftragStatus.in_progress:
            return True   # queued / error rows aren't "owned" — always slim-fine
        if r.assigned_to_user_id == me.id:
            return True
        for entry in (r.session_users or []):
            try:
                if str(entry.get("user_id")) == str(me.id):
                    return True
            except Exception:
                continue
        return False

    async def serialize(r: Auftrag) -> AuftragDetail:
        d = AuftragDetail.from_orm_row(
            r,
            assigned_to_user_name=name_map.get(r.assigned_to_user_id),
            schedule=schedule,
            pallet_claims=claims_by_auftrag.get(r.id, []),
        )
        # raw_text is the full docx body (10-30 KB / row) and never
        # rendered in any list view. Strip it to slim the payload while
        # keeping `parsed` available for caller's own active row —
        # Pruefen needs it the moment the worker clicks Start.
        d.raw_text = None
        # Peek-only for in_progress Aufträge that aren't mine: strip
        # parsed + validation so the not-yet-joined caller can't read
        # the docx contents but still sees enough to render a "Beitreten"
        # row (pallet_count from summary, palletClaims for free slots).
        if r.status == AuftragStatus.in_progress and not _is_mine(r):
            d.parsed = None
            d.validation = None
        return d

    return [await serialize(r) for r in rows]


@router.post("", response_model=AuftragDetail, status_code=status.HTTP_201_CREATED)
async def create_auftrag(
    payload: AuftragCreate,
    me: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    is_error = bool(payload.error_message)
    a = Auftrag(
        file_name=payload.file_name,
        raw_text=payload.raw_text,
        parsed=payload.parsed,
        validation=payload.validation,
        status=AuftragStatus.error if is_error else AuftragStatus.queued,
        error_message=payload.error_message,
        created_by_user_id=me.id,
    )
    db.add(a)
    await db.flush()  # populate a.id before audit insert
    _audit(db, me.id, "upload", auftrag_id=a.id, meta={"file_name": payload.file_name})
    await db.commit()
    await db.refresh(a)
    return AuftragDetail.from_orm_row(a, assigned_to_user_name=None)


# ─── Reorder (must come before /{auftrag_id} to avoid path collision) ──

@router.patch("/reorder", status_code=status.HTTP_204_NO_CONTENT)
async def reorder_queue(
    items: list[AuftragReorderItem],
    me: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Bulk update queue_position; only affects status=queued rows."""
    for item in items:
        await db.execute(
            update(Auftrag)
            .where(
                Auftrag.id == item.id,
                Auftrag.status == AuftragStatus.queued,
            )
            .values(queue_position=item.queue_position)
        )
    await db.commit()


# ─── Single — fetch / delete ─────────────────────────────────────────

@router.get("/{auftrag_id}", response_model=AuftragDetail)
async def get_auftrag(
    auftrag_id: UUID,
    me: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    schedule = Depends(load_work_schedule),
):
    a = await db.get(Auftrag, auftrag_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Auftrag not found")
    name = None
    if a.assigned_to_user_id:
        u = await db.get(User, a.assigned_to_user_id)
        name = u.name if u else None
    claims = (
        await _load_claims(db, auftrag_id)
        if a.status == AuftragStatus.in_progress
        else []
    )
    return AuftragDetail.from_orm_row(
        a, assigned_to_user_name=name, schedule=schedule, pallet_claims=claims,
    )


@router.delete("/{auftrag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_auftrag(
    auftrag_id: UUID,
    me: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    a = await db.get(Auftrag, auftrag_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Auftrag not found")
    if a.status not in (AuftragStatus.queued, AuftragStatus.error):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Cannot delete — status is {a.status.value}",
        )
    _audit(db, me.id, "delete", auftrag_id=a.id, meta={"file_name": a.file_name})
    await db.delete(a)
    await db.commit()


# ─── Workflow — start / progress / complete / cancel ─────────────────

@router.post("/{auftrag_id}/start", response_model=AuftragDetail)
async def start_auftrag(
    auftrag_id: UUID,
    me: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    schedule = Depends(load_work_schedule),
):
    """Atomic claim: succeeds only if status was 'queued' AND the caller
    has no other active session (primary or participant). One active task
    per user — without this guard the frontend's currentSrc=.find(...)
    hides extras and multi-user sessions could get tangled.

    Idempotent for primary: if the caller is already this Auftrag's
    primary and it's in_progress, treat the call as "fortsetzen" and
    return the current state instead of 409. This dodges a UI race —
    stale cache lets the worker click Start on an Auftrag that just
    transitioned, and we don't want to surface "Already taken" when
    they ARE the taker."""
    existing_pre = await db.get(Auftrag, auftrag_id)
    if (
        existing_pre is not None
        and existing_pre.status == AuftragStatus.in_progress
        and existing_pre.assigned_to_user_id == me.id
    ):
        claims = await _load_claims(db, auftrag_id)
        return AuftragDetail.from_orm_row(
            existing_pre, assigned_to_user_name=me.name,
            schedule=schedule, pallet_claims=claims,
        )

    if await _user_has_other_active_session(db, me.id, auftrag_id):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "You already have another Auftrag in progress — finish or cancel it first.",
        )

    now = datetime.now(timezone.utc)
    # Seed session_users with the primary so peers polling /api/auftraege
    # immediately see the session and can /join. Stored as JSON so
    # asyncpg encodes the dict into JSONB.
    primary_entry = [{
        "user_id": str(me.id),
        "name": me.name,
        "role": "primary",
        "joined_at": now.isoformat(),
        "last_seen_at": now.isoformat(),
    }]
    result = await db.execute(
        update(Auftrag)
        .where(
            Auftrag.id == auftrag_id,
            Auftrag.status == AuftragStatus.queued,
        )
        .values(
            status=AuftragStatus.in_progress,
            assigned_to_user_id=me.id,
            started_at=now,
            step=WorkflowStep.pruefen,
            current_pallet_idx=0,
            current_item_idx=0,
            session_users=primary_entry,
            user_progress={
                str(me.id): {
                    "current_pallet_idx": 0,
                    "current_item_idx": 0,
                    "copied_keys": {},
                }
            },
        )
        .returning(Auftrag)
    )
    row = result.scalar_one_or_none()
    if row is None:
        # Either 404 or someone got here first
        existing = await db.get(Auftrag, auftrag_id)
        if existing is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Auftrag not found")
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Already taken — status is {existing.status.value}",
        )
    _audit(db, me.id, "start", auftrag_id=auftrag_id)
    await db.commit()
    await db.refresh(row)
    return AuftragDetail.from_orm_row(
        row, assigned_to_user_name=me.name, schedule=schedule, pallet_claims=[],
    )


@router.patch("/{auftrag_id}/progress", response_model=AuftragDetail)
async def update_progress(
    auftrag_id: UUID,
    payload: WorkflowProgress,
    me: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    schedule = Depends(load_work_schedule),
):
    """Workflow progress write — supports both classic single-user and
    multi-user Focus sessions.

    Authorization:
      * Primary (assigned_to_user_id) can always write.
      * Participants must be in session_users.

    completed_keys guard:
      * In multi-user, completed_keys is keyed by `pallet.id|item_idx|key`.
        We resolve pallet.id → pallet_idx and verify the caller owns an
        active claim for every touched pallet. Missing claim → 403.
      * Classic single-user: primary writes whatever; no claim needed.
        On first /progress with completed_keys we auto-insert active
        claims for the touched pallets so multi-user invariants hold.
      * Server merges incoming keys into the existing dict instead of
        overwriting — under multi-user, two workers' writes don't clobber
        each other.
    """
    a = await db.get(Auftrag, auftrag_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Auftrag not found")
    if a.status != AuftragStatus.in_progress:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"Status is {a.status.value}"
        )

    is_primary = a.assigned_to_user_id == me.id
    is_member = _session_member_index(a.session_users or [], me.id) >= 0
    if not (is_primary or is_member):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your Auftrag")

    # ── completed_keys: resolve owned pallets + guard + merge ─────────
    if payload.completed_keys is not None:
        parsed = a.parsed or {}
        pallets = parsed.get("pallets") or []
        pid_to_idx = {
            str(p.get("id")): i
            for i, p in enumerate(pallets)
            if p.get("id") is not None
        }
        touched_idxs: set[int] = set()
        for key in payload.completed_keys.keys():
            # key shape: "<palletId>|<itemIdx>|<code>"
            head = str(key).split("|", 1)[0]
            if head in pid_to_idx:
                touched_idxs.add(pid_to_idx[head])

        # Which pallets does the caller already actively own?
        owned_rows = await db.execute(
            select(PalletClaim.pallet_idx).where(
                PalletClaim.auftrag_id == auftrag_id,
                PalletClaim.user_id == me.id,
                PalletClaim.state == PalletClaimState.active,
            )
        )
        owned_idxs = {r[0] for r in owned_rows}
        needs_claim = touched_idxs - owned_idxs

        if needs_claim:
            if is_primary:
                # Backward-compat path: classic frontend (single-user)
                # doesn't call /claim. Quietly insert active claims for
                # primary so multi-user invariants stay coherent.
                for idx in needs_claim:
                    await db.execute(
                        pg_insert(PalletClaim)
                        .values(
                            auftrag_id=auftrag_id,
                            pallet_idx=idx,
                            user_id=me.id,
                        )
                        .on_conflict_do_nothing(
                            index_elements=[
                                PalletClaim.auftrag_id, PalletClaim.pallet_idx,
                            ],
                            index_where=text("state = 'active'"),
                        )
                    )
            else:
                raise HTTPException(
                    status.HTTP_403_FORBIDDEN,
                    "You don't own all pallets in this progress update",
                )

        # Merge instead of overwrite. Keys touched by THIS write win;
        # keys other workers already set are preserved.
        merged = dict(a.completed_keys or {})
        merged.update(payload.completed_keys)
        a.completed_keys = merged

    # ── per-user cursor + copied_keys (multi-user-safe) ───────────────
    user_progress = dict(a.user_progress or {})
    my_entry = dict(user_progress.get(str(me.id)) or {})
    touched_user_progress = False
    if payload.current_pallet_idx is not None:
        my_entry["current_pallet_idx"] = payload.current_pallet_idx
        touched_user_progress = True
    if payload.current_item_idx is not None:
        my_entry["current_item_idx"] = payload.current_item_idx
        touched_user_progress = True
    if payload.copied_keys is not None:
        # Merge per-user copied chips (each user only sees their own).
        existing = dict(my_entry.get("copied_keys") or {})
        existing.update(payload.copied_keys)
        my_entry["copied_keys"] = existing
        touched_user_progress = True
    if touched_user_progress:
        user_progress[str(me.id)] = my_entry
        a.user_progress = user_progress

    # ── primary-only fields: workflow step + top-level cursors ────────
    # These are still column-level for classic backward-compat. The
    # primary owns them; participants writing them is a no-op.
    if is_primary:
        if payload.step is not None:
            a.step = payload.step
        if payload.current_pallet_idx is not None:
            a.current_pallet_idx = payload.current_pallet_idx
        if payload.current_item_idx is not None:
            a.current_item_idx = payload.current_item_idx
        if payload.pallet_timings is not None:
            # pallet_timings is shared (one start/finish per pallet,
            # whoever finished it wrote it). Merge same as completed_keys.
            merged_t = dict(a.pallet_timings or {})
            merged_t.update(payload.pallet_timings)
            a.pallet_timings = merged_t

    await db.commit()
    await db.refresh(a)
    name = me.name if is_primary else None
    if not is_primary and a.assigned_to_user_id:
        primary = await db.get(User, a.assigned_to_user_id)
        name = primary.name if primary else None
    claims = await _load_claims(db, auftrag_id)
    return AuftragDetail.from_orm_row(
        a, assigned_to_user_name=name, schedule=schedule, pallet_claims=claims,
    )


@router.post("/{auftrag_id}/complete", response_model=AuftragDetail)
async def complete_auftrag(
    auftrag_id: UUID,
    me: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    schedule = Depends(load_work_schedule),
):
    """Explicit primary-driven completion. Kept as a fallback alongside
    the auto-complete trigger in /pallets/{idx}/release (which is the
    happy path for both classic and multi-user). Useful when the primary
    needs to close an Auftrag with pallets that can't be completed
    naturally (e.g. stock-out)."""
    a = await db.get(Auftrag, auftrag_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Auftrag not found")
    if a.status != AuftragStatus.in_progress:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"Status is {a.status.value}"
        )
    if a.assigned_to_user_id != me.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your Auftrag")

    now = datetime.now(timezone.utc)
    a.status = AuftragStatus.completed
    a.finished_at = now
    if a.started_at:
        # duration_sec is the EFFECTIVE working duration — seconds spent
        # inside [work_start, work_end] of the warehouse, minus lunch.
        # Non-working hours (nights, weekends, break) are excluded so
        # KPIs and exports reflect actual hands-on time, not wall clock.
        a.duration_sec = effective_seconds(a.started_at, now, schedule)

    # Close out any active claims (e.g. primary completed early while a
    # participant still held a pallet — that pallet is now also done).
    await db.execute(
        update(PalletClaim)
        .where(
            PalletClaim.auftrag_id == auftrag_id,
            PalletClaim.state == PalletClaimState.active,
        )
        .values(state=PalletClaimState.completed, released_at=now)
    )

    _audit(
        db, me.id, "complete", auftrag_id=auftrag_id,
        meta={"duration_sec": a.duration_sec},
    )
    await db.commit()
    await db.refresh(a)
    return AuftragDetail.from_orm_row(
        a, assigned_to_user_name=me.name, schedule=schedule, pallet_claims=[],
    )


async def _other_active_claim_count(db: AsyncSession, auftrag_id: UUID, me_id: UUID) -> int:
    """How many active claims on this Auftrag are held by users other than me."""
    n = await db.scalar(
        select(text("count(*)"))
        .select_from(PalletClaim.__table__)
        .where(
            PalletClaim.auftrag_id == auftrag_id,
            PalletClaim.state == PalletClaimState.active,
            PalletClaim.user_id != me_id,
        )
    )
    return int(n or 0)


@router.post("/{auftrag_id}/cancel", response_model=AuftragDetail)
async def cancel_auftrag(
    auftrag_id: UUID,
    me: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    schedule = Depends(load_work_schedule),
):
    """Release in_progress Auftrag back to the queue.

    Refused if other workers still hold active claims — cancelling would
    yank the rug out from under them. The primary has to coordinate
    (admin escalation path lives elsewhere)."""
    a = await db.get(Auftrag, auftrag_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Auftrag not found")
    if a.status != AuftragStatus.in_progress:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"Status is {a.status.value}"
        )
    if a.assigned_to_user_id != me.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your Auftrag")
    if await _other_active_claim_count(db, auftrag_id, me.id) > 0:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Other workers still have active pallets — wait or coordinate.",
        )

    # Wipe all claim rows so the requeued Auftrag starts fresh.
    await db.execute(
        PalletClaim.__table__.delete().where(
            PalletClaim.auftrag_id == auftrag_id,
        )
    )
    a.status = AuftragStatus.queued
    a.assigned_to_user_id = None
    a.started_at = None
    a.step = None
    a.current_pallet_idx = None
    a.current_item_idx = None
    a.completed_keys = {}
    a.pallet_timings = {}
    a.session_users = []
    a.user_progress = {}

    _audit(db, me.id, "cancel", auftrag_id=auftrag_id)
    await db.commit()
    await db.refresh(a)
    return AuftragDetail.from_orm_row(
        a, assigned_to_user_name=None, schedule=schedule, pallet_claims=[],
    )


@router.post("/{auftrag_id}/abort", response_model=AuftragDetail)
async def abort_auftrag(
    auftrag_id: UUID,
    payload: WorkflowAbort,
    me: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    schedule = Depends(load_work_schedule),
):
    """Terminal cancel ("Stornieren"). Unlike /cancel (which recycles
    the Auftrag back to queued), this marks it `cancelled` so it lands
    in Historie with the Storniert badge + red border, carrying the
    flagged-article reasons in parsed.cancellation."""
    a = await db.get(Auftrag, auftrag_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Auftrag not found")
    if a.status != AuftragStatus.in_progress:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"Status is {a.status.value}"
        )
    if a.assigned_to_user_id != me.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your Auftrag")
    if await _other_active_claim_count(db, auftrag_id, me.id) > 0:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Other workers still have active pallets — wait or coordinate.",
        )

    now = datetime.now(timezone.utc)
    items_clean = [
        {
            "palletId": it.pallet_id,
            "itemIdx": it.item_idx,
            "code": it.code,
            "title": it.title,
            "reason": (it.reason or "").strip() or None,
        }
        for it in payload.items
    ]
    cancellation = {
        "items": items_clean,
        "note": (payload.note or "").strip() or None,
        "at": now.isoformat(),
        "by": {"id": str(me.id), "name": me.name},
    }
    # parsed is JSONB; preserve everything the parser wrote and append
    # the cancellation block. Re-assign the dict (not in-place mutate)
    # so SQLAlchemy flags the column dirty.
    parsed = dict(a.parsed or {})
    parsed["cancellation"] = cancellation
    a.parsed = parsed

    a.status = AuftragStatus.cancelled
    a.finished_at = now
    if a.started_at:
        a.duration_sec = effective_seconds(a.started_at, now, schedule)

    # Close out claims on storno too — Auftrag is now in a terminal state.
    await db.execute(
        update(PalletClaim)
        .where(
            PalletClaim.auftrag_id == auftrag_id,
            PalletClaim.state == PalletClaimState.active,
        )
        .values(state=PalletClaimState.released, released_at=now)
    )

    _audit(
        db, me.id, "abort", auftrag_id=auftrag_id,
        meta={
            "items": items_clean,
            "note": cancellation["note"],
        },
    )
    await db.commit()
    await db.refresh(a)
    return AuftragDetail.from_orm_row(
        a, assigned_to_user_name=me.name, schedule=schedule, pallet_claims=[],
    )
