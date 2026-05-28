"""External Amazon search providers for the Marktanalyse feature.

Abstraction layer over third-party Amazon scrapers (RainforestAPI today,
swappable for Apify / Keepa / PA-API later). The router never imports a
concrete provider — it depends on `get_amazon_provider`, which is
overridden in tests via `app.dependency_overrides` to inject a
deterministic mock.

Concrete `RainforestProvider` reads `RAINFOREST_API_KEY` lazily at first
call (not at import time) so the backend can still boot without the key
set — the endpoint then returns 503 instead of crashing the whole app.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from typing import Any, Optional, Protocol

import httpx


# ─── DTOs ─────────────────────────────────────────────────────────────


@dataclass
class ProductDTO:
    """Single product after provider-specific parsing."""
    position: int
    title: str
    url: str
    asin: Optional[str] = None
    seller: Optional[str] = None
    brand: Optional[str] = None
    price_cents: Optional[int] = None
    currency: str = "EUR"
    rating: Optional[float] = None
    reviews_count: Optional[int] = None
    image_url: Optional[str] = None
    is_prime: Optional[bool] = None
    is_sponsored: Optional[bool] = None


@dataclass
class SearchResultDTO:
    """Normalised response from any AmazonSearchProvider.

    `raw` is the verbatim provider payload — stored in
    market_searches.raw_payload for debug and future re-parsing.
    """
    products: list[ProductDTO]
    raw: dict[str, Any] = field(default_factory=dict)
    duration_ms: int = 0


class ProviderError(RuntimeError):
    """Raised when the upstream provider fails (network, bad config,
    quota, parse error). The router catches this and returns 503."""


class AmazonSearchProvider(Protocol):
    name: str

    async def search(self, query: str, marketplace: str) -> SearchResultDTO: ...


# ─── RainforestAPI provider ───────────────────────────────────────────


_RAINFOREST_BASE = "https://api.rainforestapi.com"
_DOMAIN_BY_MARKETPLACE = {
    "de": "amazon.de",
    "com": "amazon.com",
    "co.uk": "amazon.co.uk",
    "fr": "amazon.fr",
}


def _price_to_cents(price: Any) -> Optional[int]:
    """RainforestAPI's `price` is `{value: float, currency: str, ...}`.

    Some rows omit price (e.g. unavailable listings); those become None.
    """
    if not isinstance(price, dict):
        return None
    val = price.get("value")
    if not isinstance(val, (int, float)):
        return None
    return int(round(val * 100))


def _coerce_rating(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    # Clamp to schema range (Numeric(2,1) = 0.0–9.9 but ratings are 0.0–5.0).
    if f < 0 or f > 9.9:
        return None
    return round(f, 1)


class RainforestProvider:
    """Calls api.rainforestapi.com `type=search` for amazon.de.

    See https://app.rainforestapi.com/playground for the full response
    shape. We map only the fields used by the UI; everything else is
    preserved in `raw_payload` for future use.
    """
    name = "rainforest"

    def __init__(self, api_key: Optional[str] = None, *, timeout: float = 20.0) -> None:
        key = api_key if api_key is not None else os.getenv("RAINFOREST_API_KEY")
        if not key:
            raise ProviderError("RAINFOREST_API_KEY is not configured")
        self._api_key = key
        self._client = httpx.AsyncClient(base_url=_RAINFOREST_BASE, timeout=timeout)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def search(self, query: str, marketplace: str) -> SearchResultDTO:
        domain = _DOMAIN_BY_MARKETPLACE.get(marketplace, "amazon.de")
        params = {
            "api_key": self._api_key,
            "type": "search",
            "amazon_domain": domain,
            "search_term": query,
        }
        t0 = time.monotonic()
        try:
            r = await self._client.get("/request", params=params)
        except httpx.HTTPError as e:
            raise ProviderError(f"Rainforest network error: {e}") from e
        duration_ms = int((time.monotonic() - t0) * 1000)

        if r.status_code != 200:
            raise ProviderError(
                f"Rainforest returned HTTP {r.status_code}: {r.text[:200]}"
            )
        try:
            payload = r.json()
        except ValueError as e:
            raise ProviderError(f"Rainforest returned non-JSON: {e}") from e

        return SearchResultDTO(
            products=_parse_rainforest(payload, marketplace=marketplace, query=query),
            raw=payload,
            duration_ms=duration_ms,
        )


_AMAZON_DOMAIN_BY_MARKETPLACE = {"de": "amazon.de", "com": "amazon.com", "co.uk": "amazon.co.uk", "fr": "amazon.fr"}


def _extract_brand(title: str, query: Optional[str] = None) -> Optional[str]:
    """Heuristic brand extraction from an Amazon search title.

    Rainforest's `type=search` endpoint does not return brand/seller as
    structured fields (those live on the product-detail endpoint, which
    is one extra request per ASIN — prohibitively expensive at 16-70
    results). Workaround: take the first contiguous token of the title
    as the brand. Amazon's seller-driven listing convention puts the
    brand there in ~80% of cases ("Ec-Cash Thermorollen 57mm...",
    "THERMALKING Thermorollen 80mm...").

    Returns None if the token is too generic to be a brand: too short,
    purely numeric, a known stop-word, or just the search query echoed
    back (titles like "Thermorollen 80x80x12mm..." for query
    "thermorollen" — first word is the product category, not a brand).
    """
    if not title:
        return None
    first = title.split(maxsplit=1)[0].strip(",:;()[]")
    if len(first) < 3 or first.isdigit():
        return None
    lower = first.lower()
    if lower in {"the", "der", "die", "das", "neue", "neu", "pack"}:
        return None
    # Drop the query term itself (and its singular-stripped form) — the
    # title begins with the product category, brand is genuinely absent.
    if query:
        q = query.strip().lower().split()
        if q:
            q0 = q[0].rstrip("s")
            if lower.rstrip("s").startswith(q0):
                return None
    return first


def _canonical_amazon_url(asin: Optional[str], fallback: str, marketplace: str = "de") -> str:
    """Prefer /dp/<ASIN> over the sponsored /sspa/click?... redirect."""
    if asin and isinstance(asin, str):
        domain = _AMAZON_DOMAIN_BY_MARKETPLACE.get(marketplace, "amazon.de")
        return f"https://www.{domain}/dp/{asin}"
    return fallback


def _parse_rainforest(
    payload: dict[str, Any],
    marketplace: str = "de",
    query: Optional[str] = None,
) -> list[ProductDTO]:
    """Pull the search_results array out of a Rainforest payload."""
    results = payload.get("search_results") or []
    out: list[ProductDTO] = []
    for i, r in enumerate(results):
        if not isinstance(r, dict):
            continue
        title = r.get("title")
        raw_url = r.get("link")
        if not isinstance(title, str) or not isinstance(raw_url, str):
            continue
        asin = r.get("asin") if isinstance(r.get("asin"), str) else None
        rating = _coerce_rating(r.get("rating"))
        reviews = r.get("ratings_total")
        if not isinstance(reviews, int):
            reviews = None
        image = r.get("image")
        out.append(ProductDTO(
            position=int(r.get("position", i + 1)),
            title=title,
            url=_canonical_amazon_url(asin, raw_url, marketplace),
            asin=asin,
            seller=None,  # not exposed by Rainforest search endpoint
            brand=_extract_brand(title, query=query),
            price_cents=_price_to_cents(r.get("price")),
            currency=(r.get("price") or {}).get("currency", "EUR") if isinstance(r.get("price"), dict) else "EUR",
            rating=rating,
            reviews_count=reviews,
            image_url=image if isinstance(image, str) else None,
            is_prime=bool(r.get("is_prime")) if r.get("is_prime") is not None else None,
            is_sponsored=bool(r.get("sponsored")) if r.get("sponsored") is not None else None,
        ))
    return out


# ─── FastAPI dependency ───────────────────────────────────────────────


class _LazyRainforestProvider:
    """Wraps RainforestProvider so construction (env-var read) happens on
    first `.search()` call, not at dependency resolution.

    Why: FastAPI runs `Depends(get_amazon_provider)` BEFORE the endpoint
    body, so a missing RAINFOREST_API_KEY would surface as a 500 with a
    stack trace rather than the intended 503 the endpoint emits. With
    lazy construction the dependency always resolves; the `.search()`
    call raises `ProviderError` cleanly, the endpoint catches it.
    """
    name = "rainforest"

    def __init__(self) -> None:
        self._real: Optional[RainforestProvider] = None

    async def search(self, query: str, marketplace: str) -> SearchResultDTO:
        if self._real is None:
            self._real = RainforestProvider()  # may raise ProviderError
        return await self._real.search(query, marketplace)


_provider_singleton: Optional[AmazonSearchProvider] = None


def get_amazon_provider() -> AmazonSearchProvider:
    """Module-level singleton — one httpx.AsyncClient for the process.

    Tests override this via `app.dependency_overrides[get_amazon_provider]`
    to inject a mock without touching env vars.
    """
    global _provider_singleton
    if _provider_singleton is None:
        _provider_singleton = _LazyRainforestProvider()
    return _provider_singleton


def reset_amazon_provider() -> None:
    """Drop the cached singleton — used after env-var changes in tests
    or manual reloads."""
    global _provider_singleton
    _provider_singleton = None
