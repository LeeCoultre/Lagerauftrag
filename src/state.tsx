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
import mammoth from 'mammoth';
import {
  parseLagerauftragText, validateParsing,
} from './utils/parseLagerauftrag.js';
import { sortPallets, enrichItemDims } from './utils/auftragHelpers.js';
import { scanFnskuCodesZoned } from './utils/fnskuScanner';
import { validateFnskuAgainstParserZoned } from './utils/fnskuValidator';
import {
  listAuftraege, createAuftrag, getAuftrag, deleteAuftrag, reorderQueue as apiReorder,
  startAuftrag, updateProgress, completeAuftrag, cancelAuftrag, abortAuftrag,
  getHistory, deleteHistoryEntry, getMe,
  lookupSkuDimensions,
  joinSession, claimPallet,
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

    // Multi-user fields — only present on Detail rows; let consumers
    // (Warteschlange's JoinableBanner) compute free-pallet counts.
    palletClaims: detail.palletClaims,
    sessionUsers: detail.sessionUsers,
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

  /* Backend returns AuftragDetail for the list endpoint — slim for
     non-active rows (parsed/raw_text stripped), full for the caller's
     own active row. Typed as Detail so the multi-user-aware fields
     (palletClaims, sessionUsers) are readable; legacy Summary callers
     still work via structural typing. */
  const all: AuftragDetail[] = auftraegeQ.data ?? [];

  const queue = useMemo(
    () => all
      .filter((a) => a.status === 'queued' || a.status === 'error')
      .map(toLegacy)
      .filter((x): x is LegacyAuftrag => x != null),
    [all],
  );

  /* Backend's GET /api/auftraege returns ALL in_progress Aufträge now
     (peek-only payload for not-mine rows) — multi-user discovery needs
     it so non-members can see active sessions in Warteschlange and
     join. Pick MY active row by primary or session membership; fall
     back to "any in_progress" while `me` is loading so the UI still
     transitions on first start (Clerk session populates async). */
  const meId = meQ.data?.id;
  const currentSrc = useMemo(
    () => {
      if (meId) {
        // Happy path: `me` is loaded → identity-based filter.
        return all.find((a) =>
          a.status === 'in_progress'
          && (
            a.assignedToUserId === meId
            || (a.sessionUsers ?? []).some((u) => u.userId === meId)
          ),
        ) ?? null;
      }
      // `me` is still loading (first-paint or hard refresh). Backend
      // already discriminated for us: peek rows for not-mine in_progress
      // come back with parsed=null, my own row keeps the full parsed.
      // Use that as a transient identity proxy so Workspace can route
      // straight to Pruefen instead of sitting on UploadScreen for the
      // ~300 ms it takes Clerk to populate the /me query — the visible
      // "auto-start countdown ends but Pruefen lags 2 s" bug.
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
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(['auftraege'], ctx.prev);
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
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(['auftraege'], ctx.prev);
      invalidateAll();
    },
  });

  const startMut = useMutation<AuftragDetail, Error, UUID, { prev?: AuftragDetail[] }>({
    mutationFn: startAuftrag,
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['auftraege'] });
      const prev = qc.getQueryData<AuftragDetail[]>(['auftraege']);
      // Optimistic only flips status + workflow fields. parsed stays
      // null until the server returns Detail (with the full payload
      // for this user as active worker) and we patch it in.
      const nowIso = new Date().toISOString();
      qc.setQueryData<AuftragDetail[]>(['auftraege'], (old) =>
        (old || []).map((a) => a.id === id ? {
          ...a,
          status: 'in_progress' as AuftragStatus,
          startedAt: nowIso,
          step: 'pruefen' as WorkflowStep,
          currentPalletIdx: 0,
          currentItemIdx: 0,
        } : a),
      );
      return { prev };
    },
    onSuccess: (data, id) => {
      // Patch the freshly-started row with full parsed so Pruefen/
      // Focus mount with real data, no extra round-trip needed.
      qc.setQueryData<AuftragDetail[]>(['auftraege'], (old) =>
        (old || []).map((a) => a.id === id ? data : a),
      );
    },
    onError: (err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(['auftraege'], ctx.prev);
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
           Surface a friendly message instead of the raw EN string. */
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
        (old || []).map((a) => (a.id === id ? { ...a, ...(payload as Partial<AuftragSummary>) } : a)),
      );
      return { prev };
    },
    onSuccess: (data, { id }) => {
      /* Patch the server's authoritative response into cache instead of
         invalidating + refetching. Without this, every Artikel-✓ click
         on Focus triggered a fresh GET /api/auftraege round-trip (~80 KB
         payload with the full active parsed) — visibly laggy at Railway
         latency. The 3 s focus polling still picks up other workers'
         updates; we just don't pay the round-trip on our OWN writes. */
      qc.setQueryData<AuftragDetail[]>(['auftraege'], (old) =>
        (old || []).map((a) => (a.id === id ? data : a)),
      );
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['auftraege'], ctx.prev);
      // Surface the bad cache state for a refetch — only on the rare
      // error path; the success path no longer round-trips.
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
  }, [queue, qc, reorderMut]);

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
  }, [queue, qc, reorderMut]);

  const startEntry = useCallback((entryId?: UUID) => {
    if (current) {
      alert(
        'Du bearbeitest bereits einen Auftrag. ' +
        'Schließe ihn ab oder breche ihn ab, bevor du einen neuen startest.'
      );
      return;
    }
    /* If `me` hasn't populated yet, currentSrc already falls back to
       "any in_progress row that has parsed" (see above), so `current`
       above caught the real case. Past that we let /start run — if
       the worker really is double-booked the backend will surface a
       409 and `startMut.onError` shows a friendly toast. We used to
       alert here, but that fired during the Upload auto-start
       countdown and felt like a regression. */
    /* Server-side cross-check: maybe a row exists where I'm primary or
       a participant that simply hasn't reached the `current` slot yet
       (e.g. multi-user-aware row in the cache that didn't pass the
       in_progress filter due to race). Block here with a friendly
       hint instead of letting the backend 409 leak through. */
    const detailList = qc.getQueryData<AuftragDetail[]>(['auftraege']) ?? [];
    const myActive = detailList.find((a) =>
      a.status === 'in_progress'
      && (
        a.assignedToUserId === meId
        || (a.sessionUsers ?? []).some((u) => u.userId === meId)
      ),
    );
    if (myActive) {
      alert(
        'Du hast bereits einen aktiven Auftrag (' +
        (myActive.fileName || myActive.fbaCode || myActive.id) +
        '). Schließe ihn ab oder breche ihn ab, bevor du einen neuen startest.'
      );
      return;
    }
    /* Strict order: only the queue head (first non-error row) may start.
       Error rows are skipped so a single broken parse doesn't lock the
       rest of the shift. Smart-sort / DnD remain the way to reorder. */
    const headId = queue.find((q) => q.status !== 'error')?.id;
    if (entryId && headId && entryId !== headId) {
      alert(
        'Bitte zuerst den obersten Auftrag starten oder die Reihenfolge ändern.'
      );
      return;
    }
    const target = entryId || headId || queue[0]?.id;
    if (!target) return;

    /* Guard against stale-cache double-start: the row may already be
       in_progress on the server (a polling refetch will surface that
       state momentarily). Without this, /start returns 409 "Already
       taken" and the worker is left confused. Reuse the detailList
       grabbed above for the membership check. */
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

  /* ── Multi-user awareness: shared Warteschlange ──────────────────────
     All accounts see the same queue. When a worker on another account
     has an Auftrag in_progress, every other user sees it surfaced as an
     "Aktive Sitzung" banner with an Übernehmen button. The banner is
     visible REGARDLESS of free pallet count — when every pallet is
     held the Übernehmen action just goes disabled with "Voll". This
     keeps the floor view consistent with the user's mental model
     ("orders are shared, everyone sees the same Warteschlange") and
     stops a fully-claimed Auftrag from vanishing from observers'
     screens.

     `meId` not loaded → still empty (we wait for identity before
     deciding what's mine vs other; the gap is ~200 ms and only on
     first paint). */
  const joinable = useMemo<LegacyAuftrag[]>(
    () => {
      if (!meId) return [];
      return all
        .filter((a) => {
          if (a.status !== 'in_progress') return false;
          if (a.assignedToUserId === meId) return false;
          if ((a.sessionUsers ?? []).some((u) => u.userId === meId)) return false;
          return (a.palletCount ?? 0) > 0;
        })
        .map(toLegacy)
        .filter((x): x is LegacyAuftrag => x != null);
    },
    [all, meId],
  );

  /* Join a not-mine in_progress Auftrag + immediately claim the first
     free pallet. Returns true if both succeeded — the caller then
     navigates to workspace to enter Focus. */
  const joinAndClaimFirst = useCallback(async (auftragId: UUID): Promise<boolean> => {
    const row = all.find((a) => a.id === auftragId);
    if (!row || row.status !== 'in_progress') return false;
    const palletCount = row.palletCount ?? 0;
    if (palletCount === 0) return false;
    const occupied = new Set(
      (row.palletClaims ?? [])
        .filter((c) => c.state === 'active' || c.state === 'completed')
        .map((c) => c.palletIdx),
    );
    let nextFree: number | null = null;
    for (let i = 0; i < palletCount; i++) {
      if (!occupied.has(i)) { nextFree = i; break; }
    }
    if (nextFree == null) return false;
    try {
      await joinSession(auftragId);
    } catch (e) {
      /* 409 — already in another active session, or session full.
         Surface via alert; UI stays on Warteschlange. */
      const msg = e instanceof Error ? e.message : 'Beitreten fehlgeschlagen.';
      alert(msg);
      return false;
    }
    try {
      await claimPallet(auftragId, nextFree);
    } catch (e) {
      /* 409 race: a parallel worker grabbed the slot. Invalidate the
         cache so the polling cycle surfaces the next free pallet on the
         caller's next click. Don't keep retrying inline — would block
         the click handler arbitrarily long. */
      qc.invalidateQueries({ queryKey: ['auftraege'] });
      const status = e instanceof ApiError ? e.status : 0;
      alert(status === 409
        ? 'Diese Palette wurde gerade übernommen. Bitte erneut tippen.'
        : (e instanceof Error ? e.message : 'Übernehmen fehlgeschlagen.'));
      return false;
    }
    qc.invalidateQueries({ queryKey: ['auftraege'] });
    return true;
  }, [all, qc]);

  return useMemo<UseAppStateApi>(() => ({
    queue, current, history,
    addFiles, removeFromQueue, reorderQueue: reorderQueueAction, reorderQueueTo, clearQueue,
    startEntry, goToStep,
    setCurrentPalletIdx, setCurrentItemIdx, markCodeCopied,
    moveEskuToPallet, resetEskuOverrides,
    completeCurrentItem, completeAndAdvance, cancelCurrent, abortCurrent,
    removeHistoryEntry, clearHistory,
    joinable, joinAndClaimFirst,
  }), [
    queue, current, history,
    addFiles, removeFromQueue, reorderQueueAction, reorderQueueTo, clearQueue,
    startEntry, goToStep,
    setCurrentPalletIdx, setCurrentItemIdx, markCodeCopied,
    moveEskuToPallet, resetEskuOverrides,
    completeCurrentItem, completeAndAdvance, cancelCurrent, abortCurrent,
    removeHistoryEntry, clearHistory,
    joinable, joinAndClaimFirst,
  ]);
}
