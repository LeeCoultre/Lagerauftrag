/* Wire-format types for the Marathon FastAPI backend.
 *
 * Mirrors backend/schemas.py — but in camelCase, since marathonApi.ts
 * auto-converts top-level keys snake↔camel on the way in/out. The
 * OPAQUE fields (parsed, validation, completedKeys, palletTimings,
 * meta) are passed through unchanged: their inner keys stay as the
 * parser/backend wrote them. */

export type UUID = string;
export type ISODateString = string;

/* ─── Enums ──────────────────────────────────────────── */

export type UserRole = 'admin' | 'user';
export type AuftragStatus = 'queued' | 'in_progress' | 'completed' | 'error' | 'cancelled';
export type WorkflowStep = 'upload' | 'pruefen' | 'focus' | 'abschluss';

/* ─── Parser shapes (OPAQUE — owned by parseLagerauftrag.js) ── */

export type ParsedFormat = 'standard' | 'schilder' | 'unknown';

export interface ParsedItem {
  sku: string;
  title: string;
  asin: string;
  fnsku: string;
  ean: string | null;
  upc: string | null;
  condition: string;
  prep: string;
  prepType: string | null;
  labeler: string;
  units: number;
  useItem: string | null;
  dimStr: string | null;
  rollen: string | null;
  dim: { l: number; b: number; h: number } | null;
  isThermo: boolean;
  isVeit: boolean;
  isHeipa: boolean;
  isTacho: boolean;
  isKlebeband: boolean;
  isProduktion: boolean;
  category: string | null;
  codeType: string | null;
  level?: number;
  hasFourSideWarning?: boolean;
  [extra: string]: unknown;
}

export interface ParsedPallet {
  id: string;
  items: ParsedItem[];
  hasFourSideWarning?: boolean;
  [extra: string]: unknown;
}

export interface ParsedMeta {
  sendungsnummer?: string;
  fbaCode?: string;
  [extra: string]: unknown;
}

export interface Parsed {
  format: ParsedFormat | string;
  meta: ParsedMeta;
  pallets: ParsedPallet[];
  einzelneSkuItems?: ParsedItem[];
  /** Set when the worker stornierts the Auftrag from Focus. */
  cancellation?: CancellationInfo;
  [extra: string]: unknown;
}

/* The parser's validation report — shape owned by validateParsing in
 * parseLagerauftrag.ts. Loose because the producer's contract isn't
 * tight; consumers do dynamic field access on issues/counts. */
export type Validation = {
  ok?: boolean;
  errorCount?: number;
  warningCount?: number;
  issues?: Array<{ severity?: string; message?: string; [k: string]: unknown }>;
  [k: string]: unknown;
};

/* `${palletIdx}|${itemIdx}|${key}` → unix-ms timestamp | true */
export type CompletedKeys = Record<string, number | true>;

/* Per-pallet timing window. Keyed by pallet.id. */
export interface PalletTiming {
  startedAt: number;
  finishedAt?: number;
}
export type PalletTimings = Record<string, PalletTiming>;

/* ─── Users ──────────────────────────────────────────── */

export interface UserResponse {
  id: UUID;
  email: string;
  name: string;
  role: UserRole;
}

export interface UserListItem {
  id: UUID;
  name: string;
}

/* ─── Auftraege ────────────────────────────────────── */

export interface AuftragSummary {
  id: UUID;
  fileName: string;
  fbaCode: string | null;
  status: AuftragStatus;
  palletCount: number;
  articleCount: number;
  unitsCount: number;
  eskuCount: number;
  errorMessage: string | null;
  createdAt: ISODateString;
  queuePosition: number | null;
  assignedToUserId: UUID | null;
  assignedToUserName: string | null;
  startedAt: ISODateString | null;
  finishedAt: ISODateString | null;
  durationSec: number | null;
  palletTimings: PalletTimings;
}

export interface AuftragDetail extends AuftragSummary {
  rawText: string | null;
  parsed: Parsed | null;
  validation: Validation | null;
  step: WorkflowStep | null;
  currentPalletIdx: number | null;
  currentItemIdx: number | null;
  completedKeys: CompletedKeys;
}

