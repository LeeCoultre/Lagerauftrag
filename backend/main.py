import os
import time
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .database import get_db
from .routers import (
    activity,
    admin,
    auftraege,
    exports,
    history,
    lynne,
    packing,
    pallet_claims,
    reports,
    search,
    sku_dimensions,
    users,
    work_schedule,
    xlsx_import,
)


# ─── Production safety: refuse to start with ALLOW_ANONYMOUS on Railway ──
#
# ALLOW_ANONYMOUS=true is a local-dev convenience that binds requests
# without a Bearer token to a shared anonymous@local user. On Railway
# (or any other production-shaped environment) leaving it on means
# anyone on the internet can post/modify Aufträge — catastrophic.
#
# We detect prod via env vars Railway / Kubernetes / Heroku / Fly set
# automatically. The guard runs at import time so a misconfigured
# deploy fails fast at boot rather than silently leaking.
def _verify_anonymous_safety() -> None:
    if (os.getenv("ALLOW_ANONYMOUS") or "").strip().lower() != "true":
        return
    is_prod_signal = any(
        os.getenv(name)
        for name in (
            "RAILWAY_ENVIRONMENT",
            "RAILWAY_PROJECT_ID",
            "KUBERNETES_SERVICE_HOST",
            "DYNO",                  # Heroku
            "FLY_APP_NAME",          # Fly.io
        )
    )
    if is_prod_signal:
        raise SystemExit(
            "REFUSING TO START — ALLOW_ANONYMOUS=true detected in a "
            "production-shaped environment (Railway/K8s/Heroku/Fly). "
            "This would let any unauthenticated request act as the "
            "anonymous@local user. Unset ALLOW_ANONYMOUS in your "
            "service variables and redeploy.",
        )


_verify_anonymous_safety()

_BOOT_TS = time.time()
APP_VERSION = "2.4.0"

app = FastAPI(title="Pallet Loading Optimizer", version=APP_VERSION)

# Same-origin in prod (single-service Railway deploy) → CORS doesn't apply.
# Local dev runs Vite on 5176 + uvicorn on 8001, different origins, CORS needed.
# Override via CORS_ALLOWED_ORIGINS env var (comma-separated) for split deploys.
_default_origins = "http://localhost:5176,http://127.0.0.1:5176"
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("CORS_ALLOWED_ORIGINS", _default_origins).split(",")
    if o.strip()
]

# GZip responses ≥1 KB. Auftrag.parsed JSON is regularly 30-80 KB
# and compresses 8-10× — saves real bandwidth + latency on Railway.
# Order matters: GZip must come AFTER CORS so the gzipped body still
# gets the Access-Control headers attached.
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1024)

app.include_router(packing.router, prefix="/api", tags=["packing"])
app.include_router(xlsx_import.router, prefix="/api", tags=["import"])
app.include_router(auftraege.router)  # /api/auftraege
app.include_router(pallet_claims.router)  # /api/auftraege/{id}/join, .../pallets/{idx}/claim, ...
app.include_router(users.router)      # /api/users, /api/me
app.include_router(history.router)    # /api/history
app.include_router(admin.router)      # /api/admin/*
app.include_router(sku_dimensions.router)  # /api/sku-dimensions/*, /api/admin/sku-dimensions/*
app.include_router(search.router)     # /api/search
app.include_router(activity.router)   # /api/activity/live, /api/activity/shift
app.include_router(exports.router)    # /api/exports/auftraege.xlsx
app.include_router(reports.router)    # /api/reports/aggregates
app.include_router(lynne.router)      # /api/lynne/products
app.include_router(work_schedule.router)  # /api/work-schedule, /api/admin/work-schedule


@app.get("/health")
async def health():
    """Lightweight readiness probe — no DB hit. Used by Railway's
    health check; returns 200 as long as the process is alive. For a
    real diagnostic that checks DB connectivity, call /api/health."""
    return {"status": "ok"}


@app.get("/api/health")
async def api_health(db: AsyncSession = Depends(get_db)):
    """Diagnostic endpoint with DB ping + uptime + version. Pings the
    DB with a trivial SELECT 1 so a hung Postgres surfaces here even
    when the FastAPI process itself is fine. The DynamicIsland's
    connection probe + any external monitor can call this every 30s."""
    db_ok = False
    db_error = None
    try:
        await db.execute(text("SELECT 1"))
        db_ok = True
    except Exception as e:
        db_error = str(e)[:160]

    uptime = max(0, int(time.time() - _BOOT_TS))
    return {
        "status": "ok" if db_ok else "degraded",
        "db": "ok" if db_ok else "error",
        "db_error": db_error,
        "version": APP_VERSION,
        "uptime_sec": uptime,
        "anonymous_mode": (
            (os.getenv("ALLOW_ANONYMOUS") or "").strip().lower() == "true"
        ),
    }


# Serve built frontend if present (single-service deploy on Railway).
# In dev (no dist/) the frontend runs on Vite at :5176 and just hits /api here.
dist_dir = Path(__file__).resolve().parent.parent / "dist"
if dist_dir.exists():
    assets_dir = dist_dir / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    index_file = dist_dir / "index.html"

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        candidate = dist_dir / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(index_file)
