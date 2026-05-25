# Marathon — Session handoff

Auto-loaded by Claude Code at session start. Keeps context tight so a
fresh session can pick up without re-discovering the codebase.

## What this is

**Marathon** — internal tool for the Lynne warehouse. A warehouse worker
loads a `.docx` Lagerauftrag, the app guides them through a 4-step
workflow (Upload → Pruefen → Focus → Abschluss), then archives the
result with timing data per pallet/article.

5 real users planned (LynneAndy is admin, three others get invited via
Clerk). Single-tenant, internal-only.

User communicates in Russian. App UI strings stay German. Code/comments
in English.

## Stack

```
Frontend: React 19 + Vite + TanStack Query + Clerk + recharts
Backend:  FastAPI + SQLAlchemy 2 (async) + asyncpg + Alembic + PyJWT
DB:       PostgreSQL 18 (Railway-hosted, single instance shared dev/prod)
Auth:     Clerk (magic-link / email code, invite-only, pk_test mode)
Deploy:   Railway, single-service Docker (Vite-built frontend served
          as static by FastAPI; same-origin in prod, so no CORS)
```

## Production

- **App:** https://lagerauftrag-production.up.railway.app/
- **GitHub:** https://github.com/LeeCoultre/pallet-optimizer
  - Active branch: `main` (all Marathon work lives here)
- **Railway:** project has 2 services — `Marathon` (Dockerfile build)
  and `Postgres` (managed). DATABASE_URL is reference-injected.
- **Clerk:** instance `trusted-spider-53.clerk.accounts.dev` (test mode)

## Local dev

```bash
# venv + deps (Python 3.9 system; Dockerfile uses 3.11 for prod)
.venv/bin/pip install -r backend/requirements.txt
npm install

# Run backend on :8001
.venv/bin/uvicorn backend.main:app --port 8001 --host 127.0.0.1

# Run frontend on :5176 (preview tool autostarts via .claude/launch.json)
npm run dev

# Tests (against Railway Postgres — see "Tests share prod DB" gotcha)
.venv/bin/pytest                    # full suite, ~5 min on Railway lag
.venv/bin/pytest backend/tests/test_admin.py -v   # one file
```

## Environment variables (.env, Railway service variables)

| Var | Where | Notes |
|---|---|---|
| `DATABASE_URL` | both | Postgres connection string |
| `VITE_CLERK_PUBLISHABLE_KEY` | both | Frontend reads at build (Vite); backend derives JWKS URL from it. **Must be in Dockerfile ARG** for Railway to pass at build time. |
| `CLERK_SECRET_KEY` | backend | Server → Clerk Backend API for user fetch. Rotate if leaked. |
| `INITIAL_ADMIN_EMAIL` | backend | First Clerk user with this email gets `role=admin` on lazy-create |
| `VITE_API_URL` | frontend dev only | Empty string in prod (same-origin). Local dev: `http://127.0.0.1:8001`. |
| `CORS_ALLOWED_ORIGINS` | backend (optional) | Defaults to localhost dev origins. Override comma-separated for split deploys. |

## Database

Schema versioned via Alembic. **Migrations live at `backend/alembic/versions/`.**

```bash
.venv/bin/alembic current                              # current rev
.venv/bin/alembic revision --autogenerate -m "..."    # create
.venv/bin/alembic upgrade head                         # apply
.venv/bin/python -m backend.seed                       # legacy seed (4 fake users) — rarely needed in Sprint 2+
```

Tables: `users`, `auftraege`, `audit_log`, `sku_dimensions`, `alembic_version`. See
[backend/orm.py](backend/orm.py) for schema. Hot details:
- `auftraege` is one row through the whole lifecycle
  (`queued → in_progress → completed`); we don't have separate queue/
  current/history tables.
- `audit_log.auftrag_id` is `ON DELETE SET NULL` so admin DELETE-history
  preserves the audit trail (file_name lives in `meta.file_name`).
- `users.clerk_id` (unique, indexed) maps to Clerk; `email` is unique
  too. INITIAL_ADMIN_EMAIL match drives the first admin promotion.
- `sku_dimensions` (added in ESKU v2) holds L×B×H + weight per Einheit,
  keyed by FNSKU OR SKU OR EAN (CHECK constraint enforces ≥1 key).
  Admins upload via xlsx through Admin → Dimensions; the ESKU
  distributor batch-fetches at Pruefen mount.

## Tests

Pytest with httpx ASGI transport. **30 cases, ~5 min on Railway** (network
latency dominates; same dataset for every test).

Auth in tests: not real JWTs. `as_user(user)` fixture flips
`app.dependency_overrides[get_current_user]` for the current test.

```bash
.venv/bin/pytest                                          # all
.venv/bin/pytest -k "race"                                # by name
.venv/bin/pytest backend/tests/test_admin.py::test_xxx -v # single
```

