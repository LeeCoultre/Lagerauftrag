/* Focus — Schritt 03. Single-article workflow.

   Visual ethos: the page does NOT scroll. One hero card holds every
   fact about the current article; pallet/item state is folded into a
   thin progress strip inside the StickyBar. No StepperBar — the
   workflow stepper is hidden because Focus IS the focused state.

   Card layout (Apple-clean, hairline-bordered, soft shadow):

     ┌─ ArticleHeroCard ────────────────────────────────────────┐
     │ [01 / 12 · PAL003]      [L1 Thermorollen] [ESKU][flags]  │
     │                                                          │
     │ ┌─ Article (LEFT) ──────┐ │ ┌─ Codes (RIGHT) ────────┐   │
     │ │ THERMOROLLE           │ │ │ ARTIKEL-CODE  · C      │   │
     │ │ 57 × 18 · 20 Rollen   │ │ │ X0010197UP   ← dominant │   │
     │ │                       │ │ │ ─────                  │   │
     │ │ MENGE                 │ │ │ USE-ITEM      · U      │   │
     │ │ 25  Kartons           │ │ │ 4006381234567 ← quiet  │   │
     │ │ → 500 Rollen gesamt   │ │ │                        │   │
     │ └───────────────────────┘ │ └────────────────────────┘   │
     └──────────────────────────────────────────────────────────┘

     ┌─ FocusStickyBar (fixed bottom) ─────────────────────────┐
     │ [P01•][P02•][P03●][...]   │   [1✓ 2✓ 3● 4 5 6 7 ...]    │
     │ ●  Bereit · PAL003 · 5/12   ← 5/12 →   [Artikel ✓]      │
     └──────────────────────────────────────────────────────────┘

   Persistence: copiedKeys is server-backed via /api/auftraege/.../
   progress copied_keys JSONB. Reload no longer wipes chip state. */

import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppState } from '@/state.jsx';
import {
  focusItemView, sortItemsForPallet, distributeEinzelneSku, applyEskuOverrides, eskuOverrideKey,
  enrichItemDims, getDisplayLevel, LEVEL_META, formatItemTitle,
  extractProduktionPerCarton, singleSkuClusterKey, itemTotalVolumeCm3, itemTotalWeightKg, largeBaseRank,
  PALLET_VOL_CM3, cartonShapeMm, computePalletIntensityProfile,
} from '@/utils/auftragHelpers.js';
import { lookupSkuDimensions } from '@/marathonApi.js';
import { detectWiederholt } from '@/utils/wiederholtLogic.js';
import { useBetaDesign } from '@/hooks/useBetaDesign';
import { useWorkSchedule } from '@/hooks/useWorkSchedule';
import { effectiveElapsedMs, workPhaseAt, formatTimeInTz } from '@/utils/workTime';
import { Page, Topbar, Button, Badge, StudioFrame, T } from '@/components/ui.jsx';
import PalletInterlude, { resetSkipCount } from '@/components/PalletInterlude.jsx';
import AuftragFinaleStage from '@/components/AuftragFinaleStage.jsx';
import EskuMovePopover from '@/components/EskuMovePopover.jsx';
import CancelAuftragModal from '@/components/CancelAuftragModal';
import { useConfirm } from '@/components/ConfirmDialog';
import BoxIso from '@/components/BoxIso';
import { useDeclareFocusActive } from '@/hooks/useFocusPresence';
import { useFocusSession } from '@/hooks/useSession';
import { useMe } from '@/hooks/useMe';
import { useQueryClient } from '@tanstack/react-query';
import type { AuftragDetail as AuftragDetailT } from '@/types/api';

const SCHNELL_KEY = 'marathon.focus.schnellmodus';
const DOPPEL_KEY  = 'marathon.focus.doppelmodus';

/* Short, human-readable pallet name. Files come in with id like
   "P1-B1" / "P2-B3"; the "-B…" suffix is the docx box number, which
   workers don't need on screen. Prefer `pallet.number` (always set by
   the parser) and fall back to stripping the suffix. Accepts either
   a pallet object or a raw id string. */
function shortPalletId(p) {
  if (!p) return '';
  if (typeof p === 'string') {
    const m = p.match(/^([A-Za-z]+\d+)/);
    return m ? m[1] : p;
  }
  if (typeof p.number === 'number') return `P${p.number}`;
  return shortPalletId(p.id || '');
}

/* ════════════════════════════════════════════════════════════════════════ */
/* Focus = Schritt 03 single-pallet workflow. Visual design driven by
   `useBetaDesign()` — classic vs. beta branches live inline within this
   one component (FlowHero/BetaIslandBar etc.). Multi-user behaviour is
   layered on top transparently: when beta is on, auto-claim happens in
   the background; UI looks identical to single-user. See useMultiUserFocus
   below for the session integration. */
