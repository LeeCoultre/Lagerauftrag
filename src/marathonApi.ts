/* Fetch wrapper for the Marathon FastAPI backend.
 *
 * VITE_API_URL semantics (matches src/api.js):
 *   - Empty string  → same-origin (single-service Railway deploy)
 *   - http://...    → split deploy / local dev (e.g. http://127.0.0.1:8001)
 *
 * Auth: auto-injects `Authorization: Bearer <jwt>` from the active
 * Clerk session via `window.Clerk.session.getToken()`. Open endpoints
 * (e.g. /api/users) work without a session.
 *
 * Auto-converts top-level keys snake_case ↔ camelCase, but stops at
 * OPAQUE keys whose values are application-defined JSONB blobs
 * (parsed, validation, etc.) — their inner keys must be preserved as-is. */

import type {
  ActivityFeed,
  AdminAuditPage,
  AdminAuditQuery,
  AdminAuftraegePage,
  AdminAuftraegeQuery,
  AdminSkuDimensionsPage,
  AdminSkuDimensionsQuery,
  AdminStats,
  AdminUserDetail,
  AuditLogEntry,
  AuftragCreatePayload,
  AuftragDetail,
  AuftragReorderItem,
  AuftragSummary,
  HeartbeatResponse,
  HistoryPage,
  PalletReleaseBody,
  LynneAsinBatchPatch,
  LynneAsinGroup,
  LynneAsinRename,
  LynneCatalog,
  LynneProductCreate,
  LynneProductRead,
  LynneVariantPatch,
  ReportsAggregates,
  ReportsQuery,
  SearchQuery,
  SearchResults,
  ShiftInfo,
  SkuDimensionImportResult,
  SkuDimensionLookupResponse,
  SkuDimensionRead,
  SkuDimensionUpsert,
  UserListItem,
  UserResponse,
  UUID,
  UserRole,
  WorkflowAbortPayload,
  WorkflowProgressPatch,
  WorkSchedule,
  WorkSchedulePatchPayload,
  XlsxExportRange,
  XlsxExportResult,
} from './types/api';

interface ClerkLike {
  session?: { getToken: () => Promise<string | null> } | null;
}

declare global {
  interface Window {
    Clerk?: ClerkLike;
  }
}

const envUrl =
  typeof import.meta !== 'undefined' ? import.meta.env?.VITE_API_URL : undefined;
const BASE: string = envUrl ?? '';

/* Keys whose values are passed through unchanged.
   Inside `parsed`/`validation` the structure is owned by the parser, not the API. */
const OPAQUE = new Set<string>([
  'parsed', 'validation',
  'completed_keys', 'completedKeys',
  'copied_keys', 'copiedKeys',
  'pallet_timings', 'palletTimings',
  'meta',
  /* user_progress is keyed by user UUID. The OUTER map's keys are not
   * snake_case — leaving them opaque preserves them verbatim, but we
   * still want the INNER objects' keys (current_pallet_idx etc.) to
   * convert. The OPAQUE set short-circuits the recursion entirely, so
   * downstream consumers receive raw inner shapes. The beta Focus
   * screen handles this by reading both snake/camel variants. */
  'user_progress', 'userProgress',
]);

function snakeKeyToCamel(k: string): string {
  return k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}
function camelKeyToSnake(k: string): string {
  return k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

function convertKeys(obj: unknown, transform: (k: string) => string): unknown {
  if (Array.isArray(obj)) return obj.map((x) => convertKeys(x, transform));
  if (obj && typeof obj === 'object' && (obj as object).constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const newKey = transform(k);
      out[newKey] = OPAQUE.has(k) ? v : convertKeys(v, transform);
    }
    return out;
  }
  return obj;
}

const snakeToCamel = <T = unknown>(o: unknown): T => convertKeys(o, snakeKeyToCamel) as T;
const camelToSnake = (o: unknown): unknown => convertKeys(o, camelKeyToSnake);

export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown) {
    const msg =
      typeof detail === 'string'
        ? detail
        : ((detail as Array<{ msg?: string }> | null | undefined)?.[0]?.msg ?? `HTTP ${status}`);
    super(msg);
    this.status = status;
    this.detail = detail;
  }
}

