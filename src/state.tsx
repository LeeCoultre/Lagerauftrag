/* ─────────────────────────────────────────────────────────────────────────
   Marathon — central app state (Sprint 1: server-backed via TanStack Query).
   Same useAppState() shape as the localStorage version it replaced — UI
   doesn't need to know about the swap.

   Conceptual model:
     - queue   = backend rows where status='queued' or 'error'
     - current = backend row where status='in_progress' AND assigned_to == me
     - history = backend /api/history items
   ───────────────────────────────────────────────────────────────────────── */
/* eslint-disable react-refresh/only-export-components -- module exports both
   the AppStateProvider component and the useAppState hook + adapters by
   design; splitting would hurt locality. */

import { createContext, useCallback, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusActive } from './hooks/useFocusPresence';
import { useBetaDesign } from './hooks/useBetaDesign';
import mammoth from 'mammoth';
import {
  parseLagerauftragText, validateParsing,
} from './utils/parseLagerauftrag.js';
import { sortPallets, enrichItemDims } from './utils/auftragHelpers.js';
import { scanFnskuCodesZoned } from './utils/fnskuScanner';
import { validateFnskuAgainstParserZoned } from './utils/fnskuValidator';
import { removeFromRecentUploads } from './hooks/useRecentUploads';
import {
  listAuftraege, createAuftrag, getAuftrag, deleteAuftrag, reorderQueue as apiReorder,
  startAuftrag, updateProgress, completeAuftrag, cancelAuftrag, abortAuftrag,
  getHistory, deleteHistoryEntry, getMe,
  lookupSkuDimensions,
  ApiError,
} from './marathonApi';
import type {
  AuftragDetail,
  AuftragStatus,
  AuftragSummary,
  AuftragReorderItem,
  CompletedKeys,
  PalletTimings,
  Parsed,
  UUID,
  WorkflowAbortPayload,
  WorkflowProgressPatch,
  WorkflowStep,
} from './types/api';
import type { LegacyAuftrag, LegacyHistoryItem, UseAppStateApi } from './types/state';

// Avoid unused-import warnings for getAuftrag (kept for re-export parity).
void getAuftrag;

/* AppStateProvider remains a marker — TanStack Query is mounted in main.jsx.
   We keep the wrapper so existing imports don't break. */
const Ctx = createContext(true);

export function AppStateProvider({ children }: { children: ReactNode }) {
  return <Ctx.Provider value={true}>{children}</Ctx.Provider>;
}

/* ─── Copied-codes localStorage helpers ──────────────────────────────────
   `copiedKeys` is a per-pallet+item bitset that drives the green chip
   state in Focus. Stored locally (not on the server) — it's a UX
   convenience for the active session, not data we need to audit or
   sync across devices. Survives reload but not browser-storage clears
   or device switches. Cleaned up when the Auftrag finishes/cancels. */
const CK_PREFIX = 'marathon.copiedKeys.';
const CK_KEY = (auftragId: UUID) => `${CK_PREFIX}${auftragId}`;