export default function FocusScreen() {
  const {
    current,
    setCurrentPalletIdx: setCurrentPalletIdxRaw,
    setCurrentItemIdx, markCodeCopied,
    moveEskuToPallet,
    completeCurrentItem, cancelCurrent, abortCurrent, goToStep,
  } = useAppState();
  const [stornoOpen, setStornoOpen] = useState(false);
  const { beta: betaDesign } = useBetaDesign();
  // Multi-user session is gated on beta — auto-claim, transition
  // override and polling all live inside useMultiUserFocus. The hook
  // returns a thin handle the rest of FocusScreen consults at the few
  // touch points where pallet navigation differs from single-user.
  const session = useMultiUserFocus(current?.id ?? null, betaDesign);
  /* In beta + multi-user the worker is locked to whichever pallet
     they currently own — no manual hopping to a neighbour, which
     would step on another worker's claim. We shadow the global
     setCurrentPalletIdx with a guard so every callsite below
     (keyboard handlers, chip clicks, cross-pallet item-flow)
     becomes a no-op when a claim is held. */
  const setCurrentPalletIdx = useCallback((idx: number) => {
    if (session.hasClaim) return;
    setCurrentPalletIdxRaw(idx);
  }, [session.hasClaim, setCurrentPalletIdxRaw]);
  const confirm = useConfirm();
  const fbaCode = current?.fbaCode || current?.parsed?.meta?.sendungsnummer || current?.fileName || '';
  const eskuOverrides = current?.eskuOverrides || {};

  /* Async dim/weight enrichment (cached 5min, same key as Pruefen). */
  const sourcePallets = current?.parsed?.pallets || [];
  const rawEsku       = current?.parsed?.einzelneSkuItems || [];
  const allItems = useMemo(
    () => [...sourcePallets.flatMap((p) => p.items || []), ...rawEsku],
    [sourcePallets, rawEsku],
  );
  const dimsQ = useQuery({
    queryKey: ['sku-dims', current?.id],
    queryFn: () => enrichItemDims(allItems, lookupSkuDimensions),
    enabled: !!current?.id && allItems.length > 0,
    staleTime: 5 * 60 * 1000,
  });
  const enrichedSourcePallets = useMemo(() => {
    const enriched = dimsQ.data || null;
    let cursor = 0;
    return sourcePallets.map((p) => ({
      ...p,
      items: (p.items || []).map((origIt) => {
        const fromDims = enriched ? enriched[cursor] : null;
        cursor += 1;
        return fromDims || origIt;
      }),
    }));
  }, [sourcePallets, dimsQ.data]);
  const enrichedEsku = useMemo(() => {
    if (!dimsQ.data) return rawEsku;
    const palletItemsCount = sourcePallets.reduce((n, p) => n + (p.items?.length || 0), 0);
    return rawEsku.map((it, i) => dimsQ.data[palletItemsCount + i] || it);
  }, [rawEsku, sourcePallets, dimsQ.data]);
  const distribution = useMemo(
    () => {
      const auto = distributeEinzelneSku(enrichedSourcePallets, enrichedEsku);
      return applyEskuOverrides(auto, eskuOverrides, enrichedSourcePallets);
    },
    [enrichedSourcePallets, enrichedEsku, eskuOverrides],
  );
  const palletStates = distribution.palletStates;

  const rawPallets = useMemo(
    () => enrichedSourcePallets.map((p) => {
      /* Large-base ESKU goes to the START of the pallet:
           rank 2  →  80×80 only          (FIRST, heaviest flat base)
           rank 1  →  57×63m / 58×64     (after 80×80, before Mixed)
           rank 0  →  not a base format  (MERGED with Mixed and
                                          re-sorted by level — so an L1
                                          ESKU 80×63 lands in the L1
                                          group with Mixed L1 instead of
                                          being dumped after L5+) */
      const eskuRaw     = distribution.byPalletId[p.id] || [];
      const base80      = sortItemsForPallet(eskuRaw.filter((x) => largeBaseRank(x) === 2));
      const baseOther   = sortItemsForPallet(eskuRaw.filter((x) => largeBaseRank(x) === 1));
      const restEsku    = eskuRaw.filter((x) => largeBaseRank(x) === 0);
      const combined    = sortItemsForPallet([...(p.items || []), ...restEsku]);
      return { ...p, items: [...base80, ...baseOther, ...combined] };
    }),
    [enrichedSourcePallets, distribution],
  );

  /* In beta + multi-user, the worker's pallet is whichever one they
     currently own (session.palletIdxOverride). Outside beta or before
     auto-claim resolves, fall back to the shared current_pallet_idx
     field — same source-of-truth as before multi-user. */
  const palletIdxRaw = session.palletIdxOverride ?? current?.currentPalletIdx ?? 0;
  const palletIdx = Math.min(palletIdxRaw, Math.max(0, rawPallets.length - 1));
  const itemIdx   = current?.currentItemIdx ?? 0;
  const completedKeysObj = current?.completedKeys || {};

  const rawPallet = rawPallets[palletIdx];
  const rawItem   = rawPallet?.items?.[Math.min(itemIdx, (rawPallet?.items?.length || 1) - 1)];
  const pallet = rawPallet ? {
    id: rawPallet.id,
    items: rawPallet.items.map(focusItemView),
  } : null;
  const item = rawItem ? focusItemView(rawItem) : null;

  /* Next article on the SAME pallet — used by Doppel-Artikel-Modus.
     Intentionally null on the last item of a pallet so the second slot
     hides cleanly at pallet boundaries (no "Nächste Palette" preview). */
  const rawNextItem = rawPallet?.items?.[itemIdx + 1] || null;
  const nextItem = rawNextItem ? focusItemView(rawNextItem) : null;

  /* ── view-only state ── */
  const [wiederholt, setWiederholt] = useState<{ code?: string; units?: number; palletId?: string; name?: string } | null>(null);
  const [flashUse,   setFlashUse]   = useState<unknown | null>(null);
  const [interlude,  setInterlude]  = useState<{ id: string; itemCount: number; weightKg: unknown; volCm3: unknown; durationMs: number; nextPallet: unknown; nextHints: Array<{ tone: 'danger' | 'warn' | 'info'; label: string; detail?: string }> } | null>(null);
  const [finale,     setFinale]     = useState(false);
  /* «Zen»-Modus — Klick auf den freien Bereich (oder Z-Taste) blendet
     alles bis auf das Wesentliche aus: Artikelname, Menge, Codes. */
  const [zen,        setZen]        = useState(false);
  /* Whether the finale is "armed" — set true the moment the worker
     clicks Fertig on the last item of the last pallet. Without this
     gate the all-done detection effect would also trigger when the
     worker navigates back to Focus from Abschluss (cursor is past last
     item from a previous completion → effect would re-fire and bounce
     them right back to Abschluss). */
  const [finalePending, setFinalePending] = useState(false);

  const [schnellmodus, setSchnellmodus] = useState(() => {
    try { return localStorage.getItem(SCHNELL_KEY) === '1'; } catch { return false; }
  });
  const [doppelmodus, setDoppelmodus] = useState(() => {
    try { return localStorage.getItem(DOPPEL_KEY) === '1'; } catch { return false; }
  });
  const reducedMotion = useReducedMotion();

  /* Overlay state — full list of every pallet + its articles. */
  const [palletListOpen, setPalletListOpen] = useState(false);

  /* Local display-order override for pallets. Null = use the parser
     order. When the worker drags-to-reorder, we store an array of
     pallet IDs in the desired display order. The override applies to
     the displayed strip only — the workflow state (currentPalletIdx,
     copiedKeys, palletStates) stays tied to rawPallets by id, and we
     remap indices at the PalletFlow boundary. */
  const [palletOrderOverride, setPalletOrderOverride] = useState<string[] | null>(null);

  /* Per-pallet article order override (palletId → array of ORIGINAL
     item indices in display order). Same idea as the pallet override
     but at item granularity, applied only inside the Liste overlay
     and propagated to the chip strip / workflow via index remap. */
  const [articleOrderOverride, setArticleOrderOverride] =
    useState<Record<string, number[]>>({});

  /* copiedKeys derived from server-persisted current.copiedKeys. */
  const copiedKeys = useMemo(
    () => new Set(Object.keys(current?.copiedKeys || {})),
    [current?.copiedKeys],
  );

  /* Apply BOTH overrides:
       1. pallet-level: reorder the pallets array
       2. article-level: reorder items inside each pallet
     Either override is dropped silently if it's stale (size mismatch,
     missing id, etc.) so the UI stays consistent with the workflow. */
  const displayPallets = useMemo(() => {
    /* Step 1 — pallet order */
    let base: typeof rawPallets;
    if (!palletOrderOverride || palletOrderOverride.length !== rawPallets.length) {
      base = rawPallets;
    } else {
      const byId = new Map(rawPallets.map((p) => [p.id, p]));
      const out: typeof rawPallets = [];
      for (const id of palletOrderOverride) {
        const p = byId.get(id);
        if (p) out.push(p);
      }
      base = out.length === rawPallets.length ? out : rawPallets;
    }
    /* Step 2 — article order within each pallet */
    return base.map((p) => {
      const order = articleOrderOverride[p.id];
      const items = p.items || [];
      if (!order || order.length !== items.length) return p;
      const reordered = order.map((i) => items[i]).filter(Boolean);
      if (reordered.length !== items.length) return p;
      return { ...p, items: reordered };
    });
  }, [rawPallets, palletOrderOverride, articleOrderOverride]);

  /* origIdx → displayIdx — used to remap copiedKeys + currentPalletIdx
     into PalletFlow's display coordinates. */
  const origToDisplayIdx = useMemo(() => {
    const m = new Map<number, number>();
    rawPallets.forEach((p, origIdx) => {
      m.set(origIdx, displayPallets.findIndex((d) => d.id === p.id));
    });
    return m;
  }, [rawPallets, displayPallets]);

  /* Helpers to translate item indices through the per-pallet article
     order override. origItemIdx → displayItemIdx for chip strip;
     displayItemIdx → origItemIdx when the user clicks a chip. */
  const articleOrigToDisplay = (palletId: string, origItemIdx: number) => {
    const order = articleOrderOverride[palletId];
    return order ? order.indexOf(origItemIdx) : origItemIdx;
  };
  const articleDisplayToOrig = (palletId: string, displayItemIdx: number) => {
    const order = articleOrderOverride[palletId];
    return order ? order[displayItemIdx] ?? displayItemIdx : displayItemIdx;
  };

  const displayCopiedKeys = useMemo(() => {
    const out = new Set<string>();
    copiedKeys.forEach((k) => {
      const [oi, ii] = k.split('|');
      const origPalletIdx = +oi;
      const origItemIdx = +ii;
      const displayPalletIdx = origToDisplayIdx.get(origPalletIdx);
      if (displayPalletIdx == null || displayPalletIdx < 0) return;
      const palletId = rawPallets[origPalletIdx]?.id;
      if (!palletId) return;
      const displayItemIdx = articleOrigToDisplay(palletId, origItemIdx);
      if (displayItemIdx < 0) return;
      out.add(`${displayPalletIdx}|${displayItemIdx}`);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copiedKeys, origToDisplayIdx, articleOrderOverride, rawPallets]);

  /* Server-persisted "Fertig"-completed items, projected onto display
     coordinates. PalletFlow uses this to mark a pallet 'done' (green
     checkmark) ONLY when every item on it has actually been Fertig'd —
     copying all codes alone no longer auto-greens the pallet. */
  const displayCompletedKeys = useMemo(() => {
    const out = new Set<string>();
    for (const key of Object.keys(completedKeysObj)) {
      // Key format from state.completeCurrentItem: `palletId|itemIdx|code`
      const firstSep = key.indexOf('|');
      if (firstSep < 0) continue;
      const palletId = key.slice(0, firstSep);
      const rest = key.slice(firstSep + 1);
      const secondSep = rest.indexOf('|');
      if (secondSep < 0) continue;
      const origItemIdx = parseInt(rest.slice(0, secondSep), 10);
      if (!Number.isFinite(origItemIdx)) continue;
      const origPalletIdx = rawPallets.findIndex((p) => p.id === palletId);
      if (origPalletIdx < 0) continue;
      const displayPalletIdx = origToDisplayIdx.get(origPalletIdx);
      if (displayPalletIdx == null || displayPalletIdx < 0) continue;
      const displayItemIdx = articleOrigToDisplay(palletId, origItemIdx);
      if (displayItemIdx < 0) continue;
      out.add(`${displayPalletIdx}|${displayItemIdx}`);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedKeysObj, rawPallets, origToDisplayIdx, articleOrderOverride]);

  const displayCurrentIdx = origToDisplayIdx.get(palletIdx) ?? palletIdx;
  const currentPalletId = rawPallets[palletIdx]?.id || '';
  const displayCurrentItemIdx = articleOrigToDisplay(currentPalletId, itemIdx);

  /* Whether the article displayed in the Hero is in completedKeys.
     True the moment Fertig is pressed (briefly visible before cursor
     advances) and whenever the worker navigates back to a Fertig'd
     item via the chip strip — drives Hero's success styling. */
  const currentIsCompleted = displayCompletedKeys.has(
    `${displayCurrentIdx}|${displayCurrentItemIdx}`,
  );

  /* Stable callback for the chip strip — keeps NumberedChip's React.memo
     effective. Re-binds only when the active pallet id (translation key)
     or the override map changes. */
  const handlePickItem = useCallback((displayItemIdx: number) => {
    const order = articleOrderOverride[currentPalletId];
    const rawIdx = order ? (order[displayItemIdx] ?? displayItemIdx) : displayItemIdx;
    setCurrentItemIdx(rawIdx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPalletId, articleOrderOverride, setCurrentItemIdx]);

  /* Totals + position. */
  const totalArticles  = rawPallets.reduce((s, p) => s + p.items.length, 0);
  const completedCount = Object.keys(completedKeysObj).length;
  const overallPct     = totalArticles > 0 ? completedCount / totalArticles : 0;

  let articlesBefore = 0;
  for (let i = 0; i < palletIdx; i++) articlesBefore += rawPallets[i].items.length;
  const overallPos = articlesBefore + itemIdx + 1;

  /* Gating */
  const missingCopies = useMemo(() => {
    if (!rawPallet) return [];
    const out: number[] = [];
    for (let i = 0; i < rawPallet.items.length; i++) {
      if (!copiedKeys.has(`${palletIdx}|${i}`)) out.push(i);
    }
    return out;
  }, [rawPallet, palletIdx, copiedKeys]);
  const allPalletCopied   = missingCopies.length === 0;

  /* Raw item indices of the current pallet whose code has been
     copied — drives the green «successful» background of compact
     rows in FlowStream (mirrors FlowHero's `copied` green state). */
  const currentPalletCopiedIdxs = useMemo(() => {
    const out = new Set<number>();
    if (!rawPallet) return out;
    for (let i = 0; i < rawPallet.items.length; i++) {
      if (copiedKeys.has(`${palletIdx}|${i}`)) out.add(i);
    }
    return out;
  }, [rawPallet, palletIdx, copiedKeys]);

  /* Raw item indices of the current pallet that have been Fertig'd
     (server-persisted completedKeys). Key format is
     `palletId|origItemIdx|code` — filter by current pallet id. Drives
     the Beta-mode split: completed items leave FlowStream and collect
     in the «Erledigt»-Strip above the carousel. */
  const currentPalletCompletedIdxs = useMemo(() => {
    const out = new Set<number>();
    if (!rawPallet) return out;
    const prefix = `${rawPallet.id}|`;
    for (const key of Object.keys(completedKeysObj)) {
      if (!key.startsWith(prefix)) continue;
      const parts = key.split('|');
      if (parts.length < 3) continue;
      const idx = parseInt(parts[1], 10);
      if (Number.isFinite(idx)) out.add(idx);
    }
    return out;
  }, [rawPallet, completedKeysObj]);

  /* Per-pallet volume statistics — drives the FlowCompactRow mini-bar's
     RELATIVE rendering. Bars are normalized to `maxItemVolCm3` (biggest
     item on this pallet = full bar; others scaled proportionally), with
     `palletTotalVolCm3` providing the tooltip's «share of pallet»
     denominator. `palletStates[id].volCm3` is pre-computed by
     distributeEinzelneSku for Mixed + ESKU; manual sum falls back when
     palletStates isn't ready yet. */
  const palletVolStats = useMemo(() => {
    if (!rawPallet) return { maxItemVolCm3: 0, palletTotalVolCm3: 0 };
    const vols = rawPallet.items.map((it) => itemTotalVolumeCm3(it));
    return {
      maxItemVolCm3: vols.length ? Math.max(...vols) : 0,
      palletTotalVolCm3: palletStates?.[rawPallet.id]?.volCm3
        || vols.reduce((s, v) => s + v, 0),
    };
  }, [rawPallet, palletStates]);
  const isLastItemOfPallet = rawPallet && itemIdx === rawPallet.items.length - 1;
  const blockMessage = useCallback(() =>
    `Bitte zuerst alle Artikel-Codes der aktuellen Palette kopieren ` +
    `(${missingCopies.length} fehlen noch), bevor du diese Palette abschließt.`,
  [missingCopies.length]);

  /* Next-pallet raw index that honours the display reorder
     (palletOrderOverride). Returns null when the current pallet is
     the last one in display order. */
  const nextDisplayPalletRawIdx = useCallback((rawIdx: number): number | null => {
    const displayIdx = origToDisplayIdx.get(rawIdx);
    if (displayIdx == null || displayIdx < 0) return null;
    const next = displayPallets[displayIdx + 1];
    if (!next) return null;
    const nextRaw = rawPallets.findIndex((p) => p.id === next.id);
    return nextRaw >= 0 ? nextRaw : null;
  }, [origToDisplayIdx, displayPallets, rawPallets]);

  /* Prev-pallet raw index that honours the display reorder. Returns
     null when the current pallet is the first one in display order. */
  const prevDisplayPalletRawIdx = useCallback((rawIdx: number): number | null => {
    const displayIdx = origToDisplayIdx.get(rawIdx);
    if (displayIdx == null || displayIdx <= 0) return null;
    const prev = displayPallets[displayIdx - 1];
    if (!prev) return null;
    const prevRaw = rawPallets.findIndex((p) => p.id === prev.id);
    return prevRaw >= 0 ? prevRaw : null;
  }, [origToDisplayIdx, displayPallets, rawPallets]);

  const buildInterludePayload = useCallback((idx) => {
    const p = rawPallets[idx];
    if (!p) return null;
    const ps = palletStates?.[p.id];
    const timing = current?.palletTimings?.[p.id];
    const durationMs = (timing?.startedAt && timing?.finishedAt)
      ? (timing.finishedAt - timing.startedAt)
      : (timing?.startedAt ? Date.now() - timing.startedAt : 0);
    /* Pass the FULL next-pallet object so the checkpoint can render
       its level-fingerprint preview using the same vocabulary as the
       StickyBar flow (LEVEL_META colors + per-item cells). Follows the
       display reorder so the preview matches what comes next visually. */
    const nextRawIdx = nextDisplayPalletRawIdx(idx);
    const nextPallet = nextRawIdx != null ? rawPallets[nextRawIdx] : null;

    /* Worth-noting hints for the NEXT pallet, surfaced as a compact
       Hinweise strip inside the interlude card. Empty array = nothing
       worth flagging, the strip stays hidden. Tones map to T.status.
       Order: hard-block first (4-Seiten), then physical limits, then
       informational. Wording stays terse — the worker re-derives
       context from the FBA chip / level dashes. */
    const nextHints: Array<{ tone: 'danger' | 'warn' | 'info'; label: string; detail?: string }> = [];
    if (nextPallet) {
      const nextPS = palletStates?.[nextPallet.id];
      if (nextPallet.hasFourSideWarning) {
        nextHints.push({
          tone: 'danger',
          label: '4-Seiten-Warnung',
          detail: 'Single-SKU · keine ESKU erlaubt',
        });
      }
      if (nextPS?.overloadFlags?.has?.('OVERLOAD-W')) {
        nextHints.push({
          tone: 'warn',
          label: 'Übergewicht',
          detail: `${Math.round(nextPS.weightKg || 0)} kg · Limit 700 kg`,
        });
      }
      if (nextPS?.overloadFlags?.has?.('OVERLOAD-V')) {
        nextHints.push({
          tone: 'warn',
          label: 'Übervolumen',
          detail: `${(((nextPS.volCm3 || 0) / 1e6)).toFixed(2)} m³ · Limit 1.59 m³`,
        });
      }
      const eskuOnNext = distribution?.byPalletId?.[nextPallet.id]?.length || 0;
      if (eskuOnNext > 0) {
        nextHints.push({
          tone: 'info',
          label: 'ESKU dabei',
          detail: `${eskuOnNext} Einzelne SKU eingeplant`,
        });
      }
      const itemCount = (nextPallet.items || []).length;
      if (itemCount >= 18) {
        nextHints.push({
          tone: 'info',
          label: 'Viele Artikel',
          detail: `${itemCount} Stück auf einer Palette`,
        });
      }
    }

    return {
      id: p.id,
      itemCount: p.items.length,
      weightKg: ps?.weightKg || 0,
      volCm3:   ps?.volCm3   || 0,
      durationMs,
      nextPallet,
      nextHints,
    };
  }, [rawPallets, palletStates, distribution, current?.palletTimings, nextDisplayPalletRawIdx]);

  /* ── Navigation ──
     Arrow-keys (and StickyBar prev/next buttons) walk the items in
     DISPLAY order so a reorder via the Liste overlay actually takes
     effect. Internally we still store the raw item index, so each
     step translates display ↔ orig via articleOrderOverride. */
  const goNextItem = useCallback(() => {
    if (!rawPallet) return;
    const palletId = rawPallet.id;
    const total = rawPallet.items.length;
    const displayIdx = articleOrigToDisplay(palletId, itemIdx);
    if (displayIdx + 1 < total) {
      const nextRawIdx = articleDisplayToOrig(palletId, displayIdx + 1);
      setCurrentItemIdx(nextRawIdx);
      return;
    }
    // Cross-pallet step: next pallet in display order, start at its
    // first display-item (also remapped through its own override).
    const nextPalletRaw = nextDisplayPalletRawIdx(palletIdx);
    if (nextPalletRaw != null) {
      if (!allPalletCopied) {
        alert(blockMessage());
        return;
      }
      const nextPalletId = rawPallets[nextPalletRaw]?.id;
      const firstRawIdx = nextPalletId
        ? articleDisplayToOrig(nextPalletId, 0)
        : 0;
      setInterlude(buildInterludePayload(palletIdx));
      setCurrentPalletIdx(nextPalletRaw);
      if (firstRawIdx !== 0) setTimeout(() => setCurrentItemIdx(firstRawIdx), 0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawPallet, itemIdx, palletIdx, rawPallets, allPalletCopied,
      setCurrentItemIdx, setCurrentPalletIdx, buildInterludePayload,
      nextDisplayPalletRawIdx, articleOrderOverride]);

  const goPrevItem = useCallback(() => {
    if (!rawPallet) return;
    const palletId = rawPallet.id;
    const displayIdx = articleOrigToDisplay(palletId, itemIdx);
    if (displayIdx > 0) {
      const prevRawIdx = articleDisplayToOrig(palletId, displayIdx - 1);
      setCurrentItemIdx(prevRawIdx);
      return;
    }
    // Cross-pallet step backwards: prev pallet in display order,
    // land on its LAST display-item.
    const prevPalletRaw = prevDisplayPalletRawIdx(palletIdx);
    if (prevPalletRaw != null) {
      const prevPalletId = rawPallets[prevPalletRaw]?.id;
      const prevLen = rawPallets[prevPalletRaw]?.items?.length ?? 0;
      const lastRawIdx = prevPalletId
        ? articleDisplayToOrig(prevPalletId, Math.max(0, prevLen - 1))
        : Math.max(0, prevLen - 1);
      setCurrentPalletIdx(prevPalletRaw);
      setTimeout(() => setCurrentItemIdx(lastRawIdx), 0);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawPallet, itemIdx, palletIdx, rawPallets,
      setCurrentItemIdx, setCurrentPalletIdx,
      prevDisplayPalletRawIdx, articleOrderOverride]);

  const handleFertig = useCallback(() => {
    if (!rawPallet || !rawItem) return;
    /* Article cannot be completed until its Artikel-Code has been
       copied. Catches the worker pressing Space/Enter or clicking
       Fertig before they've actually scanned the code. */
    if (!copiedKeys.has(`${palletIdx}|${itemIdx}`)) return;
    if (isLastItemOfPallet && !allPalletCopied) {
      alert(blockMessage());
      return;
    }
    const wasLastOfPallet = isLastItemOfPallet;

    /* Multi-user transition (beta only, when we hold a claim): instead
       of advancing currentPalletIdx via classic auto-next, we release
       our pallet as completed and immediately claim the next free one.
       Backend auto-completes the whole Auftrag once the last pallet is
       released — polling then routes us to Abschluss. */
    if (wasLastOfPallet && session.hasClaim) {
      /* Write the final item's completedKeys without changing pallet
         position; the release call below is the source-of-truth for
         pallet ownership. */
      completeCurrentItem(rawPallet.items.length, rawItem, palletIdx);
      void (async () => {
        const advanced = await session.releaseAndClaimNext(palletIdx);
        if (!advanced) {
          /* No more free pallets. Either backend auto-completed (poll
             will route us), or every remaining pallet is held by another
             worker. Show the finale gate so the UI doesn't sit blank. */
          setFinalePending(true);
        } else {
          setInterlude(buildInterludePayload(palletIdx));
        }
      })();
      return;
    }

    // "Last of Auftrag" follows the display order, not raw indices, so
    // a reorder like P1 > P3 > P2 ends the auftrag after P2 (the last
    // visible pallet) instead of after the last raw pallet.
    const nextRawIdx = wasLastOfPallet ? nextDisplayPalletRawIdx(palletIdx) : null;
    const wasLastOfAuftrag = wasLastOfPallet && nextRawIdx == null;

    completeCurrentItem(rawPallet.items.length, rawItem, nextRawIdx ?? undefined);

    if (wasLastOfPallet && !wasLastOfAuftrag) {
      setInterlude(buildInterludePayload(palletIdx));
    }
    if (wasLastOfAuftrag) {
      setFinalePending(true);   // arm the finale gate
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawPallet, rawItem, rawPallets, palletIdx, itemIdx, isLastItemOfPallet,
      allPalletCopied, copiedKeys, completeCurrentItem, buildInterludePayload,
      nextDisplayPalletRawIdx, session.hasClaim, session.releaseAndClaimNext]);

  /* Wiederholt hit for the CURRENT article — computed per position so the
     hero card can flag it (badge) and the overlay can fire on first copy.
     `detectWiederholt` already suppresses noise (continuous repeats,
     skip when next pallet has no high-quantity hit). */
  const currentWiederholt = useMemo(
    () => detectWiederholt(rawPallets, palletIdx, itemIdx),
    [rawPallets, palletIdx, itemIdx],
  );

  /* Re-copy pulse — bumps a counter every time the worker copies the
     Artikel-Code while it's already marked kopiert. The Hero card
     uses the counter as an animation key to replay the flash even
     on identical consecutive re-copies. */
  const [reCopyTick, setReCopyTick] = useState(0);

  const onCopyArtikelCode = useCallback(() => {
    if (!item?.code) return;
    copyToClipboard(item.code);
    const wasAlreadyCopied = copiedKeys.has(`${palletIdx}|${itemIdx}`);
    if (wasAlreadyCopied) setReCopyTick((n) => n + 1);
    markCodeCopied(palletIdx, itemIdx);
    /* Wiederholt overlay fires on the FIRST copy of this article (not
       on Fertig). The worker has just acknowledged the code — that's
       the moment the warning about the next-pallet repeat is most
       actionable. Re-copies suppress to avoid nag. */
    if (!wasAlreadyCopied && currentWiederholt) {
      setWiederholt(currentWiederholt);
    }
  }, [item, palletIdx, itemIdx, markCodeCopied, copiedKeys, currentWiederholt]);

  const onCopyUseItem = useCallback(() => {
    if (!item?.useItem) return;
    // Copy ONLY the bare code (X001BVO9LV) — the displayed text may
    // wrap it in prose like "wird von … produziert", which the scanner
    // would choke on. focusItemView pre-extracts useItemCode for this.
    const toCopy = item.useItemCode || item.useItem;
    copyToClipboard(toCopy);
    setFlashUse(item.useItem);
    setTimeout(() => setFlashUse(null), 1200);
  }, [item]);

  const toggleSchnell = useCallback(() => {
    setSchnellmodus((v) => {
      const next = !v;
      try { localStorage.setItem(SCHNELL_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const toggleDoppel = useCallback(() => {
    setDoppelmodus((v) => {
      const next = !v;
      try { localStorage.setItem(DOPPEL_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  /* Reset only flashUse on item change — copiedCode is now derived from
     persistent copiedKeys (localStorage) below, so it survives navigation
     and returns to previously-copied articles still read as "kopiert". */
  useEffect(() => {
    setFlashUse(null);
  }, [palletIdx, itemIdx]);

  /* Persistent copy-state for the Artikel-Code card on the hero — true
     whenever this exact position (pallet + item) is in copiedKeys.
     Position-keyed only — never compare by code string, otherwise an
     identical article reused on a later pallet would inherit the prior
     pallet's green state. The localStorage write in markCodeCopied
     bumps copiedKeysVersion which immediately re-derives this. */
  const codeCopied = copiedKeys.has(`${palletIdx}|${itemIdx}`);

  /* Bottom-island intensity profile — per-item composite workload
     (units × volume × weight, normalized per-pallet) feeding the
     smooth heat-curve in BetaIslandBar. `lastCompletedIdx` drives
     the done-vs-pending opacity split inside the curve; `activeIdx`
     positions the 1px whisper marker. `null` when the pallet has
     fewer than 2 items (no curve to draw). */
  const islandIntensity = useMemo(() => {
    const items = rawPallet?.items || [];
    if (items.length < 2) return null;
    const profile = computePalletIntensityProfile(items);
    let lastCompletedIdx = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      if (currentPalletCompletedIdxs.has(i)) { lastCompletedIdx = i; break; }
    }
    /* Per-item rows fuel the expanded detail panel — same units / volume
       / weight signals that feed computePalletIntensityProfile, plus the
       completion + active flags so the panel can echo workflow state. */
    const details = items.map((it, i) => ({
      title:       parseMinimalTitle(it?.name || it?.title || '—'),
      /* Per-package content — what's inside ONE Karton/Einheit. Mirrors
         the perCarton field the hero card computes (ArticleColumn) so
         the tray and hero stay in sync. Empty string when no value is
         available (e.g., ESKU without packsPerCarton). */
      perPackage:  packageContentString(it),
      units:       Math.max(0, Number(it?.units) || 0),
      volCm3:      Math.max(0, itemTotalVolumeCm3(it) || 0),
      weightKg:    Math.max(0, itemTotalWeightKg(it) || 0),
      intensity:   profile.values[i] ?? 0,
      level:       it?.level || getDisplayLevel(it) || 1,
      isEsku:      !!(it?.isEinzelneSku || it?.isEsku),
      isCompleted: currentPalletCompletedIdxs.has(i),
      isActive:    i === itemIdx,
    }));
    return {
      values: profile.values,
      hasVariance: profile.hasVariance,
      activeIdx: itemIdx,
      lastCompletedIdx,
      palletShortId: shortPalletId(rawPallet),
      details,
    };
  }, [rawPallet, itemIdx, currentPalletCompletedIdxs]);

  /* Wiederholt: no auto-dismiss. Worker must explicitly click "OK" so
     the warning can't disappear before being acknowledged (the whole
     point is to prevent confusing two identical-looking pallets). */

  /* All-done detection — fires ONLY when finalePending was armed by
     handleFertig on the last item. Re-mounting Focus (e.g. via "Focus"
     breadcrumb from Abschluss) starts with finalePending=false → the
     finale stays closed and the worker can review their work. */
  useEffect(() => {
    if (!finalePending) return undefined;
    if (!rawPallets.length) return undefined;
    const isLastPallet = palletIdx === rawPallets.length - 1;
    const lastP = rawPallets[rawPallets.length - 1];
    const isPastLast = itemIdx >= (lastP?.items?.length || 0);
    if (isLastPallet && isPastLast && !wiederholt && !finale) {
      const t = setTimeout(() => {
        setFinale(true);
        setFinalePending(false);
      }, 200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [finalePending, palletIdx, itemIdx, rawPallets, wiederholt, finale]);

  /* Reset interlude skip counter on Auftrag change. */
  useEffect(() => { resetSkipCount(); }, [current?.id]);

  /* Keyboard handler — gated by Shell mode.

     Shell ON  → all workflow hotkeys live.
       Classic axis: ←/→ items, ↑/↓ pallets — matches the horizontal
                     chip-strip layout.
       Beta axis:    ↑/↓ items, ←/→ pallets — matches FlowStream's
                     vertical carousel + the horizontal pallet axis.
     Shell OFF → only the Wiederholt dialog's dismiss keys are wired.
                 Worker is expected to use mouse clicks; this keeps
                 the toggle semantically meaningful (fast vs. careful)
                 instead of "Shell" being a no-op cosmetic state. */
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA') return;
      if (t?.isContentEditable) return;
      if (interlude || finale) return;
      if (wiederholt) {
        /* While wiederholt is open: Space dismisses (mirrors the OK
           button — workers already hit Space for "Fertig", so this
           is the natural acknowledge gesture). All other keys are
           swallowed so the underlying workflow shortcuts don't fire
           through the overlay. */
        if (e.key === ' ') {
          e.preventDefault();
          setWiederholt(null);
          return;
        }
        e.preventDefault();
        return;
      }
      /* UI-mode toggles (Z/D/S) — always available, regardless of
         Shell. They flip view layers, not workflow state. Esc exits
         zen too. */
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        setZen((v) => !v);
        return;
      }
      if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        toggleDoppel();
        return;
      }
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        toggleSchnell();
        return;
      }
      /* P — quick toggle back to Prüfen. Mirrors Pruefen's "F" hotkey
         which forwards into Focus, giving the worker a one-key round-trip
         between the two live workflow steps. Always available (gated
         only by overlays), so the worker doesn't have to engage Shell
         mode just to peek at the layout. */
      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        goToStep('pruefen');
        return;
      }
      if (zen && e.key === 'Escape') {
        e.preventDefault();
        setZen(false);
        return;
      }
      if (!schnellmodus) return;          // Shell OFF — workflow keys disabled
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); handleFertig(); return; }

      if (betaDesign) {
        /* Beta axis — vertical = items inside current pallet (bounded,
           mirrors FlowStream's wheel handler; no cross-pallet step),
           horizontal = pallets (display-order, with the same
           allPalletCopied gate as the bottom island).
           ↑/↓ skip Fertig'd items so they stay in the «Erledigt»-Strip
           and the hero never briefly surfaces a completed article. */
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          for (let i = itemIdx + 1; i < rawPallet.items.length; i++) {
            if (currentPalletCompletedIdxs.has(i)) continue;
            setCurrentItemIdx(i);
            break;
          }
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          for (let i = itemIdx - 1; i >= 0; i--) {
            if (currentPalletCompletedIdxs.has(i)) continue;
            setCurrentItemIdx(i);
            break;
          }
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          const nextRaw = nextDisplayPalletRawIdx(palletIdx);
          if (nextRaw != null) {
            if (!allPalletCopied) { alert(blockMessage()); return; }
            setInterlude(buildInterludePayload(palletIdx));
            setCurrentPalletIdx(nextRaw);
          }
          return;
        }
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          const prevRaw = prevDisplayPalletRawIdx(palletIdx);
          if (prevRaw != null) setCurrentPalletIdx(prevRaw);
          return;
        }
      } else {
        /* Classic axis — horizontal = items (chip-strip layout),
           vertical = pallets. ←/→ goNextItem/goPrevItem also cross
           pallet boundaries at item ends, preserving prior behavior. */
        if (e.key === 'ArrowRight') { e.preventDefault(); goNextItem(); return; }
        if (e.key === 'ArrowLeft')  { e.preventDefault(); goPrevItem(); return; }
        if (e.key === 'ArrowDown')  {
          e.preventDefault();
          if (palletIdx + 1 < rawPallets.length) {
            if (!allPalletCopied) { alert(blockMessage()); return; }
            setInterlude(buildInterludePayload(palletIdx));
            setCurrentPalletIdx(palletIdx + 1);
          }
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (palletIdx > 0) setCurrentPalletIdx(palletIdx - 1);
          return;
        }
      }

      if (e.key === 'c' || e.key === 'C') { e.preventDefault(); onCopyArtikelCode(); return; }
      if (e.key === 'u' || e.key === 'U') { e.preventDefault(); onCopyUseItem(); return; }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wiederholt, interlude, finale, zen, schnellmodus, betaDesign,
      handleFertig, goNextItem, goPrevItem,
      onCopyArtikelCode, onCopyUseItem, palletIdx, itemIdx, rawPallet,
      allPalletCopied, rawPallets, nextDisplayPalletRawIdx, prevDisplayPalletRawIdx,
      currentPalletCompletedIdxs,
      setCurrentItemIdx, setCurrentPalletIdx, buildInterludePayload, blockMessage,
      toggleDoppel, toggleSchnell]);

  /* Auftrag totals — used by AuftragFinaleStage. */
  const totals = useMemo(() => {
    const palletCount = rawPallets.length;
    const itemCount = totalArticles;
    let weightKg = 0, volCm3 = 0;
    for (const p of rawPallets) {
      const ps = palletStates?.[p.id];
      weightKg += ps?.weightKg || 0;
      volCm3   += ps?.volCm3   || 0;
    }
    const startedAt = current?.startedAt || Date.now();
    const durationMs = Math.max(0, Date.now() - startedAt);
    return { palletCount, itemCount, weightKg, volCm3, durationMs };
  }, [rawPallets, palletStates, totalArticles, current?.startedAt]);

  const onExit = async () => {
    const ok = await confirm({
      message: 'Auftrag verlassen?',
      detail: 'Fortschritt bleibt gespeichert — du kannst jederzeit zurückkehren.',
      confirmLabel: 'Verlassen',
      cancelLabel: 'Zurück',
      danger: true,
    });
    if (ok) cancelCurrent();
  };

  /* ── Empty state ── */
  if (!pallet || !item) {
    return (
      <Page>
        <Topbar
          crumbs={[
            { label: 'Workspace', muted: true },
            { label: 'Focus' },
          ]}
        />
        <main style={{ padding: '64px 32px', textAlign: 'center', color: T.text.subtle }}>
          Kein Auftrag geladen.
        </main>
      </Page>
    );
  }

  return (
    <Page>
      {/* In BETA mode: hide the heavy Topbar entirely; render a small
          floating FBA pill at the top. All Topbar-controls move into
          the BetaIslandBar below. In classic mode, keep the existing
          sticky Topbar with crumbs + status + toggles + exit cluster. */}
      {betaDesign ? (
        <BetaTopPill
          fba={fbaCode}
          startedAt={current?.startedAt}
          onExit={onExit}
          onGoToPruefen={() => goToStep('pruefen')}
        />
      ) : (
      <div style={{
        position: 'sticky',
        top: 0,
        zIndex: 30,
        opacity: zen ? 0 : 1,
        pointerEvents: zen ? 'none' : 'auto',
        transition: 'opacity 240ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}>
        <Topbar
          crumbs={[
            { label: 'Prüfen', muted: true,
              onClick: () => goToStep('pruefen'),
              title: 'Zurück zu Prüfen' },
            { label: 'Focus' },
          ]}
          center={<FocusStatusStripe current={current} />}
          right={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              {/* View-mode toggles — same pill style, kbd hint on each.
                  Order chosen by hotkey adjacency on the keyboard so the
                  Z|S|D row reads as a single tactile group. */}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <ViewListButton onClick={() => setPalletListOpen(true)} />
                <ZenToggle    on={zen}          onToggle={() => setZen((v) => !v)} />
                <ShellToggle  on={schnellmodus} onToggle={toggleSchnell} />
                <DoppelToggle on={doppelmodus}  onToggle={toggleDoppel} />
              </span>

              {/* Hairline separator between view-modes and exit-actions
                  so the two clusters read as distinct intents. */}
              <span aria-hidden style={{
                width: 1,
                height: 22,
                background: T.border.primary,
              }} />

              {/* Exit cluster — Storno (text, dangerous) + X (quick).
                  Tighter gap binds them visually. */}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Button variant="ghost" size="sm" onClick={() => setStornoOpen(true)}
                        title="Auftrag stornieren — geht mit Begründung in die Historie"
                        style={{
                          color: T.status.danger.text,
                          borderColor: T.status.danger.border,
                        }}>
                  Stornieren
                </Button>
                <button
                  onClick={onExit}
                  title="Focus verlassen — Fortschritt bleibt gespeichert"
                  aria-label="Focus verlassen"
                  style={{
                    width: 32,
                    height: 32,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'transparent',
                    color: T.text.subtle,
                    border: `1px solid ${T.border.primary}`,
                    borderRadius: 8,
                    cursor: 'pointer',
                    transition: 'background 140ms, border-color 140ms, color 140ms',
                    padding: 0,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = T.bg.surface2;
                    e.currentTarget.style.color = T.text.primary;
                    e.currentTarget.style.borderColor = T.text.faint;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = T.text.subtle;
                    e.currentTarget.style.borderColor = T.border.primary;
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </button>
              </span>
            </span>
          }
        />
      </div>
      )}

      {/* main fills the gap between Topbar bottom and StickyBar top.
          Click on the empty background here toggles Zen mode — the
          target check ensures only the bare-main background triggers,
          not bubbled clicks from the article card or pallet flow.

          Two layouts:
            - Beta OFF (default): classic single-hero centered, PalletFlow
              docked inside the hero card.
            - Beta ON: PS5-style FlowStream + vertical PalletFlow rail
              on the left (Flow components reused). */}
      {betaDesign ? (
        <main
          style={{
            height: '100vh',
            display: 'flex',
            alignItems: 'stretch',
            justifyContent: 'center',
            padding: '0 32px',
            gap: 24,
            overflow: 'hidden',
            /* Transparent — lets the AppShell gradient (--bg-gradient)
               show through. The hero and compact cards lift off via
               their own 2px white border + #F4F5F7 fill. */
            background: 'transparent',
          }}
        >
          {!zen && (
            <div style={{
              display: 'flex',
              flexShrink: 0,
              /* No alignSelf — let main's `alignItems: stretch` give
                 this wrapper full <main> height so FlowLeftRail can
                 anchor its inner panel via percentage to match the
                 hero card's vertical position (46% — same as
                 FlowStream). */
            }}>
              <FlowLeftRail
                donePalletItems={rawPallet.items || []}
                doneCompletedItemIdxs={currentPalletCompletedIdxs}
                doneActiveItemIdx={itemIdx}
                onDonePickItem={(rawItemIdx) => {
                  if (rawItemIdx === itemIdx) return;
                  setCurrentItemIdx(rawItemIdx);
                }}
                palletFlowProps={{
                  pallets: displayPallets,
                  palletStates,
                  palletTimings: current?.palletTimings,
                  currentIdx: displayCurrentIdx,
                  itemIdx: displayCurrentItemIdx,
                  copiedKeys: displayCopiedKeys,
                  completedKeys: displayCompletedKeys,
                  allPalletCopied,
                  onPickPallet: (displayIdx) => {
                    const target = displayPallets[displayIdx];
                    if (!target) return;
                    const i = rawPallets.findIndex((p) => p.id === target.id);
                    if (i < 0 || i === palletIdx) return;
                    if (i > palletIdx && !allPalletCopied) { alert(blockMessage()); return; }
                    if (i > palletIdx) setInterlude(buildInterludePayload(palletIdx));
                    setCurrentPalletIdx(i);
                  },
                  onPickItem: handlePickItem,
                  onReorder: (fromIdx, toIdx) => {
                    if (fromIdx === toIdx) return;
                    setPalletOrderOverride((prev) => {
                      const ids = prev || rawPallets.map((p) => p.id);
                      if (fromIdx < 0 || toIdx < 0
                          || fromIdx >= ids.length || toIdx >= ids.length) return prev;
                      const arr = [...ids];
                      const [moved] = arr.splice(fromIdx, 1);
                      arr.splice(toIdx, 0, moved);
                      return arr;
                    });
                  },
                }}
              />
            </div>
          )}

          <div style={{
            flex: 1,
            maxWidth: 800,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
          }}>
            {!zen && (
              <>
                <FlowStream
                  palletItems={rawPallet.items || []}
                  itemIdx={itemIdx}
                  copiedItemIdxs={currentPalletCopiedIdxs}
                  completedItemIdxs={currentPalletCompletedIdxs}
                  palletMaxItemVolCm3={palletVolStats.maxItemVolCm3}
                  palletTotalVolCm3={palletVolStats.palletTotalVolCm3}
                  onPickItem={(rawItemIdx) => {
                    if (rawItemIdx === itemIdx) return;
                    setCurrentItemIdx(rawItemIdx);
                  }}
                  heroCopied={codeCopied}
                  onHeroCopyCode={onCopyArtikelCode}
                  onHeroCopyUseItem={onCopyUseItem}
                  heroFlashUse={flashUse}
                  heroReCopyTick={reCopyTick}
                />
              </>
            )}
            {zen && (
              <ZenItemDots
                items={displayPallets[displayCurrentIdx]?.items || []}
                palletDisplayIdx={displayCurrentIdx}
                currentDisplayItemIdx={displayCurrentItemIdx}
                copiedKeys={displayCopiedKeys}
                onPick={handlePickItem}
              />
            )}
          </div>

          {!zen && (
            <div style={{
              display: 'flex',
              flexShrink: 0,
              /* Symmetric to the left rail wrapper — full <main>
                 height so FlowRightRail's inner panel can anchor at
                 top: 46% to match the hero's vertical center. */
            }}>
              <FlowRightRail
                palletItems={rawPallet.items || []}
                itemIdx={itemIdx}
                copiedItemIdxs={currentPalletCopiedIdxs}
                completedItemIdxs={currentPalletCompletedIdxs}
                onPickItem={(rawItemIdx) => {
                  if (rawItemIdx === itemIdx) return;
                  setCurrentItemIdx(rawItemIdx);
                }}
              />
            </div>
          )}
        </main>
      ) : (
        <main
          onClick={(e) => { if (e.target === e.currentTarget) setZen((v) => !v); }}
          style={{
            minHeight: 'calc(100vh - 60px - 98px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '32px 32px 96px',
          }}
        >
          <StudioFrame
            bare
            gap={0}
            zen={zen}
            style={{ width: '100%', maxWidth: 1080 }}
          >
            <ArticleHeroCard
              item={item}
              rawItem={rawItem}
              currentPalletObjId={pallet?.id}
              itemIdx={itemIdx}
              palletStartedAt={current?.palletTimings?.[pallet.id]?.startedAt || null}
              copiedCode={codeCopied ? item?.code : null}
              flashUse={flashUse}
              onCopyCode={onCopyArtikelCode}
              onCopyUse={onCopyUseItem}
              zen={zen}
              reCopyTick={reCopyTick}
              allPallets={enrichedSourcePallets}
              palletStates={palletStates}
              eskuDist={distribution.byPalletId}
              eskuOverrides={eskuOverrides}
              onMoveEsku={moveEskuToPallet}
              doppelmodus={doppelmodus}
              nextItem={nextItem}
              isCompleted={currentIsCompleted}
            >
              {!zen && (
                <PalletFlow
                  pallets={displayPallets}
                  palletStates={palletStates}
                  palletTimings={current?.palletTimings}
                  currentIdx={displayCurrentIdx}
                  itemIdx={displayCurrentItemIdx}
                  copiedKeys={displayCopiedKeys}
                  completedKeys={displayCompletedKeys}
                  allPalletCopied={allPalletCopied}
                  onPickPallet={(displayIdx) => {
                    const target = displayPallets[displayIdx];
                    if (!target) return;
                    const i = rawPallets.findIndex((p) => p.id === target.id);
                    if (i < 0 || i === palletIdx) return;
                    if (i > palletIdx && !allPalletCopied) { alert(blockMessage()); return; }
                    if (i > palletIdx) setInterlude(buildInterludePayload(palletIdx));
                    setCurrentPalletIdx(i);
                  }}
                  onPickItem={handlePickItem}
                  onReorder={(fromIdx, toIdx) => {
                    if (fromIdx === toIdx) return;
                    setPalletOrderOverride((prev) => {
                      const ids = prev || rawPallets.map((p) => p.id);
                      if (fromIdx < 0 || toIdx < 0
                          || fromIdx >= ids.length || toIdx >= ids.length) return prev;
                      const arr = [...ids];
                      const [moved] = arr.splice(fromIdx, 1);
                      arr.splice(toIdx, 0, moved);
                      return arr;
                    });
                  }}
                />
              )}
              {zen && (
                <ZenItemDots
                  items={displayPallets[displayCurrentIdx]?.items || []}
                  palletDisplayIdx={displayCurrentIdx}
                  currentDisplayItemIdx={displayCurrentItemIdx}
                  copiedKeys={displayCopiedKeys}
                  onPick={handlePickItem}
                />
              )}
            </ArticleHeroCard>
          </StudioFrame>
        </main>
      )}

      {betaDesign ? (
        <BetaIslandBar
          onFertig={handleFertig}
          canFertig={codeCopied}
          zen={zen}
          schnellmodus={schnellmodus}
          onToggleShell={toggleSchnell}
          onOpenList={() => setPalletListOpen(true)}
          onStorno={() => setStornoOpen(true)}
          intensity={islandIntensity}
        />
      ) : (
        <FocusStickyBar
          pallets={rawPallets}
          palletIdx={palletIdx}
          itemIdx={itemIdx}
          overallPct={overallPct}
          overallPos={overallPos}
          totalArticles={totalArticles}
          missingCopies={missingCopies.length}
          canPrev={!(palletIdx === 0 && itemIdx === 0)}
          canNext={(itemIdx + 1 < rawPallet.items.length)
                   || (palletIdx + 1 < rawPallets.length && allPalletCopied)}
          onPrev={goPrevItem}
          onNext={goNextItem}
          onFertig={handleFertig}
          zen={zen}
        />
      )}

      <WiederholtOverlay
        hit={wiederholt}
        onDismiss={() => setWiederholt(null)}
      />

      {palletListOpen && (
        <PalletListOverlay
          pallets={displayPallets}
          rawPallets={rawPallets}
          currentRawIdx={palletIdx}
          currentRawItemIdx={itemIdx}
          copiedKeys={copiedKeys}
          articleOrderOverride={articleOrderOverride}
          onReorderArticles={(palletId, fromIdx, toIdx) => {
            if (fromIdx === toIdx) return;
            setArticleOrderOverride((prev) => {
              const pal = rawPallets.find((p) => p.id === palletId);
              if (!pal) return prev;
              const count = pal.items?.length || 0;
              const order = prev[palletId] || Array.from({ length: count }, (_, i) => i);
              if (fromIdx < 0 || toIdx < 0
                  || fromIdx >= order.length || toIdx >= order.length) return prev;
              const arr = [...order];
              const [moved] = arr.splice(fromIdx, 1);
              arr.splice(toIdx, 0, moved);
              return { ...prev, [palletId]: arr };
            });
          }}
          onClose={() => setPalletListOpen(false)}
        />
      )}

      {interlude && (
        <PalletInterlude
          pallet={interlude}
          nextPallet={interlude.nextPallet}
          nextHints={interlude.nextHints}
          reducedMotion={reducedMotion}
          onComplete={() => setInterlude(null)}
        />
      )}

      {finale && (
        <AuftragFinaleStage
          totals={totals}
          reducedMotion={reducedMotion}
          schnellmodus={schnellmodus}
          onComplete={() => goToStep('abschluss')}
        />
      )}

      <CancelAuftragModal
        open={stornoOpen}
        fbaCode={current?.fbaCode || current?.parsed?.meta?.sendungsnummer || current?.fileName}
        pallets={current?.parsed?.pallets || []}
        eskuItems={current?.parsed?.einzelneSkuItems || []}
        onClose={() => setStornoOpen(false)}
        onConfirm={(payload) => {
          setStornoOpen(false);
          abortCurrent(payload);
        }}
      />
    </Page>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   ARTICLE HERO CARD — single elevated card, two columns:
     LEFT  — article: name + format/rollen + Menge with breakdown.
     RIGHT — codes:   Artikel-Code (dominant) + Use-Item (quiet).

   Mirrors the HeroFBA visual language from Pruefen: T.bg.surface,
   1px hairline, soft shadow, subtle accent halo top-right. The
   divider between columns is a hairline.
   ════════════════════════════════════════════════════════════════════════ */
function ArticleHeroCard({
  item, rawItem, currentPalletObjId, itemIdx,
  palletStartedAt = null,
  copiedCode, flashUse, onCopyCode, onCopyUse,
  zen = false,
  compact = false,
  reCopyTick = 0,
  allPallets, palletStates, eskuDist, eskuOverrides, onMoveEsku,
  doppelmodus = false,
  nextItem = null,
  isCompleted = false,
  children = null,
}: any) {
  const cat = item.levelMeta || LEVEL_META[1];
  const showNext = doppelmodus && !zen && !!nextItem;
  /* Completed-success theme overrides the border + bottom-left success
     halo when the worker has Fertig'd this article. */
  const borderColor = isCompleted ? T.status.success.main : T.border.primary;
  const moveTriggerRef = useRef(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const canMoveEsku = item.isEsku && typeof onMoveEsku === 'function' && allPallets?.length > 1;
  const moveKey = item.isEsku ? eskuOverrideKey(rawItem || item) : '';
  const isMoved = item.isEsku && !!(eskuOverrides && moveKey && eskuOverrides[moveKey]);

  /* Live timer — re-renders once per second so the elapsed string stays
     fresh. The displayed value is EFFECTIVE working seconds: outside
     the warehouse window or during the 12:00–12:30 lunch, the tick
     visually freezes because `effectiveElapsedMs` stops accumulating.
     Re-bound only when the pallet's startedAt changes. */
  const { schedule: workSchedule } = useWorkSchedule();
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!palletStartedAt) return undefined;
    const id = setInterval(() => forceTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [palletStartedAt]);

  const elapsedSec = palletStartedAt
    ? Math.floor(effectiveElapsedMs(palletStartedAt, Date.now(), workSchedule) / 1000)
    : 0;
  const elapsedLabel = formatElapsedTimer(elapsedSec);

  return (
    <div
      key={`hero-${currentPalletObjId}-${itemIdx}`}
      className="mr-hero-land"
      style={{
        position: 'relative',
        width: '100%',
        maxWidth: 1080,
        padding: compact ? '14px 20px' : '24px 28px',
        background: isCompleted ? '#ecfdf575' : T.bg.surface,
        border: `${isCompleted ? 1.4 : 1}px solid ${borderColor}`,
        borderRadius: 18,
        boxShadow: isCompleted
          ? `0 0 0 4px ${T.status.success.main}1A, 0 8px 24px -8px ${T.status.success.main}3D`
          : 'none',
        overflow: 'hidden',
        transition: 'padding 240ms cubic-bezier(0.16, 1, 0.3, 1), border-color 280ms ease, box-shadow 320ms ease, background 320ms ease',
      }}
    >
      {/* Completed state keeps a soft bottom-left halo as success cue. */}
      {isCompleted && (
        <div aria-hidden style={{
          position: 'absolute',
          bottom: -140, left: -140,
          width: 320,
          height: 320,
          background: `radial-gradient(circle, ${T.status.success.main}24 0%, transparent 65%)`,
          pointerEvents: 'none',
        }} />
      )}

      <div style={{ position: 'relative' }}>
        {/* ── Command Bar ────────────────────────────────────────────
            Single horizontal row split into two equal-width halves
            (flex: 1 each): identity chips left, timer + actions right.
            Collapses fully in zen mode so the article name anchors to
            the card top. */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          marginBottom: zen ? 0 : 20,
          maxHeight: zen ? 0 : 60,
          opacity: zen ? 0 : 1,
          overflow: 'hidden',
          pointerEvents: zen ? 'none' : 'auto',
          transition: 'opacity 200ms ease, max-height 280ms cubic-bezier(0.16, 1, 0.3, 1), margin-bottom 280ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}>
          {/* LEFT cluster — identity chips, flush-left, fills its half. */}
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
            minWidth: 0,
          }}>
            <LevelChip level={item.level} cat={cat} />
            {item.isEsku && <Badge tone="accent">ESKU</Badge>}
            {item.lst && (
              <Badge tone={item.lst === 'mit LST' ? 'accent' : 'success'}>{item.lst}</Badge>
            )}
            {item.placementFlags?.length > 0 && (
              <Badge tone="warn">{item.placementFlags.join(' · ')}</Badge>
            )}
            {isCompleted && <Badge tone="success">✓ Abgeschlossen</Badge>}
          </div>

          {/* RIGHT cluster — actions + timer, flush-right, fills its half. */}
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 10,
            flexWrap: 'wrap',
            minWidth: 0,
          }}>
            {canMoveEsku && (
              <button
                ref={moveTriggerRef}
                type="button"
                onClick={() => setMoveOpen((v) => !v)}
                title="ESKU auf andere Palette verschieben"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 12px',
                  fontSize: 11,
                  fontFamily: T.font.mono,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: isMoved ? T.accent.text : T.text.subtle,
                  background: isMoved ? T.accent.bg : T.bg.surface2,
                  border: `1px solid ${isMoved ? T.accent.border : T.border.primary}`,
                  borderRadius: 999,
                  cursor: 'pointer',
                  transition: 'background 140ms, border-color 140ms',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.accent.main; }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = isMoved ? T.accent.border : T.border.primary;
                }}
              >
                ↪ {isMoved ? 'verschoben' : 'Palette wechseln'}
              </button>
            )}
            <PositionMeter
              elapsedLabel={elapsedLabel}
              live={!!palletStartedAt}
            />
          </div>
        </div>

        <EskuMovePopover
          open={moveOpen}
          anchorEl={moveTriggerRef.current}
          pallets={allPallets}
          palletStates={palletStates}
          byPalletId={eskuDist}
          currentPalletId={currentPalletObjId}
          isOverridden={isMoved}
          onPick={(targetId) => onMoveEsku?.(moveKey, targetId)}
          onClose={() => setMoveOpen(false)}
        />

        {/* Two columns — article LEFT, codes RIGHT. Equal 1fr / 1fr
            split so both halves carry the same visual weight. */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1px 1fr',
          gap: 28,
          alignItems: 'stretch',
        }}>
          <ArticleColumn item={item} zen={zen} />
          <span style={{ background: T.border.primary, alignSelf: 'stretch' }} />
          <CodesColumn
            item={item}
            copiedCode={copiedCode}
            flashUse={flashUse}
            onCopyCode={onCopyCode}
            onCopyUse={onCopyUse}
            reCopyTick={reCopyTick}
          />
        </div>

        {/* Doppel-Artikel — thin preview strip for the next article on
            the same pallet. */}
        <DoppelStrip show={showNext} nextItem={nextItem} currentItem={rawItem} currentCat={cat} />

        {/* Slot for the Pallet Flow strip — lives inside the hero card
            so the worker has a single bounded surface. Hairline divider
            separates it from the article content above. */}
        {children && (
          <div style={{
            marginTop: 20,
            paddingTop: 18,
            borderTop: `1px solid ${T.border.primary}`,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          }}>
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

/* Format an elapsed second-count into a compact live-timer string.
   < 1 hour → M:SS, ≥ 1 hour → H:MM. Distinct from formatElapsedShort
   which takes milliseconds and renders a coarser "5m / 1h 30m" form
   used by post-finish summaries. */
function formatElapsedTimer(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

/* PositionMeter — pulsing accent dot + live pallet timer. The dot
   signals «aktive Palette»; the mono mm:ss label ticks alongside.
   Renders nothing when no pallet timing is available. */
function PositionMeter({ elapsedLabel, live }) {
  if (!live) return null;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      fontFamily: T.font.mono,
      fontVariantNumeric: 'tabular-nums',
    }}>
      <span
        aria-hidden
        className="mr-live-dot"
        title="Aktive Palette — Timer läuft"
        style={{
          width: 7, height: 7, borderRadius: '50%',
          background: T.accent.main,
          flexShrink: 0,
        }}
      />
      <span style={{
        fontSize: 11.5,
        fontWeight: 600,
        color: T.text.subtle,
        letterSpacing: '0.04em',
      }}>
        {elapsedLabel}
      </span>
    </span>
  );
}

function DoppelStrip({ show, nextItem, currentItem, currentCat }: any) {
  const cat = nextItem?.levelMeta || LEVEL_META[1];
  const qty = nextItem
    ? (nextItem.isEsku ? nextItem.eskuCartons : nextItem.units)
    : null;
  /* Mirror ArticleColumn's perCarton rule: Mixed → "N Rollen" per
     Karton, ESKU → "Y Label × N total" (e.g. "1 Dose × 42" — Y from
     ACHTUNG inner-pack, N = item.units total across all FBA cartons).
     Falls back to "X Einheiten" when the parser only knows X. */
  const perCarton = nextItem
    ? (!nextItem.isEsku
        ? (nextItem.rollen ? { value: nextItem.rollen, unit: nextItem.rollenUnit || 'Rollen' } : null)
        : (nextItem.eskuItemsPerPack != null && nextItem.units
            ? { value: nextItem.eskuItemsPerPack, unit: nextItem.eskuContentLabel || 'Einheiten', multiplier: nextItem.units }
            : nextItem.eskuPacksPerCarton != null
                ? { value: nextItem.eskuPacksPerCarton, unit: 'Einheiten' }
                : null))
    : null;
  /* Volume comparison: how much bigger/smaller is the NEXT article
     vs the CURRENT one. Renders two stacked mini-bars normalized to
     whichever is larger, plus a "+X%" or "−X%" chip. The visual
     length-difference is the primary signal; the % is precise. */
  const currentVol = currentItem ? (itemTotalVolumeCm3(currentItem) || 0) : 0;
  const nextVol    = nextItem    ? (itemTotalVolumeCm3(nextItem)    || 0) : 0;
  const hasCompare = currentVol > 0 && nextVol > 0;
  const maxVol     = Math.max(currentVol, nextVol);
  const currPct    = hasCompare ? (currentVol / maxVol) * 100 : 0;
  const nextPct    = hasCompare ? (nextVol    / maxVol) * 100 : 0;
  const ratio      = hasCompare ? nextVol / currentVol : 1;
  const diffPct    = (ratio - 1) * 100;
  /* Color the ratio chip by direction: bigger = warn (eats more
     pallet, give it space), smaller = neutral, equal = quiet. */
  const ratioBig   = Math.abs(diffPct) >= 1;
  const ratioColor = !ratioBig
    ? T.text.subtle
    : diffPct > 0
      ? T.status.warn.main
      : T.text.subtle;
  const ratioLabel = !ratioBig
    ? 'gleich'
    : `${diffPct > 0 ? '+' : '−'}${Math.abs(diffPct).toFixed(0)}%`;
  const currentBarColor = currentCat?.color || T.text.faint;
  return (
    <div style={{
      maxHeight: show ? 90 : 0,
      marginTop: show ? 20 : 0,
      paddingTop: show ? 14 : 0,
      opacity: show ? 1 : 0,
      borderTop: show ? `1px solid ${T.border.primary}` : '1px solid transparent',
      overflow: 'hidden',
      pointerEvents: show ? 'auto' : 'none',
      transition: 'opacity 200ms ease, max-height 280ms cubic-bezier(0.16, 1, 0.3, 1), margin-top 240ms ease, padding-top 240ms ease, border-color 200ms ease',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        minWidth: 0,
      }}>
        {nextItem && <LevelChip level={nextItem.level} cat={cat} />}
        {/* Name + per-Karton fact sit in one shrinkable group so the
            "50 Rollen" badge always reads as a property OF this name,
            not as a standalone metric on the right. Group truncates as
            a whole; perCarton itself never wraps or shrinks. */}
        <span style={{
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: 10,
          minWidth: 0,
          flex: 1,
          overflow: 'hidden',
        }}>
          <span style={{
            fontFamily: T.font.ui,
            fontSize: 17,
            fontWeight: 500,
            color: '#4a4a4a',
            letterSpacing: '-0.01em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            minWidth: 0,
          }}>
            {nextItem?.name}
          </span>
          {perCarton && (
            <span style={{
              fontFamily: T.font.mono,
              fontSize: 14,
              fontWeight: 700,
              color: T.accent.main,
              letterSpacing: '0.02em',
              fontVariantNumeric: 'tabular-nums',
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}>
              {perCarton.value}
              <span style={{
                marginLeft: 5,
                fontSize: 10.5,
                letterSpacing: '0.10em',
                textTransform: 'uppercase',
                color: T.text.subtle,
              }}>
                {perCarton.unit}
              </span>
              {perCarton.multiplier != null && (
                <span style={{ marginLeft: 6 }}>× {perCarton.multiplier}</span>
              )}
            </span>
          )}
        </span>
        {qty != null && (
          <span style={{
            fontFamily: T.font.mono,
            fontSize: 16,
            fontWeight: 700,
            color: T.text.primary,
            letterSpacing: '0.04em',
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
          }}>
            {qty}
            <span style={{
              marginLeft: 6,
              fontSize: 10.5,
              letterSpacing: '0.10em',
              textTransform: 'uppercase',
              color: T.text.subtle,
              fontWeight: 600,
            }}>
              Kartons
            </span>
          </span>
        )}
        {/* Volume comparison — stacked mini-bars, normalised so the
            larger of (current, next) takes the full width. Bars carry
            their own level colour; the ratio chip surfaces precise
            "+X%" / "−X%" and turns orange when the next article is
            bigger, hinting the worker to plan space. */}
        {hasCompare && (
          <span
            title={`Aktuell: ${(currentVol / 1e6).toFixed(3)} m³ · Nächster: ${(nextVol / 1e6).toFixed(3)} m³ · ${ratioLabel} grösser`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 10,
              flexShrink: 0,
            }}
          >
            <span aria-hidden style={{
              display: 'inline-flex',
              flexDirection: 'column',
              gap: 3,
              width: 110,
            }}>
              {/* Current (top, muted) — current article's footprint. */}
              <span style={{
                position: 'relative',
                width: '100%',
                height: 6,
                borderRadius: 3,
                background: T.bg.surface2,
                overflow: 'hidden',
              }}>
                <span style={{
                  position: 'absolute',
                  top: 0, left: 0, bottom: 0,
                  width: `${currPct}%`,
                  background: currentBarColor,
                  opacity: 0.45,
                  borderRadius: 3,
                  transition: 'width 240ms cubic-bezier(0.16, 1, 0.3, 1)',
                }} />
              </span>
              {/* Next (bottom, full colour) — next article's footprint. */}
              <span style={{
                position: 'relative',
                width: '100%',
                height: 6,
                borderRadius: 3,
                background: T.bg.surface2,
                overflow: 'hidden',
              }}>
                <span style={{
                  position: 'absolute',
                  top: 0, left: 0, bottom: 0,
                  width: `${nextPct}%`,
                  background: cat.color,
                  borderRadius: 3,
                  boxShadow: 'inset 0 -1px 0 rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.20)',
                  transition: 'width 240ms cubic-bezier(0.16, 1, 0.3, 1), background 200ms ease',
                }} />
              </span>
            </span>
            <span style={{
              fontFamily: T.font.mono,
              fontSize: 13,
              fontWeight: 700,
              color: ratioColor,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '0.02em',
              minWidth: 44,
              textAlign: 'right',
            }}>
              {ratioLabel}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
   FocusStatusStripe — live context chip for the Topbar centre.

   Single horizontal pill carrying every fact the worker references
   without leaving the screen: FBA / Auftrag identity, pallet position,
   item position (overall), elapsed time. Click anywhere on the chip
   copies the FBA code; the file name lives in the hover tooltip.
   Sections separated by hairline dots, mono throughout for ambient
   scanability. */
function FocusStatusStripe({ current }: { current: any }) {
  const meta = current?.parsed?.meta;
  const fba = meta?.sendungsnummer || meta?.fbaCode || current?.fbaCode || null;
  const fileName: string = current?.fileName || '';
  const startedAt: number = current?.startedAt ?? Date.now();

  /* Tick every 30 s so the elapsed-time readout stays live during
     idle moments. State changes also trigger re-render, so the gap
     between ticks is the worst case, not the typical case. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const elapsedStr = formatElapsedShort(Math.max(0, now - startedAt));

  const [copied, setCopied] = useState(false);
  const [hover, setHover] = useState(false);
  const onCopy = () => {
    if (!fba) return;
    copyToClipboard(fba);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const identity = fba || (fileName ? fileName.replace(/\.docx$/i, '') : 'Auftrag');
  const tooltipParts: string[] = [];
  if (fileName) tooltipParts.push(`Datei: ${fileName}`);
  if (fba) tooltipParts.push(`FBA: ${fba}`);
  tooltipParts.push('Klick = FBA kopieren');

  const sectionStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: 4,
    fontFamily: T.font.mono,
    fontSize: 12,
    fontVariantNumeric: 'tabular-nums',
    color: T.text.primary,
    fontWeight: 600,
    letterSpacing: '-0.005em',
  };
  const sep = (
    <span aria-hidden style={{
      color: T.border.strong,
      fontFamily: T.font.mono,
      fontSize: 11,
      fontWeight: 400,
    }}>·</span>
  );

  return (
    <button
      type="button"
      onClick={onCopy}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={copied ? 'FBA-Code kopiert!' : tooltipParts.join(' · ')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 14px',
        height: 32,
        borderRadius: 999,
        background: copied ? T.accent.bg : (hover ? T.bg.surface2 : T.bg.surface),
        border: `1px solid ${copied ? T.accent.main : (hover ? T.accent.main : T.border.primary)}`,
        cursor: fba ? 'pointer' : 'default',
        transition: 'background 160ms ease, border-color 160ms ease',
      }}
    >
      {/* Identity — FBA code if available, else cleaned file name.
          The 'FBA' label flips to 'KOPIERT' on copy feedback. */}
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{
          fontFamily: T.font.mono,
          fontSize: 9.5,
          fontWeight: 700,
          color: copied ? T.accent.text : T.text.faint,
          textTransform: 'uppercase',
          letterSpacing: '0.18em',
        }}>
          {copied ? 'Kopiert' : (fba ? 'FBA' : 'Datei')}
        </span>
        <span style={{
          fontFamily: T.font.mono,
          fontSize: 12.5,
          fontWeight: 700,
          color: copied ? T.accent.text : T.text.primary,
          letterSpacing: '0.02em',
          maxWidth: 240,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {identity}
        </span>
      </span>

      {sep}

      {/* Elapsed time */}
      <span style={{ ...sectionStyle, color: T.text.subtle, fontWeight: 600 }} title="Dauer seit Start">
        {elapsedStr}
      </span>
    </button>
  );
}

function formatElapsedShort(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return '< 1m';
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function LevelChip({ level, cat }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '3px 9px',
      background: cat.bg,
      color: cat.text,
      border: `1px solid ${cat.color}40`,
      borderRadius: 999,
      fontFamily: T.font.mono,
      fontSize: 10.5,
      fontWeight: 600,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: cat.color }} />
      L{level} · {cat.name}
    </span>
  );
}

/* Compact, warehouse-friendly title for the hero card. Drops the
   descriptor trailer that follows a " - " (with surrounding spaces) and
   anything after the first ", ". Hyphens inside compound nouns
   (e.g. "Thermo-Rolle") are preserved because they have no spaces.

   Product-specific overrides come first — for Kürbiskernöl the raw
   title "HE - Steirisches Gourmet Kürbiskernöl - Kernöl g.g.A. … (1 l)"
   collapsed to just "HE" under the generic rule, which told the worker
   nothing. We now extract "Kürbiskernöl <size> l" directly.

   Generic flow also strips a short ALL-CAPS brand prefix (≤3 chars +
   " - ") so titles like "HE - …" or "TK - …" surface the real product
   instead of the brand code. */
function simplifyItemTitle(name) {
  if (!name) return '';
  const raw = String(name);
  // Kürbiskernöl: "Kürbiskernöl <N> l". Size hint can be parenthesised
  // ("(1 l)") in raw title OR a bare suffix ("1 L") if formatItemTitle
  // already normalised it upstream — match both.
  if (/kürbiskernöl|kürbis.*kern[öo]l/i.test(raw)) {
    const m = raw.match(/(\d+(?:[.,]\d+)?)\s*l\b/i);
    return m ? `Kürbiskernöl ${m[1].replace(',', '.')} l` : 'Kürbiskernöl';
  }
  // Klebeband / Packband: strip "TK THERMALKING" brand, keep first two
  // descriptor chunks ("Klebeband - Packband") and preserve the warning
  // hint ("(Bruchgefahr)" / "(Fragile)" / etc.) so the worker still sees it.
  if (/klebeband|packband|paketband/i.test(raw)) {
    const warn = raw.match(/\(([^)]+)\)/);
    const warnSuffix = warn ? ` (${warn[1].trim()})` : '';
    const stripped = raw.replace(/^TK\s+THERMALKING\s+/i, '').replace(/\s*\([^)]+\)/g, '').trim();
    const parts = stripped.split(/\s+-\s+/).map((p) => p.trim()).filter(Boolean);
    const core = parts.slice(0, 2).join(' - ');
    return (core || stripped) + warnSuffix;
  }
  let out = raw.replace(/^[A-ZÄÖÜ]{2,3}\s+[—–-]\s+/, '');
  const dash = out.match(/^(.+?)\s+[—–-]\s+/);
  if (dash) out = dash[1];
  const ci = out.indexOf(', ');
  if (ci > 0) out = out.slice(0, ci);
  return out.trim();
}

/* packageContentString — extracts "what's inside ONE package" as a
   short string for the intensity tray rows. Mirrors the perCarton
   field built by ArticleColumn / FlowHero so the breakdown matches
   the hero card vocabulary.
     • Mixed (non-ESKU) with parsed count: `${rollen} ${rollenUnit || 'Rollen'}`
     • ESKU items/pack:  `${eskuItemsPerPack} ${eskuContentLabel || 'Einheiten'}`
     • ESKU packs/carton:`${eskuPacksPerCarton} Einheiten`
     • fallback: `${units} Stk` — the order's carton/unit count. The
       parser only sets `rollen` when the docx title spells it out
       explicitly ("50 Rollen", "50 EC…"); many Thermo lines don't,
       so this guarantees every row carries a quantity signal. */
function packageContentString(it) {
  if (!it) return '';
  if (!it.isEinzelneSku && it.rollen) {
    return `${it.rollen} ${it.rollenUnit || 'Rollen'}`;
  }
  if (it.isEinzelneSku) {
    if (it.eskuItemsPerPack != null && it.units) {
      return `${it.eskuItemsPerPack} ${it.eskuContentLabel || 'Einheiten'}`;
    }
    if (it.eskuPacksPerCarton != null) {
      return `${it.eskuPacksPerCarton} Einheiten`;
    }
  }
  const u = Number(it.units);
  if (Number.isFinite(u) && u > 0) {
    return `${u} Stk`;
  }
  return '';
}

/* parseMinimalTitle — FOCUSED parser dedicated to the BetaIslandBar
   intensity tray. The worker is scanning a list to spot heavy/light
   items at a glance — they only need (a) the product kind and (b) the
   key distinguishing dimension. Everything else (SKU, brand, descriptor,
   units, third dimension) is noise and gets stripped.

   Output shape:
     "<Product> <dim1×dim2>"   e.g. "Thermo 57×18"
     "<Product>"                e.g. "Klebeband"
     "<dim>"                    rare unmatched fallback
     simplifyItemTitle(raw)     last resort for unrecognised products

   Stable: same input → same output, no length variance, easy to scan. */
const GRAPH_PRODUCT_MAP = [
  [/thermo\s*rolle?n?/i,             'Thermo'],
  [/tacho\s*rolle?n?/i,              'Tacho'],
  [/(?:klebe|pack|paket)\s*band/i,   'Klebeband'],
  [/kürbis(?:.*kern[öo]l)?/i,        'Kürbiskernöl'],
  [/etikett/i,                       'Etikett'],
  [/folie/i,                         'Folie'],
  [/karton/i,                        'Karton'],
];
function parseMinimalTitle(raw) {
  if (!raw) return '—';
  let s = String(raw);
  /* 1. Drop long digit runs — SKU/EAN/FNSKU never help quick scanning. */
  s = s.replace(/\b\d{5,}\b/g, ' ');
  /* 2. Drop parenthetical asides — "(Bruchgefahr)", "(unbedruckt)". */
  s = s.replace(/\s*\([^)]*\)/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  /* 3. Product kind — first matching keyword wins, case-insensitive. */
  let product = '';
  for (const [re, label] of GRAPH_PRODUCT_MAP) {
    if ((re as RegExp).test(s)) { product = label as string; break; }
  }

  /* 4. First two numeric components — these carry the differentiating
        info between rows (57×18 vs 58×64 vs 80×80). Unit suffixes after
        each number ("mm"/"m") are tolerated and dropped from the output. */
  let dim = '';
  const dim2 = s.match(/(\d+(?:[.,]\d+)?)\s*(?:mm|cm|m)?\s*[×xX]\s*(\d+(?:[.,]\d+)?)/);
  if (dim2) {
    dim = `${dim2[1]}×${dim2[2]}`;
  } else {
    /* Fallback single-quantity for products without × dimensions
       (e.g. "1 l" for Kürbiskernöl). */
    const dim1 = s.match(/(\d+(?:[.,]\d+)?)\s*(mm|cm|m|l|ml|kg|g)\b/i);
    if (dim1) dim = `${dim1[1]}${dim1[2].toLowerCase()}`;
  }

  if (product && dim) return `${product} ${dim}`;
  if (product)        return product;
  if (dim)            return dim;

  /* Last resort — unrecognised product, fall back to simplifyItemTitle
     so the row still reads something useful instead of "—". Cap so
     unfamiliar items don't blow up the row. */
  const fallback = simplifyItemTitle(raw);
  if (!fallback) return '—';
  return fallback.length > 24 ? fallback.slice(0, 23).trimEnd() + '…' : fallback;
}

/* ── LEFT — article column ─────────────────────────────────────────── */
function ArticleColumn({ item, zen = false }) {
  const perCarton = !item.isEsku
    ? (item.rollen ? { value: item.rollen, unit: item.rollenUnit || 'Rollen' } : null)
    : (item.eskuItemsPerPack != null && item.units
        ? { value: item.eskuItemsPerPack, unit: item.eskuContentLabel || 'Einheiten', multiplier: item.units }
        : item.eskuPacksPerCarton != null
            ? { value: item.eskuPacksPerCarton, unit: 'Einheiten' }
            : null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
      {/* TWIN HEADLINE — article name + per-Karton fact at near-equal weight.
          Title is simplified for a clean read; the full name lives in the
          tooltip so nothing is hidden from the worker. */}
      <h1
        title={item.name}
        style={{
          margin: 0,
          fontFamily: T.font.ui,
          fontSize: 'clamp(24px, 2.8vw, 34px)',
          fontWeight: 500,
          letterSpacing: '-0.022em',
          lineHeight: 1.1,
          color: T.text.primary,
        }}
      >
        {simplifyItemTitle(item.name)}
      </h1>

      {perCarton && (
        <div style={{
          fontFamily: T.font.mono,
          fontSize: 'clamp(20px, 2.4vw, 28px)',
          fontWeight: 600,
          color: T.accent.main,
          letterSpacing: '-0.018em',
          lineHeight: 1.05,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {perCarton.value} {perCarton.unit}{perCarton.multiplier != null ? ` × ${perCarton.multiplier}` : ''}
        </div>
      )}

      {/* Hairline divider */}
      <div style={{ height: 1, background: T.border.subtle, margin: '12px 0 6px' }} />

      {/* Menge — number is hero of the column */}
      <div>
        <div style={{
          fontSize: 10.5,
          fontWeight: 600,
          fontFamily: T.font.mono,
          color: T.text.subtle,
          textTransform: 'uppercase',
          letterSpacing: '0.16em',
          marginBottom: 8,
          opacity: zen ? 0 : 1,
          maxHeight: zen ? 0 : 24,
          overflow: 'hidden',
          transition: 'opacity 200ms ease, max-height 240ms cubic-bezier(0.16, 1, 0.3, 1), margin-bottom 240ms ease',
        }}>
          {item.isEsku ? 'FBA-Kartons' : 'Menge'}
        </div>
        <div style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 14,
        }}>
          <span style={{
            fontFamily: T.font.ui,
            fontSize: 'clamp(48px, 6vw, 72px)',
            fontWeight: 500,
            letterSpacing: '-0.04em',
            lineHeight: 0.94,
            color: T.text.primary,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {item.isEsku ? item.eskuCartons : item.units}
          </span>
          <span style={{
            fontFamily: T.font.mono,
            fontSize: 'clamp(15px, 1.6vw, 20px)',
            fontWeight: 600,
            color: T.text.subtle,
            letterSpacing: '0.10em',
            textTransform: 'uppercase',
          }}>
            Kartons
          </span>
        </div>
      </div>
    </div>
  );
}


/* ── RIGHT — codes column. Artikel-Code dominates over Use-Item.
   Vertically centred via space-around so the column doesn't pool the
   left column's leftover height into a void below Use-Item. */
function CodesColumn({ item, copiedCode, flashUse, onCopyCode, onCopyUse, reCopyTick = 0 }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-around',
      gap: 14,
      minWidth: 0,
      paddingLeft: 4,
      height: '100%',
    }}>
      {/* PRIMARY — Artikel-Code (dominant). For ESKU the SKU leads and
          FNSKU rides under as a secondary line; for everything else the
          secondary line is null and only the dominant value renders. */}
      <CodeRow
        label={null}
        value={item.code}
        secondary={item.secondaryCode}
        secondaryLabel={item.isEsku ? 'FNSKU' : null}
        copied={copiedCode != null && copiedCode === item.code}
        onCopy={onCopyCode}
        size="dominant"
        reCopyTick={reCopyTick}
      />

      <div style={{ height: 1, background: T.border.subtle }} />

      {/* SECONDARY — Use-Item (quiet) */}
      <CodeRow
        label="Use-Item"
        value={item.useItem}
        copied={flashUse != null && flashUse === item.useItem}
        onCopy={onCopyUse}
        size="quiet"
        accent
      />
    </div>
  );
}

function CodeRow({ label, kbd, value, secondary, secondaryLabel, copied, onCopy, size, accent, reCopyTick = 0 }: { label: React.ReactNode; kbd?: string; value: string; secondary?: string | null; secondaryLabel?: string | null; copied?: boolean; onCopy: () => void; size?: 'dominant' | 'compact' | 'quiet'; accent?: boolean; reCopyTick?: number }) {
  const isDominant = size === 'dominant';
  const valueFont = isDominant
    ? 'clamp(30px, 3.6vw, 46px)'
    : 'clamp(15px, 1.4vw, 18px)';
  const valueWeight = isDominant ? 600 : 500;

  return (
    <button
      type="button"
      onClick={onCopy}
      /* Bump key on every re-copy so the flash animation replays even
         if the same code is copied twice in a row. */
      key={`code-${reCopyTick}`}
      className={reCopyTick > 0 ? 'mr-recopy-flash' : undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: isDominant ? 10 : 6,
        padding: '10px 14px',
        margin: '-10px -14px',
        background: copied ? T.status.success.bg : 'transparent',
        border: `1.5px solid ${copied ? T.status.success.main : 'transparent'}`,
        borderRadius: 12,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: T.font.ui,
        transition: 'border-color 240ms cubic-bezier(0.16, 1, 0.3, 1), background 240ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      {/* Label row — only renders when there's a label OR a kbd hint
          to show. The «Kopiert» indicator piggybacks on the same row;
          when label/kbd are both null, copy feedback is conveyed only
          via the row's green border/background. */}
      {(label || kbd) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {label && (
            <span style={{
              fontSize: 10.5,
              fontWeight: 600,
              fontFamily: T.font.mono,
              color: copied ? T.status.success.text : T.text.subtle,
              textTransform: 'uppercase',
              letterSpacing: '0.16em',
            }}>
              {label}
            </span>
          )}
          {kbd && <Kbd>{kbd}</Kbd>}
          <span style={{ flex: 1 }} />
          {copied && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontSize: 10.5, fontFamily: T.font.mono, fontWeight: 600,
              color: T.status.success.text,
              letterSpacing: '0.10em', textTransform: 'uppercase',
            }}>
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 6.5l2 2 5-5.5" stroke="currentColor" strokeWidth="2.2"
                      strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Kopiert
            </span>
          )}
        </div>
      )}

      {/* Value — dominant for Artikel-Code, quiet for Use-Item */}
      <div style={{
        fontFamily: T.font.mono,
        fontSize: valueFont,
        fontWeight: valueWeight,
        color: copied ? T.status.success.text
          : accent ? T.accent.text : T.text.primary,
        letterSpacing: '-0.016em',
        lineHeight: 1.1,
        wordBreak: 'break-word',
        transition: 'color 200ms ease',
      }}>
        {value || '—'}
      </div>

      {/* Secondary code line (e.g. FNSKU below an ESKU's SKU). Only
          renders when set — non-ESKU rows never see it. Subtle, mono,
          no copy interaction (clicking still copies the primary). */}
      {secondary && (
        <div style={{
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: 8,
          marginTop: 2,
        }}>
          {secondaryLabel && (
            <span style={{
              fontSize: 9.5,
              fontWeight: 600,
              fontFamily: T.font.mono,
              color: T.text.faint,
              textTransform: 'uppercase',
              letterSpacing: '0.16em',
            }}>
              {secondaryLabel}
            </span>
          )}
          <span style={{
            fontFamily: T.font.mono,
            fontSize: 13,
            fontWeight: 500,
            color: T.text.subtle,
            letterSpacing: '-0.005em',
          }}>
            {secondary}
          </span>
        </div>
      )}
    </button>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   STICKY BAR — chip strip on top, status + actions below.
   ════════════════════════════════════════════════════════════════════════ */
function FocusStickyBar({
  pallets, palletIdx, itemIdx,
  overallPct, overallPos, totalArticles, missingCopies,
  canPrev, canNext,
  onPrev, onNext, onFertig,
  zen = false,
}) {
  const isReady  = missingCopies === 0;
  const dotColor = isReady ? T.status.success.main : T.status.warn.main;
  const palletId = pallets?.[palletIdx]?.id || '—';
  const totalInPallet = pallets?.[palletIdx]?.items?.length || 0;

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 50,
      background: zen ? 'var(--bg-glass-soft)' : 'var(--bg-glass-strong)',
      backdropFilter: 'blur(14px)',
      WebkitBackdropFilter: 'blur(14px)',
      borderTop: zen ? '1px solid transparent' : `1px solid ${T.border.primary}`,
      marginLeft: 'var(--sidebar-width)',
      transition: 'background 240ms ease, border-color 240ms ease',
    }}>
      {/* 2px overall progress hairline */}
      <div style={{ height: 2, background: 'var(--bg-glass-edge)' }}>
        <div style={{
          height: '100%',
          width: `${Math.max(0, Math.min(1, overallPct)) * 100}%`,
          background: T.accent.main,
          transition: 'width 320ms cubic-bezier(0.16, 1, 0.3, 1)',
        }} />
      </div>

      {/* Action row — in zen mode the status block + spacer + position
          counter are taken out of flow (display: none), and the row
          container switches to justify-content: center, so the
          [Zurück · Fertig · Weiter] cluster sits in the middle of the
          available width. Snap rather than transitioned, but the
          surrounding chrome already fades smoothly so the swap is
          masked. */}
      <div style={{
        padding: '10px 32px 12px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: zen ? 'center' : 'flex-start',
        gap: 14,
        maxWidth: 1080,
        margin: '0 auto',
      }}>
        {!zen && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%',
              background: dotColor,
              boxShadow: `0 0 0 3px ${dotColor}22`,
              flexShrink: 0,
            }} />
            <span style={{
              fontSize: 12.5,
              color: T.text.primary,
              fontWeight: 500,
              letterSpacing: '-0.005em',
            }}>
              {isReady ? 'Bereit' : `${missingCopies} Code${missingCopies === 1 ? '' : 's'} fehlen`}
            </span>
            <span style={{
              fontSize: 12, color: T.text.faint,
              fontFamily: T.font.mono, fontVariantNumeric: 'tabular-nums',
              marginLeft: 4,
            }}>
              {palletId} · {itemIdx + 1}/{totalInPallet}
            </span>
          </span>
        )}

        {!zen && <span style={{ flex: 1 }} />}

        {!zen && (
          <span style={{
            fontSize: 11.5,
            color: T.text.faint,
            fontFamily: T.font.mono,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {overallPos} / {totalArticles}
          </span>
        )}

        <Button variant="ghost" size="sm" onClick={onPrev} disabled={!canPrev}
                title="Vorheriger Artikel (←)">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M9 11L4 7l5-4" stroke="currentColor" strokeWidth="1.6"
                  strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Zurück
        </Button>

        <Button variant="primary" onClick={onFertig}
                title="Artikel abschließen (Space oder Enter)">
          Artikel abschließen
          <Kbd onPrimary>Space</Kbd>
        </Button>

        <Button variant="ghost" size="sm" onClick={onNext} disabled={!canNext}
                title="Nächster Artikel (→)">
          Weiter
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M5 3l5 4-5 4" stroke="currentColor" strokeWidth="1.6"
                  strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </Button>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   BETA MODE — Top FBA pill + Bottom Island Bar
   ────────────────────────────────────────────────────────────────────────
   When Beta-design is on, the heavy Topbar is replaced by a minimal
   floating FBA-code pill at the top. All controls that used to live in
   the Topbar (view-mode toggles, exit cluster) plus the StickyBar's
   progress / navigation are consolidated into a single rounded «island»
   floating at the bottom of the viewport.
   ════════════════════════════════════════════════════════════════════════ */
function BetaTopPill({
  fba, startedAt, onExit, onGoToPruefen,
}: {
  fba: string;
  startedAt?: number | null;
  onExit: () => void;
  /* Optional back-to-Prüfen — when omitted the button is hidden so the
     pill stays usable in any future caller that doesn't need it. */
  onGoToPruefen?: () => void;
}) {
  const [fbaCopied, setFbaCopied] = useState(false);
  useEffect(() => {
    if (!fbaCopied) return undefined;
    const t = window.setTimeout(() => setFbaCopied(false), 1400);
    return () => window.clearTimeout(t);
  }, [fbaCopied]);
  const onCopyFba = () => {
    if (!fba) return;
    copyToClipboard(fba);
    setFbaCopied(true);
  };

  /* Live elapsed counter — ticks every second while the auftrag is
     running. The value is EFFECTIVE working seconds (lunch + non-work
     hours subtracted), so the badge naturally freezes at 12:00 and
     resumes at 12:30 without any extra state to wire up. */
  const { schedule: workSchedule } = useWorkSchedule();
  const [tick, forceTick] = useState(0);
  useEffect(() => {
    if (!startedAt) return undefined;
    const id = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  void tick; // pure re-render trigger
  const nowMs = Date.now();
  const elapsedSec = startedAt
    ? Math.floor(effectiveElapsedMs(startedAt, nowMs, workSchedule) / 1000)
    : 0;
  const elapsedLabel = formatElapsedTimer(elapsedSec);
  const phaseInfo = workPhaseAt(nowMs, workSchedule);
  const isPaused = !!startedAt && phaseInfo.phase !== 'working';
  const pauseChipLabel = (() => {
    if (!isPaused) return null;
    if (phaseInfo.phase === 'lunch' && phaseInfo.nextResumeMs) {
      return `Pause bis ${formatTimeInTz(phaseInfo.nextResumeMs, workSchedule.tz)}`;
    }
    return 'Außerhalb der Arbeitszeit';
  })();
  const pauseTooltip = phaseInfo.nextResumeMs
    ? `Timer pausiert · läuft weiter ab ${formatTimeInTz(phaseInfo.nextResumeMs, workSchedule.tz)}`
    : 'Timer pausiert · außerhalb der Arbeitszeit';

  if (!fba) return null;

  /* Shared inner button style — Stornieren and X both float as white
     pills inside the outer #F4F5F7 wrapper. */
  const chipBg = '#FFFFFF';

  return (
    <div style={{
      position: 'fixed',
      top: 18,
      left: '50%',
      transform: 'translateX(-50%)',
      /* Sidebar-aware centering — offset to the right by half the
         sidebar width so the pill sits centred in the WORKSPACE area
         (matching BetaIslandBar's bottom-of-viewport alignment). The
         CSS variable updates when the sidebar collapses/expands; the
         margin-left transition lets the pill slide in step with the
         sidebar width animation. */
      marginLeft: 'calc(var(--sidebar-width, 0px) / 2)',
      transition: 'margin-left 240ms cubic-bezier(0.16, 1, 0.3, 1)',
      zIndex: 40,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      padding: onGoToPruefen ? '4px 4px 4px 4px' : '4px 4px 4px 16px',
      background: '#F8F8F8',
      border: '2px solid #FFFFFF',
      borderRadius: 999,
      whiteSpace: 'nowrap',
    }}>
      {/* Back-to-Prüfen — left-anchored navigation chip. Symmetric to
          Pruefen's BetaFocusPill (which forwards to Focus): both screens
          now offer a one-click toggle to the sibling step without
          touching the workflow state. Hotkey: P. */}
      {onGoToPruefen && (
        <button
          type="button"
          onClick={onGoToPruefen}
          title="Zurück zur Prüfen-Ansicht (P)"
          aria-label="Zurück zu Prüfen"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 32,
            padding: '0 14px 0 11px',
            fontSize: 12,
            fontFamily: T.font.ui,
            fontWeight: 600,
            letterSpacing: '-0.005em',
            color: T.text.primary,
            background: chipBg,
            border: 'none',
            borderRadius: 999,
            cursor: 'pointer',
            transition: 'background 140ms, color 140ms, transform 200ms',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = T.accent.bg;
            e.currentTarget.style.color = T.accent.text;
            e.currentTarget.style.transform = 'translateX(-1px)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = chipBg;
            e.currentTarget.style.color = T.text.primary;
            e.currentTarget.style.transform = 'translateX(0)';
          }}
        >
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden>
            <path d="M11 7H3m0 0l3.5-3.5M3 7l3.5 3.5" stroke="currentColor"
                  strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Prüfen
        </button>
      )}

      {/* FBA — bare label + middot + click-to-copy code. No surrounding
          chip background; the outer wrapper carries the visual weight. */}
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        paddingLeft: onGoToPruefen ? 8 : 0,
      }}>
        <span
          title={isPaused ? pauseTooltip : `Auftrag-Dauer · läuft seit ${elapsedLabel}`}
          style={{
            fontFamily: T.font.mono,
            fontSize: 12.5,
            fontWeight: 700,
            color: isPaused ? T.text.subtle : 'var(--accent)',
            letterSpacing: '0.02em',
            fontVariantNumeric: 'tabular-nums',
            transition: 'color 200ms ease',
          }}
        >
          {elapsedLabel}
        </span>
        {/* Pause indicator — beta-only chip surfaces when the warehouse
            schedule says we're outside work hours or mid-break. The timer
            naturally freezes (effectiveElapsedMs returns the same value
            on each tick); this chip just explains the freeze and shows
            when the timer will resume. */}
        {pauseChipLabel && (
          <span
            title={pauseTooltip}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '2px 8px 2px 6px',
              marginLeft: 2,
              borderRadius: 999,
              fontFamily: T.font.ui,
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: '-0.005em',
              color: T.text.subtle,
              background: T.bg.surface2,
              border: `1px solid ${T.border.primary}`,
              whiteSpace: 'nowrap',
            }}
          >
            <span aria-hidden style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: T.text.subtle,
              animation: 'pulse 2s ease-in-out infinite',
            }} />
            {pauseChipLabel}
          </span>
        )}
        <span aria-hidden style={{ color: T.border.strong, fontFamily: T.font.mono }}>·</span>
        <button
          type="button"
          onClick={onCopyFba}
          title={fbaCopied ? `${fba} · kopiert` : `${fba} · klick zum Kopieren`}
          style={{
            all: 'unset',
            cursor: 'pointer',
            fontFamily: T.font.mono,
            fontSize: 14,
            fontWeight: 700,
            color: fbaCopied ? T.status.success.text : T.text.primary,
            letterSpacing: '0.04em',
            fontVariantNumeric: 'tabular-nums',
            transition: 'color 200ms ease',
          }}
          onMouseEnter={(e) => { if (!fbaCopied) e.currentTarget.style.color = T.accent.text; }}
          onMouseLeave={(e) => { if (!fbaCopied) e.currentTarget.style.color = T.text.primary; }}
        >
          {fba}
        </button>
      </div>

      {/* X close — square 32×32 white circle. Stornieren has been
          relocated to the BetaIslandBar overflow menu so the top pill
          can stay focused on identity (timer · FBA) + nav (← Prüfen)
          + exit, while destructive actions live one click deeper. */}
      <button
        type="button"
        onClick={onExit}
        title="Focus verlassen — Fortschritt bleibt gespeichert"
        aria-label="Focus verlassen"
        style={{
          width: 32,
          height: 32,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: chipBg,
          color: T.text.subtle,
          border: 'none',
          borderRadius: 999,
          cursor: 'pointer',
          padding: 0,
          transition: 'background 140ms, color 140ms',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = T.bg.surface2;
          e.currentTarget.style.color = T.text.primary;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = chipBg;
          e.currentTarget.style.color = T.text.subtle;
        }}
      >
        <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

interface BetaIslandBarProps {
  onFertig: () => void;
  canFertig: boolean;
  zen: boolean;
  /* Topbar-migrated controls — only the ones still surfaced in the
     menu tray; nav/progress fields were dropped with the status pill. */
  schnellmodus: boolean;
  onToggleShell: () => void;
  onOpenList: () => void;
  /* Destructive action moved here from BetaTopPill so the top pill can
     focus on identity + navigation. Rendered inside the menu tray with
     a danger-tone style so it never competes with primary actions. */
  onStorno: () => void;
  /* Smooth pallet-intensity profile — heat-coloured curve rendered in
     the left cluster of the bar (replaces the older hint/prediction
     text pair). `null` hides the chart entirely (e.g. single-item
     pallet). See computePalletIntensityProfile() in auftragHelpers. */
  intensity?: {
    values: number[];
    activeIdx: number;
    lastCompletedIdx: number;
    hasVariance: boolean;
    palletShortId?: string;
    details?: Array<{
      title: string;
      perPackage: string;
      units: number;
      volCm3: number;
      weightKg: number;
      intensity: number;
      level: number;
      isEsku: boolean;
      isCompleted: boolean;
      isActive: boolean;
    }>;
  } | null;
}
function BetaIslandBar({
  onFertig, canFertig,
  zen,
  schnellmodus,
  onToggleShell,
  onOpenList,
  onStorno,
  intensity = null,
}: BetaIslandBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  /* Intensity chip → click toggles a floating detail panel that
     hovers just above the island, showing the larger curve plus a
     per-item breakdown (units · volume · weight · intensity). */
  const [intensityOpen, setIntensityOpen] = useState(false);
  /* Tray height is measured (not max-height) so the bar can animate to
     the exact content height. The tray content is absolutely positioned
     so its intrinsic width never propagates to the bar — keeping the
     bar's width LOCKED at its closed/nav-row natural width. */
  const trayContentRef = useRef<HTMLDivElement>(null);
  const [trayHeight, setTrayHeight] = useState(0);
  useLayoutEffect(() => {
    const el = trayContentRef.current;
    if (!el) return undefined;
    const update = () => {
      const h = el.scrollHeight;
      if (h > 0) setTrayHeight(Math.round(h));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* Auto-collapse the menu whenever Zen turns on so the floating
     island reads as a single minimal nav bar. */
  useEffect(() => { if (zen && menuOpen) setMenuOpen(false); }, [zen, menuOpen]);
  /* Same for the intensity panel — Zen should mute every popover. */
  useEffect(() => { if (zen && intensityOpen) setIntensityOpen(false); }, [zen, intensityOpen]);
  /* Esc dismisses the panel without competing with workflow hotkeys
     (the page-level handler already gates on `intensityOpen=false`
     via document target checks). */
  useEffect(() => {
    if (!intensityOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setIntensityOpen(false); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [intensityOpen]);

  /* Apple-style mutual exclusion: opening one tray closes the other so
     the island never balloons with two stacked drawers at once. */
  const openIntensity = () => { setIntensityOpen((v) => !v); setMenuOpen(false); };
  const openMenu      = () => { setMenuOpen((v) => !v);      setIntensityOpen(false); };

  /* The bar morphs between a tight pill (collapsed) and a soft rounded
     rectangle (any tray open). Radius + min-width transition in unison
     so it reads as a single Dynamic Island gesture. */
  const anyOpen = !zen && (menuOpen || intensityOpen);

  return (
    <div style={{
      position: 'fixed',
      bottom: 18,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 50,
      width: 'auto',
      maxWidth: 'calc(100% - 48px)',
      marginLeft: 'calc(var(--sidebar-width) / 2)',
      background: '#F8F8F8',
      border: '2px solid #FFFFFF',
      borderRadius: anyOpen ? 28 : 50,
      overflow: 'hidden',
      transition: [
        'background 240ms ease',
        'border-color 240ms ease',
        'border-radius 320ms cubic-bezier(0.16, 1, 0.3, 1)',
        /* Slide with the sidebar collapse/expand animation (same curve
           + duration the Sidebar uses for its width transition). */
        'margin-left 240ms cubic-bezier(0.16, 1, 0.3, 1)',
      ].join(', '),
      pointerEvents: 'auto',
    }}>
      {/* ── Intensity tray — expands inline above the nav row.
          Width-LOCKED: the bar stays the same width as its closed
          (nav-row driven) state because the tray content is absolutely
          positioned. Out-of-flow elements don't contribute to their
          containing block's intrinsic width, so no matter how wide the
          tray's natural content would be, the bar never grows.
          Only height animates — measured from the inner content via
          ResizeObserver so the bar fits its contents exactly. */}
      <div style={{
        position: 'relative',
        height:   intensityOpen && !zen ? trayHeight : 0,
        opacity:  intensityOpen && !zen ? 1 : 0,
        overflow: 'hidden',
        transition: [
          'height 320ms cubic-bezier(0.16, 1, 0.3, 1)',
          'opacity 220ms ease',
        ].join(', '),
        pointerEvents: intensityOpen && !zen ? 'auto' : 'none',
      }}>
        <div
          ref={trayContentRef}
          style={{
            position: 'absolute',
            top: 0, left: 0, right: 0,
          }}
        >
          {intensity && <IntensityTray intensity={intensity} />}
        </div>
      </div>

      {/* ── Expanding menu (toggles + storno + exit) ──────────────────
          Same morphing tray pattern as Intensity; mutually exclusive
          via openMenu/openIntensity. */}
      <div style={{
        maxHeight: menuOpen && !zen ? 64 : 0,
        opacity: menuOpen && !zen ? 1 : 0,
        overflow: 'hidden',
        borderBottom: menuOpen && !zen ? `1px solid ${T.border.subtle}` : '1px solid transparent',
        transition: 'max-height 280ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms ease, border-color 240ms ease',
        pointerEvents: menuOpen && !zen ? 'auto' : 'none',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 16px',
          whiteSpace: 'nowrap',
        }}>
          <ViewListButton onClick={onOpenList} />
          <ShellToggle  on={schnellmodus}  onToggle={onToggleShell} />
          {/* Hairline separator — splits utility toggles from the
              destructive action so a stray click on Storno is one
              deliberate jump rightward, never adjacent to the modes. */}
          <span aria-hidden style={{
            width: 1, height: 22, background: T.border.subtle, margin: '0 4px',
          }} />
          <button
            type="button"
            onClick={onStorno}
            title="Auftrag stornieren — geht mit Begründung in die Historie"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              height: 32,
              padding: '0 14px',
              fontSize: 11,
              fontFamily: T.font.mono,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: T.status.danger.text,
              background: '#FFFFFF',
              border: `1px solid ${T.border.subtle}`,
              borderRadius: 999,
              cursor: 'pointer',
              transition: 'background 140ms, color 140ms, border-color 140ms',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = T.status.danger.bg;
              e.currentTarget.style.color = T.status.danger.main;
              e.currentTarget.style.borderColor = T.status.danger.border;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#FFFFFF';
              e.currentTarget.style.color = T.status.danger.text;
              e.currentTarget.style.borderColor = T.border.subtle;
            }}
          >
            Stornieren
          </button>
        </div>
      </div>

      {/* ── Minimal nav row — always visible ───────────────────────────
          A status pill (left), the Zurück · Fertig · Weiter cluster
          (centre), and a menu-trigger button (right) that opens the
          tray of secondary controls above. */}
      <div style={{
        padding: '10px 14px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        {!zen && intensity && intensity.values.length >= 2 && (
          <button
            type="button"
            onClick={openIntensity}
            aria-expanded={intensityOpen}
            aria-controls="mr-island-intensity"
            aria-label="Pallet-Intensität — Details"
            title="Pallet-Intensität · klicken für Aufschlüsselung"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: 44,
              padding: '0 18px',
              background: intensityOpen ? T.accent.bg : '#FFFFFF',
              border: `1px solid ${intensityOpen ? T.accent.border : T.border.subtle}`,
              borderRadius: 50,
              flexShrink: 0,
              cursor: 'pointer',
              transition: 'background 160ms ease, border-color 160ms ease',
            }}
          >
            <IntensityCurve
              values={intensity.values}
              activeIdx={intensity.activeIdx}
              lastCompletedIdx={intensity.lastCompletedIdx}
              hasVariance={intensity.hasVariance}
            />
          </button>
        )}

        {!zen && <span style={{ flex: 1 }} />}

        <Button variant="primary" onClick={onFertig}
                disabled={!canFertig}
                title={canFertig
                  ? 'Artikel abschließen (Space oder Enter)'
                  : 'Erst den Artikel-Code kopieren, dann abschließen'}
                style={{
                  borderRadius: 50,
                  opacity: canFertig ? 1 : 0.45,
                  cursor: canFertig ? 'pointer' : 'not-allowed',
                }}>
          Artikel abschließen
          <Kbd onPrimary>Space</Kbd>
        </Button>

        {!zen && <span style={{ flex: 1 }} />}

        {!zen && (
          <button
            type="button"
            onClick={openMenu}
            title={menuOpen ? 'Menü schließen' : 'Menü öffnen'}
            aria-label="Insel-Menü"
            aria-expanded={menuOpen}
            style={{
              width: 44,
              height: 44,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: menuOpen ? T.accent.bg : '#FFFFFF',
              color: menuOpen ? T.accent.text : T.text.subtle,
              border: `1px solid ${menuOpen ? T.accent.border : T.border.subtle}`,
              borderRadius: 50,
              cursor: 'pointer',
              padding: 0,
              transition: 'background 160ms ease, border-color 160ms ease, color 160ms ease, transform 220ms ease',
              transform: menuOpen ? 'rotate(90deg)' : 'rotate(0deg)',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <circle cx="2" cy="7" r="1.3" fill="currentColor" />
              <circle cx="7" cy="7" r="1.3" fill="currentColor" />
              <circle cx="12" cy="7" r="1.3" fill="currentColor" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   INTENSITY TRAY — minimalist Apple-style content rendered INSIDE the
   BetaIslandBar (no floating dialog, no backdrop). The bar morphs around
   it: radius softens, min-width grows.

   Layers, top-to-bottom:
     1. Hairline header  — pallet id · article count · peak % (one line)
     2. Scrollable list  — per-item row with a heat-coloured underline bar
                           as the only visual that scales with intensity.

   Active item gets an accent halo, completed items dim to success tone.
   No tiles, no big curve duplicate — the chip already carries the
   silhouette, the tray exists to break it down by article.
   ════════════════════════════════════════════════════════════════════════ */
interface IntensityTrayProps {
  intensity: NonNullable<BetaIslandBarProps['intensity']>;
}
function IntensityTray({ intensity }: IntensityTrayProps) {
  const { values, hasVariance, activeIdx, lastCompletedIdx, palletShortId, details } = intensity;
  const rows = details || [];
  const n = rows.length;

  const peakValue = useMemo(() => {
    let pv = 0;
    for (const r of rows) if (r.intensity > pv) pv = r.intensity;
    return pv;
  }, [rows]);

  return (
    <div
      id="mr-island-intensity"
      role="region"
      aria-label={`Pallet-Intensität ${palletShortId || ''}`}
      style={{
        padding: '14px 18px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        /* Conforms to the bar island's intrinsic (nav-row driven) width.
           The bar stays the same size as its default closed pill — only
           height changes. width:100% lets the tray fill that width
           exactly, never inflating the bar past its natural pill. */
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      {/* Compact one-line header — minimum chrome, max info density. */}
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
        whiteSpace: 'nowrap',
      }}>
        <span style={{
          fontSize: 12,
          fontWeight: 700,
          color: T.text.primary,
          letterSpacing: -0.1,
        }}>
          {palletShortId || 'Palette'}
          <span style={{ fontWeight: 500, color: T.text.subtle, marginLeft: 6 }}>
            · {n} Artikel
          </span>
        </span>
        <span style={{
          fontSize: 11,
          color: T.text.subtle,
          fontVariantNumeric: 'tabular-nums',
        }}>
          Spitze {Math.round(peakValue * 100)}%
        </span>
      </div>

      {/* Hero curve — fluid SVG fills the full tray width so the
          silhouette spans the entire island. Height stays fixed; the
          curve stretches horizontally for a wide, panoramic read. */}
      <div style={{ width: '100%', padding: '2px 0' }}>
        <IntensityCurve
          values={values}
          activeIdx={activeIdx}
          lastCompletedIdx={lastCompletedIdx}
          hasVariance={hasVariance}
          width={760}
          height={84}
          fluid
        />
      </div>

      {/* List — single source of per-item detail. Each row is its own
          card container so rows read as discrete items at a glance.
          Scrolls when items overflow; otherwise the tray hugs its
          natural height.

          Wheel isolation: FlowStream attaches a window-level wheel
          listener that advances the active card. Without isolation,
          scrolling inside this list would bleed through and accidentally
          step the worker's Focus position. We stop wheel propagation at
          the list and use `overscroll-behavior: contain` to also block
          native scroll-chaining at the boundaries. */}
      <div
        onWheel={(e) => e.stopPropagation()}
        style={{
          maxHeight: 248,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          margin: '0 -2px',
          padding: '0 2px 2px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {rows.map((r, i) => (
          <IntensityRow key={i} idx={i} row={r} peakValue={peakValue} />
        ))}
      </div>
    </div>
  );
}

interface IntensityRowProps {
  idx: number;
  row: NonNullable<NonNullable<BetaIslandBarProps['intensity']>['details']>[number];
  peakValue: number;
}
function IntensityRow({ idx, row, peakValue }: IntensityRowProps) {
  const fill = peakValue > 0 ? Math.max(0.04, Math.min(1, row.intensity / peakValue)) : 0;
  const isHighlighted = row.isActive;
  /* Each row is its own card — white surface against the bar's #F8F8F8
     so rows pop as discrete items. Active row picks up the accent halo,
     completed rows take a success tint; the hairline border morphs to
     match each state for a unified visual signal. */
  const bg = isHighlighted
    ? T.accent.bg
    : row.isCompleted ? T.status.success.bg : '#FFFFFF';
  const borderColor = isHighlighted
    ? T.accent.border
    : row.isCompleted ? `${T.status.success.main}33` : T.border.subtle;
  const titleColor = row.isCompleted ? T.status.success.text : T.text.primary;
  return (
    <div
      style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: '26px 1fr auto',
        alignItems: 'center',
        gap: 14,
        padding: '13px 16px 16px',
        background: bg,
        border: `1px solid ${borderColor}`,
        borderRadius: 12,
        opacity: row.isCompleted && !row.isActive ? 0.7 : 1,
        transition: 'background 160ms, border-color 160ms',
      }}
    >
      <span style={{
        fontSize: 11,
        fontWeight: 600,
        color: T.text.faint,
        fontVariantNumeric: 'tabular-nums',
        textAlign: 'right',
      }}>
        {idx + 1}
      </span>

      <span style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        minWidth: 0,
        overflow: 'hidden',
      }}>
        <span style={{
          fontSize: 13,
          fontWeight: 500,
          color: titleColor,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minWidth: 0,
          letterSpacing: -0.1,
        }}>
          {row.title}
        </span>
        {row.perPackage && (
          <span style={{
            fontSize: 11,
            fontWeight: 500,
            color: T.text.faint,
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
          }}>
            · {row.perPackage}
          </span>
        )}
      </span>

      <span style={{
        fontSize: 12,
        fontWeight: 600,
        color: T.text.subtle,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      }}>
        {Math.round(row.intensity * 100)}%
      </span>

      {/* Underline bar — the only intensity visual, spans the row's
          content area like a Mac progress hairline. Heat-coloured so
          the curve's gradient logic carries through to the breakdown.
          Offsets account for the 1px border + roomier padding so the
          bar sits inside the card cleanly with a little breathing room. */}
      <div aria-hidden style={{
        position: 'absolute',
        left: 16,
        right: 16,
        bottom: 6,
        height: 3,
        background: 'rgba(0,0,0,0.05)',
        borderRadius: 50,
        overflow: 'hidden',
      }}>
        <div style={{
          width: `${fill * 100}%`,
          height: '100%',
          background: heatColor(row.intensity),
          borderRadius: 50,
          transition: 'width 220ms ease',
        }} />
      </div>
    </div>
  );
}

/* PalletPills — pallet flow with stepper-style connectors.
   Each pill shows: state-icon · pallet ID · counter (item count for
   done/todo, "x/y" copy progress for current). Connector hairlines
   between pills turn green as the worker crosses pallets, giving a
   horizontal "progress chain" feel without adding vertical noise. */
/* ════════════════════════════════════════════════════════════════════════
   PALLET FLOW — full timeline of pallets in one strip.

   Each pallet is a multi-layer "node" showing every fact at a glance:
     • Header row    : state-icon · ID · counter · ESKU mark · flag dot
     • Fingerprint   : one cell per item, coloured by physical level,
                       opacity by copy-state. Cells of the CURRENT pallet
                       are clickable for jump-to-item (replaces the old
                       separate numbered-chip strip).
   Stepper-style hairline connectors between nodes turn green as the
   worker crosses each pallet, so the chain itself reads as progress.
   ════════════════════════════════════════════════════════════════════════ */
interface PalletStateInfo { anyEsku?: boolean; overloadFlags?: Set<string>; [k: string]: unknown }
interface FocusPalletItem { level?: number; placementMeta?: { flags?: unknown[] }; [k: string]: unknown }
interface PalletFlowProps {
  pallets: Array<{ id: string; items?: FocusPalletItem[]; [k: string]: unknown }>;
  palletStates?: Record<string, PalletStateInfo>;
  palletTimings?: unknown;
  currentIdx: number;
  itemIdx: number;
  copiedKeys: Set<string>;
  completedKeys?: Set<string>;
  allPalletCopied: boolean;
  onPickPallet: (idx: number) => void;
  onPickItem: (palletIdx: number, itemIdx: number) => void;
  onReorder?: (fromIdx: number, toIdx: number) => void;
  direction?: 'horizontal' | 'vertical';
  collapsed?: boolean;
  /* Progress ring + click target attached to the CURRENT pallet's
     circle. `count`/`total` drive a small circular fill gauge around
     the ID circle; clicking the circle toggles the Erledigt popover.
     Only meaningful in collapsed/vertical (left-rail) mode. */
  currentDoneBadge?: { count: number; total: number; active: boolean; onClick: () => void } | null;
}

function PalletFlow({
  pallets, palletStates, currentIdx, itemIdx,
  copiedKeys, completedKeys, allPalletCopied,
  onPickPallet, onPickItem, onReorder,
  direction = 'horizontal',
  collapsed = false,
  currentDoneBadge = null,
}: PalletFlowProps) {
  const { beta } = useBetaDesign();
  const isVertical = direction === 'vertical';
  /* Drag-and-drop reorder — always live in the compact strip. The
     cards are draggable silently; visual cues only appear DURING a
     drag (source dimmed, target outlined) so the resting state stays
     clean. */
  const [dragFromIdx, setDragFromIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const dndEnabled = !!onReorder;

  /* Visual clustering — consecutive Single-SKU pallets that share the
     same useItem (or FNSKU/EAN/SKU fallback) render inside a single
     pill-shaped capsule. Mirrors the NumberedChipStrip article-cluster
     styling (surface3 bg + strong border) so the worker reads the
     same vocabulary for "same parent SKU" across both strips. */
  const clusters = useMemo<Array<{ key: string; indices: number[] }>>(() => {
    if (!pallets?.length) return [];
    const out: Array<{ key: string; indices: number[] }> = [];
    let prevKey: string | null = null;
    pallets.forEach((p, i) => {
      const k = singleSkuClusterKey(p);
      const last = out[out.length - 1];
      if (k && prevKey === k && last) {
        last.indices.push(i);
      } else {
        out.push({ key: k ? `cl:${k}` : `solo:${i}`, indices: [i] });
        prevKey = k;
      }
    });
    return out;
  }, [pallets]);

  if (!pallets?.length) return null;

  /* Per-pallet completion check — every item has a Fertig record.
     Used at two layers: each PalletNode's own 'done' state, and the
     cluster container's success transition (turns green once ALL of
     its pallets are done). */
  const isPalletDone = (p, i) => {
    const total = p.items?.length || 0;
    if (total === 0) return false;
    for (let j = 0; j < total; j++) {
      if (!completedKeys?.has?.(`${i}|${j}`)) return false;
    }
    return true;
  };

  const renderPallet = (p, i) => {
    const total = p.items?.length || 0;
    let copied = 0;
    for (let j = 0; j < total; j++) {
      if (copiedKeys?.has?.(`${i}|${j}`)) copied += 1;
    }
    // 'done' is derived from actual Fertig-completion, NOT from
    // display position. Otherwise a drag-reordered unfinished pallet
    // landing left of the current one would falsely green out.
    const allCompleted = isPalletDone(p, i);
    const state = i === currentIdx
      ? 'current'
      : allCompleted ? 'done' : 'todo';
    const blocked = i > currentIdx && !allPalletCopied;
    const ps = palletStates?.[p.id];
    const isEsku = !!ps?.anyEsku;
    const hasFlag = !!(
      (ps?.overloadFlags && ps.overloadFlags.size > 0)
      || (p.items || []).some((it) => (it.placementMeta?.flags || []).length > 0)
    );
    const isDragSource = dragFromIdx === i;
    const isDragTarget = dragOverIdx === i && dragFromIdx !== null && dragFromIdx !== i;
    return (
      <span
        key={p.id}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          flexShrink: 0,
          borderRadius: 14,
          cursor: dndEnabled ? 'grab' : 'default',
          opacity: isDragSource ? 0.4 : 1,
          boxShadow: isDragTarget
            ? `inset 0 0 0 2px ${T.accent.main}`
            : 'none',
          transition: 'opacity 160ms ease, box-shadow 160ms ease',
        }}
        draggable={dndEnabled}
        onDragStart={dndEnabled ? (e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(i));
          setDragFromIdx(i);
        } : undefined}
        onDragOver={dndEnabled ? (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (dragFromIdx === null) return;
          if (i !== dragOverIdx) setDragOverIdx(i);
        } : undefined}
        onDrop={dndEnabled ? (e) => {
          e.preventDefault();
          if (dragFromIdx !== null && dragFromIdx !== i) {
            onReorder?.(dragFromIdx, i);
          }
          setDragFromIdx(null);
          setDragOverIdx(null);
        } : undefined}
        onDragEnd={dndEnabled ? () => {
          setDragFromIdx(null);
          setDragOverIdx(null);
        } : undefined}
      >
        <PalletNode
          pallet={p}
          palletIdx={i}
          state={state}
          blocked={blocked}
          total={total}
          copied={copied}
          isEsku={isEsku}
          hasFlag={hasFlag}
          currentItemIdx={state === 'current' ? itemIdx : -1}
          copiedKeys={copiedKeys}
          completedKeys={completedKeys}
          onPickPallet={() => onPickPallet?.(i)}
          onPickItem={onPickItem}
          collapsed={collapsed}
          vertical={isVertical}
          doneBadge={i === currentIdx ? currentDoneBadge : null}
        />
      </span>
    );
  };

  return (
    <div style={{
      display: isVertical ? 'flex' : 'inline-flex',
      flexDirection: isVertical ? 'column' : 'row',
      alignItems: isVertical ? 'stretch' : 'center',
      gap: isVertical ? 8 : 10,
      flexShrink: 0,
    }}>
      {clusters.map((cluster) => {
        if (cluster.indices.length === 1) {
          const i = cluster.indices[0];
          return renderPallet(pallets[i], i);
        }
        // Whole cluster done = every pallet inside is Fertig-completed.
        // Triggers a smooth green-out: the container's surface2 bg fades
        // into the same success.bg as its inner PalletNodes, unified
        // under a stronger success border that frames the group.
        const allDone = cluster.indices.every((i) => isPalletDone(pallets[i], i));
        const clusterStyle: React.CSSProperties = beta
          ? {
            display: isVertical ? 'flex' : 'inline-flex',
            flexDirection: isVertical ? 'column' : 'row',
            flexWrap: 'nowrap',
            alignItems: 'center',
            justifyContent: 'center',
            gap: isVertical ? 8 : 6,
            padding: 0,
            background: allDone ? T.status.success.bg : '#F4F5F7',
            border: 'none',
            borderRadius: isVertical ? 28 : 999,
            boxShadow: allDone
              ? `inset 0 0 0 2px ${T.status.success.main}`
              : 'inset 0 0 0 2px #FFFFFF, 0 0 24px rgba(0, 0, 0, 0.04)',
            flexShrink: 0,
            transition: 'background 400ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 400ms cubic-bezier(0.16, 1, 0.3, 1)',
          }
          : {
            display: isVertical ? 'flex' : 'inline-flex',
            flexDirection: isVertical ? 'column' : 'row',
            flexWrap: 'nowrap',
            alignItems: isVertical ? 'stretch' : 'center',
            gap: 6,
            padding: 4,
            background: allDone ? T.status.success.bg : T.bg.surface2,
            border: `1.5px solid ${allDone ? T.status.success.main : T.border.strong}`,
            borderRadius: isVertical ? 14 : 999,
            flexShrink: 0,
            transition: 'background 400ms cubic-bezier(0.16, 1, 0.3, 1), border-color 400ms cubic-bezier(0.16, 1, 0.3, 1)',
          };
        return (
          <div
            key={cluster.key}
            title={`${cluster.indices.length}× Single-SKU mit gleichem Use-Item${allDone ? ' · alle abgeschlossen' : ''}`}
            style={clusterStyle}
          >
            {cluster.indices.map((i) => renderPallet(pallets[i], i))}
          </div>
        );
      })}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   FLOW MODE — Hero Card Flow
   ────────────────────────────────────────────────────────────────────────
   An opt-in Focus-mode layout:
     - LEFT: narrow rail (80px) with vertical PalletFlow, expands to 240px
             on hover.
     - CENTER: ArticleHeroCard kept in viewport center + vertical stream
               of compact rows for upcoming articles on the current pallet.
     - Cross-pallet preview: first 2-3 articles of the next pallet rendered
       as ghost rows under a dashed separator.
   Triggered by the FlowToggle in the Topbar (hotkey F). When OFF, the
   classic single-hero layout in <main> renders unchanged.
   ════════════════════════════════════════════════════════════════════════ */

/* IntensityCurve — smooth heat-coloured area chart that rides in the
   left cluster of the BetaIslandBar (beta-only). Reads the per-item
   intensity profile (units × volume × weight, normalized per pallet)
   produced by computePalletIntensityProfile() and renders it as a
   minimalist Catmull-Rom → cubic-Bézier filled curve. The horizontal
   <linearGradient> stops are heat-coloured (cool → warm) keyed to
   each item's intensity value so the gradient itself tells the worker
   where the heavy zones are. Completion is shown by clipping the
   curve into two regions (done = 80% opacity, pending = 28%); the
   active item gets a 1px vertical whisper-line. No axes, no grid,
   no labels — the silhouette + colour carries the whole message. */
interface IntensityCurveProps {
  values: number[];
  activeIdx: number;
  lastCompletedIdx: number;
  hasVariance: boolean;
  /* Optional sizing — the chip in BetaIslandBar uses the defaults. Kept
     extensible so a hero-sized variant can be added without forking. */
  width?: number;
  height?: number;
  /* Fluid mode — SVG scales to its container's width via
     preserveAspectRatio. Used by the expanded IntensityTray to fill the
     full bar island width regardless of viewport size. */
  fluid?: boolean;
}
const INTENSITY_W = 160;
const INTENSITY_H = 28;
/* Soft pastel heat-scale — preserves the cool→warm semantic but in
   gentler hues that don't fight the accent palette of the pill. */
const HEAT_STOPS = [
  '#A5B4FC', // 0.0   — soft indigo (low intensity)
  '#C4B5FD', // 0.33  — lavender
  '#F0ABFC', // 0.66  — soft fuchsia
  '#FDA4AF', // 1.0   — warm rose
];
function heatColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const seg = clamped * (HEAT_STOPS.length - 1);
  const i = Math.floor(seg);
  const f = seg - i;
  const a = HEAT_STOPS[i];
  const b = HEAT_STOPS[Math.min(HEAT_STOPS.length - 1, i + 1)];
  /* mix two hex colors in RGB space */
  const ah = a.slice(1); const bh = b.slice(1);
  const ar = parseInt(ah.slice(0, 2), 16);
  const ag = parseInt(ah.slice(2, 4), 16);
  const ab = parseInt(ah.slice(4, 6), 16);
  const br = parseInt(bh.slice(0, 2), 16);
  const bg = parseInt(bh.slice(2, 4), 16);
  const bb = parseInt(bh.slice(4, 6), 16);
  const r = Math.round(ar + (br - ar) * f);
  const g = Math.round(ag + (bg - ag) * f);
  const bl = Math.round(ab + (bb - ab) * f);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${bl.toString(16).padStart(2, '0')}`;
}
/* Catmull-Rom (tension 0.5) → cubic Bézier path string. Closes the
   shape down to the baseline so it can be filled as an area. */
function smoothAreaPath(points: Array<[number, number]>, baselineY: number): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const [x, y] = points[0];
    return `M${x},${baselineY} L${x},${y} L${x},${baselineY} Z`;
  }
  const parts: string[] = [`M${points[0][0]},${baselineY} L${points[0][0]},${points[0][1]}`];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    parts.push(`C${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`);
  }
  const lastX = points[points.length - 1][0];
  parts.push(`L${lastX},${baselineY} Z`);
  return parts.join(' ');
}
function IntensityCurve({
  values, activeIdx, lastCompletedIdx, hasVariance,
  width = INTENSITY_W, height = INTENSITY_H,
  fluid = false,
}: IntensityCurveProps) {
  const uid = useId().replace(/:/g, '');
  const n = values.length;
  const svgRef = useRef<SVGSVGElement>(null);

  /* Fluid mode — measure the SVG's actual rendered width so the viewBox
     matches it 1:1. That keeps marker circles circular regardless of
     container size (no preserveAspectRatio="none" distortion). The
     fallback to the prop value covers the very first paint before the
     observer fires; in practice useLayoutEffect runs before paint, so
     this fallback is almost never visible. */
  const [measuredW, setMeasuredW] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!fluid) return undefined;
    const el = svgRef.current;
    if (!el) return undefined;
    const update = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0) setMeasuredW(Math.round(r.width));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fluid]);
  const W = fluid && measuredW ? measuredW : width;

  /* Flat-profile fallback: a near-uniform pallet should still produce
     a soft baseline shape rather than a jagged 5% waveform. */
  const effective = hasVariance ? values : values.map(() => 0.5);

  const points: Array<[number, number]> = effective.map((v, i) => {
    const x = n === 1 ? W / 2 : (i / (n - 1)) * W;
    const y = (1 - v) * (height - 2) + 1; /* 1px top inset so the curve doesn't kiss the edge */
    return [x, y];
  });
  const d = smoothAreaPath(points, height);

  /* Heat stops keyed to each item's intensity value, positioned along
     the horizontal axis at the same x as the item itself. */
  const heatStops = effective.map((v, i) => ({
    offset: n === 1 ? 0 : (i / (n - 1)) * 100,
    color: heatColor(v),
  }));

  /* Stroke-only path (no baseline close) — for the silhouette curve. */
  const strokeD = (() => {
    if (points.length === 0) return '';
    if (points.length === 1) {
      const [x, y] = points[0];
      return `M${x},${y}`;
    }
    const parts: string[] = [`M${points[0][0]},${points[0][1]}`];
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(points.length - 1, i + 2)];
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = p2[1] - (p3[1] - p1[1]) / 6;
      parts.push(`C${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`);
    }
    return parts.join(' ');
  })();

  const splitX = lastCompletedIdx >= 0
    ? ((lastCompletedIdx + 1) / n) * W
    : 0;
  const activeOnCurve = activeIdx >= 0 && activeIdx < n ? points[activeIdx] : null;

  const flatOpacity = hasVariance ? 1 : 0.45;
  /* Stroke + active-marker radii scale gently with the rendered height
     so the larger curve in the detail panel reads as a proper hero
     visual instead of a stretched pill thumbnail. */
  const strokeW    = Math.max(2.5, height / 24);
  const haloR      = Math.max(4.5, height / 16);
  const dotR       = Math.max(2.6, height / 24);

  return (
    <svg
      ref={svgRef}
      width={fluid ? '100%' : W}
      height={height}
      viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
      style={{
        display: 'block',
        overflow: 'visible',
        ...(fluid ? { width: '100%' } : null),
      }}
    >
      <defs>
        <linearGradient id={`heat-${uid}`} x1="0" y1="0" x2="1" y2="0">
          {heatStops.map((s, i) => (
            <stop key={i} offset={`${s.offset}%`} stopColor={s.color} />
          ))}
        </linearGradient>
        {/* Vertical area-fade: opaque just under the stroke, fully
            transparent at the baseline — gives the soft "glow" feel
            of the reference instead of a heavy filled silhouette. */}
        <linearGradient id={`fade-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#FFF" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#FFF" stopOpacity="0" />
        </linearGradient>
        <mask id={`fademask-${uid}`}>
          <rect x={0} y={0} width={W} height={height} fill={`url(#fade-${uid})`} />
        </mask>
        <clipPath id={`done-${uid}`}>
          <rect x={0} y={0} width={splitX} height={height} />
        </clipPath>
        <clipPath id={`pending-${uid}`}>
          <rect x={splitX} y={0} width={W - splitX} height={height} />
        </clipPath>
      </defs>

      {/* Soft area glow underneath — single subtle fill across the
          whole curve, opacity modulated by done/pending zones. */}
      <g clipPath={`url(#pending-${uid})`} opacity={0.18 * flatOpacity}>
        <path d={d} fill={`url(#heat-${uid})`} mask={`url(#fademask-${uid})`} />
      </g>
      <g clipPath={`url(#done-${uid})`} opacity={0.32 * flatOpacity}>
        <path d={d} fill={`url(#heat-${uid})`} mask={`url(#fademask-${uid})`} />
      </g>

      {/* Stroke — the primary visual. Pending half at 85%, done half
          at full saturation; both share the same gentle heat gradient. */}
      <g clipPath={`url(#pending-${uid})`} opacity={0.85 * flatOpacity}>
        <path d={strokeD} fill="none" stroke={`url(#heat-${uid})`}
              strokeWidth={strokeW} strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <g clipPath={`url(#done-${uid})`} opacity={1 * flatOpacity}>
        <path d={strokeD} fill="none" stroke={`url(#heat-${uid})`}
              strokeWidth={strokeW} strokeLinecap="round" strokeLinejoin="round" />
      </g>

      {/* Active marker — small white-filled circle ON the curve at the
          active item's point, with a soft accent halo. */}
      {activeOnCurve && (
        <g>
          <circle cx={activeOnCurve[0]} cy={activeOnCurve[1]} r={haloR}
                  fill="#FFFFFF" opacity={0.35} />
          <circle cx={activeOnCurve[0]} cy={activeOnCurve[1]} r={dotR}
                  fill="#FFFFFF"
                  stroke="var(--accent)" strokeWidth="1.2" />
        </g>
      )}
    </svg>
  );
}

/* FlowCompactRow — single horizontal row for one article in the
   stream. Two visual variants only:
     - default: white surface, neutral text, clickable
     - ghost: cross-pallet preview, dashed left accent, 55% opacity
   Past/upcoming distinction is dropped — every non-active row reads as
   a peer to keep navigation friction-free. */
interface FlowCompactRowProps {
  item: any;
  ghost?: boolean;
  isDone?: boolean;
  palletMaxItemVolCm3?: number;
  palletTotalVolCm3?: number;
  onClick?: () => void;
}
function FlowCompactRow({
  item, ghost = false, isDone = false,
  palletMaxItemVolCm3 = 0, palletTotalVolCm3 = 0,
  onClick,
}: FlowCompactRowProps) {
  const lvl = item?.level || getDisplayLevel(item) || 1;
  const meta = LEVEL_META[lvl] || LEVEL_META[1];
  const isEsku = item?.isEinzelneSku === true || item?.isEsku === true;
  const cartons = isEsku ? (item?.eskuCartons ?? item?.units) : item?.units;
  const title = simplifyItemTitle(item?.name || item?.title || '—');

  /* Pallet-occupancy mini-bar — RELATIVE ranking within the current
     pallet. Bar width = this item's volume normalized to the BIGGEST
     item on this pallet (max-of-pallet), so the operator can compare
     items side-by-side: «this one is twice the size of that one».
     Tooltip exposes three layers for full context:
       - rel  = share of the largest item on this pallet
       - abs  = share of the pallet's actual total occupancy
       - lim  = share of the canonical 1.59 m³ soft limit            */
  const itemVolCm3   = itemTotalVolumeCm3(item);
  const relFrac      = palletMaxItemVolCm3 > 0 ? itemVolCm3 / palletMaxItemVolCm3 : 0;
  const absPalletPct = palletTotalVolCm3 > 0 ? itemVolCm3 / palletTotalVolCm3 : 0;
  const absLimitPct  = itemVolCm3 / PALLET_VOL_CM3;
  /* MIN_VISIBLE floor — even the tiniest item gets a visible nub
     instead of vanishing into the track when the pallet contains a
     single dominant carton. Just an existence cue. */
  const MIN_VISIBLE  = 0.08;
  const barFill      = Math.max(MIN_VISIBLE, Math.min(1, relFrac));
  /* Top-contributor highlight — items consuming >25 % of the pallet's
     actual occupancy get a tighter inset border on the fill so they
     read as «big players» at a glance, separate from the relative
     ranking signal. */
  const isTopContrib = absPalletPct > 0.25;
  const hasViz       = itemVolCm3 > 0;
  const fillColor    = isDone ? T.status.success.main : meta.color;

  /* «Successful» rows (artikel-code already copied for this item) read
     in green — mirrors the FlowHero's `copied` state so the worker has
     a consistent visual record of «done with this one» across the
     stream. Done rows keep the level-color dot ring as a faint
     reminder but switch their bg/border/text to the success palette. */
  const restBg     = isDone ? T.status.success.bg   : (ghost ? 'transparent' : '#F4F5F7');
  // Done rows skip the left border entirely — the green bg already
  // carries the «successful» signal, the side line adds noise.
  const restBorder = 'transparent';
  // Slightly darker green tint for hover that still reads as «success»
  // instead of switching to neutral surface2 (which would feel like
  // the row was «un-done» on hover).
  const hoverBg    = isDone ? `${T.status.success.main}26` : '#FFFFFF';
  const hoverBorder = isDone ? 'transparent' : meta.color;
  const restTextColor = isDone ? T.status.success.text : T.text.subtle;
  const hoverTextColor = isDone ? T.status.success.text : T.text.primary;
  const dotColor       = isDone ? T.status.success.main : meta.color;

  /* Concert-hover — at rest each row whispers (faint dot + subtle text).
     On hover every element lights up in unison: dot expands with a soft
     ring, title + number snap to a stronger tone, an accent border
     slides in from the left, and a small right-pointing arrow fades in
     to telegraph «click to navigate». DOM mutation avoids per-row
     state. */
  const onEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
    const el = e.currentTarget;
    el.style.background = hoverBg;
    el.style.transform = 'translateY(-1px)';
    const dot = el.querySelector('[data-fcr=dot]') as HTMLElement | null;
    const arrow = el.querySelector('[data-fcr=arrow]') as HTMLElement | null;
    const titleEl = el.querySelector('[data-fcr=title]') as HTMLElement | null;
    const numEl = el.querySelector('[data-fcr=num]') as HTMLElement | null;
    if (dot) { dot.style.transform = 'scale(1.4)'; dot.style.opacity = '1'; dot.style.boxShadow = `0 0 0 4px ${dotColor}26`; }
    if (arrow) { arrow.style.opacity = '1'; arrow.style.transform = 'translateX(0)'; }
    if (titleEl) titleEl.style.color = hoverTextColor;
    if (numEl) numEl.style.color = hoverTextColor;
  };
  const onLeave = (e: React.MouseEvent<HTMLButtonElement>) => {
    const el = e.currentTarget;
    el.style.background = restBg;
    el.style.transform = 'translateY(0)';
    const dot = el.querySelector('[data-fcr=dot]') as HTMLElement | null;
    const arrow = el.querySelector('[data-fcr=arrow]') as HTMLElement | null;
    const titleEl = el.querySelector('[data-fcr=title]') as HTMLElement | null;
    const numEl = el.querySelector('[data-fcr=num]') as HTMLElement | null;
    if (dot) { dot.style.transform = 'scale(1)'; dot.style.opacity = ghost ? '0.5' : '0.85'; dot.style.boxShadow = `0 0 0 2px ${dotColor}1A`; }
    if (arrow) { arrow.style.opacity = '0'; arrow.style.transform = 'translateX(-4px)'; }
    if (titleEl) titleEl.style.color = restTextColor;
    if (numEl) numEl.style.color = restTextColor;
  };

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      title={item?.name || title}
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto 160px 14px',
        alignItems: 'center',
        gap: 14,
        width: '68%',
        margin: '0 auto',
        height: 66,
        padding: '0 22px 0 20px',
        background: restBg,
        border: ghost
          ? `2px dashed ${T.border.strong}`
          : 'none',
        borderRadius: 50,
        cursor: 'pointer',
        opacity: ghost ? 0.45 : 1,
        textAlign: 'left',
        fontFamily: T.font.ui,
        transition: 'background 220ms ease, border-color 240ms ease, transform 220ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      {/* Title — subtle at rest, snaps to primary on hover; switches to
          success-text when the row is done. Slightly tightened
          letter-spacing matches the hero's caps eyebrow. */}
      <span data-fcr="title" style={{
        fontSize: 14,
        fontWeight: 500,
        color: restTextColor,
        letterSpacing: '-0.005em',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        minWidth: 0,
        transition: 'color 200ms ease',
      }}>
        {title}
      </span>

      {/* Quantity — cartons for ESKU, units for Mixed. Mono so digits
          align across stacked rows. Hover lifts it via the [data-fcr=num]
          handlers already wired in onEnter/onLeave. */}
      <span
        data-fcr="num"
        title={isEsku
          ? `${cartons ?? 0} Kartons`
          : `${cartons ?? 0} Stück`}
        style={{
          fontFamily: T.font.mono,
          fontSize: 13.5,
          fontWeight: 600,
          color: restTextColor,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '-0.005em',
          whiteSpace: 'nowrap',
          opacity: cartons != null ? 1 : 0.4,
          transition: 'color 200ms ease',
        }}
      >
        {cartons != null ? `× ${cartons}` : '—'}
        <span style={{
          marginLeft: 4,
          fontSize: 10.5,
          fontWeight: 500,
          color: T.text.faint,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}>
          {isEsku ? 'K' : 'S'}
        </span>
      </span>

      {/* Pallet-occupancy mini-bar — sits between title and quantity.
          Width-coded fraction (cap at 100%) of the 1.59 m³ soft limit
          this article consumes. Tooltip gives the exact percent.
          Empty span when no volume data so the grid cell stays. */}
      {hasViz ? (
        <span
          aria-hidden
          data-fcr="bar"
          title={
            `${Math.round(relFrac * 100)} % vom größten Artikel` +
            ` · ${Math.round(absPalletPct * 100)} % der Palette` +
            ` · ${Math.round(absLimitPct * 100)} % vom Limit`
          }
          style={{
            display: 'inline-block',
            width: 156,
            height: 6,
            background: 'rgba(15, 23, 42, 0.04)',
            borderRadius: 999,
            position: 'relative',
            overflow: 'hidden',
            flexShrink: 0,
            opacity: ghost ? 0.4 : 0.9,
          }}
        >
          <span style={{
            display: 'block',
            width: `${barFill * 100}%`,
            height: '100%',
            background: fillColor,
            borderRadius: 999,
            /* Top-contributor visual cue — inset 1px border at the
               same color tightens the fill, signalling «this item is
               a major player on this pallet». */
            boxShadow: isTopContrib ? `inset 0 0 0 1px ${fillColor}` : 'none',
            transition: 'width 240ms cubic-bezier(0.16, 1, 0.3, 1), background 220ms ease, box-shadow 200ms ease',
          }} />
        </span>
      ) : (
        <span aria-hidden style={{ display: 'inline-block', width: 156 }} />
      )}

      {/* Right arrow — fades in + slides right on hover. Tells the user
          «I'm clickable, I'll take you there» without any text labels. */}
      <span aria-hidden data-fcr="arrow" style={{
        width: 14, height: 14,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: dotColor,
        opacity: 0,
        transform: 'translateX(-4px)',
        transition: 'opacity 240ms ease, transform 240ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}>
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
          <path d="M3 7h8m0 0L7.5 3.5M11 7l-3.5 3.5" stroke="currentColor"
                strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </span>
    </button>
  );
}

/* FlowHero — Flow-mode hero. Visual hierarchy:
     X00-code (massive mono, dominant) → Use-Item (quiet secondary
     line, click-to-copy) → tiny title + per-Karton on the LEFT of
     the body row, huge carton quantity on the RIGHT.
   Title is intentionally muted so the worker's eye locks onto the
   X-code first — the title is descriptive context, the code is the
   thing to act on. Clicking the X-code or the Use-Item row copies
   the respective bare scanner code. */
interface FlowHeroProps {
  item: any;
  copied: boolean;
  onCopyCode: () => void;
  onCopyUse?: () => void;
  flashUse?: unknown;
  reCopyTick?: number;
}
function FlowHero({ item, copied, onCopyCode, onCopyUse, flashUse, reCopyTick = 0 }: FlowHeroProps) {
  const isEsku = item?.isEinzelneSku === true || item?.isEsku === true;
  const cartons = isEsku ? (item?.eskuCartons ?? item?.units) : item?.units;
  const perCarton = !isEsku
    ? (item?.rollen ? { value: item.rollen, unit: item.rollenUnit || 'Rollen' } : null)
    : (item?.eskuItemsPerPack != null && item?.units
        ? { value: item.eskuItemsPerPack, unit: item.eskuContentLabel || 'Einheiten', multiplier: item.units }
        : item?.eskuPacksPerCarton != null
            ? { value: item.eskuPacksPerCarton, unit: 'Einheiten' }
            : null);
  const code = item?.code || item?.amazonCode || item?.fnsku || '';
  const title = simplifyItemTitle(item?.name || item?.title || '—');
  const lvl = item?.level || getDisplayLevel(item) || 1;
  const lvlColor = (LEVEL_META[lvl] || LEVEL_META[1]).color;
  /* Use-Item display code — prefer the pre-extracted bare code
     (`useItemCode`, EAN/X-code only) over the raw `useItem` string
     which may contain prose like «wird von … produziert». Hidden
     entirely when there's no useItem on this article. */
  const useItemDisplay = item?.useItemCode || item?.useItem || '';
  const hasUseItem = !!useItemDisplay && typeof onCopyUse === 'function';
  const useFlashOn = flashUse != null && flashUse === item?.useItem;

  /* Carton shape for the iso preview. Delegates to cartonShapeMm() in
     auftragHelpers: uses sku_dimensions when available, otherwise derives
     a grid-packed carton silhouette from `rollen` + roll dim (axial × dia)
     for thermo/tacho items. Returns null for non-roll items lacking a
     dimensions row — Focus then hides the iso rather than mislead the
     worker with a blind default cube. */
  const boxSize = cartonShapeMm({ ...item, dim: item?.dimRaw });

  /* Cursor-tracked specular spotlights — the «light sources» the card
     catches as the worker moves the mouse over it. Three CSS custom
     properties drive three independent layers (soft halo, sharp hot
     point, top-edge highlight), updated via `style.setProperty` on a
     ref so the paint happens without React re-renders. */
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [hovered, setHovered] = useState(false);
  /* Spotlight tracking is suppressed once the article is marked
     `copied` — the green «done» state owns the surface and the
     cursor-driven sheen would visually clash. */
  const onMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (copied) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    el.style.setProperty('--spot-x', `${x}%`);
    el.style.setProperty('--spot-y', `${y}%`);
    el.style.setProperty('--spot-a', '1');
  }, [copied]);
  const onEnter = useCallback(() => setHovered(true), []);
  const onLeave = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.currentTarget.style.setProperty('--spot-a', '0');
    setHovered(false);
  }, []);

  /* Re-copy «press» — when reCopyTick bumps, toggle `mr-recopy-flash`
     on the X00 code SPAN via its ref. Inner button can't host the
     animation directly (its `all: 'unset'` inline style resets
     `display` to inline, killing transform). Direct classList toggle
     + a layout-flush reflow re-triggers the keyframes cleanly on
     every consecutive re-copy without remount. */
  const codeRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (reCopyTick <= 0) return;
    const el = codeRef.current;
    if (!el) return;
    el.classList.remove('mr-recopy-flash');
    /* eslint-disable-next-line @typescript-eslint/no-unused-expressions */
    el.offsetWidth;
    el.classList.add('mr-recopy-flash');
    const t = setTimeout(() => el.classList.remove('mr-recopy-flash'), 400);
    return () => clearTimeout(t);
  }, [reCopyTick]);

  return (
    <div
      ref={cardRef}
      className="mr-hero-land"
      onMouseMove={onMove}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: 28,
        /* 8px frame ONLY — the top sub-container sits flush with this
           thin border, reading as the hero card hugging it. The bottom
           section (divider + quantity row) restores its own roomy
           padding in its inner wrapper below. */
        padding: 8,
        background: copied
          ? T.status.success.bg
          : '#F4F5F7',
        border: '2px solid #FFFFFF',
        borderRadius: 50,
        boxShadow: '0 0 89.7px 0 rgba(0, 0, 0, 0.05)',
        transform: hovered ? 'translateY(-2px)' : 'translateY(0)',
        overflow: 'hidden',
        isolation: 'isolate',
        transition: 'background 240ms ease, transform 320ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 320ms cubic-bezier(0.16, 1, 0.3, 1)',
        // Custom properties read by the specular layers below.
        ['--spot-x' as any]: '50%',
        ['--spot-y' as any]: '0%',
        ['--spot-a' as any]: '0',
      } as React.CSSProperties}
    >
      {/* Spotlight layers 1-3 — cursor-tracked sheen + halo + hot point.
          Suppressed when the article is `copied` (done): the green
          surface owns the visual; an additional white sheen would
          read as conflicting feedback. */}
      {!copied && (
        <>
          <div aria-hidden style={{
            position: 'absolute',
            inset: 0,
            background: 'radial-gradient(ellipse 75% 55% at var(--spot-x) 0%, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0) 65%)',
            pointerEvents: 'none',
            zIndex: 0,
            mixBlendMode: 'screen',
            transition: 'opacity 320ms ease',
          }} />
          <div aria-hidden style={{
            position: 'absolute',
            inset: 0,
            background: 'radial-gradient(circle 260px at var(--spot-x) var(--spot-y), rgba(255,255,255,0.45) 0%, rgba(255,255,255,0) 70%)',
            opacity: 'var(--spot-a)',
            transition: 'opacity 380ms ease',
            pointerEvents: 'none',
            zIndex: 0,
            mixBlendMode: 'screen',
          }} />
          <div aria-hidden style={{
            position: 'absolute',
            inset: 0,
            background: 'radial-gradient(circle 90px at var(--spot-x) var(--spot-y), rgba(255,255,255,0.5) 0%, rgba(255,255,255,0) 70%)',
            opacity: 'var(--spot-a)',
            transition: 'opacity 240ms ease',
            pointerEvents: 'none',
            zIndex: 0,
            mixBlendMode: 'screen',
          }} />
        </>
      )}

      {/* Layer 4 — bottom ambient accent warmth. Intensifies a touch
          on hover, giving the card a sense of «catching warmth» as
          the user engages with it. */}
      <div aria-hidden style={{
        position: 'absolute',
        inset: 0,
        background: `radial-gradient(ellipse 75% 45% at 50% 115%, ${T.accent.main}${hovered ? '1A' : '10'} 0%, transparent 70%)`,
        pointerEvents: 'none',
        zIndex: 0,
        transition: 'background 320ms ease',
      }} />

      {/* Real content — wrapped so its stacking sits above all spec
          layers. Flex column mirrors the outer hero's layout so the
          wrapper is invisible in the visual tree. */}
      <div style={{
        position: 'relative',
        zIndex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 28,
      }}>
      {/* TOP — descriptive header in its own sub-container. Tinted
          fill + rounded corners, no border (the 8px hero frame already
          provides the visual containment). Radius = hero radius (50) -
          frame padding (8) = 42 so the inner & outer curves stay
          geometrically concentric. */}
      <div style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 24,
        minWidth: 0,
        minHeight: 110,
        padding: '26px 34px',
        background: 'rgba(15, 23, 42, 0.04)',
        borderRadius: 42,
      }}>
        <div style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 8,
        }}>
          {perCarton && (
            <span style={{
              fontFamily: T.font.mono,
              fontSize: 'clamp(15px, 1.5vw, 19px)',
              fontWeight: 600,
              color: T.accent.main,
              letterSpacing: '-0.01em',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {perCarton.value} {perCarton.unit}{perCarton.multiplier != null ? ` × ${perCarton.multiplier}` : ''}
            </span>
          )}
          <span style={{
            fontFamily: T.font.ui,
            fontSize: 'clamp(17px, 1.7vw, 22px)',
            fontWeight: 600,
            letterSpacing: '-0.01em',
            lineHeight: 1.2,
            color: lvlColor,
          }}>
            {title}
          </span>
        </div>
        {boxSize && (
          <div style={{ flexShrink: 0, alignSelf: 'center' }}>
            <BoxIso size={boxSize} color={lvlColor} px={88} />
          </div>
        )}
      </div>

      {/* Bottom block — divider + codes/quantity row. Wrapped in its
          own side+bottom padded container so it restores the comfy
          spacing the original hero used, while the top sub-container
          above stays flush against the 8px hero frame. */}
      <div style={{
        padding: '0 36px 28px',
        display: 'flex',
        flexDirection: 'column',
        gap: 28,
      }}>
        <div style={{ height: 1, background: T.border.subtle }} />

        {/* BOTTOM — codes on the LEFT (X00 dominant, use-item secondary),
            quantity hero on the RIGHT. Reads as «scan this → that many». */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 32,
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
            {/* Artikel-Code X00 — massive mono, click-to-copy. Drives the
                workflow (copiedKeys), so it gets the dominant size. */}
            <button
              type="button"
              onClick={onCopyCode}
              title={copied ? `${code} · kopiert` : `${code} · klick zum Kopieren`}
              style={{
                all: 'unset',
                cursor: 'pointer',
                fontFamily: T.font.mono,
                fontSize: 'clamp(36px, 4.4vw, 52px)',
                fontWeight: 600,
                letterSpacing: '-0.025em',
                lineHeight: 1.02,
                color: copied ? T.status.success.text : T.text.primary,
                fontVariantNumeric: 'tabular-nums',
                wordBreak: 'break-all',
                transition: 'color 240ms ease',
              }}
            >
              {/* Inner span hosts the press-animation: it's a plain
                  inline-block we own, free of the button's `all: unset`
                  display reset, so transform/opacity actually paint. */}
              <span ref={codeRef} style={{ display: 'inline-block', transformOrigin: 'center' }}>
                {code || '—'}
              </span>
            </button>

            {/* Use-Item code — small mono, click-to-copy. Hidden when the
                article has no separate use-item. */}
            {hasUseItem && (
              <button
                type="button"
                onClick={onCopyUse}
                title={useFlashOn ? `${useItemDisplay} · kopiert` : `${useItemDisplay} · klick zum Kopieren`}
                style={{
                  all: 'unset',
                  cursor: 'pointer',
                  display: 'inline-block',
                  marginTop: 6,
                  fontFamily: T.font.mono,
                  fontSize: 'clamp(13px, 1.3vw, 15px)',
                  fontWeight: 500,
                  letterSpacing: '-0.005em',
                  fontVariantNumeric: 'tabular-nums',
                  wordBreak: 'break-all',
                  color: useFlashOn ? T.status.success.text : T.text.subtle,
                  transition: 'color 240ms ease',
                }}
                onMouseEnter={(e) => { if (!useFlashOn) e.currentTarget.style.color = T.text.primary; }}
                onMouseLeave={(e) => { if (!useFlashOn) e.currentTarget.style.color = T.text.subtle; }}
              >
                {useItemDisplay}
              </button>
            )}
          </div>

          {cartons != null && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: 2,
              flexShrink: 0,
              textAlign: 'right',
            }}>
              <span style={{
                fontFamily: T.font.ui,
                fontSize: 'clamp(54px, 6.6vw, 84px)',
                fontWeight: 500,
                letterSpacing: '-0.045em',
                lineHeight: 0.9,
                color: T.text.primary,
                fontVariantNumeric: 'tabular-nums',
              }}>
                {cartons}
              </span>
              <span style={{
                fontFamily: T.font.mono,
                fontSize: 10.5,
                fontWeight: 700,
                color: T.text.faint,
                letterSpacing: '0.22em',
                textTransform: 'uppercase',
                marginTop: 4,
              }}>
                Kartons
              </span>
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

/* FlowStream — PS5-style centered carousel of articles. The active
   card sits magnetically at the vertical center of the viewport. The
   rest of the column slides above/below it, with cards further from
   the active position scaling down and fading out for spatial depth.

   Centering is DYNAMIC — instead of computing offsets from constant
   heights, we mount a ref on the active slot and measure its actual
   `offsetTop + offsetHeight / 2` via useLayoutEffect, then translate
   the inner column by that amount. This makes the math correct no
   matter how the hero card or compact rows are sized.

   Navigation:
     • Click any card → it becomes the new active (the column animates).
     • Mouse wheel scroll → advances the active selection by one card,
       throttled at 280ms so a flick doesn't blow through five tiles.

   Completed items: when `completedItemIdxs` includes an item it is
   FILTERED OUT of the slot list — Fertig'd articles live in the
   DoneFlow strip above. The active item is kept even if completed so
   the centering math always has a target slot to anchor on. */
const FLOW_GAP = 10;
interface FlowStreamProps {
  palletItems: any[];
  itemIdx: number;
  copiedItemIdxs?: Set<number>;
  completedItemIdxs?: Set<number>;
  palletMaxItemVolCm3?: number;
  palletTotalVolCm3?: number;
  onPickItem: (rawItemIdx: number) => void;
  heroCopied: boolean;
  onHeroCopyCode: () => void;
  onHeroCopyUseItem?: () => void;
  heroFlashUse?: unknown;
  heroReCopyTick?: number;
}
function FlowStream({
  palletItems, itemIdx, copiedItemIdxs, completedItemIdxs,
  palletMaxItemVolCm3 = 0, palletTotalVolCm3 = 0,
  onPickItem,
  heroCopied, onHeroCopyCode, onHeroCopyUseItem, heroFlashUse, heroReCopyTick = 0,
}: FlowStreamProps) {
  const viewItems = useMemo(
    () => palletItems.map((it) => focusItemView(it)),
    [palletItems],
  );

  /* Slots are the current-pallet items MINUS the ones that have been
     Fertig'd — completed articles flow out of the main carousel into
     the «Erledigt»-Strip above. The active item is kept even if it
     happens to be completed (e.g. the worker clicks back to it from
     the done strip) so the centering math has a target. */
  const slots = useMemo(
    () => viewItems
      .map((it, i) => ({ kind: 'item' as const, item: it, idx: i }))
      .filter((s) => !completedItemIdxs?.has(s.idx) || s.idx === itemIdx),
    [viewItems, completedItemIdxs, itemIdx],
  );
  const activeSlotPos = useMemo(
    () => slots.findIndex((s) => s.idx === itemIdx),
    [slots, itemIdx],
  );

  /* Dynamic centering — measure the active slot's actual position
     inside the column on every itemIdx change and translate so its
     center lands at the column's `top: 50%` origin. */
  const activeRef = useRef<HTMLDivElement | null>(null);
  const [activeCenterY, setActiveCenterY] = useState(0);
  useLayoutEffect(() => {
    const el = activeRef.current;
    if (!el) return;
    setActiveCenterY(el.offsetTop + el.offsetHeight / 2);
  }, [itemIdx, slots.length]);
  /* Re-measure on window resize — viewport-width-driven clamp() sizes
     mean hero height can change without itemIdx changing. */
  useEffect(() => {
    const onResize = () => {
      const el = activeRef.current;
      if (!el) return;
      setActiveCenterY(el.offsetTop + el.offsetHeight / 2);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /* Wheel throttle — one card per scroll burst. PS5's swipe gesture
     feels controlled and deliberate; we mirror that with a 280ms
     gate so accidental trackpad flicks don't fly through items.
     Listener is attached to `window` (with passive:false to allow
     preventDefault) so the entire viewport acts as the scroll zone —
     the user can wheel anywhere on the page to advance cards. */
  const lastWheelRef = useRef(0);
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const now = Date.now();
      if (now - lastWheelRef.current < 280) return;
      if (Math.abs(e.deltaY) < 6) return;
      e.preventDefault();
      lastWheelRef.current = now;
      /* Walk through the FILTERED slots — completed items are skipped
         so the wheel never lands on something that's already in the
         «Erledigt»-Strip. activeSlotPos may be -1 if the active item
         got filtered out for some edge reason; in that case fall back
         to picking the first visible slot. */
      if (slots.length === 0) return;
      const pos = activeSlotPos >= 0 ? activeSlotPos : 0;
      if (e.deltaY > 0) {
        if (pos + 1 < slots.length) onPickItem(slots[pos + 1].idx);
      } else if (pos > 0) {
        onPickItem(slots[pos - 1].idx);
      }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [slots, activeSlotPos, onPickItem]);

  return (
    <div
      style={{
        position: 'relative',
        flex: 1,
        width: '100%',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      <div style={{
        position: 'absolute',
        /* 46% (not 50%) places the active card a touch above true
           viewport center — same off-centre balance the layout had
           when the main container carried asymmetric top/bottom
           padding (64 / 160). Compensates for the island bar's
           visual weight at the bottom. */
        top: '46%',
        left: 0,
        right: 0,
        margin: '0 auto',
        maxWidth: 800,
        display: 'flex',
        flexDirection: 'column',
        gap: FLOW_GAP,
        transform: `translateY(${-activeCenterY}px)`,
        transition: 'transform 420ms cubic-bezier(0.16, 1, 0.3, 1)',
        willChange: 'transform',
      }}>
        {slots.map((slot, i) => {
          const isActive = slot.idx === itemIdx;
          /* Visual ranking uses the slot's position in the FILTERED
             list (i) vs. the active slot's position. Raw item indices
             would skip over removed (completed) rows and break the
             fade/scale curve. */
          const anchor = activeSlotPos >= 0 ? activeSlotPos : 0;
          const distance = Math.abs(i - anchor);
          const isPast   = i < anchor;  // row sits ABOVE the hero — already navigated past

          /* Distance-driven depth — active is full, neighbours shrink
             and fade. Past rows (above hero) fade MORE aggressively
             than future ones: they're done with, eye doesn't need to
             linger on them. Future stays at the original curve so the
             worker can preview what's coming. */
          let scale = 1;
          let opacity = 1;
          if (!isActive) {
            if (isPast) {
              if (distance === 1)      { scale = 0.95; opacity = 0.35; }
              else if (distance === 2) { scale = 0.90; opacity = 0.18; }
              else                     { scale = 0.85; opacity = 0.08; }
            } else {
              if (distance === 1)      { scale = 1;    opacity = 0.85; }
              else if (distance === 2) { scale = 0.95; opacity = 0.55; }
              else if (distance === 3) { scale = 0.90; opacity = 0.32; }
              else                     { scale = 0.85; opacity = 0.16; }
            }
          }

          const wrapStyle: React.CSSProperties = {
            transform: `scale(${scale})`,
            opacity,
            transformOrigin: 'center center',
            transition: 'transform 420ms cubic-bezier(0.16, 1, 0.3, 1), opacity 420ms ease',
            pointerEvents: opacity < 0.2 ? 'none' : 'auto',
          };

          if (isActive) {
            return (
              <div ref={activeRef} key={`hero-${slot.idx}`} style={wrapStyle}>
                <FlowHero
                  item={slot.item}
                  copied={heroCopied}
                  onCopyCode={onHeroCopyCode}
                  onCopyUse={onHeroCopyUseItem}
                  flashUse={heroFlashUse}
                  reCopyTick={heroReCopyTick}
                />
              </div>
            );
          }
          return (
            <div key={`row-${slot.idx}`} style={wrapStyle}>
              <FlowCompactRow
                item={slot.item}
                isDone={copiedItemIdxs?.has(slot.idx) ?? false}
                palletMaxItemVolCm3={palletMaxItemVolCm3}
                palletTotalVolCm3={palletTotalVolCm3}
                onClick={() => onPickItem(slot.idx)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* FlowHeader — small mono pill at the top of the left rail. Shows
   pallet count and total elapsed time. Adapts label length to whether
   the rail is collapsed or expanded. */
function FlowHeader({ doneCount, total, elapsedLabel, expanded }: { doneCount: number; total: number; elapsedLabel: string; expanded: boolean }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      padding: '6px 10px',
      background: T.bg.surface2,
      border: `1px solid ${T.border.subtle}`,
      borderRadius: 999,
      fontFamily: T.font.mono,
      fontSize: 10.5,
      fontWeight: 700,
      color: T.text.subtle,
      letterSpacing: '0.06em',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
    }}>
      <span style={{ color: T.text.primary }}>
        {doneCount}/{total}
      </span>
      {expanded && (
        <>
          <span aria-hidden style={{ color: T.border.strong }}>·</span>
          <span style={{ letterSpacing: '0.04em' }}>{elapsedLabel}</span>
        </>
      )}
    </div>
  );
}

/* FlowLeftRail — fixed-width 80px vertical rail hosting the pallet
   flow as circular tiles. No hover-expand: the rail stays in its
   collapsed minimal form to keep the layout stable and the visual
   noise low. Pallet detail (article chips, etc.) belongs to the
   PalletListOverlay if needed, not to a hover-state. */
interface FlowLeftRailProps {
  palletFlowProps: PalletFlowProps;
  /* Completed-article record for the CURRENT pallet, rendered as a
     vertical compact strip below the pallet circles. Lifted out of the
     screen-top «Erledigt»-Strip so the centre column belongs entirely
     to FlowStream. */
  donePalletItems: any[];
  doneCompletedItemIdxs?: Set<number>;
  doneActiveItemIdx: number;
  onDonePickItem: (rawItemIdx: number) => void;
}
function FlowLeftRail({
  palletFlowProps,
  donePalletItems, doneCompletedItemIdxs, doneActiveItemIdx, onDonePickItem,
}: FlowLeftRailProps) {
  const doneCount = doneCompletedItemIdxs?.size ?? 0;
  /* Toggle for the Erledigt list — collapsed by default to keep the rail
     quiet; opens via the small badge attached to the current pallet's
     circle inside PalletFlow (passed down through `currentDoneBadge`). */
  const [doneListOpen, setDoneListOpen] = useState(false);
  /* Auto-collapse when there's nothing to show, so re-toggling after
     navigating to a different pallet starts fresh. */
  useEffect(() => {
    if (doneCount === 0 && doneListOpen) setDoneListOpen(false);
  }, [doneCount, doneListOpen]);
  return (
    <div
      style={{
        position: 'relative',
        width: 56,
        height: '100%',
        flexShrink: 0,
        zIndex: 4,
      }}
    >
      {/* Outer card frame — mirrors FlowHero (#F4F5F7 fill + 2px white
          border + soft glow). Inner panel inherits the page-main bg
          (#F2F2F2) so the rail visually nests inside the main surface
          while the white frame reads as a lift above it. */}
      <div style={{
        position: 'absolute',
        top: '46%',
        left: 0,
        transform: 'translateY(-50%)',
        width: 56,
        maxHeight: 'calc(100vh - 200px)',
        padding: 2,
        background: '#F4F5F7',
        border: '2px solid #FFFFFF',
        borderRadius: 50,
        boxShadow: '0 0 89.7px 0 rgba(0, 0, 0, 0.05)',
        overflow: 'hidden',
        boxSizing: 'border-box',
        display: 'flex',
      }}>
        <div style={{
          flex: 1,
          background: '#F2F2F2',
          borderRadius: 48,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 2,
          overflow: 'hidden auto',
          scrollbarWidth: 'thin',
        }}>
          <PalletFlow
            {...palletFlowProps}
            direction="vertical"
            collapsed
            currentDoneBadge={{
              count: doneCount,
              total: donePalletItems.length,
              active: doneListOpen,
              onClick: () => setDoneListOpen((v) => !v),
            }}
          />
        </div>
      </div>

      {doneListOpen && doneCount > 0 && (
        <DoneListPopover
          palletItems={donePalletItems}
          completedItemIdxs={doneCompletedItemIdxs!}
          activeItemIdx={doneActiveItemIdx}
          onPickItem={(idx) => { onDonePickItem(idx); setDoneListOpen(false); }}
          onClose={() => setDoneListOpen(false)}
        />
      )}
    </div>
  );
}

/* DoneListPopover — floating panel anchored to the right of the
   FlowLeftRail, surfacing the current pallet's Fertig'd articles
   with full info (level dot, #N, title, Artikel-Code). Triggered by
   the green count-badge under the active pallet circle. Closes on
   outside click or Escape. */
interface DoneListPopoverProps {
  palletItems: any[];
  completedItemIdxs: Set<number>;
  activeItemIdx: number;
  onPickItem: (rawItemIdx: number) => void;
  onClose: () => void;
}
function DoneListPopover({
  palletItems, completedItemIdxs, activeItemIdx, onPickItem, onClose,
}: DoneListPopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current) return;
      if (panelRef.current.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const items = useMemo(() => {
    const out: { idx: number; title: string; code: string; lvl: number }[] = [];
    for (let i = 0; i < palletItems.length; i++) {
      if (!completedItemIdxs.has(i)) continue;
      const view  = focusItemView(palletItems[i]);
      const lvl   = view?.level || getDisplayLevel(view) || 1;
      const title = simplifyItemTitle(view?.name || '—');
      const code  = view?.code || view?.useItemCode || '';
      out.push({ idx: i, title, code, lvl });
    }
    return out;
  }, [palletItems, completedItemIdxs]);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Erledigte Artikel"
      style={{
        position: 'absolute',
        /* Anchor outside the rail panel — rail is `top: 46%, left: 0,
           width: 56` translated by -50%. The popover sits to the right
           with a 14px gap and the same vertical centring. */
        top: '46%',
        left: 'calc(56px + 14px)',
        transform: 'translateY(-50%)',
        width: 320,
        maxHeight: 'calc(100vh - 200px)',
        background: '#FFFFFF',
        border: '2px solid #FFFFFF',
        borderRadius: 24,
        boxShadow: '0 0 89.7px 0 rgba(0, 0, 0, 0.12)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        zIndex: 30,
        fontFamily: T.font.ui,
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '14px 18px 10px',
        borderBottom: `1px solid ${T.border.subtle}`,
      }}>
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 22,
          height: 18,
          padding: '0 6px',
          borderRadius: 999,
          background: T.status.success.main,
          color: '#FFFFFF',
          fontFamily: T.font.mono,
          fontSize: 10,
          fontWeight: 800,
        }}>
          {items.length}
        </span>
        <span style={{
          fontFamily: T.font.mono,
          fontSize: 11,
          fontWeight: 700,
          color: T.text.subtle,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          flex: 1,
        }}>
          Erledigt
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Schließen"
          style={{
            width: 22,
            height: 22,
            border: 0,
            background: 'transparent',
            color: T.text.faint,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 999,
            transition: 'background 160ms, color 160ms',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = T.bg.surface2;
            e.currentTarget.style.color = T.text.secondary;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = T.text.faint;
          }}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor"
                  strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}>
        {items.map(({ idx, title, code, lvl }) => {
          const lvlColor = (LEVEL_META[lvl] || LEVEL_META[1]).color;
          const isActive = idx === activeItemIdx;
          return (
            <button
              key={idx}
              type="button"
              onClick={() => onPickItem(idx)}
              title={`#${idx + 1} · ${title}`}
              style={{
                all: 'unset',
                cursor: 'pointer',
                display: 'grid',
                gridTemplateColumns: '20px 28px 1fr auto',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 12,
                background: isActive ? T.bg.surface2 : 'transparent',
                transition: 'background 160ms',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = T.bg.surface2; }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = isActive ? T.bg.surface2 : 'transparent';
              }}
            >
              <span aria-hidden style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 18,
                height: 18,
                borderRadius: '50%',
                background: T.status.success.main,
                color: '#FFFFFF',
                flexShrink: 0,
              }}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M2 5l2 2 4-4" stroke="currentColor" strokeWidth="1.8"
                        strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span style={{
                fontFamily: T.font.mono,
                fontSize: 11,
                fontWeight: 700,
                color: T.text.faint,
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: '0.02em',
              }}>
                #{idx + 1}
              </span>
              <span style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                minWidth: 0,
              }}>
                <span style={{
                  fontFamily: T.font.ui,
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: lvlColor,
                  letterSpacing: '-0.005em',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {title}
                </span>
                {code && (
                  <span style={{
                    fontFamily: T.font.mono,
                    fontSize: 10.5,
                    fontWeight: 600,
                    color: T.text.subtle,
                    fontVariantNumeric: 'tabular-nums',
                    letterSpacing: '-0.005em',
                  }}>
                    {code}
                  </span>
                )}
              </span>
              <span aria-hidden style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: lvlColor,
                flexShrink: 0,
              }} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* FlowRightRail — mirror of FlowLeftRail on the right side, anchored
   to the right edge and vertically aligned with the hero (top: 46%).
   Renders ALL items of the current pallet as numbered chips; the
   currently-active item is suppressed (it's the hero in the center).
   Past items (above the active in raw order) are extra-faded to match
   the FlowStream's directional fade.

   Coexists with FlowStream's in-stream compact previews — left rail
   indexes pallets, right rail indexes the current pallet's articles
   as a stable «table of contents». No hover-expand — the rail stays
   in its fixed-width minimal form (a quiet timeline of dots). */
interface FlowRightRailProps {
  palletItems: any[];
  itemIdx: number;
  copiedItemIdxs?: Set<number>;
  /* Fertig'd items are removed from the right-rail timeline entirely
     so the worker only sees what's still ahead. Live record of
     completed articles lives in the DoneListPopover on the left rail. */
  completedItemIdxs?: Set<number>;
  onPickItem: (rawItemIdx: number) => void;
}
function FlowRightRail({
  palletItems, itemIdx, copiedItemIdxs, completedItemIdxs, onPickItem,
}: FlowRightRailProps) {

  /* Pre-compute a per-item view (level, title, quantity, use-item key,
     done state) so the render loop stays tight and clustering can read
     a single source. The cluster key uses `useItemCode` — consecutive
     items sharing the same alternate-code stack into a single capsule.
     ESKU items fall back to FNSKU as a secondary group key so the
     same physical SKU still clusters. */
  const itemsView = useMemo(() => palletItems.map((rawIt, i) => {
    const view    = focusItemView(rawIt);
    const lvl     = view?.level || getDisplayLevel(view) || 1;
    const meta    = LEVEL_META[lvl] || LEVEL_META[1];
    const title   = simplifyItemTitle(view?.name || '—');
    const isEsku  = view?.isEsku === true;
    const cartons = isEsku ? (view?.eskuCartons ?? view?.units) : view?.units;
    const clusterKey = view?.useItemCode || view?.code || null;
    return { rawIt, view, i, lvl, meta, title, cartons, clusterKey, isEsku };
  }), [palletItems]);

  /* Consecutive same-clusterKey items collapse into groups. Singletons
     emit `{ indices: [i] }`. Multi-item clusters get a wrapping capsule
     in the render below. Fertig'd items (in `completedItemIdxs`) are
     skipped entirely — they disappear from the rail and live only in
     the DoneListPopover on the left side. An all-Fertig cluster
     collapses to nothing. */
  const clusters = useMemo(() => {
    if (!itemsView.length) return [];
    const out: Array<{ key: string; indices: number[] }> = [];
    let prevKey: string | null = null;
    itemsView.forEach(({ clusterKey }, i) => {
      if (completedItemIdxs?.has(i)) { prevKey = null; return; }
      const last = out[out.length - 1];
      if (clusterKey && prevKey === clusterKey && last) {
        last.indices.push(i);
      } else {
        out.push({ key: clusterKey ? `cl:${clusterKey}:${i}` : `solo:${i}`, indices: [i] });
        prevKey = clusterKey;
      }
    });
    return out;
  }, [itemsView, completedItemIdxs]);

  const renderItem = (i: number) => {
    const { title, isEsku } = itemsView[i];
    const isDone   = copiedItemIdxs?.has(i) ?? false;
    const isActive = i === itemIdx;
    const isPast   = !isActive && i < itemIdx;
    const dotColor = isDone ? T.status.success.main : itemsView[i].meta.color;
    /* ESKU items render as a hollow ring (2px stroke, transparent
       inside) so the worker can spot Einzelne-SKU placements at a
       glance; Mixed items stay as solid discs. Same 12×12 footprint
       to keep the timeline rhythm consistent. */
    const dotTitle = `${isEsku ? 'ESKU · ' : ''}${title}`;

    return (
      <button
        key={i}
        type="button"
        onClick={() => onPickItem(i)}
        title={dotTitle}
        aria-current={isActive ? 'true' : undefined}
        style={{
          all: 'unset',
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          padding: '6px 0',
          justifyContent: 'center',
          borderRadius: 12,
          cursor: 'pointer',
          /* Active is the only «relevant» row → full opacity. Inactive
             rows fade hard so the active dot is the single bright
             anchor on the timeline. */
          opacity: isActive ? 1 : (isPast ? 0.16 : 0.3),
          /* Soft blur on inactive items — pushes them into the
             «atmospheric background» so active reads as the only
             sharp element. */
          filter: isActive ? 'none' : 'blur(0.6px)',
          transition: 'opacity 200ms ease, filter 200ms ease',
          boxSizing: 'border-box',
        }}
      >
        <span aria-hidden style={{
          display: 'inline-block',
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: isEsku ? 'transparent' : dotColor,
          border: isEsku ? `2px solid ${dotColor}` : '0',
          boxSizing: 'border-box',
          boxShadow: isActive
            ? `0 0 0 3px ${dotColor}66`
            : `0 0 0 2px ${dotColor}1A`,
          flexShrink: 0,
          transition: 'background 200ms ease, border-color 200ms ease, box-shadow 200ms ease',
        }} />
      </button>
    );
  };

  return (
    <div
      style={{
        position: 'relative',
        width: 56,
        height: '100%',
        flexShrink: 0,
        zIndex: 4,
      }}
    >
      {/* No outer card frame, no hover-expand — the right rail floats
          on the page main surface as a fixed-width timeline of dots.
          Cluster capsules (below) provide visual grouping; individual
          items render as bare dots. */}
      <div style={{
        position: 'absolute',
        top: '46%',
        right: 0,
        transform: 'translateY(-50%)',
        width: 56,
        maxHeight: 'calc(100vh - 200px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        overflow: 'hidden auto',
        scrollbarWidth: 'thin',
      }}>
        {clusters.map((cluster) => {
          if (cluster.indices.length === 1) {
            return renderItem(cluster.indices[0]);
          }
          /* Multi-item cluster — consecutive items sharing a useItemCode
             wrapped in a surface2 capsule. Mirrors PalletFlow's
             cluster styling so the same «shared SKU» vocabulary reads
             across both rails. Done-when-all-done turns the capsule
             green for parity with PalletFlow. */
          const allDone = cluster.indices.every((i) => copiedItemIdxs?.has(i));
          return (
            <div
              key={cluster.key}
              title={`${cluster.indices.length}× gleiches Use-Item${allDone ? ' · alle kopiert' : ''}`}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignSelf: 'center',
                alignItems: 'center',
                gap: 4,
                padding: '7px 0',
                width: 40,
                boxSizing: 'border-box',
                background: allDone ? T.status.success.bg : T.bg.surface2,
                border: allDone
                  ? '1px solid transparent'
                  : `1px solid ${T.border.strong}`,
                /* Full pill wraps the stacked dots — same vocabulary
                   as PalletFlow's clusters. */
                borderRadius: 999,
                transition: 'background 400ms cubic-bezier(0.16, 1, 0.3, 1), border-color 400ms cubic-bezier(0.16, 1, 0.3, 1)',
              }}
            >
              {cluster.indices.map((i) => renderItem(i))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ZenItemDots — minimal article progress strip shown only in zen
   mode (full Pallet Flow is hidden). One dot per item of the
   CURRENT pallet: green = kopiert, accent = aktiv, outline = todo.
   Click to jump. Centered, low-profile, fades in with zen. */
function ZenItemDots({ items, palletDisplayIdx, currentDisplayItemIdx, copiedKeys, onPick }) {
  if (!items || items.length === 0) return null;
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      gap: 12,
      paddingTop: 26,
      opacity: 0.85,
      animation: 'mr-rise 360ms cubic-bezier(0.16, 1, 0.3, 1) both',
    }}>
      {items.map((_, j) => {
        const isCopied = copiedKeys?.has?.(`${palletDisplayIdx}|${j}`);
        const isActive = j === currentDisplayItemIdx;
        const size = isActive ? 16 : 11;
        return (
          <button
            key={j}
            type="button"
            onClick={() => onPick?.(j)}
            title={`Artikel ${j + 1}${isCopied ? ' · ✓ kopiert' : ''}`}
            aria-label={`Artikel ${j + 1}`}
            aria-current={isActive ? 'true' : undefined}
            style={{
              all: 'unset',
              cursor: 'pointer',
              width: size,
              height: size,
              borderRadius: '50%',
              background: isActive
                ? T.accent.main
                : (isCopied ? T.status.success.main : 'transparent'),
              border: (!isActive && !isCopied)
                ? `1.75px solid ${T.border.strong}`
                : 'none',
              boxShadow: isActive
                ? `0 0 0 4px ${T.accent.main}20`
                : 'none',
              transition: 'width 200ms ease, height 200ms ease, background 200ms ease, box-shadow 200ms ease',
            }}
          />
        );
      })}
    </div>
  );
}

function PalletNode({
  pallet, palletIdx, state, blocked, total, copied,
  isEsku, hasFlag, currentItemIdx, copiedKeys, completedKeys,
  onPickPallet, onPickItem,
  collapsed = false, vertical = false,
  doneBadge = null,
}: any) {
  const STATE_STYLES = {
    done:    { bg: T.status.success.bg, border: T.status.success.border,
               text: T.status.success.text, sub: T.status.success.text,
               accent: T.status.success.main },
    current: { bg: T.bg.surface,        border: T.border.primary,
               text: T.text.primary,    sub: T.text.subtle,
               accent: T.accent.main },
    todo:    { bg: T.bg.surface,        border: T.border.primary,
               text: T.text.subtle,     sub: T.text.faint,
               accent: T.border.strong },
  };
  /* visualState mirrors the `state` prop directly — 'done' is reserved
     for pallets whose every item has actually been Fertig'd. The old
     "all codes copied = green" shortcut was removed because it falsely
     greened pallets that were dragged ahead of the current one before
     Fertig was pressed. */
  const isCurrent   = state === 'current';
  const visualState = state;
  const styles    = STATE_STYLES[visualState];
  const showCheck = visualState === 'done';
  const showRing  = visualState === 'todo';
  const shortId   = shortPalletId(pallet);
  const tooltip   = blocked
    ? 'Erst alle Codes der aktuellen Palette kopieren'
    : `Palette ${shortId} · ${isCurrent ? `${copied}/${total} kopiert` : `${total} Artikel`}`;
  const clickable = blocked ? undefined : onPickPallet;

  /* Collapsed-rail variant — small circular tile with the pallet ID
     centered. No status indicators: state is conveyed via fill (white
     for current) and opacity / text-color (faded for done/todo). The
     CURRENT pallet may also carry a doneBadge — a tiny green chip
     anchored to its top-right corner that surfaces the Fertig'd-count
     and toggles the Erledigt list in the rail. */
  if (collapsed) {
    /* Active pallet with a Fertig-progress gauge: the 1px circle
       border is replaced by an SVG ring whose green segment fills
       proportionally to `count / total`. Click toggles the Erledigt
       popover instead of re-selecting the (already-current) pallet —
       click-to-pallet-jump is meaningless when you're already on it. */
    const hasProgress = isCurrent && doneBadge && doneBadge.total > 0;
    if (hasProgress) {
      const { count, total, active, onClick: onBadgeClick } = doneBadge;
      const progress = Math.min(1, count / total);
      const r = 22;                       // ring radius (inside the 48px box)
      const c = 2 * Math.PI * r;
      return (
        <div
          onClick={count > 0 ? onBadgeClick : clickable}
          title={count > 0
            ? `${count}/${total} erledigt · Liste ${active ? 'schließen' : 'öffnen'}`
            : tooltip}
          aria-expanded={count > 0 ? active : undefined}
          style={{
            position: 'relative',
            width: 48,
            height: 48,
            flexShrink: 0,
            cursor: blocked ? 'not-allowed' : 'pointer',
          }}
        >
          {/* Solid white background disc — gives the ID text its
              standard active-pallet surface, with the SVG ring drawn
              on top so the green progress sits at the perimeter. */}
          <div style={{
            position: 'absolute',
            inset: 3,
            background: styles.bg,
            borderRadius: '50%',
            transition: 'background 240ms ease',
          }} />
          <svg width="48" height="48" viewBox="0 0 48 48"
               style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            {/* Track */}
            <circle cx="24" cy="24" r={r}
                    fill="none"
                    stroke={T.border.subtle}
                    strokeWidth="2" />
            {/* Progress */}
            <circle cx="24" cy="24" r={r}
                    fill="none"
                    stroke={T.status.success.main}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeDasharray={c}
                    strokeDashoffset={c * (1 - progress)}
                    transform="rotate(-90 24 24)"
                    style={{
                      transition: 'stroke-dashoffset 360ms cubic-bezier(0.16, 1, 0.3, 1)',
                    }} />
            {/* Active-popover ring — subtle accent halo when the
                popover is open, mirrors the «active» bezel pattern
                used elsewhere in the new design. */}
            {active && (
              <circle cx="24" cy="24" r={r + 2}
                      fill="none"
                      stroke={`${T.status.success.main}33`}
                      strokeWidth="3" />
            )}
          </svg>
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: T.font.mono,
          }}>
            <span style={{
              fontSize: 13,
              fontWeight: 700,
              color: styles.text,
              letterSpacing: '-0.005em',
              lineHeight: 1,
            }}>
              {shortId}
            </span>
          </div>
        </div>
      );
    }

    /* Standard circle — used for every non-current pallet, and for
       the current pallet before any items live on it. */
    return (
      <div
        onClick={clickable}
        title={tooltip}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 48,
          height: 48,
          background: isCurrent ? styles.bg : 'transparent',
          border: isCurrent
            ? `1px solid ${styles.border}`
            : `1px solid ${visualState === 'done' ? T.status.success.border : T.border.subtle}`,
          borderRadius: '50%',
          opacity: blocked ? 0.45 : (isCurrent ? 1 : visualState === 'done' ? 0.7 : 0.6),
          cursor: blocked ? 'not-allowed' : 'pointer',
          fontFamily: T.font.mono,
          flexShrink: 0,
          transition: 'background 240ms ease, border-color 240ms ease, opacity 240ms ease',
        }}
      >
        <span style={{
          fontSize: 13,
          fontWeight: isCurrent ? 700 : visualState === 'done' ? 600 : 500,
          color: styles.text,
          letterSpacing: '-0.005em',
          lineHeight: 1,
        }}>
          {shortId}
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        display: vertical ? 'flex' : 'inline-flex',
        flexDirection: vertical ? 'column' : 'row',
        alignItems: vertical ? 'stretch' : 'center',
        gap: isCurrent ? (vertical ? 10 : 14) : 8,
        padding: isCurrent ? '10px 16px' : '10px 14px',
        /* Current pallet gets a white surface + standard hairline border
           so it reads as the active workspace. Others stay transparent. */
        background: isCurrent ? styles.bg : 'transparent',
        border: isCurrent ? `1px solid ${styles.border}` : '1px solid transparent',
        borderRadius: vertical ? 14 : 999,
        opacity: blocked ? 0.45 : (isCurrent ? 1 : 0.55),
        flexShrink: 0,
        boxShadow: 'none',
        transition: 'background 240ms ease, border-color 240ms ease, opacity 240ms ease',
      }}
    >
      {/* Header — state-icon (done/todo only) + ID + badges */}
      <div
        onClick={clickable}
        title={tooltip}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: blocked ? 'not-allowed' : 'pointer',
          fontFamily: T.font.mono,
        }}
      >
        {showCheck && (
          <span style={{
            width: 16, height: 16, borderRadius: '50%',
            background: styles.accent,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
              <path d="M2.5 6.5l2 2 5-5.5" stroke="#fff" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
        )}
        {showRing && (
          <span style={{
            width: 10, height: 10, borderRadius: '50%',
            border: `1.5px solid ${styles.accent}`, flexShrink: 0,
          }} />
        )}

        {/* ID — back inside the container, dominant label */}
        <span style={{
          fontSize: isCurrent ? 22 : 19,
          fontWeight: isCurrent ? 700 : visualState === 'done' ? 600 : 500,
          color: styles.text,
          letterSpacing: '-0.01em',
        }}>
          {shortId}
        </span>

        {isCurrent && vertical && total > 0 && (
          <span style={{
            fontSize: 11,
            fontWeight: 600,
            color: styles.sub,
            letterSpacing: '0.04em',
            fontVariantNumeric: 'tabular-nums',
            marginLeft: 'auto',
          }}>
            {copied}/{total}
          </span>
        )}

        {isEsku && (
          <span
            title="Pallet enthält ESKU-Artikel"
            style={{
              fontSize: 11,
              color: styles.accent,
              opacity: visualState === 'todo' ? 0.6 : 1,
            }}
          >⬢</span>
        )}
        {hasFlag && (
          <span
            title="Pallet hat OVERLOAD oder Platzierungs-Flags"
            aria-hidden
            style={{
              width: 6, height: 6, borderRadius: '50%',
              background: T.status.warn.main,
              boxShadow: `0 0 0 2.5px ${T.status.warn.main}26`,
            }}
          />
        )}
      </div>

      {isCurrent && (
        <div style={vertical ? { maxWidth: 200 } : undefined}>
          <NumberedChipStrip
            items={pallet.items || []}
            palletIdx={palletIdx}
            currentItemIdx={currentItemIdx}
            copiedKeys={copiedKeys}
            completedKeys={completedKeys}
            onPick={onPickItem}
            wrap={vertical}
          />
        </div>
      )}
    </div>
  );
}


/* ViewListButton — opens the full-pallet overview overlay. Pill shape
   + mono uppercase so it docks cleanly next to the view-mode toggle
   cluster (Zen/Shell/Doppel) in the Topbar. On hover it lifts to the
   accent palette to signal it's a navigation action, not a state toggle. */
function ViewListButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => { onClick(); e.currentTarget.blur(); }}
      title="Alle Paletten und Artikel als Liste anzeigen"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 24,
        padding: '0 10px',
        fontSize: 10.5,
        fontFamily: T.font.mono,
        fontWeight: 700,
        color: T.text.subtle,
        background: '#FFFFFF',
        border: '1px solid transparent',
        borderRadius: 999,
        cursor: 'pointer',
        letterSpacing: '0.10em',
        textTransform: 'uppercase',
        transition: 'background 140ms ease, border-color 140ms ease, color 140ms ease',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = T.accent.bg;
        e.currentTarget.style.color = T.accent.text;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = '#FFFFFF';
        e.currentTarget.style.color = T.text.subtle;
      }}
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
           stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 4h10M3 8h10M3 12h10"/>
        <circle cx="1.5" cy="4" r="0.6" fill="currentColor" stroke="none"/>
        <circle cx="1.5" cy="8" r="0.6" fill="currentColor" stroke="none"/>
        <circle cx="1.5" cy="12" r="0.6" fill="currentColor" stroke="none"/>
      </svg>
      <span>Liste</span>
    </button>
  );
}

