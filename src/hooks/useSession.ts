/* Multi-user Focus session — TanStack-driven hook for the beta Focus
 * screen. Wraps the six new endpoints (join/leave/claim/release/
 * takeover/heartbeat) with optimistic cache patches and provides the
 * derived state the UI consumes (myClaim, others, free pallets, stale
 * claims). Classic Focus does NOT use this hook; the beta branch
 * mounts it once at the top of <BetaFocusScreen>.
 *
 * Heartbeat lifecycle: started in a useEffect whose only "armed" key
 * is `!!myClaim`, so the interval stays stable across the 3-second
 * polling refetches. Reload-safe: if the worker reloads mid-claim,
 * useFocusSession auto-joins and the next claim API call resyncs
 * because the same user UUID still owns the row server-side.
 */
import {
  useCallback, useEffect, useMemo, useRef, type RefObject,
} from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
  ApiError,
  claimPallet as apiClaim,
  heartbeat as apiHeartbeat,
  joinSession as apiJoin,
  leaveSession as apiLeave,
  releasePallet as apiRelease,
  takeoverPallet as apiTakeover,
} from '@/marathonApi';
import type {
  AuftragDetail,
  PalletClaim,
  SessionUser,
  UUID,
  UserPalletProgress,
} from '@/types/api';
import { useMe } from '@/hooks/useMe';

const STALE_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;

interface UseFocusSessionResult {
  /** The caller's active (not yet completed) claim on this Auftrag, or null. */
  myClaim: PalletClaim | null;
  /** Other workers in the same session (excludes me). */
  others: SessionUser[];
  /** Active claims held by users other than me — keyed by pallet_idx. */
  othersClaims: PalletClaim[];
  /** Pallet indices currently unclaimed (no active claim row). */
  freeIdxs: number[];
  /** Claims that are active AND >5 min idle — takeover candidates. */
  staleClaims: PalletClaim[];
  /** Server-stored per-user progress map (OPAQUE — read both snake/camel). */
  userProgress: Record<UUID, UserPalletProgress>;
  /** Per-user progress entry for the caller, or null if absent. */
  myProgress: UserPalletProgress | null;
  /** Server-derived membership flag. */
  inSession: boolean;
  /** Pending state — useful for spinners. */
  joining: boolean;
  claiming: boolean;
  releasing: boolean;
  takingOver: boolean;
  leaving: boolean;
  /** Imperative actions. claim() throws ApiError(409) when occupied. */
  join(): Promise<AuftragDetail | null>;
  leave(): Promise<AuftragDetail | null>;
  claim(palletIdx: number): Promise<AuftragDetail | null>;
  release(palletIdx: number, completed?: boolean): Promise<AuftragDetail | null>;
  takeover(palletIdx: number): Promise<AuftragDetail | null>;
}

/** Resolve the user_progress map's snake/camel inner-key variants so
 *  consumers can read a single shape. Backend stores raw JSONB keyed
 *  by user UUID; the OPAQUE pass-through in marathonApi.ts leaves
 *  the *outer* keys intact and the *inner* objects unconverted. */
export function readUserProgress(
  raw: unknown, userId: string,
): UserPalletProgress | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = (raw as Record<string, unknown>)[userId];
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  const out: UserPalletProgress = {};
  const cpi = e.current_pallet_idx ?? e.currentPalletIdx;
  const cii = e.current_item_idx ?? e.currentItemIdx;
  const ck = e.copied_keys ?? e.copiedKeys;
  if (typeof cpi === 'number') out.currentPalletIdx = cpi;
  if (typeof cii === 'number') out.currentItemIdx = cii;
  if (ck && typeof ck === 'object') out.copiedKeys = ck as Record<string, number | true>;
  return out;
}

/** Build a fresh AuftragDetail with the cache patched by the optimistic
 *  update; falls back to the input when the cache is empty. */
function patchAuftragInList(
  qc: ReturnType<typeof useQueryClient>,
  id: UUID,
  patch: (a: AuftragDetail) => AuftragDetail,
): AuftragDetail[] | undefined {
  return qc.setQueryData<AuftragDetail[]>(
    ['auftraege'],
    (old) => (old || []).map((a) => (a.id === id ? patch(a) : a)),
  );
}

