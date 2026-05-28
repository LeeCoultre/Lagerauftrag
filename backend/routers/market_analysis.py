"""Marktanalyse — third-party Amazon search cache.

POST /api/market/search performs a cache-aware lookup:
  * normalise query (lowercase + collapse whitespace)
  * if a row exists in market_searches < 24h old → return cached
  * else hit the provider, persist, return

GET /api/market/searches lists recent searches for a "Letzte Suchen"
dropdown. All endpoints are gated by `get_current_user` (any signed-in
warehouse worker can use it — not admin-only).

Audit: every real provider hit writes an `AuditLog` row with action
`market_search_fetch` and meta `{query, marketplace, provider,
result_count, duration_ms, force_refresh}`. Cache hits do not.

Rate limit: each user can trigger at most one forceRefresh per 60s
(in-memory dict; good enough for 5 users — Redis swap is backlog).
"""
from __future__ import annotations

import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.deps import get_current_user
from backend.orm import AuditLog, MarketProduct, MarketSearch, User
from backend.schemas import (
    MarketProductRead,
    MarketSearchRead,
    MarketSearchRequest,
    MarketSearchSummary,
)
from backend.services.amazon_search import (
    AmazonSearchProvider,
    ProviderError,
    SearchResultDTO,
    get_amazon_provider,
)


router = APIRouter(prefix="/api/market", tags=["market"])


# Cache TTL — override per deploy via env if needed. Read each call so
# tests can monkeypatch without process restart.
def _cache_ttl_hours() -> int:
    import os
    try:
        return max(1, int(os.getenv("MARKET_CACHE_TTL_HOURS", "24")))
    except ValueError:
        return 24


# In-memory force-refresh throttle. {user_id: monotonic_ts_of_last_call}.
_FORCE_REFRESH_COOLDOWN_SEC = 60.0
_force_refresh_last: dict[Any, float] = {}


_WS_RE = re.compile(r"\s+")


def _normalize_query(q: str) -> str:
    return _WS_RE.sub(" ", q.strip().lower())


def _product_to_read(p: MarketProduct) -> MarketProductRead:
    return MarketProductRead(
        id=p.id,
        position=p.position,
        asin=p.asin,
        title=p.title,
        seller=p.seller,
        brand=p.brand,
        priceCents=p.price_cents,
        currency=p.currency,
        rating=float(p.rating) if p.rating is not None else None,
        reviewsCount=p.reviews_count,
        url=p.url,
        imageUrl=p.image_url,
        isPrime=p.is_prime,
        isSponsored=p.is_sponsored,
    )


def _search_to_read(
    search: MarketSearch,
    products: list[MarketProduct],
    *,
    from_cache: bool,
) -> MarketSearchRead:
    return MarketSearchRead(
        id=search.id,
        query=search.query,
        marketplace=search.marketplace,
        provider=search.provider,
        fetchedAt=search.fetched_at,
        resultCount=search.result_count,
        fromCache=from_cache,
        products=[_product_to_read(p) for p in products],
    )


async def _load_products(db: AsyncSession, search_id: Any) -> list[MarketProduct]:
    rows = (
        await db.execute(
            select(MarketProduct)
            .where(MarketProduct.search_id == search_id)
            .order_by(MarketProduct.position)
        )
    ).scalars().all()
    return list(rows)


async def _find_cached(
    db: AsyncSession, normalized_query: str, marketplace: str
) -> MarketSearch | None:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=_cache_ttl_hours())
    row = (
        await db.execute(
            select(MarketSearch)
            .where(
                MarketSearch.query == normalized_query,
                MarketSearch.marketplace == marketplace,
                MarketSearch.fetched_at > cutoff,
            )
            .order_by(MarketSearch.fetched_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return row


def _enforce_force_refresh_rate(user_id: Any) -> None:
    now = time.monotonic()
    last = _force_refresh_last.get(user_id)
    if last is not None and now - last < _FORCE_REFRESH_COOLDOWN_SEC:
        wait = int(_FORCE_REFRESH_COOLDOWN_SEC - (now - last))
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"Force-refresh rate-limited. Try again in {wait}s.",
        )
    _force_refresh_last[user_id] = now


@router.post("/search", response_model=MarketSearchRead)
async def search_market(
    payload: MarketSearchRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    provider: AmazonSearchProvider = Depends(get_amazon_provider),
) -> MarketSearchRead:
    """Cache-aware Amazon search. Marketplace is hard-coded to 'de' for
    now — extension point lives in `_DOMAIN_BY_MARKETPLACE`."""
    marketplace = "de"
    q = _normalize_query(payload.query)
    if not q:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "query is empty after normalization")

    if not payload.forceRefresh:
        cached = await _find_cached(db, q, marketplace)
        if cached is not None:
            products = await _load_products(db, cached.id)
            return _search_to_read(cached, products, from_cache=True)
    else:
        _enforce_force_refresh_rate(user.id)

    # Cache miss (or force) — call provider.
    try:
        result: SearchResultDTO = await provider.search(q, marketplace)
    except ProviderError as e:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            f"Market data provider unavailable: {e}",
        )

    search_row = MarketSearch(
        query=q,
        marketplace=marketplace,
        provider=getattr(provider, "name", "unknown"),
        result_count=len(result.products),
        duration_ms=result.duration_ms,
        raw_payload=result.raw,
        user_id=user.id,
    )
    db.add(search_row)
    await db.flush()  # populate search_row.id for FK below

    product_rows: list[MarketProduct] = []
    for p in result.products:
        product_rows.append(MarketProduct(
            search_id=search_row.id,
            position=p.position,
            asin=p.asin,
            title=p.title,
            seller=p.seller,
            brand=p.brand,
            price_cents=p.price_cents,
            currency=p.currency or "EUR",
            rating=p.rating,
            reviews_count=p.reviews_count,
            url=p.url,
            image_url=p.image_url,
            is_prime=p.is_prime,
            is_sponsored=p.is_sponsored,
        ))
    for pr in product_rows:
        db.add(pr)

    db.add(AuditLog(
        user_id=user.id,
        auftrag_id=None,
        action="market_search_fetch",
        meta={
            "query": q,
            "marketplace": marketplace,
            "provider": getattr(provider, "name", "unknown"),
            "result_count": len(result.products),
            "duration_ms": result.duration_ms,
            "force_refresh": bool(payload.forceRefresh),
        },
    ))
    await db.commit()
    await db.refresh(search_row)
    # Reload products in canonical (position-sorted) order — also confirms
    # the FK + cascade are wired up.
    products = await _load_products(db, search_row.id)
    return _search_to_read(search_row, products, from_cache=False)


@router.get("/searches", response_model=list[MarketSearchSummary])
async def list_recent_searches(
    limit: int = Query(20, ge=1, le=100),
    _user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[MarketSearchSummary]:
    rows = (
        await db.execute(
            select(MarketSearch)
            .order_by(MarketSearch.fetched_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    return [
        MarketSearchSummary(
            id=r.id,
            query=r.query,
            marketplace=r.marketplace,
            provider=r.provider,
            fetchedAt=r.fetched_at,
            resultCount=r.result_count,
        )
        for r in rows
    ]


@router.get("/searches/{search_id}", response_model=MarketSearchRead)
async def get_search(
    search_id: str,
    _user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MarketSearchRead:
    row = await db.get(MarketSearch, search_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Search not found")
    products = await _load_products(db, row.id)
    return _search_to_read(row, products, from_cache=True)
