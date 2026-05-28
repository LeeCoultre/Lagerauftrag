"""Marktanalyse cache router — backend tests.

Uses a `MockProvider` that records every call and lets each test
control how many results / what error to return. Real RainforestAPI
is never contacted from tests.
"""
from __future__ import annotations

from typing import Optional

import pytest
import pytest_asyncio
from sqlalchemy import select, func

from backend.database import AsyncSessionLocal
from backend.main import app
from backend.orm import AuditLog, MarketProduct, MarketSearch
from backend.routers import market_analysis as market_router
from backend.services.amazon_search import (
    ProductDTO,
    ProviderError,
    SearchResultDTO,
    get_amazon_provider,
)


# ─── Mock provider + fixture ──────────────────────────────────────────


class MockProvider:
    """Records every search() call. `next_result` / `next_error` decide
    what to return on the next call (defaults: 3 thermorollen products,
    no error)."""

    name = "mock"

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self.next_error: Optional[Exception] = None
        self.next_result: Optional[SearchResultDTO] = None

    async def search(self, query: str, marketplace: str) -> SearchResultDTO:
        self.calls.append((query, marketplace))
        if self.next_error is not None:
            err, self.next_error = self.next_error, None
            raise err
        if self.next_result is not None:
            r, self.next_result = self.next_result, None
            return r
        return _default_result()


def _default_result() -> SearchResultDTO:
    return SearchResultDTO(
        products=[
            ProductDTO(
                position=1, title="ETM Thermorollen 80x80 18m",
                url="https://amazon.de/dp/B001",
                asin="B001", seller="ETM GmbH", brand="ETM",
                price_cents=1990, currency="EUR",
                rating=4.5, reviews_count=2100,
                image_url="https://m.media-amazon.com/img1.jpg",
                is_prime=True, is_sponsored=False,
            ),
            ProductDTO(
                position=2, title="Thermorollen 57x40",
                url="https://amazon.de/dp/B002",
                asin="B002", seller=None, brand="GenericBrand",
                price_cents=890, currency="EUR",
                rating=4.1, reviews_count=550,
                is_prime=False, is_sponsored=True,
            ),
            ProductDTO(
                position=3, title="Thermal paper 80x70",
                url="https://amazon.de/dp/B003",
                asin="B003", seller="ThirdParty Trading",
                brand=None,
                # No price: provider sometimes omits "unavailable" listings.
                price_cents=None, currency="EUR",
                rating=None, reviews_count=None,
                is_prime=None, is_sponsored=False,
            ),
        ],
        raw={"source": "mock", "request_info": {"success": True}},
        duration_ms=42,
    )


@pytest_asyncio.fixture
async def mock_provider():
    mp = MockProvider()
    app.dependency_overrides[get_amazon_provider] = lambda: mp
    # Reset the in-memory force-refresh throttle so tests don't see
    # 429s from previous test runs in the same process.
    market_router._force_refresh_last.clear()
    yield mp
    app.dependency_overrides.pop(get_amazon_provider, None)


# ─── Tests ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cache_hit_within_ttl(client, user, as_user, mock_provider):
    """Second POST with the same query within TTL must not hit the provider."""
    as_user(user)

    r1 = await client.post("/api/market/search", json={"query": "thermorollen"})
    assert r1.status_code == 200, r1.text
    body1 = r1.json()
    assert body1["fromCache"] is False
    assert body1["resultCount"] == 3
    assert len(body1["products"]) == 3
    assert body1["products"][0]["asin"] == "B001"
    assert body1["products"][0]["priceCents"] == 1990
    assert body1["products"][0]["seller"] == "ETM GmbH"

    r2 = await client.post("/api/market/search", json={"query": "thermorollen"})
    assert r2.status_code == 200, r2.text
    body2 = r2.json()
    assert body2["fromCache"] is True
    assert body2["id"] == body1["id"]
    assert body2["resultCount"] == 3
    # Provider was called exactly once across the two requests.
    assert len(mock_provider.calls) == 1
    assert mock_provider.calls[0] == ("thermorollen", "de")

    # DB sanity: 1 MarketSearch row, 3 MarketProduct rows, 1 AuditLog row.
    async with AsyncSessionLocal() as s:
        n_searches = (await s.execute(select(func.count(MarketSearch.id)))).scalar_one()
        n_products = (await s.execute(select(func.count(MarketProduct.id)))).scalar_one()
        n_audit = (await s.execute(
            select(func.count(AuditLog.id)).where(AuditLog.action == "market_search_fetch")
        )).scalar_one()
    assert n_searches == 1
    assert n_products == 3
    assert n_audit == 1


@pytest.mark.asyncio
async def test_force_refresh_bypasses_cache(client, user, as_user, mock_provider):
    """forceRefresh=true must call the provider even with a fresh cache row."""
    as_user(user)

    r1 = await client.post("/api/market/search", json={"query": "thermorollen"})
    assert r1.status_code == 200
    assert r1.json()["fromCache"] is False

    # Disable the per-user rate-limit for this test.
    market_router._force_refresh_last.clear()

    r2 = await client.post(
        "/api/market/search",
        json={"query": "thermorollen", "forceRefresh": True},
    )
    assert r2.status_code == 200, r2.text
    body2 = r2.json()
    assert body2["fromCache"] is False
    assert len(mock_provider.calls) == 2

    # Two MarketSearch rows now, two AuditLog rows.
    async with AsyncSessionLocal() as s:
        n_searches = (await s.execute(select(func.count(MarketSearch.id)))).scalar_one()
        n_audit = (await s.execute(
            select(func.count(AuditLog.id)).where(AuditLog.action == "market_search_fetch")
        )).scalar_one()
    assert n_searches == 2
    assert n_audit == 2


@pytest.mark.asyncio
async def test_provider_failure_returns_503(client, user, as_user, mock_provider):
    """ProviderError from the upstream call surfaces as 503 with nothing
    persisted (transactional safety)."""
    as_user(user)
    mock_provider.next_error = ProviderError("upstream timeout")

    r = await client.post("/api/market/search", json={"query": "thermorollen"})
    assert r.status_code == 503, r.text
    assert "upstream timeout" in r.json()["detail"]

    async with AsyncSessionLocal() as s:
        n_searches = (await s.execute(select(func.count(MarketSearch.id)))).scalar_one()
        n_products = (await s.execute(select(func.count(MarketProduct.id)))).scalar_one()
        n_audit = (await s.execute(
            select(func.count(AuditLog.id)).where(AuditLog.action == "market_search_fetch")
        )).scalar_one()
    assert n_searches == 0
    assert n_products == 0
    assert n_audit == 0


@pytest.mark.asyncio
async def test_unauthenticated_returns_401(client):
    """Without a Bearer token (and ALLOW_ANONYMOUS off) → 401."""
    # Note: as_user is NOT called → get_current_user falls through to the
    # real Clerk verification path, which 401s on the missing header.
    r = await client.post("/api/market/search", json={"query": "thermorollen"})
    assert r.status_code == 401
