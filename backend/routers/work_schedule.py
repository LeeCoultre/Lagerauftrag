"""Warehouse working-schedule endpoints.

Single-row config (work_schedule.id=1). Drives `effective_seconds`
everywhere — `/complete` of an Auftrag, per-pallet timings in
AuftragDetail, and the live Focus timer on the frontend.

  GET  /api/work-schedule          — any signed-in user (cached 1h client-side)
  PATCH /api/admin/work-schedule   — admin-only, audited
"""

from __future__ import annotations

from datetime import datetime, time as time_t, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.deps import _work_schedule_table_exists, get_current_user, require_admin
from backend.orm import AuditLog, User, WorkSchedule
from backend.schemas import WorkScheduleRead, WorkSchedulePatch

router = APIRouter(prefix="/api", tags=["work_schedule"])


def _default_payload() -> dict[str, Any]:
    """Wire-format default — used both as the seeded row and as the GET
    fallback when the table is missing (pre-migration deploy state)."""
    return {
        "work_start": time_t(7, 0),
        "work_end": time_t(15, 30),
        "break_start": time_t(12, 0),
        "break_end": time_t(12, 30),
        "working_days": [1, 2, 3, 4, 5],
        "timezone_name": "Europe/Berlin",
        "updated_at": datetime.now(timezone.utc),
        "updated_by_user_id": None,
    }


async def _get_or_create(db: AsyncSession) -> Optional[WorkSchedule]:
    """Return the singleton row, seeding the migration default if it
    happens to be missing. Returns None when the table itself doesn't
    exist yet (migration not applied) — callers decide how to respond."""
    if not await _work_schedule_table_exists(db):
        return None
    row = await db.get(WorkSchedule, 1)
    if row is not None:
        return row
    row = WorkSchedule(id=1, **{k: v for k, v in _default_payload().items()
                                if k not in {"updated_at", "updated_by_user_id"}})
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


@router.get("/work-schedule", response_model=WorkScheduleRead)
async def get_work_schedule(
    _: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create(db)
    if row is None:
        # Pre-migration fallback — surface the defaults so the frontend
        # timer + Pause chip still have a coherent schedule to apply.
        return WorkScheduleRead.model_validate(_default_payload())
    return WorkScheduleRead.model_validate(row)


@router.patch("/admin/work-schedule", response_model=WorkScheduleRead)
async def update_work_schedule(
    payload: WorkSchedulePatch,
    me: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create(db)
    if row is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Work schedule table missing — apply pending migration first.",
        )
    before: dict[str, Any] = {
        "work_start": row.work_start.isoformat(),
        "work_end": row.work_end.isoformat(),
        "break_start": row.break_start.isoformat(),
        "break_end": row.break_end.isoformat(),
        "working_days": list(row.working_days or []),
        "timezone_name": row.timezone_name,
    }

    if payload.work_start is not None:
        row.work_start = payload.work_start
    if payload.work_end is not None:
        row.work_end = payload.work_end
    if payload.break_start is not None:
        row.break_start = payload.break_start
    if payload.break_end is not None:
        row.break_end = payload.break_end
    if payload.working_days is not None:
        days = sorted({int(d) for d in payload.working_days})
        if not days or any(d < 1 or d > 7 for d in days):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "working_days must be a non-empty subset of 1..7 (ISO Mon=1)",
            )
        row.working_days = days
    if payload.timezone_name is not None:
        # Validate by attempting to construct a ZoneInfo.
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
        try:
            ZoneInfo(payload.timezone_name)
        except ZoneInfoNotFoundError:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"Unknown timezone: {payload.timezone_name}",
            )
        row.timezone_name = payload.timezone_name

    # CHECK constraint will reject out-of-order windows, but a clearer
    # 422 helps the form surface the error inline.
    if not (row.work_start < row.break_start < row.break_end < row.work_end):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Order violation: work_start < break_start < break_end < work_end",
        )

    row.updated_by_user_id = me.id

    after: dict[str, Any] = {
        "work_start": row.work_start.isoformat(),
        "work_end": row.work_end.isoformat(),
        "break_start": row.break_start.isoformat(),
        "break_end": row.break_end.isoformat(),
        "working_days": list(row.working_days),
        "timezone_name": row.timezone_name,
    }
    db.add(AuditLog(
        user_id=me.id,
        action="work_schedule_update",
        meta={"before": before, "after": after},
    ))
    await db.commit()
    await db.refresh(row)
    return WorkScheduleRead.model_validate(row)