/* NumberedChipStrip — one chip per item on the current pallet.
   Level-tinted bg = todo, green bg = completed (Fertig'd), accent
   fill = active item. Each chip is clickable to jump. ESKU items get a
   dashed border. Items with placement flags get a tiny warn dot. Copy
   state lives only on the Hero's Artikel-Code button — chips do NOT
   green-out on copy, only on Fertig. */
function NumberedChipStrip({ items, palletIdx, currentItemIdx, copiedKeys, completedKeys, onPick, wrap = false }) {
  if (!items.length) return null;
  /* Bucket consecutive items that share the same `useItem` into the
     same container — one visual unit per repeating SKU. Items without
     a useItem each get their own bucket (no accidental clustering).

     For the Thermo family (L1 Thermo + L2 Veit + L3 ÖKO Thermo) the
     useItem alone is enough — same EAN/X-code = same roll product,
     pack-per-carton is always identical for the same SKU.
     For everything else (Klebeband, Produktion, Kernöl, Tacho) the
     same useItem can ship in different pack sizes: "Sandsäcke 5 Stück"
     and "Sandsäcke 20 Stück" share the EAN but are distinct variants.
     The 5/20 lives in the item's `rollen` (per-Einheit count, the
     orange "5 Stück" line in the hero), NOT in `units` (total cartons
     on this row). Fold rollen into the key. */
  const groupKey = (it) => {
    if (!it?.useItem) return null;
    const lvl = it.level || getDisplayLevel(it) || 1;
    // Thermo family (L1 Thermo + L2 Veit + L3 ÖKO) — useItem alone
    // identifies the parent product; pack-per-carton is fixed per SKU.
    if (lvl === 1 || lvl === 2 || lvl === 3) return `u:${it.useItem}`;
    /* Per-Einheit pack count. Items here come from the parsed payload
       (not focusItemView'd) so we manually run the same fallback
       chain the hero card uses: explicit `rollen` from parseTitleMeta,
       a precomputed `perCarton` if any, and finally — only for L5 —
       the "(N)" / "TK 50x …" title patterns. */
    let perPack = it.rollen ?? it.perCarton ?? null;
    if (perPack == null && lvl === 5) {
      perPack = extractProduktionPerCarton(it.title || '');
    }
    if (perPack != null) return `u:${it.useItem}|r:${perPack}`;
    /* No pack-count anywhere → never assume two rows are the same SKU.
       Use the normalized title as the discriminator: identical title
       + identical useItem may still merge; anything else stays
       separate. Beats falsely merging "Sandsäcke 20 Stück" with
       "Sandsäcke 50 Stück" when neither line carries an explicit
       per-Einheit number the parser can pick up. */
    const titleKey = (it.title || '').trim().toLowerCase();
    return `u:${it.useItem}|t:${titleKey}`;
  };
  const groups: { key: string | null; from: number; items: typeof items }[] = [];
  items.forEach((item, j) => {
    const k = groupKey(item);
    const last = groups[groups.length - 1];
    if (last && k != null && last.key === k) {
      last.items.push(item);
    } else {
      groups.push({ key: k, from: j, items: [item] });
    }
  });
  return (
    <div style={{
      display: 'flex',
      flexWrap: wrap ? 'wrap' : 'nowrap',
      alignItems: 'center',
      gap: wrap ? 6 : 10,
    }}>
      {groups.map((g) => {
        const isCluster = g.items.length > 1;
        // Cluster success transition: once every chip inside this
        // useItem-group is Fertig'd (not just copied), fade the
        // capsule into success.bg + success border. Copy alone no
        // longer triggers the green frame.
        const allCompleted = isCluster && g.items.every((_, gi) =>
          completedKeys?.has?.(`${palletIdx}|${g.from + gi}`)
        );
        return (
        <div
          key={g.from}
          title={isCluster
            ? `${g.items.length}× gleicher Use-Item${allCompleted ? ' · alle abgeschlossen' : ''}`
            : undefined}
          style={{
            display: 'inline-flex',
            flexWrap: 'nowrap',
            gap: 6,
            /* Clusters get a clearly visible capsule — deeper surface
               bg + bolder border — so the operator reads each group
               of same-useItem chips as one unit at a glance. */
            padding: isCluster ? 4 : 0,
            background: isCluster
              ? (allCompleted ? T.status.success.bg : T.bg.surface3)
              : 'transparent',
            border: isCluster
              ? `1.5px solid ${allCompleted ? T.status.success.main : T.border.strong}`
              : 'none',
            borderRadius: 999,
            transition: isCluster
              ? 'background 400ms cubic-bezier(0.16, 1, 0.3, 1), border-color 400ms cubic-bezier(0.16, 1, 0.3, 1)'
              : 'none',
          }}
        >
          {g.items.map((item, gi) => {
            const j = g.from + gi;
            const isCompleted = completedKeys?.has?.(`${palletIdx}|${j}`);
            const isCopied = copiedKeys?.has?.(`${palletIdx}|${j}`);
            const isActive = j === currentItemIdx;
            const isEsku = item.isEinzelneSku === true;
            const hasFlag = (item.placementMeta?.flags || []).length > 0;
            const lvl = item.level || getDisplayLevel(item) || 1;
            const meta = LEVEL_META[lvl] || LEVEL_META[1];
            return (
              <NumberedChip
                key={j}
                idx={j + 1}
                itemIdx={j}
                isActive={isActive}
                isCompleted={isCompleted}
                isCopied={isCopied}
                isEsku={isEsku}
                hasFlag={hasFlag}
                levelMeta={meta}
                onPick={onPick}
                title={`Artikel ${j + 1} · L${lvl} ${meta.shortName || meta.name}` +
                       (isEsku ? ' · ⬢ ESKU' : '') +
                       (isCompleted
                         ? ' · ✓ abgeschlossen'
                         : isCopied ? ' · Code kopiert' : ' · noch offen')}
              />
            );
          })}
        </div>
        );
      })}
    </div>
  );
}

