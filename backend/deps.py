"""FastAPI dependencies — Clerk JWT auth.

The `Authorization: Bearer <jwt>` header is verified against Clerk's
public JWKS. On first request from a new user, a row is lazy-created
in our users table (Clerk owns the auth, we own the role + audit log).

INITIAL_ADMIN_EMAIL env var picks the bootstrap admin: the first user
to sign in with that email gets role='admin'. Everyone else starts as
'user'; flip them via the admin panel later.

ALLOW_ANONYMOUS=true   (LOCAL DEV ONLY, never set on Railway):
  Requests without a Bearer token are accepted and bound to a single
  shared "anonymous@local" user (lazy-created on first hit, role='user').
  Lets the warehouse team test the workflow before Clerk Sign-In is
  wired up, or after a session expires. Frontend mirrors via
  VITE_ALLOW_ANONYMOUS=true to keep the TanStack Query gates open.
"""

import os
from datetime import datetime, timezone
from typing import Optional

import jwt as pyjwt
from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.clerk import (
    display_name,
    fetch_clerk_user,
    primary_email,
    verify_jwt,
)
from backend.database import get_db
from backend.orm import User, UserRole

# Anonymous-mode constants — only consulted when ALLOW_ANONYMOUS=true.
ANON_CLERK_ID = "__anonymous_local__"
ANON_EMAIL    = "anonymous@local"
ANON_NAME     = "Anonymous (local dev)"


def _allow_anonymous() -> bool:
    """Read the env var afresh each call so test-suites can flip it
    via monkeypatch without restarting the app."""
    return (os.getenv("ALLOW_ANONYMOUS") or "").strip().lower() == "true"


async def _get_or_create_anonymous(db: AsyncSession) -> User:
    """Return the singleton anonymous-mode user, creating it on first hit.
    All anonymous requests share this row so audit logs / FKs stay sane."""
    user = (
        await db.execute(select(User).where(User.clerk_id == ANON_CLERK_ID))
    ).scalar_one_or_none()
    if user is not None:
        return user
    user = User(
        clerk_id=ANON_CLERK_ID,
        email=ANON_EMAIL,
        name=ANON_NAME,
        role=UserRole.user,
        last_login_at=datetime.now(timezone.utc),
    )
    db.add(user)
    try:
        await db.commit()
    except IntegrityError:
        # Race: a parallel request just created the same row. Pick up theirs.
        await db.rollback()
        user = (
            await db.execute(select(User).where(User.clerk_id == ANON_CLERK_ID))
        ).scalar_one()
    else:
        await db.refresh(user)
    return user


async def _provision_user(clerk_id: str, db: AsyncSession) -> User:
    """First-login lazy-create. Pulls email/name from Clerk Backend API
    once, stores them locally so subsequent requests don't roundtrip."""
    try:
        cu = await fetch_clerk_user(clerk_id)
    except Exception as e:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            f"Could not fetch Clerk user: {e}",
        )
    email = primary_email(cu)
    if not email:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Clerk user has no primary email"
        )
    name = display_name(cu)
    initial_admin = (os.getenv("INITIAL_ADMIN_EMAIL") or "").strip().lower()
    is_admin = email.lower() == initial_admin and bool(initial_admin)

    user = User(
        clerk_id=clerk_id,
        email=email,
        name=name,
        role=UserRole.admin if is_admin else UserRole.user,
        last_login_at=datetime.now(timezone.utc),
    )
    db.add(user)
    try:
        await db.commit()
    except IntegrityError:
        # Race: another request just created the same row. Pick up theirs.
        await db.rollback()
        user = (
            await db.execute(select(User).where(User.clerk_id == clerk_id))
        ).scalar_one()
    else:
        await db.refresh(user)
    return user


async def get_current_user(
    authorization: Optional[str] = Header(None),
    db: AsyncSession = Depends(get_db),
) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        # Local-dev fallback: when ALLOW_ANONYMOUS is on, a missing or
        # malformed Authorization header binds to the shared anonymous user.
        # An invalid (but Bearer-prefixed) token still fails below — we only
        # bypass the "no token at all" path, never the cryptography.
        if _allow_anonymous():
            return await _get_or_create_anonymous(db)
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Missing Bearer token"
        )
    token = authorization[len("Bearer "):]
    try:
        payload = verify_jwt(token)
    except pyjwt.InvalidTokenError as e:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, f"Invalid token: {e}"
        )

    clerk_id = payload.get("sub")
    if not clerk_id:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Token missing 'sub'"
        )

    user = (
        await db.execute(select(User).where(User.clerk_id == clerk_id))
    ).scalar_one_or_none()
    if user is None:
        user = await _provision_user(clerk_id, db)
    return user


async def require_admin(
    user: User = Depends(get_current_user),
) -> User:
    if user.role != UserRole.admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin only")
    return user


# Module-level cache for the "is the migration applied?" check. Set
# to False once we discover the work_schedule table is missing, so we
# stop probing the DB on every request (which would otherwise rollback
# the active txn and poison the rest of the request). A redeploy after
# `alembic upgrade head` resets this back to None.
_WORK_SCHEDULE_TABLE_EXISTS: Optional[bool] = None


async def _work_schedule_table_exists(db: AsyncSession) -> bool:
    global _WORK_SCHEDULE_TABLE_EXISTS
    if _WORK_SCHEDULE_TABLE_EXISTS is not None:
        return _WORK_SCHEDULE_TABLE_EXISTS
    from sqlalchemy import text
    row = await db.execute(text("SELECT to_regclass('public.work_schedule')"))
    exists = row.scalar_one() is not None
    _WORK_SCHEDULE_TABLE_EXISTS = exists
    return exists


def invalidate_work_schedule_table_check() -> None:
    """Force re-probing the table existence — call after a migration runs
    in the same process. Most deploys restart the container, which makes
    this a no-op."""
    global _WORK_SCHEDULE_TABLE_EXISTS
    _WORK_SCHEDULE_TABLE_EXISTS = None


async def load_work_schedule(
    db: AsyncSession = Depends(get_db),
):
    """FastAPI dep returning the active warehouse schedule.

    Reads the singleton row from `work_schedule` (id=1). Falls back to
    `DEFAULT_SCHEDULE` when the row is missing OR the table itself
    doesn't exist yet (pre-migration deploy state). The existence
    check is cached process-wide, so the hot path costs at most one
    `SELECT` per request — and zero once the table is confirmed present.
    """
    from zoneinfo import ZoneInfo
    from backend.orm import WorkSchedule as WorkScheduleRow
    from backend.work_time import DEFAULT_SCHEDULE, WorkSchedule as WorkScheduleCfg

    if not await _work_schedule_table_exists(db):
        return DEFAULT_SCHEDULE
    row = await db.get(WorkScheduleRow, 1)
    if row is None:
        return DEFAULT_SCHEDULE
    return WorkScheduleCfg(
        work_start=row.work_start,
        work_end=row.work_end,
        break_start=row.break_start,
        break_end=row.break_end,
        working_days=frozenset(row.working_days or [1, 2, 3, 4, 5]),
        tz=ZoneInfo(row.timezone_name or "Europe/Berlin"),
    )