function readCopiedKeys(auftragId: UUID | undefined | null): Record<string, number> {
  if (!auftragId || typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(CK_KEY(auftragId));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function writeCopiedKeys(auftragId: UUID, obj: Record<string, number>): void {
  if (!auftragId || typeof window === 'undefined') return;
  try { window.localStorage.setItem(CK_KEY(auftragId), JSON.stringify(obj)); }
  catch { /* quota / private mode — silent */ }
}

function clearCopiedKeys(auftragId: UUID): void {
  if (!auftragId || typeof window === 'undefined') return;
  try { window.localStorage.removeItem(CK_KEY(auftragId)); }
  catch { /* ignore */ }
}

/* ─── ESKU overrides localStorage helpers ────────────────────────────────
   Manual ESKU→Pallet reassignments made by the worker in Pruefen/Focus.
   Persisted locally (same model as copiedKeys — UX layer, not server
   state). Shape: `{ [eskuKey]: targetPalletId }`. Cleaned on cancel/
   complete. The eskuKey is `fnsku || sku || title` — same key used by
   distributeEinzelneSku to group atomically. */
const EO_PREFIX = 'marathon.eskuOverrides.';
const EO_KEY = (auftragId: UUID) => `${EO_PREFIX}${auftragId}`;

function readEskuOverrides(auftragId: UUID | undefined | null): Record<string, string> {
  if (!auftragId || typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(EO_KEY(auftragId));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function writeEskuOverrides(auftragId: UUID, obj: Record<string, string>): void {
  if (!auftragId || typeof window === 'undefined') return;
  try { window.localStorage.setItem(EO_KEY(auftragId), JSON.stringify(obj)); }
  catch { /* quota / private mode — silent */ }
}

function clearEskuOverrides(auftragId: UUID): void {
  if (!auftragId || typeof window === 'undefined') return;
  try { window.localStorage.removeItem(EO_KEY(auftragId)); }
  catch { /* ignore */ }
}

/* ─── Adapters: backend (camelCase via marathonApi) → legacy localStorage shape ── */

export function toLegacy(a: AuftragDetail | AuftragSummary | null | undefined): LegacyAuftrag | null {
  if (!a) return null;
  const detail = a as Partial<AuftragDetail>;
  return {
    id:        a.id,
    fileName:  a.fileName,
    fbaCode:   a.fbaCode,
    addedAt:   a.createdAt ? Date.parse(a.createdAt) : Date.now(),
    rawText:   detail.rawText,
    parsed:    detail.parsed,
    validation: detail.validation,
    status:    a.status === 'error' ? 'error' : 'ready',
    error:     a.errorMessage,
    palletCount:  a.palletCount,
    articleCount: a.articleCount,
    unitsCount:   a.unitsCount ?? 0,
    eskuCount:    a.eskuCount ?? 0,

    startedAt:        a.startedAt  ? Date.parse(a.startedAt)  : undefined,
    finishedAt:       a.finishedAt ? Date.parse(a.finishedAt) : undefined,
    durationSec:      a.durationSec,
    step:             detail.step,
    currentPalletIdx: detail.currentPalletIdx ?? 0,
    currentItemIdx:   detail.currentItemIdx ?? 0,
    completedKeys:    detail.completedKeys ?? {},
    copiedKeys:       readCopiedKeys(a.id),
    eskuOverrides:    readEskuOverrides(a.id),
    palletTimings:    a.palletTimings ?? {},

    assignedToUserId:   a.assignedToUserId,
    assignedToUserName: a.assignedToUserName,
  };
}

export function toLegacyHistory(h: AuftragSummary): LegacyHistoryItem {
  return {
    id:           h.id,
    fileName:     h.fileName,
    fbaCode:      h.fbaCode,
    status:       h.status,
    startedAt:    h.startedAt  ? Date.parse(h.startedAt)  : null,
    finishedAt:   h.finishedAt ? Date.parse(h.finishedAt) : null,
    durationSec:  h.durationSec,
    palletCount:  h.palletCount,
    articleCount: h.articleCount,
    palletTimings: h.palletTimings ?? {},
    assignedToUserName: h.assignedToUserName,
  };
}

/* Parse one .docx in-browser; sort pallets so the upload result matches
   the workflow ordering used by Focus mode. */
async function parseDocxFile(file: File) {
  const buf = await file.arrayBuffer();
  let rawText = '';
  try {
    const r = await mammoth.extractRawText({ arrayBuffer: buf });
    rawText = r.value;
    const parsed = parseLagerauftragText(rawText);
    if (parsed?.pallets) parsed.pallets = sortPallets(parsed.pallets);
    const baseValidation = (validateParsing(rawText, parsed) || {}) as Record<string, unknown>;
    /* Independent FNSKU scanner — second pass over the raw text, no
       columnar assumptions. v2: scanner partitions hits by palette
       block (own palette regex, not imported from parseLagerauftrag),
       and the validator surfaces per-palette count mismatches. Result
       is stashed under validation.fnsku so it round-trips through the
       backend's opaque JSON blob and survives a refresh without any
       schema/migration change. */
    const fnskuScan = scanFnskuCodesZoned(rawText);
    const validation = {
      ...baseValidation,
      fnsku: validateFnskuAgainstParserZoned(fnskuScan, parsed as unknown as Parsed),
    };
    return { fileName: file.name, rawText, parsed, validation, errorMessage: null };
  } catch (e) {
    return {
      fileName: file.name, rawText, parsed: null, validation: null,
      errorMessage: String((e as Error)?.message ?? e),
    };
  }
}

/* ─────────────────────────────────────────────────────────────────────── */

const ALLOW_ANONYMOUS = import.meta.env.VITE_ALLOW_ANONYMOUS === 'true';

interface ProgressMutationArgs { id: UUID; payload: WorkflowProgressPatch }

export function useAppState(): UseAppStateApi {
  const qc = useQueryClient();
  const { isSignedIn } = useAuth();
  const effectivelySignedIn = isSignedIn || ALLOW_ANONYMOUS;
  const { beta } = useBetaDesign();

  /* ── Queries ───────────────────────────────────────────────────────── */
  const meQ = useQuery({
    queryKey: ['me'],
    queryFn: getMe,
    enabled: !!effectivelySignedIn,
    refetchInterval: false,
    staleTime: Infinity,
    retry: false,
  });

  /* Beta Focus polling: 5 s refetch ONLY while the worker is actually
   * on the multi-user Focus screen AND has a `me` identity loaded.
   * Outside Focus (queue, Upload, Pruefen, Historie) we stay
   * invalidate-driven — same behaviour the app had before multi-user.
   * `refetchIntervalInBackground: false` (default) means TanStack
   * pauses the interval when the tab is hidden, so we don't need a
   * visibilityState check on top.
   *
   * 5 s (was 3 s) is a deliberate latency↔chattiness trade-off: with
   * the full active row reaching ~80 KB on Railway, 3 s polling was
   * the dominant cost on Focus screens; 5 s halves bandwidth and the
   * worker still sees a peer takeover before the 5 min stale window. */
  const focusActive = useFocusActive();
  const auftraegeQ = useQuery({
    queryKey: ['auftraege'],
    queryFn: listAuftraege,
    enabled: !!effectivelySignedIn,
    refetchInterval: focusActive ? 5000 : false,
    refetchIntervalInBackground: false,
  });

  const historyQ = useQuery({
    queryKey: ['history'],
    queryFn: () => getHistory(50, 0),
    enabled: !!effectivelySignedIn,
  });

  /* Backend returns AuftragDetail for the list endpoint — raw_text is
     stripped to slim the payload, but `parsed` is present for the
     caller's active row so Pruefen / Focus have the data on mount
     without a separate detail fetch. */
  const all: AuftragDetail[] = auftraegeQ.data ?? [];

  const queue = useMemo(
    () => all
      .filter((a) => a.status === 'queued' || a.status === 'error')
      .map(toLegacy)
      .filter((x): x is LegacyAuftrag => x != null),
    [all],
  );

  /* Pick MY active in_progress Auftrag — the single source of truth
     for the workflow screen routing. Falls back to "any in_progress
     with parsed" while `me` is loading: backend only serves full
     parsed for the assigned user, so a non-null parsed is a reliable
     identity proxy during the ~300 ms Clerk session populate window. */
  const meId = meQ.data?.id;
  const currentSrc = useMemo(
    () => {
      if (meId) {
        return all.find(
          (a) => a.status === 'in_progress' && a.assignedToUserId === meId,
        ) ?? null;
      }
      return all.find(
        (a) => a.status === 'in_progress' && a.parsed != null,
      ) ?? null;
    },
    [all, meId],
  );
  const [copiedKeysVersion, setCopiedKeysVersion] = useState(0);
  const [eskuOverridesVersion, setEskuOverridesVersion] = useState(0);
  const current = useMemo(
    () => toLegacy(currentSrc),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentSrc, copiedKeysVersion, eskuOverridesVersion],
  );

  const history: LegacyHistoryItem[] = useMemo(
    () => (historyQ.data?.items ?? []).map(toLegacyHistory),
    [historyQ.data],
  );

  /* ── Mutations ─────────────────────────────────────────────────────── */
  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['auftraege'] });
    qc.invalidateQueries({ queryKey: ['history'] });
  };

  /* Beta-aware optimistic rollback. Classic always rolls back; beta only
     rolls back on definitive 4xx (server rejected the request). For
     network/timeout/5xx the server may have committed the change — a
     rollback there causes a visible "teleport back" until the invalidate
     refetch resyncs from server truth. */
  const rollbackIfDefinite = (
    err: unknown,
    prev: AuftragDetail[] | AuftragSummary[] | undefined,
  ) => {
    if (!prev) return;
    const status = (err as ApiError | null)?.status;
    const isDefinite4xx =
      beta && typeof status === 'number' && status >= 400 && status < 500;
    if (!beta || isDefinite4xx) qc.setQueryData(['auftraege'], prev);
  };

  /* createMut populates the cache directly with the server-returned
     Detail instead of invalidating ['auftraege'] and waiting for a
     refetch. Without this, the new Auftrag sits invisible to the
     React Query cache for the ~300-700ms a refetch takes — and any
     click on it during that window misses the optimistic Start path
     (setQueryData does old.map() which can't find a row that isn't
     there yet). History doesn't change on upload, so no invalidate
     needed there either. raw_text is nulled to match the slim list
     endpoint (the list slim strips raw_text). */
  const createMut = useMutation({
    mutationFn: createAuftrag,
    onSuccess: (data: AuftragDetail) => {
      const slim: AuftragDetail = { ...data, rawText: null };
      qc.setQueryData<AuftragDetail[]>(['auftraege'], (old) => {
        const arr = old ? [...old] : [];
        const idx = arr.findIndex((a) => a.id === slim.id);
        if (idx >= 0) arr[idx] = slim;
        else arr.push(slim);
        return arr;
      });
    },
  });
  /* Optimistic delete — Entfernen from queue. Was previously invalidate-
     and-refetch, which spent the full GET /api/auftraege round-trip
     before the row disappeared from the UI (~700 ms on Railway). The
     row IS visibly gone before the API replies; rollback on error
     puts it back. */
  const removeMut = useMutation<unknown, Error, UUID, { prev?: AuftragDetail[] }>({
    mutationFn: deleteAuftrag,
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['auftraege'] });
      const prev = qc.getQueryData<AuftragDetail[]>(['auftraege']);
      qc.setQueryData<AuftragDetail[]>(['auftraege'], (old) =>
        (old || []).filter((a) => a.id !== id),
      );
      return { prev };
    },
    onError: (err, _id, ctx) => {
      rollbackIfDefinite(err, ctx?.prev);
      invalidateAll();
    },
    onSuccess: () => {
      // History never changes from a delete (we only allow deleting
      // queued/error rows), so no history invalidate needed.
    },
  });
  /* Reorder: rest of the UI already mutates the cache locally in
     reorderQueueAction / reorderQueueTo before calling the API, so
     the success path doesn't need a refetch. Only the failure path
     pulls the server's view back. */
  const reorderMut = useMutation({
    mutationFn: apiReorder,
    onError: invalidateAll,
  });

  /* ── Optimistic cancel + start ───────────────────────────────────────
     Before this, every click on Verlassen / Start blocked the UI until
     the server returned AND a full ['auftraege'] refetch finished. With
     Railway latency that was 5-30 s.
     Now we mutate the local cache immediately (onMutate) and patch the
     server's response back in (onSuccess), skipping the heavy refetch
     entirely for the success path. Rollback on error via onError. */
  const cancelMut = useMutation<AuftragDetail, Error, UUID, { prev?: AuftragDetail[] }>({
    mutationFn: cancelAuftrag,
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['auftraege'] });
      const prev = qc.getQueryData<AuftragDetail[]>(['auftraege']);
      qc.setQueryData<AuftragDetail[]>(['auftraege'], (old) =>
        (old || []).map((a) => a.id === id ? {
          ...a,
          status: 'queued' as AuftragStatus,
          assignedToUserId: null,
          assignedToUserName: null,
          startedAt: null,
          step: null,
          currentPalletIdx: null,
          currentItemIdx: null,
          completedKeys: {},
          palletTimings: {},
          // No longer my active row → list payload won't carry parsed for it
          parsed: null,
          rawText: null,
          validation: null,
        } : a),
      );
      return { prev };
    },
    onSuccess: (_data, id) => {
      clearCopiedKeys(id);
      clearEskuOverrides(id);
      // history may have changed if cancel re-queued an Auftrag (rare),
      // but the auftraege list is already in the right shape locally.
      qc.invalidateQueries({ queryKey: ['history'] });
    },
    onError: (err, _id, ctx) => {
      rollbackIfDefinite(err, ctx?.prev);
      invalidateAll();
    },
  });

  /* Terminal "Verlassen" — permanently deletes the active Auftrag from
     the DB (and its cascade-linked pallet_claims). Distinct from /cancel
     which would put the row back into the queue. Optimistic update
     drops the row from cache immediately so the UI flips to the empty
     Workspace / next queued Auftrag without waiting on the network. */
  const leaveMut = useMutation<null, Error, UUID, { prev?: AuftragDetail[] }>({
    mutationFn: deleteAuftrag,
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['auftraege'] });
      const prev = qc.getQueryData<AuftragDetail[]>(['auftraege']);
      qc.setQueryData<AuftragDetail[]>(['auftraege'], (old) =>
        (old || []).filter((a) => a.id !== id),
      );
      return { prev };
    },
    onSuccess: (_data, id) => {
      clearCopiedKeys(id);
      clearEskuOverrides(id);
      /* Drop from the recent-uploads localStorage so the file-dedup
         check in Upload doesn't flag a re-upload as «schon vorhanden»
         after the Auftrag has been permanently deleted. */
      removeFromRecentUploads(id);
      // Audit log entries survive via ON DELETE SET NULL; admin views
      // refresh their own data. Nothing else to do — the row is gone.
    },
    onError: (err, _id, ctx) => {
      rollbackIfDefinite(err, ctx?.prev);
      invalidateAll();
      alert('Auftrag konnte nicht gelöscht werden — bitte erneut versuchen.');
    },
  });

  const startMut = useMutation<AuftragDetail, Error, UUID, { prev?: AuftragDetail[] }>({
    mutationFn: startAuftrag,
    onMutate: async (id) => {
      /* Optimistic write FIRST (synchronous), THEN await cancelQueries.
         The await would otherwise delay the cache flip by a microtask
         and cause a one-frame Upload drop-zone flicker before Pruefen
         mounts.

         Crucially: assigned_to_user_id must be set to ME — otherwise
         currentSrc.find(a => a.status==='in_progress' && a.assignedToUserId===meId)
         won't match the optimistic row (still has assignedToUserId=null
         from the queued state), and Workspace stays on UploadScreen
         until the backend response arrives (1-2 s on Railway). That
         IS the "delay between countdown end and Pruefen showing" bug. */
      const prev = qc.getQueryData<AuftragDetail[]>(['auftraege']);
      const nowIso = new Date().toISOString();
      const meIdNow   = meQ.data?.id;
      const meNameNow = meQ.data?.name;
      qc.setQueryData<AuftragDetail[]>(['auftraege'], (old) =>
        (old || []).map((a) => a.id === id ? {
          ...a,
          status: 'in_progress' as AuftragStatus,
          startedAt: nowIso,
          step: 'pruefen' as WorkflowStep,
          currentPalletIdx: 0,
          currentItemIdx: 0,
          assignedToUserId:   meIdNow   ?? a.assignedToUserId,
          assignedToUserName: meNameNow ?? a.assignedToUserName,
        } : a),
      );
      await qc.cancelQueries({ queryKey: ['auftraege'] });
      return { prev };
    },
    onSuccess: (data, id) => {
      // Patch the freshly-started row with full parsed so Pruefen/
      // Focus mount with real data, no extra round-trip needed.
      // Defensive: preserve cache's parsed if response is missing it.
      qc.setQueryData<AuftragDetail[]>(['auftraege'], (old) =>
        (old || []).map((a) => {
          if (a.id !== id) return a;
          return {
            ...data,
            parsed: data.parsed ?? a.parsed,
            rawText: data.rawText ?? a.rawText,
            validation: data.validation ?? a.validation,
          };
        }),
      );
    },
    onError: (err, _id, ctx) => {
      rollbackIfDefinite(err, ctx?.prev);
      const status = (err as ApiError | null)?.status;
      const detail = (err as ApiError | null)?.detail;
      const detailStr = typeof detail === 'string' ? detail : '';
      const lower = detailStr.toLowerCase();
      if (status === 409 && lower.includes('already taken')) {
        /* Race with another worker who started the same row a few ms
           earlier. The polling refetch will move the row out of queue
           — no toast needed, the UI self-corrects. */
      } else if (status === 409 && lower.includes('another auftrag in progress')) {
        /* Server-side "one active per user" guard fired because our
           frontend guard missed (e.g. cache hadn't caught up yet).
           Friendly message instead of the raw EN string. */
        alert(
          'Du hast bereits einen aktiven Auftrag. Schließe ihn ab oder ' +
          'breche ihn ab, bevor du einen neuen startest.'
        );
      } else {
        const msg = err instanceof Error
          ? err.message
          : 'Auftrag konnte nicht gestartet werden.';
        alert(msg);
      }
      invalidateAll();
    },
  });
  const completeMut = useMutation({
    mutationFn: completeAuftrag,
    onSuccess: async (_data, id: UUID) => {
      clearCopiedKeys(id);
      clearEskuOverrides(id);
      invalidateAll();
      const fresh = await listAuftraege();
      const next = fresh.find((a) => a.status === 'queued');
      if (next) startMut.mutate(next.id);
    },
  });

  /* Terminal cancel ("Stornieren") — flips the active row into status
     cancelled with the worker's flagged-article reasons, and surfaces
     it in Historie with a red border. Distinct from cancelMut (which
     just releases the Auftrag back to the queue). */
  const abortMut = useMutation<AuftragDetail, Error, { id: UUID; payload: WorkflowAbortPayload }>({
    mutationFn: ({ id, payload }) => abortAuftrag(id, payload),
    onSuccess: (_data, { id }) => {
      clearCopiedKeys(id);
      clearEskuOverrides(id);
      invalidateAll();
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : 'Stornierung fehlgeschlagen.';
      alert(msg);
    },
  });
  const deleteHistMut = useMutation({
    mutationFn: deleteHistoryEntry,
    onSuccess: invalidateAll,
  });

  const progressMut = useMutation<AuftragDetail, Error, ProgressMutationArgs, { prev?: AuftragSummary[] }>({
    mutationFn: ({ id, payload }) => updateProgress(id, payload),
    onMutate: async ({ id, payload }) => {
      await qc.cancelQueries({ queryKey: ['auftraege'] });
      const prev = qc.getQueryData<AuftragSummary[]>(['auftraege']);
      qc.setQueryData<AuftragSummary[]>(['auftraege'], (old) =>
        (old || []).map((a) => {
          if (a.id !== id) return a;
          const patched = { ...a, ...(payload as Partial<AuftragSummary>) };
          /* Beta: object-shaped payload fields are MERGE-on-server
             (backend update_progress lines 423/440/460). When the user
             fires "Fertig" twice faster than React can re-render, the
             second click's payload is built from a stale `current.*`
             closure and only carries the newest key — a blanket spread
             would erase the first click's optimistic entry from cache
             until the server's merged response arrives (~300ms flash
             of stale completed-count in the UI). Mirror the server's
             merge in onMutate so cache stays union-correct under
             rapid-fire interactions. */
          if (beta) {
            const p = payload as Record<string, unknown>;
            for (const dictKey of ['completedKeys', 'palletTimings', 'copiedKeys'] as const) {
              const incoming = p[dictKey];
              if (incoming && typeof incoming === 'object') {
                const existing = (a as unknown as Record<string, unknown>)[dictKey];
                (patched as unknown as Record<string, unknown>)[dictKey] = {
                  ...((existing as object | null) ?? {}),
                  ...(incoming as object),
                };
              }
            }
          }
          return patched;
        }),
      );
      return { prev };
    },
    onSuccess: (data, { id, payload }) => {
      /* Patch the server's authoritative response into cache instead of
         invalidating + refetching. Defensive merge: if the response is
         missing `parsed` (backend transient / stripped serialization),
         keep what cache had — never overwrite a populated parsed with
         null, that's the "Pruefen suddenly empty" bug.

         Beta: when the user fires multiple progress updates in quick
         succession (e.g. clicking pallet B → C → D in PalletFlow), the
         PATCH responses arrive in unspecified order. A late response
         from the B mutation carries currentPalletIdx=B in its payload,
         and a blanket `...data` spread would overwrite cache's freshly
         optimistic D — visible teleport B→C→D→B→C→D. Skip the
         payload-touched fields in the merge: cache already holds the
         newest optimistic value, and the next stable mutation will
         resync them via its own onMutate patch. */
      qc.setQueryData<AuftragDetail[]>(['auftraege'], (old) =>
        (old || []).map((a) => {
          if (a.id !== id) return a;
          const merged: AuftragDetail = {
            ...data,
            parsed: data.parsed ?? a.parsed,
            rawText: data.rawText ?? a.rawText,
            validation: data.validation ?? a.validation,
          };
          if (beta && payload && typeof payload === 'object') {
            const DICT_KEYS = ['completedKeys', 'palletTimings', 'copiedKeys'] as const;
            const aRec = a as unknown as Record<string, unknown>;
            const dataRec = data as unknown as Record<string, unknown>;
            const mergedRec = merged as unknown as Record<string, unknown>;
            for (const key of Object.keys(payload)) {
              if (!(key in a)) continue;
              if ((DICT_KEYS as readonly string[]).includes(key)) {
                /* Union the server response with the cache. Cache wins
                   for overlapping keys (it carries the freshest
                   optimistic patches from concurrent fast clicks), server
                   contributes any keys cache doesn't have yet (e.g.
                   completedKeys from another worker in multi-user). */
                mergedRec[key] = {
                  ...((dataRec[key] as object | null) ?? {}),
                  ...((aRec[key] as object | null) ?? {}),
                };
              } else {
                /* Scalar fields (currentPalletIdx, currentItemIdx, step):
                   cache wins to preserve newer optimistic patches from
                   concurrent mutations whose response landed later. */
                mergedRec[key] = aRec[key];
              }
            }
          }
          return merged;
        }),
      );
    },
    onError: (err, _vars, ctx) => {
      rollbackIfDefinite(err, ctx?.prev);
      qc.invalidateQueries({ queryKey: ['auftraege'] });
    },
  });

  /* ── Actions (legacy useAppState() shape) ──────────────────────────── */
  const addFiles = useCallback(async (fileList: FileList | File[] | null): Promise<LegacyAuftrag[]> => {
    const files = Array.from(fileList || []).filter((f) => /\.docx$/i.test(f.name));
    if (!files.length) return [];
    const built = await Promise.all(files.map(parseDocxFile));
    const created = await Promise.all(
      built.map((p) => createMut.mutateAsync(p).catch(() => null)),
    );
    return created
      .map((c) => toLegacy(c))
      .filter((x): x is LegacyAuftrag => x != null);
  }, [createMut]);

  const removeFromQueue = useCallback((id: UUID) => removeMut.mutate(id), [removeMut]);

  const clearQueue = useCallback(() => {
    queue.forEach((q) => removeMut.mutate(q.id));
  }, [queue, removeMut]);

  const reorderQueueAction = useCallback((fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx) return;
    const next = [...queue];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    const items: AuftragReorderItem[] = next.map((q, i) => ({ id: q.id, queuePosition: i }));
    // Beta-only: abort any in-flight ['auftraege'] refetch so a slow GET
    // can't overwrite the optimistic reorder right after the user drops.
    if (beta) qc.cancelQueries({ queryKey: ['auftraege'] });
    qc.setQueryData<AuftragSummary[]>(['auftraege'], (old) => {
      if (!old) return old;
      const byId = new Map(old.map((a) => [a.id, a]));
      const reordered: AuftragSummary[] = [];
      items.forEach((it, i) => {
        const base = byId.get(it.id);
        if (base) reordered.push({ ...base, queuePosition: i });
      });
      const inProgress = old.filter((a) => a.status === 'in_progress');
      return [...reordered, ...inProgress];
    });
    reorderMut.mutate(items);
  }, [queue, qc, reorderMut, beta]);

  const reorderQueueTo = useCallback((orderedIds: UUID[]) => {
    if (!Array.isArray(orderedIds) || orderedIds.length !== queue.length) return;
    const idSet = new Set(queue.map((q) => q.id));
    if (!orderedIds.every((id) => idSet.has(id))) return;
    let changed = false;
    for (let i = 0; i < orderedIds.length; i++) {
      if (queue[i]?.id !== orderedIds[i]) { changed = true; break; }
    }
    if (!changed) return;
    const items: AuftragReorderItem[] = orderedIds.map((id, i) => ({ id, queuePosition: i }));
    if (beta) qc.cancelQueries({ queryKey: ['auftraege'] });
    qc.setQueryData<AuftragSummary[]>(['auftraege'], (old) => {
      if (!old) return old;
      const byId = new Map(old.map((a) => [a.id, a]));
      const reordered: AuftragSummary[] = [];
      items.forEach((it, i) => {
        const base = byId.get(it.id);
        if (base) reordered.push({ ...base, queuePosition: i });
      });
      const inProgress = old.filter((a) => a.status === 'in_progress');
      return [...reordered, ...inProgress];
    });
    reorderMut.mutate(items);
  }, [queue, qc, reorderMut, beta]);

  const startEntry = useCallback((entryId?: UUID) => {
    if (current) {
      alert(
        'Du bearbeitest bereits einen Auftrag. ' +
        'Schließe ihn ab oder breche ihn ab, bevor du einen neuen startest.'
      );
      return;
    }
    /* Any non-error queued row may start. Strict head-of-queue used to
       block this with an alert; in practice it just blocked workers
       whose UI cache lagged behind the server (stale rows on top) and
       added zero invariant — the backend doesn't enforce queue order.
       Drag-to-reorder remains the way to prioritise. */
    const headId = queue.find((q) => q.status !== 'error')?.id;
    const target = entryId || headId || queue[0]?.id;
    if (!target) return;

    /* Guard against stale-cache double-start: the row may already be
       in_progress on the server (a polling refetch will surface that
       state momentarily). Without this, /start returns 409 "Already
       taken" and the worker is left confused. */
    const detailList = qc.getQueryData<AuftragDetail[]>(['auftraege']) ?? [];
    const targetDetail = detailList.find((a) => a.id === target);
    if (targetDetail && targetDetail.status === 'in_progress') {
      // Either I'm the primary returning to my row (back-button reload
      // mid-flow) or someone beat me to it. Backend's idempotent /start
      // handles the first case gracefully; for the second, we'd 409.
      // Skip the API call entirely and let the caller's UI react to the
      // cache (Workspace already renders my own in_progress as current).
      qc.invalidateQueries({ queryKey: ['auftraege'] });
      return;
    }

    /* Pre-warm the sku-dimensions query so Pruefen mounts with the
       lookup already inflight (or done). Uses the same queryKey
       Pruefen subscribes to, so it'll just hand back the cached
       result on mount instead of firing a fresh HTTP roundtrip
       (~150-300 ms on Railway). */
    const targetAuftrag = queue.find((a) => a.id === target) || (current as LegacyAuftrag | null);
    const parsed = targetAuftrag?.parsed;
    if (parsed) {
      const palletsItems = (parsed.pallets || []).flatMap((p) => p.items || []);
      const eskuItems   = parsed.einzelneSkuItems || [];
      const allItems    = [...palletsItems, ...eskuItems];
      if (allItems.length > 0) {
        qc.prefetchQuery({
          queryKey: ['sku-dims', target],
          queryFn: () => enrichItemDims(allItems, lookupSkuDimensions),
          staleTime: 5 * 60 * 1000,
        });
      }
    }

    /* Pre-import the Pruefen chunk while the start mutation is in
       flight. The lazy-loaded module fetch races with the network
       roundtrip — by the time the optimistic UI flips step→pruefen,
       the chunk is usually already parsed and ready to render. */
    void import('./screens/Pruefen');

    startMut.mutate(target);
  }, [current, queue, startMut, qc]);

  const goToStep = useCallback((step: WorkflowStep) => {
    if (current?.id) progressMut.mutate({ id: current.id, payload: { step } });
  }, [current, progressMut]);

  const setCurrentPalletIdx = useCallback((idx: number) => {
    if (!current?.id) return;
    const pId = current.parsed?.pallets?.[idx]?.id;
    const palletTimings: PalletTimings = { ...(current.palletTimings ?? {}) };
    if (pId && !palletTimings[pId]) palletTimings[pId] = { startedAt: Date.now() };
    progressMut.mutate({
      id: current.id,
      payload: { currentPalletIdx: idx, currentItemIdx: 0, palletTimings },
    });
  }, [current, progressMut]);

  const setCurrentItemIdx = useCallback((idx: number) => {
    if (current?.id) {
      progressMut.mutate({ id: current.id, payload: { currentItemIdx: idx } });
    }
  }, [current, progressMut]);

  const markCodeCopied = useCallback((palletIdx: number, itemIdx: number) => {
    if (!current?.id) return;
    const key = `${palletIdx}|${itemIdx}`;
    const prev = readCopiedKeys(current.id);
    if (prev[key]) return;
    writeCopiedKeys(current.id, { ...prev, [key]: Date.now() });
    setCopiedKeysVersion((v) => v + 1);
  }, [current?.id]);

  const moveEskuToPallet = useCallback((eskuKey: string, palletId: string | null) => {
    if (!current?.id || !eskuKey) return;
    const prev = readEskuOverrides(current.id);
    const next = { ...prev };
    if (palletId == null || palletId === '') delete next[eskuKey];
    else next[eskuKey] = palletId;
    if (JSON.stringify(prev) === JSON.stringify(next)) return;
    writeEskuOverrides(current.id, next);
    setEskuOverridesVersion((v) => v + 1);
  }, [current?.id]);

  const resetEskuOverrides = useCallback(() => {
    if (!current?.id) return;
    clearEskuOverrides(current.id);
    setEskuOverridesVersion((v) => v + 1);
  }, [current?.id]);

  const completeCurrentItem = useCallback((effectiveItemsCount?: number, effectiveItem: unknown = null, nextPalletIdxOverride?: number): boolean => {
    if (!current?.parsed) return false;
    const pallet = current.parsed.pallets[current.currentPalletIdx];
    if (!pallet) return false;
    const itemsLength = effectiveItemsCount ?? pallet.items.length;
    const item = (effectiveItem as { fnsku?: string; sku?: string } | null) || pallet.items[current.currentItemIdx];
    if (!item && effectiveItemsCount == null) return false;
    const code = (item && (item.fnsku || item.sku))
      || `pos-${current.currentItemIdx}`;
    const key = `${pallet.id}|${current.currentItemIdx}|${code}`;
    const completedKeys: CompletedKeys = { ...(current.completedKeys ?? {}), [key]: Date.now() };

    let palletTimings: PalletTimings = { ...(current.palletTimings ?? {}) };
    let nextPalletIdx = current.currentPalletIdx;
    let nextItemIdx   = current.currentItemIdx + 1;
    let didFinishAll  = false;

    if (nextItemIdx >= itemsLength) {
      const prevTiming = palletTimings[pallet.id] ?? { startedAt: Date.now() };
      palletTimings = {
        ...palletTimings,
        [pallet.id]: { ...prevTiming, finishedAt: Date.now() },
      };
      // Caller-provided override lets Focus follow the display reorder
      // (palletOrderOverride) when picking the next pallet. Falls back
      // to raw idx + 1 for the normal unreordered flow.
      const candidate = nextPalletIdxOverride != null
        ? nextPalletIdxOverride
        : nextPalletIdx + 1;
      if (candidate >= 0 && candidate < current.parsed.pallets.length) {
        nextPalletIdx = candidate;
        nextItemIdx = 0;
        const nextId = current.parsed.pallets[nextPalletIdx].id;
        if (!palletTimings[nextId]) {
          palletTimings = { ...palletTimings, [nextId]: { startedAt: Date.now() } };
        }
      } else {
        didFinishAll = true;
      }
    }

    progressMut.mutate({
      id: current.id,
      payload: {
        completedKeys, palletTimings,
        currentPalletIdx: nextPalletIdx,
        currentItemIdx:   nextItemIdx,
      },
    });
    return didFinishAll;
  }, [current, progressMut]);

  const completeAndAdvance = useCallback(() => {
    if (current?.id) completeMut.mutate(current.id);
  }, [current, completeMut]);

  const cancelCurrent = useCallback(() => {
    if (current?.id) cancelMut.mutate(current.id);
  }, [current, cancelMut]);

  const leaveCurrent = useCallback(() => {
    if (current?.id) leaveMut.mutate(current.id);
  }, [current, leaveMut]);

  const abortCurrent = useCallback((payload: WorkflowAbortPayload) => {
    if (current?.id) abortMut.mutate({ id: current.id, payload });
  }, [current, abortMut]);

  const removeHistoryEntry = useCallback(
    (id: UUID) => deleteHistMut.mutate(id),
    [deleteHistMut],
  );

  const clearHistory = useCallback(() => {
    history.forEach((h) => deleteHistMut.mutate(h.id));
  }, [history, deleteHistMut]);

  return useMemo<UseAppStateApi>(() => ({
    queue, current, history,
    addFiles, removeFromQueue, reorderQueue: reorderQueueAction, reorderQueueTo, clearQueue,
    startEntry, goToStep,
    setCurrentPalletIdx, setCurrentItemIdx, markCodeCopied,
    moveEskuToPallet, resetEskuOverrides,
    completeCurrentItem, completeAndAdvance, cancelCurrent, leaveCurrent, abortCurrent,
    removeHistoryEntry, clearHistory,
  }), [
    queue, current, history,
    addFiles, removeFromQueue, reorderQueueAction, reorderQueueTo, clearQueue,
    startEntry, goToStep,
    setCurrentPalletIdx, setCurrentItemIdx, markCodeCopied,
    moveEskuToPallet, resetEskuOverrides,
    completeCurrentItem, completeAndAdvance, cancelCurrent, leaveCurrent, abortCurrent,
    removeHistoryEntry, clearHistory,
  ]);
}