const NumberedChip = memo(function NumberedChip({
  idx, itemIdx, isActive, isCompleted, isCopied, isEsku, hasFlag, levelMeta, onPick, title,
}: {
  idx: number;
  itemIdx: number;
  isActive: boolean;
  isCompleted: boolean;
  isCopied: boolean;
  isEsku: boolean;
  hasFlag: boolean;
  levelMeta: { color: string; bg: string; text: string; [k: string]: unknown };
  onPick?: (itemIdx: number) => void;
  title: string;
}) {
  /* Coloring rules:
       active    → filled accent, white number — the selected chip
       completed → green tinted (Fertig wurde gedrückt)
       todo      → level-color soft (tinted bg + colored border + text)
     The copy-only state (code in clipboard but Fertig not pressed)
     intentionally has NO bg change — copy progress is shown on the
     Hero's Artikel-Code button, and chips greening on copy alone
     misled workers into skipping the Fertig step. A subtle inner ring
     hints at copy-progress for navigability without competing with
     the completion state.
     ESKU shifts border style to dashed; flags → tiny warn dot. */
  const meta = levelMeta || LEVEL_META[1];
  let color: string, fontWeight: number, bg: string, border: string;
  if (isActive) {
    color = '#fff';
    fontWeight = 700;
    bg = T.accent.main;
    border = T.accent.main;
  } else if (isCompleted) {
    color = T.status.success.text;
    fontWeight = 600;
    bg = T.status.success.bg;
    border = T.status.success.border;
  } else {
    color = meta.text;
    fontWeight = 600;
    bg = meta.bg;
    border = meta.color;
  }
  /* Inner accent ring marks "copied but not yet Fertig'd" — quieter
     than a bg flip, just enough so the worker can scan and see which
     codes are queued in clipboard. Suppressed on active/completed. */
  const showCopyHint = !isActive && !isCompleted && isCopied;

  const handleClick = useCallback(() => {
    onPick?.(itemIdx);
  }, [onPick, itemIdx]);

  return (
    <button
      type="button"
      onClick={handleClick}
      title={title}
      style={{
        position: 'relative',
        minWidth: 28,
        height: 28,
        padding: '0 6px',
        background: bg,
        border: `1.5px ${isEsku ? 'dashed' : 'solid'} ${border}`,
        borderRadius: 999,
        color,
        fontFamily: T.font.mono,
        fontSize: 12.5,
        fontWeight,
        textDecoration: 'none',
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '-0.005em',
        cursor: 'pointer',
        transition: 'color 200ms ease, background 200ms ease, border-color 200ms ease, transform 160ms ease',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        boxShadow: isActive
          ? `0 1px 2px rgba(17,24,39,0.06), 0 4px 12px -4px ${T.accent.main}55`
          : showCopyHint
            ? `inset 0 0 0 1.5px ${T.accent.main}`
            : 'none',
      }}
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.transform = 'none';
      }}
    >
      {idx}
      {hasFlag && (
        <span aria-hidden style={{
          position: 'absolute',
          top: -3, right: -3,
          width: 7, height: 7, borderRadius: '50%',
          background: T.status.warn.main,
          border: '1.5px solid #fff',
        }} />
      )}
    </button>
  );
});