async function getAuthToken(): Promise<string | null> {
  const session = typeof window !== 'undefined' ? window.Clerk?.session : null;
  if (!session) return null;
  try {
    return await session.getToken();
  } catch {
    return null;
  }
}

async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = await getAuthToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(camelToSnake(body)) : undefined,
  });

  if (res.status === 204) return null as T;

  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = (data as { detail?: unknown } | null)?.detail ?? data;
    throw new ApiError(res.status, detail);
  }
  return snakeToCamel<T>(data);
}

/* ─── Users ──────────────────────────────────────────── */
export const listUsers = (): Promise<UserListItem[]> => call('GET', '/api/users');
export const getMe     = (): Promise<UserResponse>   => call('GET', '/api/me');

/* ─── Auftraege ─────────────────────────────────────── */
export const listAuftraege = (): Promise<AuftragDetail[]>                        => call('GET', '/api/auftraege');
export const createAuftrag = (payload: AuftragCreatePayload): Promise<AuftragDetail> => call('POST', '/api/auftraege', payload);
export const getAuftrag    = (id: UUID): Promise<AuftragDetail>                  => call('GET',  `/api/auftraege/${id}`);
export const deleteAuftrag = (id: UUID): Promise<null>                           => call('DELETE', `/api/auftraege/${id}`);
export const reorderQueue  = (items: AuftragReorderItem[]): Promise<AuftragSummary[]> => call('PATCH', '/api/auftraege/reorder', items);

export const startAuftrag    = (id: UUID): Promise<AuftragDetail>                       => call('POST',  `/api/auftraege/${id}/start`);
export const updateProgress  = (id: UUID, p: WorkflowProgressPatch): Promise<AuftragDetail> => call('PATCH', `/api/auftraege/${id}/progress`, p);
export const completeAuftrag = (id: UUID): Promise<AuftragDetail>                       => call('POST',  `/api/auftraege/${id}/complete`);
export const cancelAuftrag   = (id: UUID): Promise<AuftragDetail>                       => call('POST',  `/api/auftraege/${id}/cancel`);
export const abortAuftrag    = (id: UUID, payload: WorkflowAbortPayload): Promise<AuftragDetail> => call('POST',  `/api/auftraege/${id}/abort`, payload);

/* ─── Multi-user session (beta) ──────────────────────
 * Beta Focus lets several workers share an in_progress Auftrag while
 * each pallet stays single-owner. `claimPallet` is race-safe — backend
 * uses a partial unique index, so a parallel claim from another worker
 * surfaces here as ApiError(409). `heartbeat` should be called every
 * 30 s while the caller holds at least one active claim; stale claims
 * (>5 min idle) become available for `takeoverPallet`. */
export const joinSession    = (id: UUID): Promise<AuftragDetail>                            => call('POST', `/api/auftraege/${id}/join`);
export const leaveSession   = (id: UUID): Promise<AuftragDetail>                            => call('POST', `/api/auftraege/${id}/leave`);
export const claimPallet    = (id: UUID, palletIdx: number): Promise<AuftragDetail>         => call('POST', `/api/auftraege/${id}/pallets/${palletIdx}/claim`);
export const releasePallet  = (id: UUID, palletIdx: number, completed = false): Promise<AuftragDetail> =>
  call('POST', `/api/auftraege/${id}/pallets/${palletIdx}/release`, { completed } as PalletReleaseBody);
export const takeoverPallet = (id: UUID, palletIdx: number): Promise<AuftragDetail>         => call('POST', `/api/auftraege/${id}/pallets/${palletIdx}/takeover`);
export const heartbeat      = (id: UUID): Promise<HeartbeatResponse>                        => call('POST', `/api/auftraege/${id}/heartbeat`);

/* ─── History ───────────────────────────────────────── */
export const getHistory = (limit = 50, offset = 0): Promise<HistoryPage> =>
  call('GET', `/api/history?limit=${limit}&offset=${offset}`);