export interface AuftragCreatePayload {
  fileName: string;
  rawText?: string | null;
  /* Parsed/Validation are loose at the API boundary because the
     parseLagerauftrag.js producer is JS-typed (all-any). The receiving
     end (Parsed in api.ts) has the structured shape consumers rely on. */
  parsed?: unknown;
  validation?: unknown;
  errorMessage?: string | null;
}

export interface WorkflowProgressPatch {
  step?: WorkflowStep;
  currentPalletIdx?: number;
  currentItemIdx?: number;
  completedKeys?: CompletedKeys;
  palletTimings?: PalletTimings;
}

/** One flagged article in a Stornierung. `palletId` references
 *  parsed.pallets[].id so the Historie expand can highlight even
 *  after pallet reorder. */
export interface AbortItemPayload {
  palletId?: string | null;
  itemIdx?: number | null;
  code?: string | null;
  title?: string | null;
  reason?: string | null;
}

export interface WorkflowAbortPayload {
  items: AbortItemPayload[];
  note?: string | null;
}

/** Server-stored cancellation block, appended onto parsed when the
 *  worker stornierts an Auftrag. Lives under parsed.cancellation. */
export interface CancellationInfo {
  items: Array<{
    palletId: string | null;
    itemIdx: number | null;
    code: string | null;
    title: string | null;
    reason: string | null;
  }>;
  note: string | null;
  at: ISODateString;
  by: { id: UUID; name: string } | null;
}

export interface AuftragReorderItem {
  id: UUID;
  queuePosition: number;
}

/* ─── History ──────────────────────────────────────── */

export interface HistoryPage {
  items: AuftragSummary[];
  total: number;
  limit: number;
  offset: number;
}

/* ─── Admin ────────────────────────────────────────── */

export interface AdminUserDetail {
  id: UUID;
  clerkId: string | null;
  email: string;
  name: string;
  role: UserRole;
  createdAt: ISODateString;
  lastLoginAt: ISODateString | null;
  auftraegeCompleted: number;
}

export interface AuditLogEntry {
  id: UUID;
  action: string;
  createdAt: ISODateString;
  userId: UUID;
  userName: string | null;
  auftragId: UUID | null;
  auftragFileName: string | null;
  meta: Record<string, unknown>;
}

export interface AdminTopUser {
  user_id: UUID;
  user_name: string;
  count: number;
}

export interface AdminPerDay {
  date: string;
  count: number;
}

export interface AdminStats {
  totalAuftraege: number;
  queuedNow: number;
  inProgressNow: number;
  completedTotal: number;
  completedToday: number;
  completedThisWeek: number;
  avgDurationSec: number | null;
  topUsers: AdminTopUser[];
  completedPerDay: AdminPerDay[];
}