/* ════════════════════════════════════════════════════════════════════════
   Wiederholt overlay
   ════════════════════════════════════════════════════════════════════════ */
/* ArticleDetailPanel — expanded info bound to a list row in
   PalletListOverlay. Shows the full title, every code we have, the
   units, and any placement notes. Read-only audit view. */
function ArticleDetailPanel({ item, level, levelMeta }) {
  const codes: Array<[string, string | null | undefined]> = [
    ['Artikel-Code', item.code],
    ['Use-Item',     item.useItem],
    ['FNSKU',        item.fnsku],
    ['SKU',          item.sku],
    ['EAN',          item.ean],
    ['ASIN',         item.asin],
  ];
  const visibleCodes = codes.filter(([, v]) => v);
  const lstLabel = item.lst || null;
  const flags    = (item.placementMeta?.flags || item.placementFlags || []) as unknown[];
  return (
    <div style={{
      padding: '12px 16px 16px 32px',
      background: T.bg.surface2,
      borderTop: `1px dashed ${T.border.subtle}`,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    }}>
      {/* Full title */}
      <div>
        <div style={{
          fontFamily: T.font.mono,
          fontSize: 10,
          fontWeight: 600,
          color: T.text.faint,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          marginBottom: 4,
        }}>
          Titel
        </div>
        <div style={{
          fontSize: 13.5,
          color: T.text.primary,
          lineHeight: 1.45,
          letterSpacing: '-0.005em',
          wordBreak: 'break-word',
        }}>
          {item.title || '—'}
        </div>
      </div>

      {/* Codes — key/value grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: '8px 18px',
      }}>
        {visibleCodes.map(([k, v]) => (
          <div key={k} style={{ minWidth: 0 }}>
            <div style={{
              fontFamily: T.font.mono,
              fontSize: 10,
              fontWeight: 600,
              color: T.text.faint,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              marginBottom: 2,
            }}>
              {k}
            </div>
            <div style={{
              fontFamily: T.font.mono,
              fontSize: 13,
              fontWeight: 500,
              color: T.text.primary,
              wordBreak: 'break-all',
            }}>
              {String(v)}
            </div>
          </div>
        ))}
      </div>

      {/* Meta row — level + units + LST + flags */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '6px 10px',
        alignItems: 'center',
      }}>
        <span style={{
          fontFamily: T.font.mono,
          fontSize: 10.5,
          fontWeight: 600,
          padding: '2px 7px',
          background: levelMeta.bg,
          color: levelMeta.text,
          border: `1px solid ${levelMeta.color}40`,
          borderRadius: 999,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}>
          L{level} {levelMeta.name}
        </span>
        {item.units != null && (
          <span style={{
            fontFamily: T.font.mono,
            fontSize: 11,
            fontWeight: 600,
            padding: '2px 8px',
            background: T.bg.surface,
            color: T.text.primary,
            border: `1px solid ${T.border.primary}`,
            borderRadius: 999,
          }}>
            × {item.units} Stück
          </span>
        )}
        {item.isEinzelneSku && (
          <span style={{
            fontFamily: T.font.mono,
            fontSize: 11,
            fontWeight: 600,
            padding: '2px 8px',
            background: T.accent.bg,
            color: T.accent.text,
            border: `1px solid ${T.accent.main}40`,
            borderRadius: 999,
          }}>
            ⬢ ESKU
          </span>
        )}
        {lstLabel && (
          <span style={{
            fontFamily: T.font.mono,
            fontSize: 11,
            fontWeight: 600,
            padding: '2px 8px',
            background: T.bg.surface,
            color: T.text.subtle,
            border: `1px solid ${T.border.primary}`,
            borderRadius: 999,
          }}>
            {lstLabel}
          </span>
        )}
        {flags.length > 0 && flags.map((f, k) => (
          <span key={k} style={{
            fontFamily: T.font.mono,
            fontSize: 11,
            fontWeight: 600,
            padding: '2px 8px',
            background: T.status.warn.bg,
            color: T.status.warn.text,
            border: `1px solid ${T.status.warn.main}40`,
            borderRadius: 999,
          }}>
            {String(f)}
          </span>
        ))}
      </div>
    </div>
  );
}

