"""History — completed Auftrag entries.

DELETE is admin-only — completed records are compliance/audit data.
Regular users can only read.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.deps import get_current_user, load_work_schedule, require_admin
from backend.orm import AuditLog, Auftrag, AuftragStatus, User
from backend.schemas import AuftragSummary, HistoryPage

router = APIRouter(prefix="/api/history", tags=["history"])


async def _name_lookup(
    db: AsyncSession, user_ids: set[UUID]
) -> dict[UUID, str]:
    if not user_ids:
        return {}
    rows = (
        await db.execute(select(User).where(User.id.in_(user_ids)))
    ).scalars().all()
    return {u.id: u.name for u in rows}


@router.get("", response_model=HistoryPage)
async def list_history(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    me: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    schedule = Depends(load_work_schedule),
):
    """Terminal Aufträge (completed + cancelled), newest first. Paginated."""
    base = select(Auftrag).where(
        Auftrag.status.in_([AuftragStatus.completed, AuftragStatus.cancelled])
    )

    total = (
        await db.execute(
            select(func.count()).select_from(base.subquery())
        )
    ).scalar_one()

    rows = (
        await db.execute(
            base.order_by(Auftrag.finished_at.desc())
            .limit(limit)
            .offset(offset)
        )
    ).scalars().all()

    name_map = await _name_lookup(
        db, {r.assigned_to_user_id for r in rows if r.assigned_to_user_id}
    )
    items = [
        AuftragSummary.from_orm_row(
            r,
            assigned_to_user_name=name_map.get(r.assigned_to_user_id),
            schedule=schedule,
        )
        for r in rows
    ]
    return HistoryPage(items=items, total=total, limit=limit, offset=offset)


@router.delete("/{auftrag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_history_entry(
    auftrag_id: UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    a = await db.get(Auftrag, auftrag_id)
    if a is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Auftrag not found")
    if a.status not in (AuftragStatus.completed, AuftragStatus.cancelled):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Not in history — status is {a.status.value}",
        )
    db.add(AuditLog(
        user_id=admin.id,
        auftrag_id=a.id,
        action="history_delete",
        meta={"file_name": a.file_name},
    ))
    await db.delete(a)
    await db.commit()
