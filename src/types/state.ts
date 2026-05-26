/* Front-end-side projection of the API DTOs. The legacy `useAppState`
 * contract was designed before the backend existed (everything lived
 * in localStorage) — it uses unix-ms timestamps, a `ready|error`
 * status, and flattens out a few nested fields. Adapters in state.tsx
 * map the API shapes (AuftragDetail / AuftragSummary) into these. */

import type {
  AuftragStatus,
  CompletedKeys,
  PalletClaim,
  Parsed,
  PalletTimings,
  SessionUser,
  UUID,
  Validation,
  WorkflowAbortPayload,
  WorkflowStep,
} from './api';

export type LegacyStatus = 'ready' | 'error';

export interface LegacyAuftrag {
  id: UUID;
  fileName: string;
  fbaCode: string | null;
  addedAt: number;
  rawText: string | null | undefined;
  parsed: Parsed | null | undefined;
  validation: Validation | null | undefined;
  status: LegacyStatus;
  error: string | null | undefined;
  palletCount: number;
  articleCount: number;
  unitsCount: number;
  eskuCount: number;

  startedAt: number | undefined;
  finishedAt: number | undefined;
  durationSec: number | null | undefined;
  step: WorkflowStep | null | undefined;
  currentPalletIdx: number;
  currentItemIdx: number;
  completedKeys: CompletedKeys;
  copiedKeys: Record<string, number>;
  /** Manual ESKU→Pallet overrides set by the worker in Pruefen/Focus.
   *  Key = `fnsku || sku || title` (same group key used by
   *  distributeEinzelneSku). Value = target palletId. */
  eskuOverrides: Record<string, string>;
  palletTimings: PalletTimings;

  assignedToUserId: UUID | null | undefined;
  assignedToUserName: string | null | undefined;

  /* Multi-user session fields (beta). Optional — populated for rows
   * surfaced via the "joinable" selector in useAppState, omitted on
   * classic single-user paths. */
  palletClaims?: PalletClaim[];
  sessionUsers?: SessionUser[];
}

export interface LegacyHistoryItem {
  id: UUID;
  fileName: string;
  fbaCode: string | null;
  /** Underlying API status — 'completed' for normal runs, 'cancelled'
   *  for stornierte rows (those get a red border in Historie). */
  status: AuftragStatus;
  startedAt: number | null;
  finishedAt: number | null;
  durationSec: number | null;
  palletCount: number;
  articleCount: number;
  palletTimings: PalletTimings;
  assignedToUserName: string | null | undefined;
}

export interface UseAppStateApi {
  queue: LegacyAuftrag[];
  current: LegacyAuftrag | null;
  history: LegacyHistoryItem[];

  addFiles: (fileList: FileList | File[] | null) => Promise<LegacyAuftrag[]>;
  removeFromQueue: (id: UUID) => void;
  reorderQueue: (fromIdx: number, toIdx: number) => void;
  reorderQueueTo: (orderedIds: UUID[]) => void;
  clearQueue: () => void;

  startEntry: (entryId?: UUID) => void;
  goToStep: (step: WorkflowStep) => void;

  setCurrentPalletIdx: (idx: number) => void;
  setCurrentItemIdx: (idx: number) => void;
  markCodeCopied: (palletIdx: number, itemIdx: number) => void;

  /** Move an ESKU group to a different pallet. Pass `null` to revert
   *  to the auto-assigned target. eskuKey = `fnsku || sku || title`. */
  moveEskuToPallet: (eskuKey: string, palletId: string | null) => void;
  /** Drop all manual ESKU overrides for the current Auftrag. */
  resetEskuOverrides: () => void;

  completeCurrentItem: (effectiveItemsCount?: number, effectiveItem?: unknown, nextPalletIdxOverride?: number) => boolean;
  completeAndAdvance: () => void;
  /** Release the active Auftrag back to the queue (Verlassen — keeps row alive). */
  cancelCurrent: () => void;
  /** Terminal cancel (Stornieren) — row lands in Historie with a red border. */
  abortCurrent: (payload: WorkflowAbortPayload) => void;

  removeHistoryEntry: (id: UUID) => void;
  clearHistory: () => void;

  /** Active in_progress Aufträge held by other workers that still
   *  have at least one free pallet. Used by Warteschlange to surface
   *  "Beitreten" rows. Empty in classic single-user usage. */
  joinable: LegacyAuftrag[];
  /** Join a not-mine in_progress Auftrag and atomically claim the
   *  first free pallet. Resolves true on success; false on race / no
   *  free / 409 (already alerts the user). The caller should navigate
   *  to workspace on true. */
  joinAndClaimFirst: (auftragId: UUID) => Promise<boolean>;
}