/* PalletListOverlay — full-screen modal listing every pallet and its
   articles. Worker uses it as an audit/overview and as a sandbox to
   rearrange article order: each row is draggable inside its pallet
   section, drops re-emit through onReorderArticles. Current article
   gets an accent rail + tint so the worker keeps orientation. */
function PalletListOverlay({
  pallets, rawPallets,
  currentRawIdx, currentRawItemIdx,
  copiedKeys,
  articleOrderOverride,
  onReorderArticles,
  onClose,
}) {
  const { beta } = useBetaDesign();
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const currentPalletId = rawPallets[currentRawIdx]?.id;

  /* DnD scoped to (palletId, displayIdx). We only allow reordering
     within a single pallet — cross-pallet drops fall back to no-op. */
  const [dragInfo, setDragInfo]       = useState<{ palletId: string; from: number } | null>(null);
  const [dragOverInfo, setDragOverInfo] = useState<{ palletId: string; idx: number } | null>(null);

  /* Row-expand state — clicking a row toggles a detail panel that
     shows every code, units, and placement notes for the article. */
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const toggleExpanded = (key: string) =>
    setExpandedKey((prev) => (prev === key ? null : key));
  const onItemDragStart = (palletId, from) => (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `${palletId}|${from}`);
    setDragInfo({ palletId, from });
  };
  const onItemDragOver = (palletId, idx) => (e) => {
    if (!dragInfo || dragInfo.palletId !== palletId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!dragOverInfo || dragOverInfo.palletId !== palletId || dragOverInfo.idx !== idx) {
      setDragOverInfo({ palletId, idx });
    }
  };
  const onItemDrop = (palletId, idx) => (e) => {
    e.preventDefault();
    if (dragInfo && dragInfo.palletId === palletId && dragInfo.from !== idx) {
      onReorderArticles?.(palletId, dragInfo.from, idx);
    }
    setDragInfo(null);
    setDragOverInfo(null);
  };
  const onItemDragEnd = () => {
    setDragInfo(null);
    setDragOverInfo(null);
  };
  return (
    <div onClick={onClose} style={{
      position: 'fixed',
      inset: 0,
      background: beta ? 'rgba(15, 23, 42, 0.32)' : 'rgba(17, 24, 39, 0.42)',
      zIndex: 1000,
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'center',
      padding: '6vh 24px 32px',
      cursor: 'pointer',
      backdropFilter: beta ? 'blur(4px)' : 'blur(2px)',
      WebkitBackdropFilter: beta ? 'blur(4px)' : 'blur(2px)',
      animation: 'wiederholt-bg-in 200ms cubic-bezier(0.16, 1, 0.3, 1) both',
    }}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={beta ? {
          maxWidth: 920,
          width: '100%',
          maxHeight: '88vh',
          padding: 8,
          background: '#F4F5F7',
          border: '2px solid #FFFFFF',
          borderRadius: 32,
          boxShadow: '0 0 89.7px 0 rgba(0, 0, 0, 0.05)',
          display: 'flex',
          flexDirection: 'column',
          cursor: 'default',
          overflow: 'hidden',
        } : {
          maxWidth: 920,
          width: '100%',
          maxHeight: '88vh',
          background: T.bg.surface,
          border: `1px solid ${T.border.primary}`,
          borderRadius: 18,
          boxShadow: 'none',
          display: 'flex',
          flexDirection: 'column',
          cursor: 'default',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: beta ? '14px 18px 12px' : '18px 24px 14px',
          borderBottom: beta ? `1px solid ${T.border.subtle}` : `1px solid ${T.border.primary}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <h2 style={{
              margin: 0,
              fontSize: 18,
              fontWeight: 600,
              color: T.text.primary,
              letterSpacing: '-0.01em',
            }}>
              Alle Paletten · Liste
            </h2>
            <span style={{
              fontFamily: T.font.mono,
              fontSize: 11,
              fontWeight: 600,
              color: T.text.faint,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
            }}>
              {pallets.length} Paletten
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Schließen"
            aria-label="Schließen"
            style={beta ? {
              all: 'unset',
              width: 30, height: 30,
              display: 'inline-flex',
              alignItems: 'center', justifyContent: 'center',
              background: 'transparent',
              border: 0,
              borderRadius: 999,
              cursor: 'pointer',
              color: T.text.subtle,
              transition: 'background 200ms ease, color 200ms ease',
            } : {
              all: 'unset',
              width: 30, height: 30,
              display: 'inline-flex',
              alignItems: 'center', justifyContent: 'center',
              border: `1px solid ${T.border.primary}`,
              borderRadius: 8,
              cursor: 'pointer',
              color: T.text.subtle,
              transition: 'border-color 200ms ease, color 200ms ease',
            }}
            onMouseEnter={(e) => {
              if (beta) {
                e.currentTarget.style.background = T.bg.surface2;
                e.currentTarget.style.color = T.text.secondary;
              } else {
                e.currentTarget.style.borderColor = T.accent.main;
                e.currentTarget.style.color = T.accent.main;
              }
            }}
            onMouseLeave={(e) => {
              if (beta) {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = T.text.subtle;
              } else {
                e.currentTarget.style.borderColor = T.border.primary;
                e.currentTarget.style.color = T.text.subtle;
              }
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"
                 stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M3 3l8 8M11 3l-8 8"/>
            </svg>
          </button>
        </div>

        {/* Scrollable body */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 24px 22px',
          WebkitOverflowScrolling: 'touch',
        }}>
          {pallets.map((p) => {
            const origIdx = rawPallets.findIndex((rp) => rp.id === p.id);
            const items = p.items || [];
            const total = items.length;
            let copied = 0;
            for (let j = 0; j < total; j++) {
              if (copiedKeys?.has?.(`${origIdx}|${j}`)) copied += 1;
            }
            const isCurrent = p.id === currentPalletId;
            const allCopied = total > 0 && copied === total;
            return (
              <section key={p.id} style={{ marginTop: beta ? 18 : 14 }}>
                {/* Pallet header */}
                <div style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 10,
                  paddingBottom: beta ? 10 : 6,
                  paddingLeft: beta ? 4 : 0,
                  borderBottom: beta ? '0' : `1px solid ${T.border.subtle}`,
                }}>
                  <span style={{
                    fontFamily: T.font.mono,
                    fontSize: 17,
                    fontWeight: 700,
                    color: isCurrent ? T.accent.main : T.text.primary,
                    letterSpacing: '-0.01em',
                  }}>
                    {shortPalletId(p)}
                  </span>
                  <span style={{
                    fontFamily: T.font.mono,
                    fontSize: 11,
                    fontWeight: 500,
                    color: T.text.faint,
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {copied} / {total} kopiert
                  </span>
                  {isCurrent && (
                    <span style={{
                      fontFamily: T.font.mono,
                      fontSize: 10,
                      fontWeight: 700,
                      color: T.accent.main,
                      letterSpacing: '0.14em',
                      textTransform: 'uppercase',
                    }}>
                      Aktuell
                    </span>
                  )}
                  {allCopied && !isCurrent && (
                    <span style={{
                      fontFamily: T.font.mono,
                      fontSize: 10,
                      fontWeight: 700,
                      color: T.status.success.text,
                      letterSpacing: '0.14em',
                      textTransform: 'uppercase',
                    }}>
                      ✓ Fertig
                    </span>
                  )}
                </div>

                {/* Items list — drag rows to reorder within this pallet.
                   In beta mode each article renders as its own white card
                   with a gap between rows; classic keeps the dashed-row
                   continuous list. */}
                <ul style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: beta ? 6 : 0,
                }}>
                  {items.map((it, j) => {
                    const articleOrder = articleOrderOverride[p.id];
                    const origItemIdx  = articleOrder ? articleOrder[j] : j;
                    const isCopiedItem = copiedKeys?.has?.(`${origIdx}|${origItemIdx}`);
                    const isActiveItem = isCurrent && origItemIdx === currentRawItemIdx;
                    const lvl = it.level || getDisplayLevel(it) || 1;
                    const meta = LEVEL_META[lvl] || LEVEL_META[1];
                    const units = it.units;
                    const rowKey = `${p.id}|${origItemIdx}`;
                    const isExpanded = expandedKey === rowKey;
                    const isDragSrc = !!dragInfo && dragInfo.palletId === p.id && dragInfo.from === j;
                    const isDragTgt = !!dragInfo && !!dragOverInfo
                                      && dragOverInfo.palletId === p.id && dragOverInfo.idx === j
                                      && dragInfo.palletId === p.id && dragInfo.from !== j;
                    return (
                      <li
                        key={`${origItemIdx}-${it.code || it.fnsku || j}`}
                        style={beta ? {
                          listStyle: 'none',
                          background: isActiveItem ? T.accent.bg : '#FFFFFF',
                          border: '1px solid transparent',
                          boxShadow: isActiveItem
                            ? `inset 0 0 0 1.5px ${T.accent.main}`
                            : 'none',
                          borderRadius: 16,
                          overflow: 'hidden',
                          transition: 'background 200ms ease, box-shadow 200ms ease, transform 200ms cubic-bezier(0.16, 1, 0.3, 1)',
                        } : {
                          listStyle: 'none',
                          borderBottom: `1px dashed ${T.border.subtle}`,
                          background: isActiveItem ? T.accent.bg : 'transparent',
                          borderLeft: isActiveItem
                            ? `3px solid ${T.accent.main}`
                            : '3px solid transparent',
                          transition: 'background 160ms ease',
                        }}
                      >
                        {/* Row — draggable + clickable to expand */}
                        <div
                          draggable
                          onClick={() => toggleExpanded(rowKey)}
                          onDragStart={onItemDragStart(p.id, j)}
                          onDragOver={onItemDragOver(p.id, j)}
                          onDrop={onItemDrop(p.id, j)}
                          onDragEnd={onItemDragEnd}
                          style={{
                            position: 'relative',
                            display: 'grid',
                            gridTemplateColumns: '18px 30px 64px minmax(80px, auto) 1fr minmax(120px, auto) 22px',
                            alignItems: 'center',
                            gap: 12,
                            padding: beta ? '12px 14px 12px 12px' : '8px 8px 8px 7px',
                            opacity: isDragSrc ? 0.4 : (isCopiedItem && !isActiveItem ? 0.75 : 1),
                            boxShadow: isDragTgt ? `inset 0 2px 0 ${T.accent.main}` : 'none',
                            cursor: 'grab',
                            transition: 'opacity 160ms ease, box-shadow 160ms ease',
                          }}
                        >
                          {/* Drag handle */}
                          <span aria-hidden style={{
                            display: 'inline-grid',
                            gridTemplateColumns: 'repeat(2, 3px)',
                            gridAutoRows: '3px',
                            gap: 2,
                            color: T.text.faint,
                            justifySelf: 'center',
                          }}>
                            {Array.from({ length: 6 }).map((_, k) => (
                              <span key={k} style={{
                                width: 3, height: 3, borderRadius: '50%',
                                background: 'currentColor',
                              }} />
                            ))}
                          </span>

                          {/* Position number */}
                          <span style={{
                            fontFamily: T.font.mono,
                            fontSize: 11,
                            color: isActiveItem ? T.accent.main : T.text.faint,
                            fontWeight: isActiveItem ? 700 : 500,
                            fontVariantNumeric: 'tabular-nums',
                            textAlign: 'right',
                          }}>
                            {String(j + 1).padStart(2, '0')}
                          </span>

                          {/* Units / Menge */}
                          <span
                            title={units != null ? `${units} Stück` : 'Menge nicht erkannt'}
                            style={{
                              fontFamily: T.font.mono,
                              fontSize: 12,
                              fontWeight: 600,
                              color: units != null ? T.text.primary : T.text.faint,
                              fontVariantNumeric: 'tabular-nums',
                              textAlign: 'right',
                            }}
                          >
                            {units != null ? `× ${units}` : '—'}
                          </span>

                          {/* Level pill */}
                          <span style={{
                            fontFamily: T.font.mono,
                            fontSize: 10.5,
                            fontWeight: 600,
                            padding: '2px 7px',
                            background: meta.bg,
                            color: meta.text,
                            border: `1px solid ${meta.color}40`,
                            borderRadius: 999,
                            letterSpacing: '0.06em',
                            textTransform: 'uppercase',
                            justifySelf: 'start',
                            whiteSpace: 'nowrap',
                          }}>
                            L{lvl} {meta.shortName || meta.name}
                          </span>

                          {/* Title — single line by default; full text
                             appears in the expanded panel + via tooltip. */}
                          <span style={{
                            fontSize: 13,
                            fontWeight: isActiveItem ? 600 : 400,
                            color: T.text.primary,
                            letterSpacing: '-0.005em',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }} title={it.title || ''}>
                            {formatItemTitle(it.title || '—')}
                          </span>

                          {/* Code — ESKU rows lead with the merchant SKU
                             (the label workers actually scan) and surface
                             FNSKU as a small subtle line underneath.
                             Mixed rows keep the legacy single-line code. */}
                          {it.isEinzelneSku ? (
                            <span style={{
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'flex-end',
                              gap: 2,
                              minWidth: 0,
                              overflow: 'hidden',
                            }} title={[it.sku, it.fnsku].filter(Boolean).join(' · ') || ''}>
                              <span style={{
                                fontFamily: T.font.mono,
                                fontSize: 12,
                                fontWeight: 600,
                                color: T.text.primary,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                maxWidth: '100%',
                              }}>
                                {it.sku || it.fnsku || '—'}
                              </span>
                              {it.sku && it.fnsku && it.fnsku !== it.sku && (
                                <span style={{
                                  fontFamily: T.font.mono,
                                  fontSize: 10.5,
                                  color: T.text.faint,
                                  letterSpacing: '0.02em',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                  maxWidth: '100%',
                                }}>
                                  {it.fnsku}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span style={{
                              fontFamily: T.font.mono,
                              fontSize: 12,
                              color: T.text.subtle,
                              textAlign: 'right',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }} title={it.code || it.useItem || it.fnsku || ''}>
                              {it.code || it.useItem || it.fnsku || '—'}
                            </span>
                          )}

                          {/* Status indicator (✓ if copied) OR chevron
                             when expanded. Status wins — copy state is
                             primary signal. */}
                          <span aria-hidden style={{
                            width: 18, height: 18, borderRadius: '50%',
                            border: isCopiedItem ? 'none' : `1.5px solid ${T.border.strong}`,
                            background: isCopiedItem ? T.status.success.main : 'transparent',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            justifySelf: 'center',
                            color: isCopiedItem ? '#fff' : T.text.faint,
                            transform: isExpanded ? 'rotate(180deg)' : 'none',
                            transition: 'transform 200ms ease',
                          }}>
                            {isCopiedItem ? (
                              <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                                <path d="M2.5 6.5l2 2 5-5.5" stroke="currentColor" strokeWidth="2"
                                      strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            ) : (
                              <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                                <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.6"
                                      strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            )}
                          </span>
                        </div>

                        {/* Detail panel — opens on row click */}
                        {isExpanded && (
                          <ArticleDetailPanel
                            item={it}
                            level={lvl}
                            levelMeta={meta}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function WiederholtOverlay({ hit, onDismiss }) {
  if (!hit) return null;
  /* Minimalist redesign (2026-05-24): the worker has already seen the
     Artikel-Code on the hero card — repeating it here is noise. The
     one new fact this overlay carries is the TARGET PALETTE-ID; units
     is supporting context to set expectation. Everything else is
     chrome.
     Dismissal: ONLY via the explicit "OK" button. No backdrop click,
     no Esc/Enter/Space, no timeout — worker must acknowledge so the
     warning can't be missed when two identical pallets follow. */
  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(15, 23, 42, 0.32)',
      backdropFilter: 'blur(4px)',
      WebkitBackdropFilter: 'blur(4px)',
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 32,
      animation: 'wiederholt-bg-in 200ms cubic-bezier(0.16, 1, 0.3, 1) both',
    }}>
      <div
        style={{
          maxWidth: 520,
          width: '100%',
          padding: 8,
          background: '#F4F5F7',
          border: '2px solid #FFFFFF',
          borderRadius: 32,
          boxShadow: '0 0 89.7px 0 rgba(0, 0, 0, 0.05)',
          cursor: 'default',
          animation: 'wiederholt-card-in 320ms cubic-bezier(0.16, 1, 0.3, 1) both',
        }}
      >
        <div style={{
          background: '#FFFFFF',
          borderRadius: 24,
          padding: '40px 36px 28px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 14,
        }}>
          {/* Eyebrow: state label only — code + units now live as a
              dedicated row under the pallet ID hero. */}
          <span style={{
            fontFamily: T.font.mono,
            fontSize: 10.5,
            fontWeight: 700,
            color: T.status.warn.text,
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
          }}>
            Wiederholt
          </span>

          {/* Hero — the one fact that matters: the next pallet ID. */}
          <span style={{
            fontFamily: T.font.mono,
            fontSize: 'clamp(56px, 8vw, 88px)',
            fontWeight: 600,
            color: T.status.warn.main,
            letterSpacing: '-0.04em',
            lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {hit.palletId}
          </span>

          {/* Article code + quantity row — sits under the pallet ID so
              the worker can cross-check the scanner code without going
              back to the hero card. Code is mono (matches scanner ID),
              quantity accents the warn-tone so it reads as paired. */}
          {(hit.code || hit.units != null) && (
            <div style={{
              marginTop: 6,
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 12,
              flexWrap: 'wrap',
              justifyContent: 'center',
            }}>
              {hit.code && (
                <span style={{
                  fontFamily: T.font.mono,
                  fontSize: 'clamp(16px, 1.8vw, 22px)',
                  fontWeight: 500,
                  color: T.text.primary,
                  letterSpacing: '-0.01em',
                  fontVariantNumeric: 'tabular-nums',
                  wordBreak: 'break-all',
                }}>
                  {hit.code}
                </span>
              )}
              {hit.units != null && (
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'baseline',
                  gap: 5,
                  fontFamily: T.font.mono,
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  <span style={{
                    fontSize: 'clamp(18px, 2vw, 24px)',
                    fontWeight: 600,
                    color: T.status.warn.main,
                    letterSpacing: '-0.01em',
                  }}>
                    {hit.units}
                  </span>
                  <span style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: T.text.subtle,
                    textTransform: 'uppercase',
                    letterSpacing: '0.12em',
                  }}>
                    Stück
                  </span>
                </span>
              )}
            </div>
          )}

          {/* Single dismiss action — pill style consistent with beta UI. */}
          <button
            type="button"
            onClick={onDismiss}
            style={{
              all: 'unset',
              cursor: 'pointer',
              marginTop: 18,
              padding: '11px 28px',
              background: T.accent.main,
              color: '#FFFFFF',
              borderRadius: 999,
              fontFamily: T.font.ui,
              fontSize: 13,
              fontWeight: 600,
              letterSpacing: '0.01em',
            }}
          >
            OK
          </button>
        </div>
      </div>

      <style>{`
        @keyframes wiederholt-bg-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes wiederholt-card-in {
          from { opacity: 0; transform: translateY(12px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Atoms
   ════════════════════════════════════════════════════════════════════════ */
/* Shared ModeToggle — uniform pill style for view-mode flags (Doppel/
   Shell/Zen). Variant icon distinguishes them at a glance; a Kbd hint
   surfaces the keyboard shortcut so workers learn it ambient.

   Focus-steal guard (mouseDown preventDefault + blur on click) keeps
   the document-level keydown handler in charge — without it, a
   focused toggle could re-fire its own click on Space/Enter, hijacking
   Fertig. */
function ModeToggle({
  label, hotkey, on, onToggle, icon, title,
}: {
  label: string;
  hotkey: string;
  on: boolean;
  onToggle: () => void;
  icon: 'dot' | 'double' | 'zen' | 'flow';
  title: string;
}) {
  const dotColor = on ? T.accent.main : T.text.faint;
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => { onToggle(); e.currentTarget.blur(); }}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 24,
        padding: '0 6px 0 10px',
        fontSize: 10.5,
        fontFamily: T.font.mono,
        fontWeight: 700,
        color: on ? T.accent.text : T.text.subtle,
        background: on ? T.accent.bg : '#FFFFFF',
        border: '1px solid transparent',
        borderRadius: 999,
        cursor: 'pointer',
        letterSpacing: '0.10em',
        textTransform: 'uppercase',
        transition: 'background 140ms ease, border-color 140ms ease, color 140ms ease',
      }}
    >
      {icon === 'double' ? (
        <span aria-hidden style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: dotColor }} />
          <span style={{ width: 3, height: 3, borderRadius: '50%', background: dotColor, opacity: 0.5 }} />
        </span>
      ) : icon === 'zen' ? (
        <span aria-hidden style={{
          width: 6, height: 6,
          border: `1.5px solid ${dotColor}`,
          borderRadius: '50%',
          background: 'transparent',
        }} />
      ) : icon === 'flow' ? (
        <span aria-hidden style={{
          display: 'inline-flex',
          flexDirection: 'column',
          gap: 1.5,
          alignItems: 'stretch',
          width: 7,
        }}>
          <span style={{ height: 1.5, background: dotColor, borderRadius: 1, opacity: 0.55 }} />
          <span style={{ height: 1.5, background: dotColor, borderRadius: 1 }} />
          <span style={{ height: 1.5, background: dotColor, borderRadius: 1, opacity: 0.55 }} />
        </span>
      ) : (
        <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: dotColor }} />
      )}
      <span>{label}</span>
      <span aria-hidden style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 14, height: 14,
        marginLeft: 2,
        fontSize: 9,
        fontFamily: T.font.mono,
        fontWeight: 700,
        color: on ? T.accent.text : T.text.faint,
        background: on ? 'rgba(255,255,255,0.55)' : T.bg.surface2,
        border: `1px solid ${on ? T.accent.border : T.border.subtle}`,
        borderRadius: 3,
        letterSpacing: 0,
        lineHeight: 1,
      }}>
        {hotkey}
      </span>
    </button>
  );
}

function DoppelToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <ModeToggle
      label="Doppel"
      hotkey="D"
      on={on}
      onToggle={onToggle}
      icon="double"
      title={on
        ? 'Doppel-Artikel-Modus an — nächster Artikel als Vorschau (D)'
        : 'Doppel-Artikel-Modus aus — nur aktueller Artikel (D)'}
    />
  );
}

function ShellToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <ModeToggle
      label="Shell"
      hotkey="S"
      on={on}
      onToggle={onToggle}
      icon="dot"
      title={on
        ? 'Shell-Modus an — Tastatur-Hotkeys aktiv (S)'
        : 'Shell-Modus aus — Tastatur-Hotkeys deaktiviert (S)'}
    />
  );
}

function ZenToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <ModeToggle
      label="Zen"
      hotkey="Z"
      on={on}
      onToggle={onToggle}
      icon="zen"
      title={on
        ? 'Zen-Modus an — nur Artikel sichtbar (Z oder Esc)'
        : 'Zen-Modus aus — vollständige Oberfläche (Z)'}
    />
  );
}

function Kbd({ children, onPrimary }: { children?: React.ReactNode; onPrimary?: boolean }) {
  return (
    <kbd style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 18, height: 16,
      padding: '0 5px',
      fontSize: 10, fontFamily: T.font.mono, fontWeight: 600,
      color: onPrimary ? '#fff' : T.text.subtle,
      background: onPrimary ? 'var(--bg-glass-on-accent)' : T.bg.surface,
      border: `1px solid ${onPrimary ? 'var(--bg-glass-on-accent-border)' : T.border.primary}`,
      borderRadius: 3,
      lineHeight: 1,
      letterSpacing: '0.04em',
    }}>{children}</kbd>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Hooks
   ════════════════════════════════════════════════════════════════════════ */