`pytest.ini` has `asyncio_default_fixture_loop_scope = session` —
without it, pytest-asyncio v1.2 binds the module-level engine to a
different loop than fixtures, every test errors with "different event
loop". Don't remove.

## Deployment (Railway, Dockerfile)

Single-service. `Dockerfile` builds Vite frontend in stage 1, copies
`dist/` into the FastAPI image in stage 2. The FastAPI app serves both
`/api/*` and the SPA static files at `/`.

**Vite env-var gotcha:** `VITE_*` env vars are baked into the bundle at
build time. Railway exposes service vars as `--build-arg`, but they
only become visible to `RUN npm run build` if the Dockerfile re-declares
them as `ARG ... ENV ...`. We learned this the hard way — see the
`fix(deploy): bake VITE_CLERK_PUBLISHABLE_KEY` commit.

Push to GitHub → Railway auto-deploys (3-5 min build).

## Auth (Clerk, invite-only)

Frontend: `<ClerkProvider publishableKey>` at the root. UserSwitcher
renders `<SignInButton mode="modal">` when signed out, `<UserButton/>`
+ name/role when signed in.

Backend: every request to `/api/me`, `/api/auftraege`, `/api/admin/*`
checks `Authorization: Bearer <jwt>`. JWT is verified against Clerk's
public JWKS via `PyJWKClient` (cached). On first request from a new
clerk_id, [`_provision_user()`](backend/deps.py) hits Clerk Backend API
to fetch profile + lazy-creates a `users` row. INITIAL_ADMIN_EMAIL match
sets role=admin.

Open endpoint: `GET /api/users` (no auth — used to be the picker; now
mostly vestigial, could be removed).

## Code map

```
backend/
  main.py              app + CORS + router includes + SPA static fallback
  database.py          async engine, AsyncSessionLocal, Base, get_db
  orm.py               SQLAlchemy models (users, auftraege, audit_log)
  schemas.py           Pydantic DTOs incl. Paginated[T] generic
  deps.py              get_current_user (Clerk JWT), require_admin, _provision_user
  clerk.py             JWT verify + Clerk Backend API client
  seed.py              legacy 4 Lynne fake users (rarely used)
  routers/
    auftraege.py       CRUD + workflow (start/progress/complete/cancel)
    history.py         GET/DELETE history (admin-only delete)
    users.py           GET /api/users (open) + GET /api/me (auth)
    admin.py           /api/admin/* — list, role toggle, audit, stats
    sku_dimensions.py  /api/sku-dimensions/lookup + /api/admin/sku-dimensions/* (xlsx import)
    packing.py         pre-existing CP-SAT solver (unrelated)
    xlsx_import.py     pre-existing
  alembic/             migrations
  tests/               pytest (30 cases)

src/
  main.jsx             ClerkProvider + QueryClientProvider mount; applyAccent() before render
  App.jsx              Router (workspace/historie/einstellungen/admin) + legacy localStorage cleanup
  state.jsx            useAppState() — TanStack Query backed; same return shape as the old localStorage version
  marathonApi.js       fetch wrapper, snake↔camel conversion (with OPAQUE keys), Clerk JWT injection
  index.css            CSS vars: --bg-*, --ink-*, --accent-*, --sidebar-width
  hooks/useMe.js       shared /api/me query
  components/
    AppShell.jsx       layout shell
    Sidebar.jsx        nav + queue (DnD reorder) + CurrentProgress + TodayStats + UserSwitcher;
                       collapse toggle writes 224↔64px to --sidebar-width
    UserSwitcher.jsx   Clerk SignedOut/SignedIn + identity row, collapsed-aware
    Logo.jsx           Mark (3-chevron icon, accent stroke = var(--accent)) + Wordmark
    ui.jsx             T tokens (T.accent.* → var(--accent-*)), Page/Topbar/Card/Kpi/Badge/Button/etc.
    LagerauftragParser.jsx   ⚠️ 433KB legacy, only imported from _archive
  screens/
    Upload.jsx, Pruefen.jsx, Focus.jsx, Abschluss.jsx
    Historie.jsx (lazy-fetches Detail per row for articles)
    Einstellungen.jsx (Akzentfarbe picker), Admin.jsx (4 tabs + recharts)
  utils/
    parseLagerauftrag.js  29KB, parses .docx text → {meta, pallets[]}
    auftragHelpers.js     sortPallets etc.
    accent.js             deriveAccent(hex) → 5 shades, applyAccent() writes to :root,
                          getStoredAccent/setStoredAccent (localStorage)
```

## Done so far