export const deleteHistoryEntry = (id: UUID): Promise<null> =>
  call('DELETE', `/api/history/${id}`);

/* ─── Admin (require role=admin on backend) ───────── */
function qs(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

function camelParamsToSnake(params: Record<string, unknown>): Record<string, unknown> {
  const snake: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    snake[k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())] = v;
  }
  return snake;
}

export const adminListAuftraege = (params: AdminAuftraegeQuery = {}): Promise<AdminAuftraegePage> =>
  call('GET', `/api/admin/auftraege${qs(camelParamsToSnake(params as Record<string, unknown>))}`);

export const adminListUsers = (): Promise<AdminUserDetail[]> =>
  call('GET', '/api/admin/users');

export const adminChangeUserRole = (userId: UUID, role: UserRole): Promise<AdminUserDetail> =>
  call('PATCH', `/api/admin/users/${userId}/role`, { role });

export const adminListAudit = (params: AdminAuditQuery = {}): Promise<AdminAuditPage> =>
  call('GET', `/api/admin/audit${qs(params as Record<string, unknown>)}`);

export const adminGetStats = (): Promise<AdminStats> =>
  call('GET', '/api/admin/stats');

/* ─── Search / Activity / Exports (Phase 1) ───────────────────────── */

export const searchAuftraege = (params: SearchQuery): Promise<SearchResults> => {
  const snake: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    snake[k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())] = v;
  }
  return call('GET', `/api/search${qs(snake)}`);
};

export const getActivityLive = (limit = 50): Promise<ActivityFeed> =>
  call('GET', `/api/activity/live?limit=${limit}`);

export const getMyShift = (): Promise<ShiftInfo> =>
  call('GET', '/api/activity/shift');

/* ─── LYNNE catalog ─────────────────────────────────────────────────────
 * Standalone product catalog fed from Produktaufstellung_KWxx.xlsx
 * (sheet "Verkäufe") via `python -m backend.import_lynne`. Independent
 * of Marathon's operational tables — refresh by re-running the importer
 * with the new weekly xlsx. */
export const getLynneProducts = (): Promise<LynneCatalog> =>
  call('GET', '/api/lynne/products');

/* Admin CRUD for /api/lynne/admin/*. Each helper goes through `call()`
   so the JWT, snake↔camel conversion and error normalisation are
   identical to the rest of the surface. Use from TanStack Query
   mutations with optimistic updates against ['lynne-products']. */
export const adminCreateLynneProduct = (payload: LynneProductCreate): Promise<LynneProductRead> =>
  call('POST', '/api/lynne/admin/products', payload);

export const adminPatchLynneAsin = (asin: string, payload: LynneAsinBatchPatch): Promise<LynneAsinGroup> =>
  call('PATCH', `/api/lynne/admin/asins/${encodeURIComponent(asin)}`, payload);

export const adminPatchLynneProduct = (id: string, payload: LynneVariantPatch): Promise<LynneProductRead> =>
  call('PATCH', `/api/lynne/admin/products/${encodeURIComponent(id)}`, payload);

export const adminDeleteLynneProduct = (id: string): Promise<null> =>
  call('DELETE', `/api/lynne/admin/products/${encodeURIComponent(id)}`);

export const adminRenameLynneAsin = (asin: string, payload: LynneAsinRename): Promise<LynneAsinGroup> =>
  call('PATCH', `/api/lynne/admin/asins/${encodeURIComponent(asin)}/rename`, payload);

/* ─── Reports (Berichte analytics aggregates) ─────────────────────────
 * Backend aggregates parsed blobs over a lookback window (≤90 days) and
 * returns the 4 slices the analytics sections consume. Frontend treats
 * the response as immutable for `staleTime` purposes — values change
 * only when an Auftrag completes (~minutes), so 30s polling is plenty. */
export const getReportsAggregates = (params: ReportsQuery = {}): Promise<ReportsAggregates> => {
  const qsParams: Record<string, unknown> = {};
  if (params.days != null) qsParams.days = params.days;
  if (params.levels) qsParams.levels = params.levels;
  return call('GET', `/api/reports/aggregates${qs(qsParams)}`);
};