function useReducedMotion() {
  const [v, setV] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches || false;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setV(mq.matches);
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener?.(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener?.(onChange);
    };
  }, []);
  return v;
}

/* ── Clipboard helpers ── */
function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    return;
  }
  fallbackCopy(text);
}
function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch {
    /* ignore */
  }
}

/* ════════════════════════════════════════════════════════════════════════
   Multi-user session integration (beta only).

   Visually invisible: the worker never sees peer badges, a free-pallet
   grid, or a "pick a pallet" dialog. Backend assigns them a pallet,
   they work it like single-user, and when they finish it we release
   and auto-claim the next one in the background.

   Returns a thin handle FocusScreen consults at three points:
     - palletIdxOverride : when set, overrides current.currentPalletIdx
                           so the displayed pallet is always the one
                           we currently own
     - hasClaim          : tells handleFertig whether to use the
                           multi-user transition (release + claim_next)
                           instead of the classic next-pallet advance
     - releaseAndClaimNext(idx) : marks `idx` as completed and claims
                           the first remaining free pallet. Returns
                           true if a next pallet was claimed; false
                           when no free pallets remain (then backend
                           auto-completes and Workspace routes to
                           Abschluss via polling).

   When `enabled` is false (classic mode), the hook returns a no-op
   handle so single-user behaviour is byte-identical to the pre-
   multi-user version. */
function useMultiUserFocus(
  auftragId: string | null,
  enabled: boolean,
): {
  hasClaim: boolean;
  palletIdxOverride: number | null;
  releaseAndClaimNext: (palletIdx: number) => Promise<boolean>;
} {
  const qc = useQueryClient();
  const me = useMe().data;
  const meId = me?.id ?? null;
  /* Polling only runs while we declare focus-active. Mounting this
     hook unconditionally would also flip the flag for classic users;
     gate via `enabled` so classic stays invalidate-driven. */
  // eslint-disable-next-line react-hooks/rules-of-hooks
  if (enabled) useDeclareFocusActive();

  /* Read current AuftragDetail from the ['auftraege'] cache the global
     useAppState query maintains. Polling refetches (3 s while focus-
     active) keep this fresh — we just read, don't write. */
  const list = (qc.getQueryData<AuftragDetailT[]>(['auftraege']) ?? []);
  const auftrag = (auftragId
    ? list.find((a) => a.id === auftragId) ?? null
    : null);
  const session = useFocusSession(enabled ? auftrag : null);

  const myClaim = enabled ? session.myClaim : null;
  const hasClaim = !!myClaim;
  const palletIdxOverride = myClaim ? myClaim.palletIdx : null;
  const firstFree = session.freeIdxs[0];

  /* Auto-claim first free pallet on mount or whenever we lose our claim.
     Guards:
       - enabled (beta only)
       - auftrag loaded and still in_progress
       - I have no active claim
       - There IS a free pallet (otherwise nothing to do; backend will
         auto-complete once peers finish theirs)
     The claim() call returns 409 if a parallel worker beat us; the
     next 3-second poll will surface a different free slot we can try.
     We don't retry in-effect to avoid hot loops. */
  useEffect(() => {
    if (!enabled || !auftrag || !meId) return;
    if (auftrag.status !== 'in_progress') return;
    if (hasClaim) return;
    if (firstFree == null) return;
    session.claim(firstFree).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, auftragId, meId, hasClaim, firstFree, auftrag?.status]);

  const releaseAndClaimNext = useCallback(async (palletIdx: number): Promise<boolean> => {
    if (!enabled || !auftrag) return false;
    /* release(completed=true) flips the claim row to 'completed' and
       triggers backend auto-complete check. The response is the fresh
       AuftragDetail. Read the resulting freeIdxs by inspecting its
       palletClaims — anything not in state='active' or 'completed' is
       fair game. */
    const after = await session.release(palletIdx, true).catch(() => null);
    if (!after) return false;
    if (after.status === 'completed') {
      /* Backend just auto-completed the whole Auftrag — Workspace
         will route to Abschluss on the next poll. Nothing to claim. */
      return false;
    }
    const palletCount = after.parsed?.pallets?.length ?? 0;
    const occupied = new Set(
      (after.palletClaims ?? [])
        .filter((c) => c.state === 'active' || c.state === 'completed')
        .map((c) => c.palletIdx),
    );
    let next: number | null = null;
    for (let i = 0; i < palletCount; i++) {
      if (!occupied.has(i)) { next = i; break; }
    }
    if (next == null) return false;
    await session.claim(next).catch(() => undefined);
    return true;
  }, [enabled, auftrag, session]);

  return { hasClaim, palletIdxOverride, releaseAndClaimNext };
}