| Sprint | What |
|---|---|
| **1** | localStorage → PostgreSQL backend; CRUD + workflow endpoints; multi-user atomic Auftrag claim; pytest baseline (19 tests) |
| **1.5** | Bug: one user could claim multiple Auftraege; backend now 409s if caller has another in_progress |
| **2** | Clerk auth (magic-link, invite-only); lazy user provisioning; admin-only DELETE history; CORS tightening; full admin panel (4 tabs); pytest grew to 30 |
| **2.5 polish** | Pagination + sortable columns in admin; recharts KPI bar charts |
| **brand** | New 3-chevron logo on black square; themable accent palette (default `#FF5B1F`) — picker in Einstellungen, 5 shades derived at runtime via CSS vars in `:root`. (Pallet weight cap was removed here, but ESKU v2 reintroduced it as a SOFT 700 kg limit — see ESKU v2 row.) |
| **sidebar** | Collapse toggle 224↔64px (persisted, exposes `--sidebar-width`); CurrentProgress mini-stepper for active workflow; Quick-Start ▶ on hover; native HTML5 DnD reorder; "Heute: X fertig · Yh Zm" line. Build bumped to v2.1.0 |
| **historie fix** | Sprint 2 trimmed `/api/history` to Summary which broke the row-expand article list. Now expanding a row lazy-fetches Detail via `getAuftrag(id)` and flattens `parsed.pallets[].items` |
| **focus item-flow** | Sticky strip lists every item of the current pallet as numbered chips. Green = Artikel-Code copied; Red = not yet. Click jumps to item. Pallet transition (Artikel abschließen on last item / arrow-right across boundary) is **blocked** until every item on the current pallet is green |
| **ESKU v2** | Einzelne-SKU distribution rewritten per SOP v1.1: 6-level physical hierarchy (Thermorollen 1 → Tachorollen 6) replaces old `category`. Hard constraints H1-H4 (level order) + H7 (Single-SKU pallets via `pallet.hasFourSideWarning`). Sweet-Spot 85% scoring kept as tie-breaker on top of useItem/format/brand/FNSKU/level bonuses. Soft 700 kg / 1.59 m³ limits → OVERLOAD-W/-V flags (no block, surface in UI + sticky bar). Pruefen renders a vertical Stack-Pyramide per pallet with hover tooltips + score-breakdown popover for each placed ESKU. Real `L×B×H + Gewicht` from new `sku_dimensions` table (admin uploads `Dimensional_list.xlsx` via new "Dimensions" admin tab); falls back to heuristics when no row. 16 new backend tests. Build bumped to v2.2.0. |

## What's NOT done (backlog)

- **Sprint 3 — Quality** (deferred, not strictly necessary):
  - TypeScript migration (high risk for marginal gain at 5 users)
  - Sentry error tracking on prod (low risk, high value — easy win)
  - Real unit tests for `parseLagerauftrag.js` (currently zero coverage on
    the most complex 29 KB file in the repo)
  - PWA / offline mode (only if warehouse wifi is unreliable)
  - Code splitting (no current need — bundle is 942 KB acceptable)
- Delete dead `LagerauftragParser.jsx` (433 KB, only legacy archive
  imports it; Vite tree-shakes from build but bloats source)
- Invite the 3 other Lynne emails into Clerk allowlist
- Rotate `CLERK_SECRET_KEY` (was shared in chat during Sprint 2 setup)
- Fix git committer email (currently `thecoultre@Andys-MacBook-Air.local`,
  GitHub shows commits as unverified)
- Tests use the prod Postgres → fragile. Sprint 3+ should split to a
  separate test DB or schema.

## Theming via CSS vars (important for any new component)

`T.accent.*` and `--sidebar-width` are CSS vars, NOT JS string literals.
Components read them through `T` as before:

```jsx
<div style={{ background: T.accent.main }}>  // resolves to var(--accent)
```

Changing the value at runtime (color picker, sidebar collapse) just
calls `document.documentElement.style.setProperty(...)` — every existing
inline-style component re-paints automatically without React re-render.
This is why the chevron logo's accent stroke flips colour the moment
the user picks a new accent in Einstellungen.

⚠️ **Do not concatenate accent vars with alpha hex** —
`` `${T.accent.main}30` `` would produce `var(--accent)30` which is invalid
CSS. If you need an alpha tint, derive it via the helper:
`backgroundColor: T.accent.bg` (a tinted version of main) or use a
proper `rgba(...)` literal.

## Gotchas (real ones we hit)

1. **Vite cache after `npm install`** — new deps need
   `rm -rf node_modules/.vite` + restart, otherwise "Invalid hook call /
   different React copy" errors. Hit this for both `@tanstack/react-query`
   and `@clerk/clerk-react`.
2. **VITE_* not in prod bundle** — Dockerfile must `ARG VAR` then
   `ENV VAR=$VAR` before `RUN npm run build`. Otherwise Railway env vars
   stay invisible to the build. Symptom: blank prod page, console error
   "VITE_CLERK_PUBLISHABLE_KEY is not set".