export const downloadAuftraegeXlsx = async ({ from, to }: XlsxExportRange = {}): Promise<XlsxExportResult> => {
  const params: Record<string, string> = {};
  if (from) params.from = from;
  if (to) params.to = to;
  const headers: Record<string, string> = {};
  const token = await getAuthToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api/exports/auftraege.xlsx${qs(params)}`, { headers });
  if (!res.ok) {
    const err: unknown = await res.json().catch(() => null);
    throw new ApiError(res.status, (err as { detail?: unknown } | null)?.detail ?? 'Export fehlgeschlagen');
  }
  const rowCount = parseInt(res.headers.get('X-Row-Count') || '0', 10);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const cd = res.headers.get('Content-Disposition') || '';
  const m = cd.match(/filename="?([^";]+)"?/);
  a.download = m ? m[1] : 'marathon-auftraege.xlsx';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return { ok: true, rowCount };
};

/* ─── Work schedule (warehouse hours + break + working days) ─────────
 * Read endpoint is auth-only — the live Focus timer + Historie expand
 * both depend on it. Write is admin-gated; Admin → Arbeitszeit is the
 * sole editor. Mutations invalidate ['workSchedule'] so every active
 * useWorkSchedule() consumer immediately picks up the new window. */
export const getWorkSchedule = (): Promise<WorkSchedule> =>
  call('GET', '/api/work-schedule');

export const adminUpdateWorkSchedule = (payload: WorkSchedulePatchPayload): Promise<WorkSchedule> =>
  call('PATCH', '/api/admin/work-schedule', payload);

/* ─── SKU Dimensions (lookup is auth, admin endpoints require role) ─── */

export const lookupSkuDimensions = async (keys: string[] = []): Promise<SkuDimensionLookupResponse> => {
  const clean = (keys || []).map((k) => k && String(k).trim()).filter(Boolean) as string[];
  if (clean.length === 0) return { lookups: {}, missing: [] };
  const q = clean.map((k) => `keys=${encodeURIComponent(k)}`).join('&');
  return call('GET', `/api/sku-dimensions/lookup?${q}`);
};

export const adminListSkuDimensions = (params: AdminSkuDimensionsQuery = {}): Promise<AdminSkuDimensionsPage> =>
  call('GET', `/api/admin/sku-dimensions${qs(camelParamsToSnake(params as Record<string, unknown>))}`);

export const adminCreateSkuDimension = (payload: SkuDimensionUpsert): Promise<SkuDimensionRead> =>
  call('POST', '/api/admin/sku-dimensions', payload);

export const adminUpdateSkuDimension = (id: number, payload: Partial<SkuDimensionUpsert>): Promise<SkuDimensionRead> =>
  call('PATCH', `/api/admin/sku-dimensions/${id}`, payload);

export const adminDeleteSkuDimension = (id: number): Promise<null> =>
  call('DELETE', `/api/admin/sku-dimensions/${id}`);

export const adminExportSkuDimensions = async (): Promise<{ ok: true }> => {
  const headers: Record<string, string> = {};
  const token = await getAuthToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api/admin/sku-dimensions/export`, { headers });
  if (!res.ok) {
    const err: unknown = await res.json().catch(() => null);
    throw new ApiError(res.status, (err as { detail?: unknown } | null)?.detail ?? 'Export fehlgeschlagen');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const cd = res.headers.get('Content-Disposition') || '';
  const m = cd.match(/filename="?([^";]+)"?/);
  a.download = m ? m[1] : `dimensions_export.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return { ok: true };
};

export const adminImportSkuDimensions = async (file: File): Promise<SkuDimensionImportResult> => {
  const fd = new FormData();
  fd.append('file', file);
  const headers: Record<string, string> = {};
  const token = await getAuthToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}/api/admin/sku-dimensions/import`, {
    method: 'POST',
    headers,
    body: fd,
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, (data as { detail?: unknown } | null)?.detail ?? data);
  return snakeToCamel<SkuDimensionImportResult>(data);
};