export function useFocusSession(
  auftrag: AuftragDetail | null | undefined,
): UseFocusSessionResult {
  const qc = useQueryClient();
  const me = useMe().data;

  const auftragId = auftrag?.id ?? null;
  const meId = me?.id ?? null;

  const myClaim = useMemo<PalletClaim | null>(() => {
    if (!auftrag || !meId) return null;
    return (auftrag.palletClaims ?? []).find(
      (c) => c.userId === meId && c.state === 'active',
    ) ?? null;
  }, [auftrag, meId]);

  const others = useMemo<SessionUser[]>(() => {
    if (!auftrag || !meId) return [];
    return (auftrag.sessionUsers ?? []).filter((u) => u.userId !== meId);
  }, [auftrag, meId]);

  const othersClaims = useMemo<PalletClaim[]>(() => {
    if (!auftrag || !meId) return [];
    return (auftrag.palletClaims ?? []).filter(
      (c) => c.userId !== meId && c.state === 'active',
    );
  }, [auftrag, meId]);

  const freeIdxs = useMemo<number[]>(() => {
    if (!auftrag) return [];
    const palletCount = auftrag.parsed?.pallets?.length ?? 0;
    const occupied = new Set(
      (auftrag.palletClaims ?? [])
        .filter((c) => c.state === 'active' || c.state === 'completed')
        .map((c) => c.palletIdx),
    );
    const out: number[] = [];
    for (let i = 0; i < palletCount; i++) if (!occupied.has(i)) out.push(i);
    return out;
  }, [auftrag]);

  const staleClaims = useMemo<PalletClaim[]>(() => {
    if (!auftrag) return [];
    const now = Date.now();
    return (auftrag.palletClaims ?? []).filter((c) => {
      if (c.state !== 'active') return false;
      if (c.isStale) return true;
      const hb = Date.parse(c.heartbeatAt);
      return Number.isFinite(hb) && now - hb > STALE_MS;
    });
  }, [auftrag]);

  const userProgress = (auftrag?.userProgress ?? {}) as Record<UUID, UserPalletProgress>;
  const myProgress = useMemo<UserPalletProgress | null>(() => {
    if (!auftrag || !meId) return null;
    return readUserProgress(auftrag.userProgress, meId);
  }, [auftrag, meId]);

  const inSession = useMemo(() => {
    if (!auftrag || !meId) return false;
    return (auftrag.sessionUsers ?? []).some((u) => u.userId === meId);
  }, [auftrag, meId]);

  /* ── Mutations ───────────────────────────────────────────────────── */
  const onSettled = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['auftraege'] });
  }, [qc]);

  const joinMut = useMutation<AuftragDetail, ApiError, UUID, { prev?: AuftragDetail[] }>({
    mutationFn: (id) => apiJoin(id),
    onSettled,
  });

  const leaveMut = useMutation<AuftragDetail, ApiError, UUID, { prev?: AuftragDetail[] }>({
    mutationFn: (id) => apiLeave(id),
    onSettled,
  });

  const claimMut = useMutation<
    AuftragDetail, ApiError, { id: UUID; palletIdx: number },
    { prev?: AuftragDetail[] }
  >({
    mutationFn: ({ id, palletIdx }) => apiClaim(id, palletIdx),
    onMutate: async ({ id, palletIdx }) => {
      await qc.cancelQueries({ queryKey: ['auftraege'] });
      const prev = qc.getQueryData<AuftragDetail[]>(['auftraege']);
      if (meId) {
        patchAuftragInList(qc, id, (a) => ({
          ...a,
          palletClaims: [
            // Drop any prior released/taken_over row for this pallet
            // so the optimistic active row is unambiguous.
            ...(a.palletClaims ?? []).filter(
              (c) => !(c.palletIdx === palletIdx && c.state === 'active'),
            ),
            {
              palletIdx,
              userId: meId,
              userName: me?.name ?? '',
              state: 'active',
              claimedAt: new Date().toISOString(),
              heartbeatAt: new Date().toISOString(),
              releasedAt: null,
              isStale: false,
            },
          ],
        }));
      }
      return { prev };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['auftraege'], ctx.prev);
    },
    onSettled,
  });

  const releaseMut = useMutation<
    AuftragDetail, ApiError, { id: UUID; palletIdx: number; completed: boolean },
    { prev?: AuftragDetail[] }
  >({
    mutationFn: ({ id, palletIdx, completed }) => apiRelease(id, palletIdx, completed),
    onMutate: async ({ id, palletIdx, completed }) => {
      await qc.cancelQueries({ queryKey: ['auftraege'] });
      const prev = qc.getQueryData<AuftragDetail[]>(['auftraege']);
      if (meId) {
        patchAuftragInList(qc, id, (a) => ({
          ...a,
          palletClaims: (a.palletClaims ?? []).map((c) =>
            c.palletIdx === palletIdx && c.userId === meId && c.state === 'active'
              ? { ...c, state: completed ? 'completed' : 'released', releasedAt: new Date().toISOString() }
              : c,
          ),
        }));
      }
      return { prev };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['auftraege'], ctx.prev);
    },
    onSettled,
  });

  const takeoverMut = useMutation<
    AuftragDetail, ApiError, { id: UUID; palletIdx: number },
    { prev?: AuftragDetail[] }
  >({
    mutationFn: ({ id, palletIdx }) => apiTakeover(id, palletIdx),
    onSettled,
  });

  const heartbeatMut = useMutation({
    mutationFn: (id: UUID) => apiHeartbeat(id),
    retry: false,
    /* Heartbeat is fire-and-forget — no cache patch, no invalidate.
       The next 3-second poll picks up the bumped heartbeat_at. */
  });

  /* ── Auto-join + heartbeat lifecycle ──────────────────────────────── */
  // Latest auftrag ref so the heartbeat tick captures it without
  // becoming an effect dependency (would restart the interval every poll).
  const auftragRef: RefObject<AuftragDetail | null> = useRef<AuftragDetail | null>(null);
  auftragRef.current = auftrag ?? null;

  // Auto-join when arriving on Focus and we're not yet a member.
  useEffect(() => {
    if (!auftragId || !meId) return;
    if (!auftrag || auftrag.status !== 'in_progress') return;
    const already = (auftrag.sessionUsers ?? []).some((u) => u.userId === meId);
    if (already) return;
    joinMut.mutate(auftragId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auftragId, meId, !!auftrag?.sessionUsers?.length]);

  // Heartbeat: armed only when we hold an active claim. !!myClaim keys
  // the interval so it isn't recreated on every 3-second poll.
  const hasClaim = !!myClaim;
  useEffect(() => {
    if (!auftragId || !hasClaim) return;
    const tick = () => {
      const a = auftragRef.current;
      if (!a || a.status !== 'in_progress') return;
      heartbeatMut.mutate(a.id);
    };
    tick();
    const t = window.setInterval(tick, HEARTBEAT_MS);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auftragId, hasClaim]);

  /* ── Imperative actions ───────────────────────────────────────────── */
  const join = useCallback(async () => {
    if (!auftragId) return null;
    return joinMut.mutateAsync(auftragId).catch((e) => {
      if (e instanceof ApiError && e.status === 409) {
        // Surface a typed null + invalidate; caller decides whether to toast.
        onSettled();
        return null;
      }
      throw e;
    });
  }, [auftragId, joinMut, onSettled]);

  const leave = useCallback(async () => {
    if (!auftragId) return null;
    return leaveMut.mutateAsync(auftragId);
  }, [auftragId, leaveMut]);

  const claim = useCallback(async (palletIdx: number) => {
    if (!auftragId) return null;
    return claimMut.mutateAsync({ id: auftragId, palletIdx });
  }, [auftragId, claimMut]);

  const release = useCallback(async (palletIdx: number, completed = false) => {
    if (!auftragId) return null;
    return releaseMut.mutateAsync({ id: auftragId, palletIdx, completed });
  }, [auftragId, releaseMut]);

  const takeover = useCallback(async (palletIdx: number) => {
    if (!auftragId) return null;
    return takeoverMut.mutateAsync({ id: auftragId, palletIdx });
  }, [auftragId, takeoverMut]);

  return {
    myClaim, others, othersClaims, freeIdxs, staleClaims,
    userProgress, myProgress, inSession,
    joining: joinMut.isPending,
    claiming: claimMut.isPending,
    releasing: releaseMut.isPending,
    takingOver: takeoverMut.isPending,
    leaving: leaveMut.isPending,
    join, leave, claim, release, takeover,
  };
}