3. **Tests share prod DB** — `clean_db` autouse TRUNCATEs before each
   test. After the suite, `wipe_test_users_after_suite` cascades through
   audit_log + auftraege FK before deleting *@test users. Real Clerk users
   (any non-`@test` email) survive.
4. **One user, multiple in_progress** — backend now refuses; frontend
   pre-checks via `current` to avoid the round-trip.
5. **zsh `$UID`** — built-in, can't use as a shell variable. Use `$U`
   or other name.
6. **Test instance Clerk** — `pk_test_*` works on any origin during
   development. For real prod with `pk_live_*` you'd need to add the
   prod URL to Clerk Dashboard → Domains.
7. **Two `flex: 1` in sidebar** — QueueSection has its own `flex: 1`
   internally; if you add another spacer with `flex: 1` they will split
   the space 50/50 instead of queue claiming all of it. Use the spacer
   only when QueueSection is hidden (collapsed mode).
8. **`getAuftrag(id)` for history rows** — `/api/history` returns
   Summary (no `parsed`), so anything that needs the article list inside
   the row (Historie expand, future export, etc.) must lazy-fetch via
   `getAuftrag(id)` with `staleTime: Infinity` (history rows are
   immutable).
9. **Focus copiedKeys is local-only** — keyed by `${palletIdx}|${itemIdx}`
   and lives in component state, NOT in DB. Reload resets it. If we ever
   want copy state to survive across sessions, sync it to backend (new
   column on `auftraege` or extend `completed_keys`).
10. **`category` field is dead in v2** — items still have `category` from
    `parseLagerauftrag.js` (line 253) for historical Aufträge in Historie,
    but ALL active code reads `level` via `getLevel(item)` /
    `getDisplayLevel(item)` from `auftragHelpers.js`. The legacy
    `LagerauftragParser.jsx` (433KB, archive-only) still uses category;
    don't touch it. ESKU placement scoring lives in
    `distributeEinzelneSku()` — same name as before but completely
    rewritten signature: now returns `{ byPalletId, unassigned, reasons,
    palletStates, overloadCount, noValidCount }`. `palletStates` is what
    `PalletStackViz` consumes for the vertical pyramid.
11. **ESKU dimensional data lookup is async** — Pruefen calls
    `enrichItemDims(items, lookupSkuDimensions)` via TanStack Query (key
    `['sku-dims', auftragId]`, staleTime 5min). Items WITHOUT a row in
    `sku_dimensions` fall back to `itemBoxVolCm3()` heuristics +
    `DEFAULT_KG_PER_CARTON=0.55`. The fallback is silent (no warning) —
    if a worker complains "the OVERLOAD-W flag is wrong", check first
    whether the SKU has a row via Admin → Dimensions.
12. **LYNNE catalog admin edits vs xlsx re-import** — `/api/lynne/admin/*`
    endpoints let admins inline-edit `lynne_products` rows (description,
    brand, perPallet, asin/sku rename, channel, ean, weekly_sales,
    graz_stock + dimensions in `sku_dimensions`) via the Edit-drawer in
    Katalog. **These edits are NOT persisted in the source xlsx — the
    next `python -m backend.import_lynne --source ...xlsx` will OVERWRITE
    them.** Workflow: either fix the upstream xlsx first, or coordinate
    with whoever runs the importer. Every mutation writes an `AuditLog`
    row (`action=lynne_product_create/update/delete/asin_rename/_asin_batch`)
    so changes are traceable.

## LYNNE admin endpoints (Sprint 4 — UI in EditAsinDrawer)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/lynne/admin/products` | LynneProductCreate | 409 if `<asin>__<sku>` exists |
| PATCH | `/api/lynne/admin/asins/{asin}` | LynneAsinBatchPatch | desc/brand/perPallet batch over all variants |
| PATCH | `/api/lynne/admin/products/{id}` | LynneVariantPatch | sku-rename → DELETE+INSERT (PK recompute) |
| DELETE | `/api/lynne/admin/products/{id}` | — | 404 if missing |
| PATCH | `/api/lynne/admin/asins/{asin}/rename` | `{newAsin}` | 409 if target ASIN already has rows |

All gated by `require_admin`. Frontend hides edit affordances unless
`useMe().data?.role === 'admin'`. Drawer rendered only in Katalog view
(Verkäufe stays read-only).

## Working with Claude in this repo

- Communicate in Russian; UI strings stay German; code in English
- The user prefers concise responses — long explanations only when
  they ask "why" or for trade-offs
- For destructive ops (push, force-push, delete), ask first
- For env vars / secrets: never coммит to git, always update both
  `.env` (local) AND Railway service variables (prod)
- Before starting code work, propose a short plan (3-5 bullets) and
  wait for "Идём" / "Делай"
- Before exploring large files, use `grep`/Agent — direct Read on a
  29 KB parser is wasteful
