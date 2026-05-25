"""Shared pytest fixtures.

Tests run against the live Railway PostgreSQL via the same engine the
app uses. `clean_db` (autouse) TRUNCATEs every Marathon table before
each test, so order doesn't matter.

⚠️  SAFETY GUARD: because the test fixtures TRUNCATE the live database
the app reads, an accidental `pytest` invocation during work hours
would wipe a worker's in-progress Auftrag mid-flow. To prevent this
the suite refuses to run unless the operator has explicitly opted in
via `MARATHON_TESTS_OK_TO_WIPE_DB=yes`. Set it from the shell that
launches pytest, never bake it into a config that runs on save.

Auth: instead of issuing real Clerk JWTs, we override get_current_user
(and require_admin transitively) via FastAPI's dependency_overrides.
The `as_user(user)` fixture flips the active identity inside a single
test, so we can simulate "user A starts → user B tries to progress".
"""

import os
from urllib.parse import urlparse

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from backend.database import AsyncSessionLocal, engine
from backend.deps import get_current_user
from backend.main import app
from backend.orm import User, UserRole


def _looks_local(database_url: str) -> bool:
    """True if DATABASE_URL points at a host that cannot be the shared
    Railway Postgres — localhost / 127.0.0.1 / *.local, or an explicit
    *_test database name. CI runs against an ephemeral Postgres on
    localhost; the guard must not block it.
    """
    if not database_url:
        return False
    try:
        parsed = urlparse(database_url.replace("postgresql+asyncpg://", "postgresql://"))
    except ValueError:
        return False
    host = (parsed.hostname or "").lower()
    db_name = (parsed.path or "").lstrip("/").lower()
    if host in {"localhost", "127.0.0.1", "::1"} or host.endswith(".local"):
        return True
    if db_name.endswith("_test") or db_name.endswith("-test"):
        return True
    return False


def pytest_configure(config):
    """Refuse to start if the operator hasn't acknowledged that the
    suite TRUNCATEs the shared prod database before every test.

    Auto-bypass: CI / local ephemeral Postgres on localhost is safe.
    Manual bypass: `MARATHON_TESTS_OK_TO_WIPE_DB=yes pytest …`
    """
    if os.environ.get("MARATHON_TESTS_OK_TO_WIPE_DB") == "yes":
        return
    if _looks_local(os.environ.get("DATABASE_URL", "")):
        return
    pytest.exit(
        "\n\n"
        "  Tests are blocked: this suite runs against the SHARED prod\n"
        "  database and TRUNCATES every Marathon table before each test.\n"
        "  Running it during work hours wipes any in-progress Auftrag.\n\n"
        "  If you're sure no warehouse worker is mid-flow, opt in:\n\n"
        "    MARATHON_TESTS_OK_TO_WIPE_DB=yes .venv/bin/pytest\n\n",
        returncode=2,
    )


@pytest_asyncio.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest_asyncio.fixture(autouse=True)
async def clean_db():
    """Wipe every Marathon table before each test (RESTART IDENTITY + CASCADE)."""
    async with engine.begin() as conn:
        await conn.execute(text(
            "TRUNCATE audit_log, auftraege, users, sku_dimensions, lynne_products "
            "RESTART IDENTITY CASCADE"
        ))
    yield
    # Drop any auth overrides set during the test.
    app.dependency_overrides.pop(get_current_user, None)


@pytest_asyncio.fixture(scope="session", autouse=True)
async def wipe_test_users_after_suite():
    """We share the dev/prod Postgres with the running app, so the suite
    ends by pruning any *@test rows that might leak after the final
    test (clean_db only runs BEFORE each test).

    Cascade order matches FK directions:
      audit_log.user_id  → users.id  (NOT NULL, no ON DELETE)
      auftraege.created_by_user_id   → users.id (nullable)
      auftraege.assigned_to_user_id  → users.id (nullable)
    Real Clerk-provisioned users are untouched — their email is never *@test.
    """
    yield
    async with engine.begin() as conn:
        sub = "(SELECT id FROM users WHERE email LIKE '%@test')"
        await conn.execute(text(f"DELETE FROM audit_log WHERE user_id IN {sub}"))
        await conn.execute(text(
            f"DELETE FROM auftraege "
            f"WHERE created_by_user_id IN {sub} "
            f"OR assigned_to_user_id IN {sub}"
        ))
        await conn.execute(text("DELETE FROM users WHERE email LIKE '%@test'"))


@pytest_asyncio.fixture
async def admin():
    async with AsyncSessionLocal() as s:
        u = User(
            email="admin@test", name="TestAdmin", role=UserRole.admin,
            clerk_id="user_test_admin",
        )
        s.add(u)
        await s.commit()
        await s.refresh(u)
        return u


@pytest_asyncio.fixture
async def user():
    async with AsyncSessionLocal() as s:
        u = User(
            email="user@test", name="TestUser", role=UserRole.user,
            clerk_id="user_test_user1",
        )
        s.add(u)
        await s.commit()
        await s.refresh(u)
        return u


@pytest_asyncio.fixture
async def user2():
    async with AsyncSessionLocal() as s:
        u = User(
            email="user2@test", name="TestUser2", role=UserRole.user,
            clerk_id="user_test_user2",
        )
        s.add(u)
        await s.commit()
        await s.refresh(u)
        return u


@pytest_asyncio.fixture
def as_user():
    """Switch the authenticated identity for this test.

    Usage:
        async def test_x(client, admin, user, as_user):
            as_user(admin)
            await client.post(...)
            as_user(user)
            await client.patch(...)
    """
    def _set(u: User):
        app.dependency_overrides[get_current_user] = lambda: u
    return _set


def make_payload(file_name="t.docx", fba="T-1", pallets=None):
    """Build a minimal AuftragCreate payload."""
    if pallets is None:
        pallets = [{"id": "P1", "items": [{"sku": "A"}]}]
    return {
        "file_name": file_name,
        "parsed": {"meta": {"sendungsnummer": fba}, "pallets": pallets},
    }