export interface AdminAuftraegeQuery {
  status?: AuftragStatus | '';
  assignedTo?: UUID | '';
  search?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface AdminAuftraegePage {
  items: AuftragSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminAuditQuery {
  action?: string;
  user_id?: UUID;
  limit?: number;
  offset?: number;
}

export interface AdminAuditPage {
  items: AuditLogEntry[];
  total: number;
  limit: number;
  offset: number;
}

/* ─── SKU Dimensions ─────────────────────────────────── */

export interface SkuDimensionRead {
  id: number;
  fnskus: string[];
  skus: string[];
  eans: string[];
  title: string | null;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
  palletLoadMax: number | null;
  source: string | null;
  updatedAt: ISODateString;
  updatedBy: string | null;
}

export interface SkuDimensionLookup {
  id: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
  palletLoadMax: number | null;
  source: string | null;
}

export interface SkuDimensionLookupResponse {
  lookups: Record<string, SkuDimensionLookup>;
  missing: string[];
}

export interface SkuDimensionUpsert {
  fnskus?: string[];
  skus?: string[];
  eans?: string[];
  title?: string | null;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number;
  palletLoadMax?: number | null;
}

export interface SkuDimensionImportResult {
  imported: number;
  updated: number;
  skipped: number;
  warnings: string[];
}

export interface AdminSkuDimensionsQuery {
  q?: string;
  limit?: number;
  offset?: number;
}

export interface AdminSkuDimensionsPage {
  items: SkuDimensionRead[];
  total: number;
  limit: number;
  offset: number;
}

/* ─── Search / Activity ──────────────────────────────── */

export type MatchedField = 'fnsku' | 'sku' | 'ean' | 'sendungsnummer' | 'file_name';

export interface SearchHit {
  id: UUID;
  fileName: string;
  fbaCode: string | null;
  status: AuftragStatus;
  palletCount: number;
  articleCount: number;
  createdAt: ISODateString;
  finishedAt: ISODateString | null;
  durationSec: number | null;
  assignedToUserName: string | null;
  matchedField: MatchedField | null;
  matchedValue: string | null;
}

export interface SearchResults {
  items: SearchHit[];
  total: number;
  limit: number;
  offset: number;
  query: string;
}

export interface SearchQuery {
  q: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface ActiveWorker {
  userId: UUID;
  userName: string;
  auftragId: UUID;
  fileName: string;
  fbaCode: string | null;
  step: WorkflowStep | null;
  startedAt: ISODateString | null;
  currentPalletIdx: number | null;
  palletCount: number;
}

export interface ActivityEvent {
  id: UUID;
  action: string;
  createdAt: ISODateString;
  userId: UUID;
  userName: string | null;
  auftragId: UUID | null;
  auftragFileName: string | null;
  fbaCode: string | null;
  meta: Record<string, unknown>;
}

export interface ActivityFeed {
  activeWorkers: ActiveWorker[];
  events: ActivityEvent[];
  serverTime: ISODateString;
}

export interface ShiftInfo {
  startedAt: ISODateString | null;
  durationSec: number;
  completedToday: number;
}

/* ─── Exports ──────────────────────────────────────── */

export interface XlsxExportResult {
  ok: true;
  rowCount: number;
}

export interface XlsxExportRange {
  from?: string;
  to?: string;
}

/* ─── Reports (Berichte analytics aggregates) ─────── */

export interface LevelBucket {
  level: number;
  units: number;
  rollen: number;
  auftragCount: number;
}

/* date is YYYY-MM-DD; values keys are level numbers as JSON strings */
export interface DailyLevelBucket {
  date: string;
  values: Record<string, number>;
}

export interface HeatmapCell {
  date: string;
  count: number;
  units: number;
}

export interface ReportsAggregates {
  byLevel: LevelBucket[];
  dailyByLevel: DailyLevelBucket[];
  rollenByDay: DailyLevelBucket[];
  heatmap: HeatmapCell[];
  days: number;
}

export interface ReportsQuery {
  days?: number;
  /* Comma-separated level filter, e.g. "1,3,7" */
  levels?: string;
}

/* ─── LYNNE catalog ─────────────────────────────────────────────────── */

export type LynneChannel = 'PRIME' | 'EV' | 'EV-PRIME' | 'OTHER';

export interface LynneVariant {
  sku: string;
  ean: string | null;
  channel: LynneChannel;
  weeklySales: number;
  grazStock: number;
}

export interface LynneAsinGroup {
  asin: string;
  description: string;
  brand: string;
  variantCount: number;
  totalWeeklySales: number;
  totalGrazStock: number;
  perPallet: number;
  variants: LynneVariant[];
}

export interface LynneCatalog {
  items: LynneAsinGroup[];
  totalAsins: number;
  totalBrands: number;
  totalGrazStock: number;
}

/* Admin CRUD DTOs — mirror backend/schemas.py LynneProduct{Read,Create}
   / LynneVariantPatch / LynneAsinBatchPatch / LynneAsinRename. */

export interface LynneProductRead {
  id: string;
  asin: string;
  sku: string;
  channel: LynneChannel;
  ean: string | null;
  description: string;
  brand: string;
  perPallet: number;
  weeklySales: number;
  grazStock: number;
}

export interface LynneProductCreate {
  asin: string;
  sku: string;
  channel: LynneChannel;
  ean?: string | null;
  description?: string;
  brand?: string;
  perPallet?: number;
  weeklySales?: number;
  grazStock?: number;
}

export interface LynneVariantPatch {
  asin?: string;
  sku?: string;
  channel?: LynneChannel;
  ean?: string | null;
  description?: string;
  brand?: string;
  perPallet?: number;
  weeklySales?: number;
  grazStock?: number;
}

export interface LynneAsinBatchPatch {
  description?: string;
  brand?: string;
  perPallet?: number;
}

export interface LynneAsinRename {
  newAsin: string;
}
