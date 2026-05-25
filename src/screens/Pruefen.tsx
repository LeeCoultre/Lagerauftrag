/* Pruefen — Schritt 02. "Priority-driven hierarchy" redesign.

   Operator priorities, in order:
     1. FBA-Code  — primary anchor of the page
     2. Preflight — only if there are flags (auto-expanded)
     3. Paletten  — main content (story-cards or mini-grid)

   Supporting metrics (Übersicht, Auslastung, Levels) are demoted to
   a single compact monoline + a collapsible Levels disclosure. They
   never compete with FBA / Preflight / Paletten for attention.

   Visual decisions:
     • FBA mono 64-80px is the page's hero — nothing visually competes
       with it on the same row except a small status pill.
     • Status + duration + auto-insights live as one mono caption line
       under FBA.
     • Fingerprint row (12 colored squares) gives the operator a
       one-glance understanding of "shape" of this Auftrag.
     • Pallets section gets a STICKY toolbar at scroll — filter/toggle
       always one click away, even mid-list.
     • Page background is a subtle dot-grid for "blueprint" feel.
*/

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppState } from '@/state.jsx';
import { useBetaDesign } from '@/hooks/useBetaDesign';
import {
  pruefenView, distributeEinzelneSku, applyEskuOverrides, eskuOverrideKey,
  enrichItemDims,
  levelDistribution, sortItemsForPallet, LEVEL_META,
  itemTotalWeightKg,
  formatItemTitle, getDisplayLevel, largeBaseRank,
} from '@/utils/auftragHelpers.js';
import { lookupSkuDimensions } from '@/marathonApi.js';
import {
  Page, Topbar, StepperBar, StudioFrame, Button, T,
} from '@/components/ui.jsx';
import PreflightCard from '@/components/PreflightCard.jsx';
import PalletStoryCard from '@/components/PalletStoryCard.jsx';
import PalletMiniCard from '@/components/PalletMiniCard.jsx';
import PalletStackViz from '@/components/PalletStackViz.jsx';
import CancelAuftragModal from '@/components/CancelAuftragModal';
import { analyzeAuftrag } from '@/utils/preflightAnalyzer.js';
import { buildPalletStory, rankPallets } from '@/utils/palletStory.js';

const AUTO_OVERVIEW_THRESHOLD = 15;

/* ════════════════════════════════════════════════════════════════════════
   Top-level router — branches on beta-design flag. Classic body preserved
   verbatim; beta body rendered by BetaPruefen further down.
   ════════════════════════════════════════════════════════════════════════ */
export default function PruefenScreen() {
  const { beta } = useBetaDesign();
  if (beta) return <BetaPruefen />;
  return <ClassicPruefen />;
}

/* ════════════════════════════════════════════════════════════════════════ */
function ClassicPruefen() {
  const { current, goToStep, cancelCurrent, moveEskuToPallet } = useAppState();
  const rawPallets = current?.parsed?.pallets || [];
  const eskuItems  = current?.parsed?.einzelneSkuItems || [];
  const eskuOverrides = current?.eskuOverrides || {};

  /* ── data: enrichment + distribution ─────────────────────────── */
  const allItems = useMemo(() => [
    ...rawPallets.flatMap((p) => p.items || []),
    ...eskuItems,
  ], [rawPallets, eskuItems]);

  const dimsQ = useQuery({
    queryKey: ['sku-dims', current?.id],
    queryFn: () => enrichItemDims(allItems, lookupSkuDimensions),
    enabled: !!current?.id && allItems.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  const enrichedPallets = useMemo(() => {
    const enriched = dimsQ.data || null;
    let cursor = 0;
    const base = rawPallets.map((p) => ({
      ...p,
      items: (p.items || []).map((origIt) => {
        const fromDims = enriched ? enriched[cursor] : null;
        cursor += 1;
        return fromDims || origIt;
      }),
    }));
    return base.map((p) => ({ ...p, items: sortItemsForPallet(p.items || []) }));
  }, [rawPallets, dimsQ.data]);

  const enrichedEsku = useMemo(() => {
    if (!dimsQ.data) return eskuItems;
    const palletItemsCount = rawPallets.reduce((n, p) => n + (p.items?.length || 0), 0);
    return eskuItems.map((it, i) => dimsQ.data[palletItemsCount + i] || it);
  }, [eskuItems, rawPallets, dimsQ.data]);

  const view = useMemo(
    () => pruefenView({ ...current?.parsed, pallets: enrichedPallets }),
    [current?.parsed, enrichedPallets],
  );
  const distribution = useMemo(
    () => {
      const auto = distributeEinzelneSku(enrichedPallets, enrichedEsku);
      return applyEskuOverrides(auto, eskuOverrides, enrichedPallets);
    },
    [enrichedPallets, enrichedEsku, eskuOverrides],
  );
  const eskuDist = distribution.byPalletId;
  const palletStates = distribution.palletStates;

  const validation = current?.validation || { ok: true, errorCount: 0, warningCount: 0, issues: [] };
  const validView = {
    ok: validation.ok ?? (validation.errorCount === 0),
    errors: validation.errorCount || 0,
    warnings: validation.warningCount || 0,
  };

  /* ── Parser warnings aggregation ───────────────────────────────────
     Each parsed item may carry `parseWarnings[]` set by the strict
     classifiers in parseLagerauftrag.ts. We surface them here so the
     worker reviews them BEFORE entering Focus. High-severity ones
     block Focus until acknowledged; low/medium are informational. */
  const parseWarnings = useMemo(() => {
    const out: Array<{
      key: string;
      palletId: string;
      itemIdx: number;
      item: any;
      warnings: any[];
      maxSeverity: 'low' | 'medium' | 'high';
    }> = [];
    const addItems = (items: any[], palletId: string) => {
      items.forEach((it, idx) => {
        const ws = (it?.parseWarnings || []) as any[];
        if (!ws.length) return;
        const sev = ws.reduce((m: 'low' | 'medium' | 'high', w: any) =>
          w.severity === 'high' ? 'high'
          : (w.severity === 'medium' && m !== 'high') ? 'medium'
          : m,
        'low' as 'low' | 'medium' | 'high');
        out.push({
          key: `${palletId}|${idx}`,
          palletId,
          itemIdx: idx,
          item: it,
          warnings: ws,
          maxSeverity: sev,
        });
      });
    };
    (current?.parsed?.pallets || []).forEach((p: any) => addItems(p.items || [], p.id));
    addItems(current?.parsed?.einzelneSkuItems || [], 'ESKU');
    return out;
  }, [current?.parsed]);

  /* ── Acknowledged warnings — persisted in localStorage keyed by
     Auftrag id + item key. Worker clicks "Akzeptieren" → that item's
     warning is muted (but still visible, just no longer blocks). */
  const ackKey = `marathon.pruefen.parseAcks.${current?.id || 'none'}`;
  const [acked, setAcked] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(ackKey);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  });
  const ackOne = (key: string) => {
    setAcked((prev) => {
      const next = new Set(prev);
      next.add(key);
      try { localStorage.setItem(ackKey, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };
  const ackAll = () => {
    setAcked((prev) => {
      const next = new Set(prev);
      parseWarnings.forEach((w) => next.add(w.key));
      try { localStorage.setItem(ackKey, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };

  /* High-severity warnings that haven't been acknowledged block Focus. */
  const blockingWarnings = parseWarnings.filter(
    (w) => w.maxSeverity === 'high' && !acked.has(w.key),
  );

  const briefing = useMemo(
    () => analyzeAuftrag({
      parsed: current?.parsed,
      validation,
      distribution,
      enrichedPallets,
      enrichedEsku,
    }),
    [current?.parsed, validation, distribution, enrichedPallets, enrichedEsku],
  );
  const hasPreflightFlags = briefing && briefing.worst !== 'ok' && briefing.flags?.length > 0;

  /* ── pallet auto-insights for the meta line under FBA ─────── */
  const insights = useMemo(
    () => buildAuftragInsights(view?.pallets || [], enrichedPallets, palletStates, eskuDist),
    [view?.pallets, enrichedPallets, palletStates, eskuDist],
  );

  /* ── pallet view-mode + filter ─────────────────────────────── */
  const [viewMode, setViewMode] = useState(() => {
    if (typeof window === 'undefined') return 'story';
    const stored = localStorage.getItem('pruefen.palletViewMode');
    if (stored === 'overview' || stored === 'story') return stored;
    return rawPallets.length >= AUTO_OVERVIEW_THRESHOLD ? 'overview' : 'story';
  });
  const switchViewMode = (mode) => {
    setViewMode(mode);
    try { localStorage.setItem('pruefen.palletViewMode', mode); } catch { /* ignore */ }
  };

  const [problemOnly, setProblemOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const handleJumpToPallet = (palletId) => {
    if (viewMode !== 'story') switchViewMode('story');
    setTimeout(() => {
      const el = document.getElementById(`pallet-row-${palletId}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
  };

  const ranking = useMemo(
    () => rankPallets(view?.pallets || [], palletStates),
    [view?.pallets, palletStates],
  );

  /* Build a per-pallet search index once — flattened searchable
     string per pallet covers id + every item's FNSKU / EAN / SKU /
     ASIN / useItem / title. Lower-cased so the query comparison is
     case-insensitive.

     Source must be the item-carrying enrichedPallets, NOT view.pallets
     (the latter is `pruefenView()` output which only carries summary
     fields like {id, level, articles}, no items). ESKU items are
     pre-distributed via `distribution.byPalletId`, so we also fold
     them in so a worker searching for an ESKU code lands on the
     correct destination pallet. */
  const palletSearchIndex = useMemo(() => {
    const idx = new Map<string, string>();
    enrichedPallets.forEach((p: any) => {
      const parts: string[] = [String(p.id || '').toLowerCase()];
      const items = [
        ...(p.items || []),
        ...(eskuDist?.[p.id] || []),
      ];
      items.forEach((it: any) => {
        if (it.fnsku)   parts.push(String(it.fnsku).toLowerCase());
        if (it.ean)     parts.push(String(it.ean).toLowerCase());
        if (it.sku)     parts.push(String(it.sku).toLowerCase());
        if (it.asin)    parts.push(String(it.asin).toLowerCase());
        if (it.useItem) parts.push(String(it.useItem).toLowerCase());
        if (it.title)   parts.push(String(it.title).toLowerCase());
      });
      idx.set(p.id, parts.join(' '));
    });
    return idx;
  }, [enrichedPallets, eskuDist]);

  const searchQ = searchQuery.trim().toLowerCase();

  const visiblePallets = useMemo(() => {
    let arr = view?.pallets || [];
    if (problemOnly) {
      arr = arr.filter((p) => {
        const st = palletStates[p.id];
        return st && Array.isArray(st.flags) && st.flags.length > 0;
      });
    }
    if (searchQ) {
      arr = arr.filter((p) => (palletSearchIndex.get(p.id) || '').includes(searchQ));
    }
    return arr;
  }, [view?.pallets, palletStates, problemOnly, searchQ, palletSearchIndex]);

  const hiddenByFilter = (view?.pallets?.length || 0) - visiblePallets.length;

  /* ── Levels disclosure (collapsed by default — secondary info) */
  const [levelsOpen, setLevelsOpen] = useState(true);

  /* ── Sticky pallets toolbar — IntersectionObserver on header ── */
  const palletsHeaderRef = useRef(null);
  const [stickyToolbar, setStickyToolbar] = useState(false);
  useEffect(() => {
    const el = palletsHeaderRef.current;
    if (!el) return undefined;
    const obs = new IntersectionObserver(
      ([entry]) => setStickyToolbar(!entry.isIntersecting && entry.boundingClientRect.top < 0),
      { threshold: 0, rootMargin: '-60px 0px 0px 0px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [visiblePallets.length]);

  /* ── Keyboard F → Focus. Blocked also by unacknowledged
     high-severity parser warnings — the worker must explicitly
     acknowledge ambiguous parses before moving on. */
  const focusBlocked = validView.errors > 0 || blockingWarnings.length > 0;
  const onStartFocus = () => {
    if (!focusBlocked) goToStep('focus');
  };
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      const tag = t?.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable;
      /* Slash → focus the first visible search field. Works only when
         the worker isn't already typing somewhere else. */
      if (e.key === '/' && !inField && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const input = document.querySelector<HTMLInputElement>('input[data-pruefen-search]');
        if (input) {
          e.preventDefault();
          input.focus();
          input.select();
          return;
        }
      }
      if (e.key !== 'f' && e.key !== 'F') return;
      if (inField) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!focusBlocked) {
        e.preventDefault();
        goToStep('focus');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [focusBlocked, goToStep]);

  if (!view) {
    return (
      <Page>
        <Topbar crumbs={[{ label: 'Workspace', muted: true }, { label: 'Auftrag prüfen' }]} />
        <main style={{ padding: '64px 32px', textAlign: 'center', color: T.text.subtle }}>
          Kein Auftrag geladen.
        </main>
      </Page>
    );
  }

  return (
    <Page>
      <PruefenStyles />
      <Topbar
        crumbs={[
          { label: 'Prüfen' },
        ]}
        right={
          <Button variant="ghost" size="sm" onClick={cancelCurrent} title="Auftrag abbrechen, zurück zur Warteschlange">
            Verlassen
          </Button>
        }
      />

      <StepperBar active="pruefen" />

      {/* Sticky toolbar — only renders when section header scrolls out */}
      <StickyPalletsToolbar
        visible={stickyToolbar}
        count={view.pallets.length}
        visibleCount={visiblePallets.length}
        problemOnly={problemOnly}
        onToggleProblem={() => setProblemOnly((v) => !v)}
        viewMode={viewMode}
        onChangeViewMode={switchViewMode}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />

      <div className="mp-prf-canvas" style={{ minHeight: 'calc(100vh - 200px)' }}>
        <main style={{
          maxWidth: 1080,
          margin: '0 auto',
          padding: '40px 32px 140px',
          display: 'flex',
          flexDirection: 'column',
          gap: 32,
        }}>

          {/* PRIMARY 1+2: FBA Hero + Preflight wrapped in one «studio»
              frame — single set of corner-marks brackets both cards
              with one mono eyebrow at the top, like Upload's drop
              studio. */}
          <StudioFrame
            bare
            gap={20}
            label="Auftrags-Identität · Schritt 02"
            status={
              validView.ok && validView.warnings === 0 ? 'Validiert'
              : validView.errors > 0 ? `${validView.errors} Fehler`
              : `${validView.warnings} Warnungen`
            }
          >
            <HeroFBA
              view={view}
              stats={view.stats}
              validView={validView}
              insights={insights}
              palletStates={palletStates}
              onJumpToPallet={handleJumpToPallet}
            />

            <div style={{ animation: 'mp-prf-rise 480ms cubic-bezier(0.16,1,0.3,1) 100ms backwards' }}>
              <PreflightCard
                briefing={briefing}
                onJumpToPallet={handleJumpToPallet}
              />
            </div>
          </StudioFrame>

          {/* Parser warnings — only renders when items carry warnings.
              High-severity rows block Focus until acknowledged. */}
          {parseWarnings.length > 0 && (
            <div style={{ animation: `mp-prf-rise 480ms cubic-bezier(0.16,1,0.3,1) ${hasPreflightFlags ? 160 : 120}ms backwards` }}>
              <ParseWarningsPanel
                warnings={parseWarnings}
                acked={acked}
                onAckOne={ackOne}
                onAckAll={ackAll}
              />
            </div>
          )}

          {/* SECONDARY: collapsible Levels disclosure */}
          <div style={{ animation: `mp-prf-rise 480ms cubic-bezier(0.16,1,0.3,1) ${hasPreflightFlags ? 180 : 140}ms backwards` }}>
            <LevelsDisclosure
              pallets={enrichedPallets}
              open={levelsOpen}
              onToggle={() => setLevelsOpen((v) => !v)}
            />
          </div>

          {/* PRIMARY 3: Paletten */}
          <PalletsSection
            headerRef={palletsHeaderRef}
            pallets={view.pallets}
            visiblePallets={visiblePallets}
            enrichedPallets={enrichedPallets}
            eskuDist={eskuDist}
            eskuItems={eskuItems}
            palletStates={palletStates}
            ranking={ranking}
            viewMode={viewMode}
            onChangeViewMode={switchViewMode}
            problemOnly={problemOnly}
            onTogglProblemOnly={() => setProblemOnly((v) => !v)}
            hiddenByFilter={hiddenByFilter}
            onJumpToPallet={handleJumpToPallet}
            eskuOverrides={eskuOverrides}
            onMoveEsku={moveEskuToPallet}
            mountDelay={hasPreflightFlags ? 260 : 180}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
          />
        </main>
      </div>

      <StickyBar
        validated={validView.ok}
        stats={view.stats}
        overloadCount={distribution.overloadCount}
        noValidCount={distribution.noValidCount}
        onStartFocus={onStartFocus}
        blockedReason={
          blockingWarnings.length > 0
            ? `${blockingWarnings.length} ungeklärte Parser-Warnungen zuerst akzeptieren`
            : null
        }
      />
    </Page>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   PARSE WARNINGS PANEL — surfaces parser-detected ambiguities per item.

   Severity stripe on the left:
     low      — quiet T.text.faint stripe; informational, auto-OK
     medium   — yellow T.status.warn.main; review recommended
     high     — red T.status.danger.main; blocks Focus until ack'd

   Each row carries: pallet/item position, item title, FNSKU/units,
   then a wrapped list of reasons. "Akzeptieren" mutes that row; "Alle
   akzeptieren" mutes everything in one go. Ack'd rows stay visible
   but with reduced opacity + ✓ chip so the worker still sees them.
   ════════════════════════════════════════════════════════════════════════ */
function ParseWarningsPanel({
  warnings, acked, onAckOne, onAckAll,
}: {
  warnings: Array<{
    key: string;
    palletId: string;
    itemIdx: number;
    item: any;
    warnings: any[];
    maxSeverity: 'low' | 'medium' | 'high';
  }>;
  acked: Set<string>;
  onAckOne: (key: string) => void;
  onAckAll: () => void;
}) {
  const counts = useMemo(() => {
    let low = 0, medium = 0, high = 0, unacked = 0;
    for (const w of warnings) {
      const sev = w.maxSeverity;
      if (sev === 'low') low += 1;
      else if (sev === 'medium') medium += 1;
      else high += 1;
      if (!acked.has(w.key)) unacked += 1;
    }
    return { low, medium, high, unacked };
  }, [warnings, acked]);

  const allAcked = counts.unacked === 0;
  const headerColor =
    counts.high > 0 && !allAcked ? T.status.danger.main
    : counts.medium > 0 && !allAcked ? T.status.warn.main
    : T.text.subtle;

  return (
    <div style={{
      background: T.bg.surface,
      border: `1px solid ${T.border.primary}`,
      borderRadius: 14,
      overflow: 'hidden',
    }}>
      {/* Header — count summary + bulk-ack */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 18px',
        borderBottom: `1px solid ${T.border.subtle}`,
        background: T.bg.surface2,
      }}>
        <span aria-hidden style={{
          width: 8, height: 8, borderRadius: '50%',
          background: headerColor,
          boxShadow: `0 0 0 3px ${headerColor}22`,
        }} />
        <span style={{
          fontFamily: T.font.mono,
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: T.text.faint,
        }}>
          Parser-Warnungen
        </span>
        <span style={{
          fontFamily: T.font.mono,
          fontSize: 11.5,
          fontWeight: 600,
          color: T.text.primary,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {warnings.length}
          {counts.unacked > 0 && (
            <span style={{ color: T.text.subtle, fontWeight: 500 }}>
              {' '}· {counts.unacked} offen
            </span>
          )}
        </span>
        {counts.high > 0 && !allAcked && (
          <span style={{
            padding: '2px 8px',
            background: T.status.danger.bg,
            color: T.status.danger.text,
            border: `1px solid ${T.status.danger.border}`,
            borderRadius: 999,
            fontFamily: T.font.mono,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.10em',
            textTransform: 'uppercase',
          }}>
            Focus blockiert · {counts.high} kritisch
          </span>
        )}
        <span style={{ flex: 1 }} />
        {!allAcked && (
          <Button variant="ghost" size="sm" onClick={onAckAll}
                  title="Alle Warnungen als gesichtet markieren">
            Alle akzeptieren
          </Button>
        )}
      </div>

      {/* List of warning rows */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {warnings.map((w, idx) => (
          <ParseWarningRow
            key={w.key}
            row={w}
            isAcked={acked.has(w.key)}
            isLast={idx === warnings.length - 1}
            onAck={() => onAckOne(w.key)}
          />
        ))}
      </div>
    </div>
  );
}

function ParseWarningRow({
  row, isAcked, isLast, onAck,
}: {
  row: { key: string; palletId: string; itemIdx: number; item: any; warnings: any[]; maxSeverity: 'low' | 'medium' | 'high' };
  isAcked: boolean;
  isLast: boolean;
  onAck: () => void;
}) {
  const stripeColor =
    row.maxSeverity === 'high' ? T.status.danger.main
    : row.maxSeverity === 'medium' ? T.status.warn.main
    : T.border.strong;
  const item = row.item || {};
  const title = (item.title || '').replace(/\s+/g, ' ').slice(0, 80);

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '4px 1fr auto',
      gap: 0,
      borderBottom: isLast ? 'none' : `1px solid ${T.border.subtle}`,
      opacity: isAcked ? 0.5 : 1,
      transition: 'opacity 240ms ease',
    }}>
      {/* Severity stripe */}
      <span aria-hidden style={{ background: stripeColor }} />

      {/* Content */}
      <div style={{
        padding: '12px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 0,
      }}>
        {/* Position + title */}
        <div style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          minWidth: 0,
        }}>
          <span style={{
            fontFamily: T.font.mono,
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: '0.10em',
            textTransform: 'uppercase',
            color: T.text.faint,
            flexShrink: 0,
          }}>
            {row.palletId} · #{row.itemIdx + 1}
          </span>
          <span style={{
            fontFamily: T.font.ui,
            fontSize: 13,
            fontWeight: 500,
            color: T.text.primary,
            letterSpacing: '-0.005em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}>
            {title || '—'}
          </span>
        </div>

        {/* Field values */}
        <div style={{
          display: 'flex',
          gap: 14,
          fontFamily: T.font.mono,
          fontSize: 11,
          color: T.text.subtle,
          fontVariantNumeric: 'tabular-nums',
          flexWrap: 'wrap',
        }}>
          <span>
            <span style={{ color: T.text.faint, marginRight: 4 }}>FNSKU</span>
            <span style={{ color: T.text.primary, fontWeight: 600 }}>
              {item.fnsku || '—'}
            </span>
          </span>
          <span>
            <span style={{ color: T.text.faint, marginRight: 4 }}>Menge</span>
            <span style={{ color: T.text.primary, fontWeight: 600 }}>
              {item.units ?? '—'}
            </span>
          </span>
          {item.ean && (
            <span>
              <span style={{ color: T.text.faint, marginRight: 4 }}>EAN</span>
              <span style={{ color: T.text.primary, fontWeight: 600 }}>
                {item.ean}
              </span>
            </span>
          )}
          {item.useItem && (
            <span>
              <span style={{ color: T.text.faint, marginRight: 4 }}>use_item</span>
              <span style={{ color: T.text.primary, fontWeight: 600, maxWidth: 220, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
                {item.useItem}
              </span>
            </span>
          )}
        </div>

        {/* Warning reasons */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 2 }}>
          {row.warnings.map((w: any, j: number) => {
            const sevColor =
              w.severity === 'high' ? T.status.danger.text
              : w.severity === 'medium' ? T.status.warn.text
              : T.text.subtle;
            const sevGlyph =
              w.severity === 'high' ? '✗'
              : w.severity === 'medium' ? '!'
              : '·';
            return (
              <div key={j} style={{
                fontFamily: T.font.ui,
                fontSize: 12,
                color: sevColor,
                display: 'flex',
                gap: 8,
                alignItems: 'baseline',
              }}>
                <span aria-hidden style={{
                  fontFamily: T.font.mono,
                  fontWeight: 800,
                  flexShrink: 0,
                  width: 12,
                }}>
                  {sevGlyph}
                </span>
                <span style={{ flex: 1 }}>
                  <span style={{ fontWeight: 600 }}>{w.field}</span>
                  {': '}{w.reason}
                  {w.original && (
                    <span style={{ marginLeft: 6, color: T.text.faint, fontFamily: T.font.mono, fontSize: 11 }}>
                      ({w.original}
                      {w.corrected && (
                        <>
                          {' → '}
                          <span style={{ color: T.text.primary, fontWeight: 600 }}>{w.corrected}</span>
                        </>
                      )}
                      )
                    </span>
                  )}
                  {w.candidates?.length > 0 && (
                    <span style={{
                      marginLeft: 6,
                      color: T.text.faint,
                      fontFamily: T.font.mono,
                      fontSize: 11,
                    }}>
                      [{w.candidates.join(', ')}]
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Ack button (right gutter) */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: '0 14px',
      }}>
        {isAcked ? (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            background: T.status.success.bg,
            color: T.status.success.text,
            border: `1px solid ${T.status.success.border}`,
            borderRadius: 999,
            fontFamily: T.font.mono,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.10em',
            textTransform: 'uppercase',
          }}>
            ✓ akzeptiert
          </span>
        ) : (
          <Button variant="ghost" size="sm" onClick={onAck}
                  title="Diese Warnung als gesichtet markieren">
            Akzeptieren
          </Button>
        )}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════ */
function PruefenStyles() {
  return (
    <style>{`
      .mp-prf-canvas {
        background-color: ${T.bg.page};
        background-image: radial-gradient(${T.border.primary} 1px, transparent 1px);
        background-size: 24px 24px;
        background-position: -1px -1px;
      }
      @keyframes mp-prf-rise {
        0%   { opacity: 0; transform: translateY(8px); }
        100% { opacity: 1; transform: translateY(0); }
      }
      @keyframes mp-prf-hero {
        0%   { opacity: 0; transform: scale(0.97); }
        100% { opacity: 1; transform: scale(1); }
      }
      @keyframes mp-prf-fp-pulse {
        0%, 100% { box-shadow: 0 0 0 0 transparent; }
        50%      { box-shadow: 0 0 0 3px var(--accent, #FF5B1F)55; }
      }
    `}</style>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   HERO FBA — primary anchor. Mega FBA mono + meta line + auto-insights
   + fingerprint row. Single elevated card on the page.
   ════════════════════════════════════════════════════════════════════════ */
function HeroFBA({ view, stats, validView, insights, palletStates, onJumpToPallet }) {
  return (
    <div style={{
      position: 'relative',
      padding: '28px 32px',
      background: T.bg.surface,
      border: `1px solid ${T.border.primary}`,
      borderRadius: 18,
      boxShadow: 'none',
      overflow: 'hidden',
      animation: 'mp-prf-hero 540ms cubic-bezier(0.16, 1, 0.3, 1) backwards',
    }}>
      {/* Soft accent radial halo top-right */}
      <div aria-hidden style={{
        position: 'absolute',
        top: -100,
        right: -100,
        width: 260,
        height: 260,
        background: `radial-gradient(circle, ${T.accent.main}0E 0%, transparent 65%)`,
        pointerEvents: 'none',
      }} />

      <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: 18 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* FBA — compact but still hero */}
          <div style={{
            fontFamily: T.font.mono,
            fontSize: 'clamp(28px, 3.8vw, 44px)',
            fontWeight: 500,
            color: T.text.primary,
            letterSpacing: '-0.03em',
            lineHeight: 1,
            wordBreak: 'break-all',
          }}>
            {view.fba}
          </div>

          {/* Meta line + insights merged into one tight stack */}
          <div style={{
            marginTop: 10,
            fontSize: 12.5,
            color: T.text.subtle,
            display: 'flex',
            gap: 10,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}>
            <span style={{ fontFamily: T.font.mono }}>{view.destination}</span>
            <Dot />
            <span>{view.format}-Format</span>
            {view.createdDate && (
              <>
                <Dot />
                <span style={{ fontFamily: T.font.mono }}>
                  {view.createdDate}{view.createdTime ? ' ' + view.createdTime : ''}
                </span>
              </>
            )}
          </div>

          {insights.length > 0 && (
            <div style={{
              marginTop: 6,
              display: 'flex',
              gap: 12,
              flexWrap: 'wrap',
              fontSize: 11,
              color: T.text.faint,
              fontFamily: T.font.mono,
            }}>
              {insights.map((ins, i) => (
                <span key={ins.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ color: T.text.subtle, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                    {ins.label}
                  </span>
                  <span style={{ color: T.text.secondary, fontWeight: 500 }}>
                    {ins.value}
                  </span>
                  {i < insights.length - 1 && <span style={{ color: T.border.strong }}>·</span>}
                </span>
              ))}
            </div>
          )}
        </div>

        <ReadyPill validView={validView} stats={stats} />
      </div>

      {/* Fingerprint row */}
      <FingerprintRow
        pallets={view.pallets}
        palletStates={palletStates}
        onClick={onJumpToPallet}
      />

      {/* Übersicht monoline — primary stats inside the hero card,
          separated by a hairline. Shares space with FBA and fingerprint
          so the operator sees identity + facts in one elevated block. */}
      <div style={{
        marginTop: 18,
        paddingTop: 16,
        borderTop: `1px solid ${T.border.primary}`,
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        flexWrap: 'wrap',
      }}>
        <Metric value={stats.palletCount} label="Paletten" />
        <MetricSep />
        <Metric value={stats.articles} label="Artikel" />
        <MetricSep />
        <Metric value={stats.cartons.toLocaleString('de-DE')} label="Kartons" />
        <MetricSep />
        <Metric value={stats.weightKg.toLocaleString('de-DE')} label="kg" />
        <MetricSep />
        <FillMetric pct={stats.fillPct} />
      </div>
    </div>
  );
}

function Dot() {
  return <span style={{
    width: 3, height: 3,
    borderRadius: '50%',
    background: T.text.faint,
    flexShrink: 0,
  }} />;
}

function ReadyPill({ validView, stats }) {
  const tone = validView.errors > 0 ? 'danger'
    : validView.warnings > 0 ? 'warn'
    : 'success';
  const palette = T.status[tone];
  const label = validView.errors > 0 ? `${validView.errors} Fehler`
    : validView.warnings > 0 ? `${validView.warnings} Warnung${validView.warnings === 1 ? '' : 'en'}`
    : 'Bereit';
  const okPulse = tone === 'success';

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: 8,
      flexShrink: 0,
    }}>
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        padding: '6px 12px',
        borderRadius: 999,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        fontSize: 12,
        fontWeight: 500,
        color: palette.text,
        position: 'relative',
      }}>
        <span style={{
          width: 6, height: 6,
          borderRadius: '50%',
          background: palette.main,
          boxShadow: okPulse ? `0 0 0 3px ${palette.main}22` : 'none',
        }} />
        {label}
      </span>
      <span style={{
        fontSize: 11,
        fontFamily: T.font.mono,
        color: T.text.faint,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '0.02em',
      }}>
        ~ {formatDur(stats.durationSec)}
      </span>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   FINGERPRINT — 12 mini-squares, color = dominant level, top-right
   flag-dot if pallet has issues. Click → jump to pallet.
   ════════════════════════════════════════════════════════════════════════ */
function FingerprintRow({ pallets, palletStates, onClick }) {
  if (!pallets || pallets.length === 0) return null;
  return (
    <div style={{
      marginTop: 18,
      paddingTop: 16,
      borderTop: `1px solid ${T.border.primary}`,
      position: 'relative',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 10,
      }}>
        <span style={{
          fontSize: 10,
          fontWeight: 600,
          color: T.text.faint,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          fontFamily: T.font.mono,
        }}>
          Fingerprint
        </span>
        <span style={{
          fontSize: 11,
          color: T.text.faint,
          fontFamily: T.font.mono,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {pallets.length} {pallets.length === 1 ? 'Palette' : 'Paletten'}
        </span>
      </div>
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 4,
      }}>
        {pallets.map((p) => (
          <FingerprintCell
            key={p.id}
            pallet={p}
            state={palletStates?.[p.id]}
            onClick={() => onClick(p.id)}
          />
        ))}
      </div>
    </div>
  );
}

function FingerprintCell({ pallet, state, onClick }) {
  const [hover, setHover] = useState(false);

  /* `pallet.level` is already pre-computed by pruefenView()
     (= primaryLevel(items) inside the view-builder), so we can use
     it directly. Earlier code tried to re-derive it from pallet.items
     which the view doesn't expose — leaving cells grey. */
  const lvl = pallet.level;
  const meta = lvl != null ? LEVEL_META[lvl] : null;
  const baseColor = meta?.color || T.bg.surface3;
  const hasFlag = state && Array.isArray(state.flags) && state.flags.length > 0;

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${pallet.id} · ${meta?.name || 'Unbekannt'}${hasFlag ? ' · ' + state.flags.length + ' Hinweis(e)' : ''}`}
      style={{
        position: 'relative',
        width: 24,
        height: 24,
        background: baseColor,
        border: `1px solid ${hover ? T.text.primary : 'transparent'}`,
        borderRadius: 4,
        cursor: 'pointer',
        padding: 0,
        flexShrink: 0,
        transition: 'all 160ms cubic-bezier(0.16, 1, 0.3, 1)',
        transform: hover ? 'scale(1.12)' : 'scale(1)',
        opacity: hasFlag ? 1 : 0.85,
      }}
    >
      {hasFlag && (
        <span style={{
          position: 'absolute',
          top: 2,
          right: 2,
          width: 5, height: 5,
          borderRadius: '50%',
          background: T.status.warn.main,
          border: `1.5px solid ${T.bg.surface}`,
        }} />
      )}
    </button>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   ÜBERSICHT METRICS — atoms used inside the HeroFBA card. Visually
   share space with FBA + Fingerprint to consolidate "this Auftrag's
   identity + facts" into one elevated block.
   ════════════════════════════════════════════════════════════════════════ */

function Metric({ value, label }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'baseline',
      gap: 6,
      padding: '0 4px',
    }}>
      <span style={{
        fontSize: 16,
        fontWeight: 600,
        color: T.text.primary,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '-0.012em',
      }}>
        {value}
      </span>
      <span style={{
        fontSize: 11,
        color: T.text.faint,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        fontFamily: T.font.mono,
      }}>
        {label}
      </span>
    </span>
  );
}

function MetricSep() {
  return (
    <span style={{
      width: 1,
      height: 18,
      background: T.border.primary,
      margin: '0 14px',
    }} />
  );
}

function FillMetric({ pct }) {
  const pctValue = Math.round(pct * 100);
  const color = pct > 1 ? T.status.danger.main
    : pct >= 0.92 ? T.status.warn.main
    : T.accent.main;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      padding: '0 4px',
    }}>
      <span style={{
        fontSize: 16,
        fontWeight: 600,
        color: T.text.primary,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '-0.012em',
      }}>
        {pctValue}%
      </span>
      <span style={{
        position: 'relative',
        width: 60,
        height: 3,
        background: T.bg.surface3,
        borderRadius: 999,
        overflow: 'hidden',
      }}>
        <span style={{
          position: 'absolute',
          left: 0, top: 0, bottom: 0,
          width: `${Math.min(100, pctValue)}%`,
          background: color,
          borderRadius: 999,
          transition: 'width 600ms cubic-bezier(0.16, 1, 0.3, 1)',
        }} />
      </span>
      <span style={{
        fontSize: 11,
        color: T.text.faint,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        fontFamily: T.font.mono,
      }}>
        Auslastung
      </span>
    </span>
  );
}

interface LevelDist { level: number; units: number; pct: number; meta: { name: string; shortName?: string; color: string }; [k: string]: unknown }

function LevelsDisclosure({ pallets, open, onToggle }: { pallets: unknown[]; open: boolean; onToggle: () => void }) {
  const distribution: LevelDist[] = useMemo(() => levelDistribution(pallets), [pallets]);
  const grand = distribution.reduce((s: number, d) => s + d.units, 0);
  if (grand === 0) return null;
  const filled = distribution.filter((d) => d.units > 0).length;

  return (
    <div style={{ marginTop: 8 }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 10px 4px 4px',
          background: 'transparent',
          border: 0,
          cursor: 'pointer',
          fontSize: 11.5,
          color: T.text.subtle,
          fontFamily: T.font.mono,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          fontWeight: 500,
          borderRadius: 4,
          transition: 'color 160ms',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = T.text.primary; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = T.text.subtle; }}
      >
        <span style={{
          display: 'inline-flex',
          width: 16, height: 16,
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'transform 200ms',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        }}>
          <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
            <path d="M2 1l4 3.5-4 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        Levels-Verteilung · {filled} von 6 belegt
      </button>

      {open && (
        <div style={{
          marginTop: 12,
          padding: '18px 20px',
          background: T.bg.surface,
          border: `1px solid ${T.border.primary}`,
          borderRadius: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          animation: 'mp-prf-rise 320ms cubic-bezier(0.16,1,0.3,1)',
        }}>
          <div style={{
            display: 'flex',
            height: 12,
            background: T.bg.surface3,
            borderRadius: 999,
            overflow: 'hidden',
          }}>
            {distribution.map((s, i) => (
              <div
                key={s.level}
                title={`L${s.level} ${s.meta.name}: ${s.units.toLocaleString('de-DE')} (${Math.round(s.pct * 100)}%)`}
                style={{
                  width: `${s.pct * 100}%`,
                  background: s.meta.color,
                  borderRight: i < distribution.length - 1 ? `2px solid ${T.bg.surface}` : 'none',
                }}
              />
            ))}
          </div>
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 14,
          }}>
            {distribution.map((s) => (
              <span
                key={s.level}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                }}
              >
                <span style={{
                  width: 16, height: 16,
                  background: s.meta.color,
                  borderRadius: 3,
                  color: '#fff',
                  fontSize: 9,
                  fontWeight: 700,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: T.font.mono,
                  opacity: s.units > 0 ? 1 : 0.3,
                }}>
                  {s.level}
                </span>
                <span style={{ color: T.text.primary, fontWeight: 500 }}>{s.meta.name}</span>
                <span style={{
                  color: T.text.faint,
                  fontVariantNumeric: 'tabular-nums',
                  fontFamily: T.font.mono,
                }}>
                  {Math.round(s.pct * 100)}%
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   PALLETS SECTION — primary content. Section header + body.
   Header gets a ref so an IntersectionObserver upstream knows when
   to render the sticky toolbar.
   ════════════════════════════════════════════════════════════════════════ */
function PalletsSection({
  headerRef,
  pallets, visiblePallets, enrichedPallets, eskuDist, eskuItems,
  palletStates, ranking, viewMode, onChangeViewMode,
  problemOnly, onTogglProblemOnly, hiddenByFilter, onJumpToPallet,
  eskuOverrides, onMoveEsku,
  mountDelay = 0,
  searchQuery = '', onSearchChange = () => {},
}: any) {
  const total = pallets.length;
  const hasSearch = searchQuery.trim().length > 0;
  const subtitle = useMemo(() => {
    if (hasSearch) {
      return visiblePallets.length === 0
        ? `Keine Treffer für "${searchQuery}"`
        : `${visiblePallets.length} Treffer für "${searchQuery}"`;
    }
    if (problemOnly) {
      return hiddenByFilter > 0
        ? `${visiblePallets.length} mit Hinweisen · ${hiddenByFilter} ausgeblendet`
        : 'Keine problematischen Paletten';
    }
    if (eskuItems.length > 0) {
      return viewMode === 'overview'
        ? `Übersicht · ${eskuItems.length} ESKU-Kartons verteilt`
        : `Story · ${eskuItems.length} ESKU-Kartons verteilt`;
    }
    return viewMode === 'overview'
      ? 'Übersicht — Mini-Karten für schnellen Vergleich'
      : 'Story — Headline, Auslastung und Top-Artikel pro Palette';
  }, [viewMode, eskuItems.length, problemOnly, visiblePallets.length, hiddenByFilter, hasSearch, searchQuery]);

  return (
    <section style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      animation: `mp-prf-rise 480ms cubic-bezier(0.16,1,0.3,1) ${mountDelay}ms backwards`,
    }}>
      {/* Section header */}
      <div ref={headerRef} style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{
              fontSize: 22,
              fontWeight: 500,
              color: T.text.primary,
              letterSpacing: '-0.02em',
            }}>
              Paletten
            </span>
            <span style={{
              fontSize: 14,
              color: T.text.faint,
              fontVariantNumeric: 'tabular-nums',
              fontFamily: T.font.mono,
            }}>
              {total}
            </span>
          </div>
          <div style={{
            marginTop: 4,
            fontSize: 12.5,
            color: T.text.subtle,
          }}>
            {subtitle}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <SearchInput value={searchQuery} onChange={onSearchChange} placeholder="FNSKU · EAN · Titel · P-ID" />
        <FilterChip active={problemOnly} onClick={onTogglProblemOnly} />
        <ViewModeToggle value={viewMode} onChange={onChangeViewMode} />
      </div>

      {/* Body */}
      <PalletsBody
        visiblePallets={visiblePallets}
        enrichedPallets={enrichedPallets}
        eskuDist={eskuDist}
        eskuItems={eskuItems}
        palletStates={palletStates}
        ranking={ranking}
        viewMode={viewMode}
        problemOnly={problemOnly}
        hiddenByFilter={hiddenByFilter}
        onJumpToPallet={onJumpToPallet}
        eskuOverrides={eskuOverrides}
        onMoveEsku={onMoveEsku}
      />
    </section>
  );
}

function PalletsBody({
  visiblePallets, enrichedPallets, eskuDist, eskuItems,
  palletStates, ranking, viewMode, problemOnly, hiddenByFilter,
  onJumpToPallet,
  eskuOverrides, onMoveEsku,
}) {
  if (visiblePallets.length === 0 && problemOnly) {
    return (
      <div style={{
        padding: '24px 20px',
        textAlign: 'center',
        fontSize: 13,
        color: T.status.success.text,
        background: T.status.success.bg,
        border: `1px solid ${T.status.success.border}`,
        borderRadius: 14,
      }}>
        ✓ Keine problematischen Paletten · {hiddenByFilter} ausgeblendet
      </div>
    );
  }

  if (viewMode === 'overview') {
    return (
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 10,
      }}>
        {visiblePallets.map((p) => {
          const raw = enrichedPallets.find((r) => r.id === p.id);
          const eskuAssigned = sortItemsForPallet(eskuDist[p.id] || []);
          const palletState = palletStates[p.id];
          const story = buildPalletStory({
            pallet: p,
            items: raw?.items || [],
            eskuAssigned,
            palletState,
            ranking,
          });
          return (
            <PalletMiniCard
              key={p.id}
              pallet={p}
              palletState={palletState}
              story={story}
              onClick={() => onJumpToPallet(p.id)}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {visiblePallets.map((p, i) => {
        const raw = enrichedPallets.find((r) => r.id === p.id);
        const eskuAssigned = sortItemsForPallet(eskuDist[p.id] || []);
        const palletState = palletStates[p.id];
        const story = buildPalletStory({
          pallet: p,
          items: raw?.items || [],
          eskuAssigned,
          palletState,
          ranking,
        });
        return (
          <PalletStoryCard
            key={p.id}
            pallet={p}
            items={raw?.items || []}
            eskuAssigned={eskuAssigned}
            palletState={palletState}
            story={story}
            allPallets={enrichedPallets}
            palletStates={palletStates}
            eskuDist={eskuDist}
            eskuOverrides={eskuOverrides}
            onMoveEsku={onMoveEsku}
          />
        );
      })}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   STICKY PALLETS TOOLBAR — appears when section header scrolls past.
   ════════════════════════════════════════════════════════════════════════ */
function StickyPalletsToolbar({
  visible, count, visibleCount,
  problemOnly, onToggleProblem,
  viewMode, onChangeViewMode,
  searchQuery = '', onSearchChange = (_v: string) => {},
}: any) {
  return (
    <div style={{
      position: 'fixed',
      top: visible ? 0 : -56,
      left: 'var(--sidebar-width)',
      right: 0,
      zIndex: 30,
      padding: '10px 32px',
      background: 'var(--bg-glass-strong)',
      backdropFilter: 'blur(14px)',
      WebkitBackdropFilter: 'blur(14px)',
      borderBottom: `1px solid ${T.border.primary}`,
      transition: 'top 280ms cubic-bezier(0.16, 1, 0.3, 1)',
      pointerEvents: visible ? 'auto' : 'none',
    }}>
      <div style={{
        maxWidth: 1080,
        margin: '0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}>
        <span style={{
          fontSize: 12.5,
          fontWeight: 500,
          color: T.text.primary,
          letterSpacing: '-0.005em',
        }}>
          Paletten
        </span>
        <span style={{
          fontSize: 11.5,
          color: T.text.faint,
          fontFamily: T.font.mono,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {visibleCount === count ? count : `${visibleCount} / ${count}`}
        </span>
        <span style={{ flex: 1 }} />
        <SearchInput value={searchQuery} onChange={onSearchChange} placeholder="Suchen…" compact />
        <FilterChip active={problemOnly} onClick={onToggleProblem} />
        <ViewModeToggle value={viewMode} onChange={onChangeViewMode} />
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   SEARCH INPUT — quick filter for pallets / items in Pruefen.

   Matches across FNSKU, EAN, SKU, ASIN, useItem, title and pallet ID
   (case-insensitive substring). When the worker scans a barcode the
   pallet containing that code surfaces immediately.

   • Slash key (/) at the page level focuses the first visible input
     (handled in PruefenScreen useEffect — relies on
     data-pruefen-search attribute).
   • Esc clears the query and blurs.
   • Compact variant shrinks for the sticky toolbar's tighter row.
   ════════════════════════════════════════════════════════════════════════ */
function SearchInput({
  value, onChange, placeholder = 'Suchen…', compact = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  compact?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const hasValue = value.length > 0;
  const ref = useRef<HTMLInputElement>(null);
  const height = compact ? 28 : 32;
  const width = compact ? 200 : 240;
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      height,
      width,
      padding: '0 10px',
      background: T.bg.surface,
      border: `1px solid ${focused ? T.accent.main : T.border.primary}`,
      borderRadius: 999,
      transition: 'border-color 140ms ease, background 140ms ease',
      flexShrink: 0,
    }}>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden
           style={{ color: focused || hasValue ? T.text.subtle : T.text.faint, flexShrink: 0 }}>
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input
        ref={ref}
        data-pruefen-search="true"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            if (hasValue) onChange('');
            else (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          fontSize: compact ? 12 : 13,
          color: T.text.primary,
          fontFamily: T.font.mono,
          letterSpacing: '0.02em',
        }}
      />
      {hasValue ? (
        <button
          type="button"
          onClick={() => { onChange(''); ref.current?.focus(); }}
          title="Suche leeren (Esc)"
          aria-label="Suche leeren"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18, height: 18,
            background: 'transparent',
            border: 'none',
            color: T.text.subtle,
            cursor: 'pointer',
            padding: 0,
            borderRadius: '50%',
            transition: 'color 140ms ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = T.text.primary; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = T.text.subtle; }}
        >
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      ) : !focused && (
        <span aria-hidden style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 16, height: 16,
          padding: '0 5px',
          fontSize: 10,
          fontFamily: T.font.mono,
          fontWeight: 600,
          color: T.text.faint,
          background: T.bg.surface2,
          border: `1px solid ${T.border.subtle}`,
          borderRadius: 3,
          letterSpacing: '0.04em',
        }}>
          /
        </span>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   FILTER CHIP + VIEW TOGGLE
   ════════════════════════════════════════════════════════════════════════ */
function FilterChip({ active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 11px',
        fontSize: 12,
        fontWeight: 500,
        color: active ? T.status.warn.text : T.text.subtle,
        background: active ? T.status.warn.bg : 'transparent',
        border: `1px solid ${active ? T.status.warn.border : T.border.primary}`,
        borderRadius: 999,
        cursor: 'pointer',
        fontFamily: T.font.ui,
        transition: 'all 160ms',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.borderColor = T.text.subtle;
          e.currentTarget.style.color = T.text.secondary;
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.borderColor = T.border.primary;
          e.currentTarget.style.color = T.text.subtle;
        }
      }}
    >
      <span style={{
        width: 5, height: 5,
        borderRadius: '50%',
        background: active ? T.status.warn.main : T.text.faint,
      }} />
      Nur problematische
    </button>
  );
}

function ViewModeToggle({ value, onChange }) {
  const options = [
    { id: 'story',    label: 'Story',     icon: <StoryIcon /> },
    { id: 'overview', label: 'Übersicht', icon: <GridIcon /> },
  ];
  return (
    <div style={{
      display: 'inline-flex',
      gap: 2,
      padding: 2,
      background: T.bg.surface3,
      border: `1px solid ${T.border.primary}`,
      borderRadius: 6,
    }}>
      {options.map((opt) => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            aria-pressed={active}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              fontSize: 12,
              fontWeight: active ? 600 : 500,
              color: active ? T.text.primary : T.text.subtle,
              background: active ? T.bg.surface : 'transparent',
              border: 0,
              borderRadius: 4,
              cursor: 'pointer',
              fontFamily: T.font.ui,
              boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              transition: 'background 150ms, color 150ms',
            }}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function StoryIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="3" width="12" height="3" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2" y="9" width="12" height="3" rx="1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
function GridIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
      <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   STICKY BAR (bottom)
   ════════════════════════════════════════════════════════════════════════ */
function StickyBar({ validated, stats, overloadCount, noValidCount, onStartFocus, blockedReason }) {
  const hasFlags = overloadCount > 0 || noValidCount > 0;
  const isBlocked = !validated || !!blockedReason;

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 50,
      padding: '12px 32px',
      background: 'var(--bg-glass-strong)',
      backdropFilter: 'blur(14px)',
      WebkitBackdropFilter: 'blur(14px)',
      borderTop: `1px solid ${T.border.primary}`,
      display: 'flex',
      marginLeft: 'var(--sidebar-width)',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        maxWidth: 1080,
        margin: '0 auto',
        width: '100%',
      }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: validated ? T.status.success.main : T.status.warn.main,
            boxShadow: `0 0 0 3px ${(validated ? T.status.success.main : T.status.warn.main) + '22'}`,
          }} />
          <span style={{
            fontSize: 12.5,
            color: T.text.primary,
            fontWeight: 500,
            letterSpacing: '-0.005em',
          }}>
            {validated ? 'Bereit' : 'Validierung erforderlich'}
          </span>
          <span style={{
            fontSize: 12,
            color: T.text.faint,
            fontFamily: T.font.mono,
            fontVariantNumeric: 'tabular-nums',
            marginLeft: 4,
          }}>
            {stats.palletCount} Pal · {stats.articles} Art
          </span>
        </span>

        {hasFlags && (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 11.5,
            color: T.status.warn.text,
            fontWeight: 500,
            padding: '3px 9px',
            background: T.status.warn.bg,
            borderRadius: 999,
            border: `1px solid ${T.status.warn.border}`,
          }}>
            <span style={{
              width: 5, height: 5,
              borderRadius: '50%',
              background: T.status.warn.main,
            }} />
            {overloadCount > 0 && `${overloadCount} OVERLOAD`}
            {overloadCount > 0 && noValidCount > 0 && ' · '}
            {noValidCount > 0 && `${noValidCount} NO_VALID`}
          </span>
        )}

        <span style={{ flex: 1 }} />

        <span style={{
          fontSize: 11.5,
          color: T.text.faint,
          fontFamily: T.font.mono,
          fontVariantNumeric: 'tabular-nums',
        }}>
          ~ {formatDur(stats.durationSec)}
        </span>

        <Button
          variant="primary"
          onClick={onStartFocus}
          disabled={isBlocked}
          title={
            !validated ? 'Validierungsfehler beheben'
            : blockedReason ? blockedReason
            : 'Focus-Modus starten (F)'
          }
        >
          Focus-Modus
          <Kbd>F</Kbd>
        </Button>
      </div>
    </div>
  );
}

function Kbd({ children }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 18,
      height: 18,
      padding: '0 5px',
      fontSize: 10,
      fontWeight: 600,
      color: '#fff',
      background: 'var(--bg-glass-on-accent)',
      border: '1px solid var(--bg-glass-on-accent-border)',
      borderRadius: 3,
      fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      marginLeft: 2,
    }}>
      {children}
    </span>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   AUTO-INSIGHTS — derive presentation-quality facts from the pallet list.
   Each insight: { id, label, value }. Returned in order of importance:
     • Schwerste Palette (kg)
     • Vielfalt (most distinct articles on one pallet)
     • Knappste Palette (highest fillPct)
   We cap at 3 to keep the line visually clean.
   ════════════════════════════════════════════════════════════════════════ */
function buildAuftragInsights(pallets, enrichedPallets, palletStates, eskuDist) {
  if (!pallets || pallets.length === 0) return [];
  const out: { id: string; label: string; value: string }[] = [];

  /* Schwerste — by computed weightKg. We use enrichedPallets items
     because they carry real dim/weight data. */
  let heaviest: { id: string; weightKg: number } | null = null;
  let mostVariety: { id: string; distinctArticles: number } | null = null;
  let tightest: { id: string; fill: number } | null = null;

  for (const p of pallets) {
    const raw = enrichedPallets.find((r) => r.id === p.id);
    const items = raw?.items || [];
    const eskuAssigned = eskuDist[p.id] || [];
    const allItems = [...items, ...eskuAssigned];

    const weightKg = allItems.reduce((s, it) => s + (itemTotalWeightKg(it) || 0), 0);
    const distinctArticles = items.length;
    const state = palletStates[p.id];
    const fill = state?.capacityFraction ?? state?.fillPct ?? 0;

    if (weightKg > 0 && (!heaviest || weightKg > heaviest.weightKg)) {
      heaviest = { id: p.id, weightKg };
    }
    if (distinctArticles > 0 && (!mostVariety || distinctArticles > mostVariety.distinctArticles)) {
      mostVariety = { id: p.id, distinctArticles };
    }
    if (fill > 0 && (!tightest || fill > tightest.fill)) {
      tightest = { id: p.id, fill };
    }
  }

  if (heaviest && heaviest.weightKg >= 1) {
    out.push({
      id: 'heaviest',
      label: 'Schwerste',
      value: `${heaviest.id} · ${Math.round(heaviest.weightKg)} kg`,
    });
  }
  if (mostVariety && mostVariety.distinctArticles >= 2) {
    out.push({
      id: 'variety',
      label: 'Vielfalt',
      value: `${mostVariety.id} · ${mostVariety.distinctArticles} Art.`,
    });
  }
  if (tightest && tightest.fill > 0.7) {
    out.push({
      id: 'tightest',
      label: 'Knappste',
      value: `${tightest.id} · ${Math.round(tightest.fill * 100)}%`,
    });
  }

  return out.slice(0, 3);
}

/* ── helpers ─────────────────────────────────────────────────────────── */
function formatDur(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

/* ════════════════════════════════════════════════════════════════════════
   ▓▓▓  BETA  ▓▓▓
   Beta-mode variant — one column of three paper cards (Identity → Hinweise
   if any → Paletten) + one floating Focus pill at the bottom. Mirrors the
   paper-grey + 2px white rim + halo + nested white panels grammar applied
   in FlowHero / BetaIslandBar / BetaInterlude / BetaFinale / BetaAbschluss
   / BetaPalletList / BetaUpload.

   Data flow is identical to ClassicPruefen — same hooks, same enrichment,
   same distribution and override pipeline, same parser-warning ack model.
   Only the surface UI changes; all keyboard, search, filter, ESKU-move,
   and Focus-gate logic is preserved.
   ════════════════════════════════════════════════════════════════════════ */
function BetaPruefen() {
  const { current, goToStep, moveEskuToPallet, cancelCurrent, abortCurrent } = useAppState();
  const [stornoOpen, setStornoOpen] = useState(false);
  const rawPallets = current?.parsed?.pallets || [];
  const eskuItems  = current?.parsed?.einzelneSkuItems || [];
  const eskuOverrides = current?.eskuOverrides || {};

  /* ── enrichment + distribution (same as classic) ─────────────────── */
  const allItems = useMemo(() => [
    ...rawPallets.flatMap((p) => p.items || []),
    ...eskuItems,
  ], [rawPallets, eskuItems]);

  const dimsQ = useQuery({
    queryKey: ['sku-dims', current?.id],
    queryFn: () => enrichItemDims(allItems, lookupSkuDimensions),
    enabled: !!current?.id && allItems.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  const enrichedPallets = useMemo(() => {
    const enriched = dimsQ.data || null;
    let cursor = 0;
    const base = rawPallets.map((p) => ({
      ...p,
      items: (p.items || []).map((origIt) => {
        const fromDims = enriched ? enriched[cursor] : null;
        cursor += 1;
        return fromDims || origIt;
      }),
    }));
    return base.map((p) => ({ ...p, items: sortItemsForPallet(p.items || []) }));
  }, [rawPallets, dimsQ.data]);

  const enrichedEsku = useMemo(() => {
    if (!dimsQ.data) return eskuItems;
    const palletItemsCount = rawPallets.reduce((n, p) => n + (p.items?.length || 0), 0);
    return eskuItems.map((it, i) => dimsQ.data[palletItemsCount + i] || it);
  }, [eskuItems, rawPallets, dimsQ.data]);

  const view = useMemo(
    () => pruefenView({ ...current?.parsed, pallets: enrichedPallets }),
    [current?.parsed, enrichedPallets],
  );
  const distribution = useMemo(() => {
    const auto = distributeEinzelneSku(enrichedPallets, enrichedEsku);
    return applyEskuOverrides(auto, eskuOverrides, enrichedPallets);
  }, [enrichedPallets, enrichedEsku, eskuOverrides]);
  const eskuDist = distribution.byPalletId;
  const palletStates = distribution.palletStates;

  const validation = current?.validation || { ok: true, errorCount: 0, warningCount: 0, issues: [] };
  const validView = {
    ok: validation.ok ?? (validation.errorCount === 0),
    errors: validation.errorCount || 0,
    warnings: validation.warningCount || 0,
  };

  /* ── Parser warnings aggregation (same as classic) ──────────────── */
  const parseWarnings = useMemo(() => {
    const out: Array<{
      key: string; palletId: string; itemIdx: number; item: any;
      warnings: any[]; maxSeverity: 'low' | 'medium' | 'high';
    }> = [];
    const addItems = (items: any[], palletId: string) => {
      items.forEach((it, idx) => {
        const ws = (it?.parseWarnings || []) as any[];
        if (!ws.length) return;
        const sev = ws.reduce((m: 'low' | 'medium' | 'high', w: any) =>
          w.severity === 'high' ? 'high'
          : (w.severity === 'medium' && m !== 'high') ? 'medium'
          : m,
        'low' as 'low' | 'medium' | 'high');
        out.push({
          key: `${palletId}|${idx}`, palletId, itemIdx: idx, item: it,
          warnings: ws, maxSeverity: sev,
        });
      });
    };
    (current?.parsed?.pallets || []).forEach((p: any) => addItems(p.items || [], p.id));
    addItems(current?.parsed?.einzelneSkuItems || [], 'ESKU');
    return out;
  }, [current?.parsed]);

  const ackKey = `marathon.pruefen.parseAcks.${current?.id || 'none'}`;
  const [acked, setAcked] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(ackKey);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  });
  const ackOne = (key: string) => {
    setAcked((prev) => {
      const next = new Set(prev); next.add(key);
      try { localStorage.setItem(ackKey, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };
  const ackAll = () => {
    setAcked((prev) => {
      const next = new Set(prev);
      parseWarnings.forEach((w) => next.add(w.key));
      try { localStorage.setItem(ackKey, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };
  const blockingWarnings = parseWarnings.filter(
    (w) => w.maxSeverity === 'high' && !acked.has(w.key),
  );

  /* ── Preflight briefing (same as classic) ────────────────────────── */
  const briefing = useMemo(
    () => analyzeAuftrag({
      parsed: current?.parsed, validation, distribution, enrichedPallets, enrichedEsku,
    }),
    [current?.parsed, validation, distribution, enrichedPallets, enrichedEsku],
  );

  /* ── Search + filter (no sticky-toolbar logic in beta) ───────────── */
  const [problemOnly, setProblemOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const handleJumpToPallet = (palletId) => {
    setTimeout(() => {
      const el = document.getElementById(`pallet-row-${palletId}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
  };

  const ranking = useMemo(
    () => rankPallets(view?.pallets || [], palletStates),
    [view?.pallets, palletStates],
  );

  const palletSearchIndex = useMemo(() => {
    const idx = new Map<string, string>();
    enrichedPallets.forEach((p: any) => {
      const parts: string[] = [String(p.id || '').toLowerCase()];
      const items = [...(p.items || []), ...(eskuDist?.[p.id] || [])];
      items.forEach((it: any) => {
        if (it.fnsku)   parts.push(String(it.fnsku).toLowerCase());
        if (it.ean)     parts.push(String(it.ean).toLowerCase());
        if (it.sku)     parts.push(String(it.sku).toLowerCase());
        if (it.asin)    parts.push(String(it.asin).toLowerCase());
        if (it.useItem) parts.push(String(it.useItem).toLowerCase());
        if (it.title)   parts.push(String(it.title).toLowerCase());
      });
      idx.set(p.id, parts.join(' '));
    });
    return idx;
  }, [enrichedPallets, eskuDist]);

  const searchQ = searchQuery.trim().toLowerCase();

  const visiblePallets = useMemo(() => {
    let arr = view?.pallets || [];
    if (problemOnly) {
      arr = arr.filter((p) => {
        const st = palletStates[p.id];
        return st && Array.isArray(st.flags) && st.flags.length > 0;
      });
    }
    if (searchQ) {
      arr = arr.filter((p) => (palletSearchIndex.get(p.id) || '').includes(searchQ));
    }
    return arr;
  }, [view?.pallets, palletStates, problemOnly, searchQ, palletSearchIndex]);

  const hiddenByFilter = (view?.pallets?.length || 0) - visiblePallets.length;

  /* ── Focus gate + keyboard (same as classic) ─────────────────────── */
  const focusBlocked = validView.errors > 0 || blockingWarnings.length > 0;
  const onStartFocus = () => { if (!focusBlocked) goToStep('focus'); };
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      const tag = t?.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable;
      if (e.key === '/' && !inField && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const input = document.querySelector<HTMLInputElement>('input[data-pruefen-search]');
        if (input) { e.preventDefault(); input.focus(); input.select(); return; }
      }
      if (e.key !== 'f' && e.key !== 'F') return;
      if (inField) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!focusBlocked) { e.preventDefault(); goToStep('focus'); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [focusBlocked, goToStep]);

  /* ── Hinweise merge: briefing flags + parser warnings ────────────── */
  const hinweise = useMemo(() => {
    const rows: Array<{
      key: string;
      severity: 'high' | 'medium' | 'low';
      position?: string;
      title: string;
      reasons: string[];
      ackable: boolean;
      ackKey?: string;
      target?: { palletId?: string };
    }> = [];

    (briefing?.flags || []).forEach((f: any, i: number) => {
      if (f.severity === 'ok') return;
      const sev: 'high' | 'medium' | 'low' =
        f.severity === 'error' ? 'high'
        : f.severity === 'warn' ? 'medium'
        : 'low';
      rows.push({
        key: `pf|${f.kind}|${f.code || i}|${f.target?.palletId || ''}`,
        severity: sev,
        position: f.target?.palletId,
        title: f.message,
        reasons: f.detail ? [f.detail] : [],
        ackable: false,
        target: f.target,
      });
    });

    parseWarnings.forEach((w) => {
      const reasons = (w.warnings || []).map((wi: any) => wi.reason || wi.msg || wi.message || String(wi.code || 'Unklar'));
      const position = w.palletId === 'ESKU' ? `ESKU · #${w.itemIdx + 1}` : `${w.palletId} · #${w.itemIdx + 1}`;
      const title = w.item?.useItem || w.item?.title || w.item?.fnsku || 'Artikel';
      rows.push({
        key: `pw|${w.key}`,
        severity: w.maxSeverity,
        position,
        title,
        reasons,
        ackable: true,
        ackKey: w.key,
        target: { palletId: w.palletId !== 'ESKU' ? w.palletId : undefined },
      });
    });

    return {
      rows,
      high: rows.filter((r) => r.severity === 'high'),
      medium: rows.filter((r) => r.severity === 'medium'),
      low: rows.filter((r) => r.severity === 'low'),
    };
  }, [briefing, parseWarnings]);

  const hasHinweise = hinweise.rows.length > 0;
  const unackedHigh = hinweise.high.filter((r) => !r.ackable || !acked.has(r.ackKey || '')).length;

  /* ── Severity for identity eyebrow ───────────────────────────────── */
  const severity: 'ok' | 'warn' | 'err' =
    validView.errors > 0 ? 'err'
    : validView.warnings > 0 || blockingWarnings.length > 0 ? 'warn'
    : 'ok';

  if (!view) {
    return (
      <Page>
        <BetaPruefenStyles />
        <main style={{ padding: '120px 32px', textAlign: 'center', color: T.text.subtle, fontFamily: T.font.ui }}>
          <BetaPaperCard>
            <BetaWhitePanel padding="48px 32px">
              <div style={{ fontSize: 14, color: T.text.subtle }}>Kein Auftrag geladen.</div>
            </BetaWhitePanel>
          </BetaPaperCard>
        </main>
      </Page>
    );
  }

  const stats = view.stats;

  return (
    <Page>
      <BetaPruefenStyles />

      <main style={{
        maxWidth: 1080,
        margin: '0 auto',
        padding: '40px 32px 140px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        fontFamily: T.font.ui,
      }}>

        {/* ── EXIT ACTIONS ────────────────────────────────────────── */}
        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 8,
        }}>
          <button
            type="button"
            onClick={cancelCurrent}
            title="Auftrag verlassen, zurück in die Warteschlange"
            style={{
              all: 'unset',
              cursor: 'pointer',
              fontFamily: T.font.ui,
              fontSize: 12,
              fontWeight: 600,
              color: T.text.subtle,
              padding: '6px 14px',
              borderRadius: 999,
              background: '#F4F5F7',
              border: '1px solid transparent',
              letterSpacing: '0.02em',
              transition: 'background 160ms ease, color 160ms ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#FFFFFF';
              e.currentTarget.style.color = T.text.primary;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#F4F5F7';
              e.currentTarget.style.color = T.text.subtle;
            }}
          >
            Verlassen
          </button>
          <button
            type="button"
            onClick={() => setStornoOpen(true)}
            title="Auftrag stornieren — geht mit Begründung in die Historie"
            style={{
              all: 'unset',
              cursor: 'pointer',
              fontFamily: T.font.ui,
              fontSize: 12,
              fontWeight: 600,
              color: T.status.danger.text,
              padding: '6px 14px',
              borderRadius: 999,
              background: T.status.danger.bg,
              border: `1px solid ${T.status.danger.border}`,
              letterSpacing: '0.02em',
              transition: 'background 160ms ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = T.status.danger.border;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = T.status.danger.bg;
            }}
          >
            Stornieren
          </button>
        </div>

        {/* ── IDENTITY + PREFLIGHT — combined paper-island ───────── */}
        <div style={{ animation: 'mp-prf-rise 480ms cubic-bezier(0.16,1,0.3,1) backwards' }}>
          <BetaPaperCard>
            <BetaWhitePanel padding="28px 32px">
              <BetaEyebrow
                color={severity === 'ok' ? T.status.success.text
                      : severity === 'warn' ? T.status.warn.text
                      : T.status.danger.text}
                icon={severity === 'ok' ? <BetaCheckIcon />
                     : severity === 'warn' ? <BetaWarnIcon />
                     : <BetaXIcon />}
              >
                {severity === 'ok'
                  ? 'Alles validiert'
                  : severity === 'err'
                    ? `${validView.errors} Fehler`
                    : `${validView.warnings + unackedHigh} Hinweis${(validView.warnings + unackedHigh) === 1 ? '' : 'e'}`}
              </BetaEyebrow>
              <div style={{ marginTop: 10 }}>
                <BetaBigCopy value={view.fba} rawValue={String(view.fba)} ariaLabel="FBA-Code" />
              </div>
              <div style={{
                marginTop: 4,
                display: 'flex',
                gap: 10,
                flexWrap: 'wrap',
                alignItems: 'center',
                fontFamily: T.font.mono,
                fontSize: 12,
                color: T.text.subtle,
                letterSpacing: '0.02em',
              }}>
                <span>{view.destination}</span>
                {view.createdDate && (
                  <>
                    <BetaMetaDot />
                    <span>{view.createdDate}{view.createdTime ? ' ' + view.createdTime : ''}</span>
                  </>
                )}
              </div>

              <div style={{ marginTop: 22 }}>
                <BetaFingerprintBare
                  pallets={view.pallets}
                  palletStates={palletStates}
                  onClick={handleJumpToPallet}
                />
              </div>

              <div style={{ marginTop: 18 }}>
                <BetaMetricsLine stats={stats} />
              </div>
            </BetaWhitePanel>

            {/* Preflight nested as a second white panel inside the same
                paper-island, so worker sees FBA-Identity and Hinweise as
                one structural block. */}
            {hasHinweise && (
              <BetaHinweiseCard
                naked
                hinweise={hinweise}
                acked={acked}
                onAckOne={ackOne}
                onAckAll={ackAll}
                onJumpToPallet={handleJumpToPallet}
              />
            )}
          </BetaPaperCard>
        </div>

        {/* ── PALETTEN ─────────────────────────────────────────────── */}
        <div style={{ animation: 'mp-prf-rise 480ms cubic-bezier(0.16,1,0.3,1) 140ms backwards' }}>
          <BetaPaperCard>
            <BetaWhitePanel padding="18px 24px">
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                flexWrap: 'wrap',
              }}>
                <BetaEyebrow>Paletten · {view.pallets.length}</BetaEyebrow>
                <span style={{ flex: 1 }} />
                <BetaSearchInput
                  value={searchQuery}
                  onChange={setSearchQuery}
                  placeholder="FNSKU · EAN · Titel · P-ID"
                />
                <BetaFilterChip
                  active={problemOnly}
                  onClick={() => setProblemOnly((v) => !v)}
                >
                  Nur Hinweise
                </BetaFilterChip>
              </div>
              {(searchQ || problemOnly) && (
                <div style={{
                  marginTop: 8,
                  fontSize: 11.5,
                  color: T.text.faint,
                  fontFamily: T.font.mono,
                  letterSpacing: '0.04em',
                }}>
                  {searchQ
                    ? (visiblePallets.length === 0
                        ? `Keine Treffer für "${searchQuery}"`
                        : `${visiblePallets.length} Treffer für "${searchQuery}"`)
                    : (visiblePallets.length === 0
                        ? 'Keine problematischen Paletten'
                        : `${visiblePallets.length} mit Hinweisen · ${hiddenByFilter} ausgeblendet`)}
                </div>
              )}
            </BetaWhitePanel>

            {visiblePallets.length === 0 ? (
              <BetaWhitePanel padding="32px 24px">
                <div style={{
                  textAlign: 'center',
                  fontSize: 13,
                  color: T.text.subtle,
                  fontFamily: T.font.mono,
                  letterSpacing: '0.02em',
                }}>
                  {problemOnly ? '✓ Keine problematischen Paletten' : `Keine Treffer für "${searchQuery}"`}
                </div>
              </BetaWhitePanel>
            ) : (
              visiblePallets.map((p) => {
                const raw = enrichedPallets.find((r) => r.id === p.id);
                const eskuAssigned = sortItemsForPallet(eskuDist[p.id] || []);
                const palletState = palletStates[p.id];
                return (
                  <BetaWhitePanel key={p.id} padding="18px 22px">
                    <BetaPalletBlock
                      pallet={p}
                      palletNumber={raw?.number}
                      items={raw?.items || []}
                      eskuAssigned={eskuAssigned}
                      palletState={palletState}
                    />
                  </BetaWhitePanel>
                );
              })
            )}
          </BetaPaperCard>
        </div>
      </main>

      <BetaFocusPill
        isBlocked={focusBlocked}
        stats={stats}
        unackedHigh={unackedHigh}
        validErrors={validView.errors}
        onStartFocus={onStartFocus}
      />

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

/* ──────────────────────────────────────────────────────────────────────
   Beta atoms — local, mirror Upload.tsx / Abschluss.tsx pattern.
   ────────────────────────────────────────────────────────────────────── */

function BetaPruefenStyles() {
  return (
    <style>{`
      @keyframes mp-prf-rise {
        0%   { opacity: 0; transform: translateY(8px); }
        100% { opacity: 1; transform: translateY(0); }
      }
      @keyframes mr-spin {
        0%   { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    `}</style>
  );
}

function BetaPaperCard({ children }) {
  return (
    <div style={{
      padding: 8,
      background: '#F4F5F7',
      border: '2px solid #FFFFFF',
      borderRadius: 32,
      boxShadow: '0 0 89.7px 0 rgba(0, 0, 0, 0.05)',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      {children}
    </div>
  );
}

function BetaWhitePanel({ children, padding, id }: { children?: React.ReactNode; padding?: string; id?: string }) {
  return (
    <div id={id} style={{
      background: '#FFFFFF',
      borderRadius: 24,
      padding: padding || '22px 26px',
    }}>
      {children}
    </div>
  );
}

function BetaEyebrow({ children, color, icon }: { children?: React.ReactNode; color?: string; icon?: React.ReactNode }) {
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 10.5,
      fontWeight: 700,
      fontFamily: T.font.mono,
      color: color || T.text.faint,
      textTransform: 'uppercase',
      letterSpacing: '0.18em',
    }}>
      {icon}
      <span>{children}</span>
    </div>
  );
}

function BetaCheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <path d="M2.5 6.5l2 2 5-5.5" stroke="currentColor" strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BetaWarnIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <path d="M6 1.5L11 10H1z" stroke="currentColor" strokeWidth="1.6"
            strokeLinejoin="round" />
      <path d="M6 5v2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="6" cy="9" r="0.55" fill="currentColor" />
    </svg>
  );
}

function BetaXIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none"
         stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M3 3l6 6M9 3l-6 6" />
    </svg>
  );
}

function BetaMetaDot() {
  return (
    <span aria-hidden style={{
      width: 3, height: 3, borderRadius: '50%',
      background: 'rgba(15, 23, 42, 0.22)',
      flexShrink: 0,
    }} />
  );
}

function BetaKbd({ children }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 22, height: 20,
      padding: '0 7px',
      fontSize: 10.5,
      fontFamily: T.font.mono,
      fontWeight: 700,
      color: '#FFFFFF',
      background: 'rgba(255, 255, 255, 0.22)',
      borderRadius: 6,
      lineHeight: 1,
      letterSpacing: '0.04em',
    }}>{children}</span>
  );
}

/* Big mono FBA-code click-to-copy — mirror of Abschluss/Upload variant. */
function BetaBigCopy({ value, rawValue, ariaLabel }: { value: React.ReactNode; rawValue: string; ariaLabel?: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = (e) => {
    e.stopPropagation();
    betaCopyToClipboard(rawValue);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => { onClick(e); e.currentTarget.blur(); }}
      title={copied ? 'Kopiert' : 'Klick zum Kopieren'}
      aria-label={ariaLabel}
      style={{
        all: 'unset',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '8px 12px',
        marginLeft: -12,
        background: copied ? T.status.success.bg : 'transparent',
        borderRadius: 14,
        transition: 'background 220ms ease',
      }}
    >
      <span style={{
        fontFamily: T.font.mono,
        fontSize: 'clamp(28px, 3.6vw, 40px)',
        fontWeight: 600,
        color: copied ? T.status.success.text : T.text.primary,
        letterSpacing: '-0.025em',
        lineHeight: 1.05,
        wordBreak: 'break-all',
        transition: 'color 220ms ease',
      }}>
        {value}
      </span>
      {copied && (
        <span style={{
          fontFamily: T.font.mono,
          fontSize: 10,
          fontWeight: 600,
          color: T.status.success.text,
          letterSpacing: '0.10em',
          textTransform: 'uppercase',
        }}>
          ✓ Kopiert
        </span>
      )}
    </button>
  );
}

function BetaPalletBlock({ pallet, palletNumber, items, eskuAssigned, palletState }) {
  const lvl = pallet.level;
  const meta = lvl != null ? LEVEL_META[lvl] : null;
  const fillPct = Math.round((palletState?.fillPct ?? pallet.fillPct ?? 0) * 100);
  const totalArticles = (items?.length || 0) + (eskuAssigned?.length || 0);
  const totalUnits = [...(items || []), ...(eskuAssigned || [])]
    .reduce((s, it) => s + (it?.units || 0), 0);
  const isSingleSku = pallet.isSingleSku === true;

  return (
    <section
      id={`pallet-row-${pallet.id}`}
      style={{
        scrollMarginTop: 120,
        display: 'grid',
        gridTemplateColumns: '80px 1fr',
        gap: 18,
        alignItems: 'start',
        animation: 'mp-prf-rise 380ms cubic-bezier(0.16,1,0.3,1) backwards',
      }}
    >
      {/* Stack-viz column — vertical pallet visualization with level stripes */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        paddingTop: 4,
      }}>
        <PalletStackViz palletState={palletState} size="mini" radius={14} />
        <span style={{
          fontFamily: T.font.mono,
          fontSize: 10.5,
          fontWeight: 600,
          color: T.text.faint,
          letterSpacing: '0.04em',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {fillPct}%
        </span>
      </div>

      {/* Right column — header + article list */}
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Pallet header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          padding: '4px 4px 10px',
        }}>
          <span style={{
            fontFamily: T.font.mono,
            fontSize: 16,
            fontWeight: 700,
            color: T.text.primary,
            letterSpacing: '-0.01em',
          }}>
            {typeof palletNumber === 'number' ? `P${palletNumber}` : (pallet.id || '')}
          </span>
          {meta && (
            <span style={{
              fontFamily: T.font.mono,
              fontSize: 10.5,
              fontWeight: 600,
              padding: '3px 9px',
              background: meta.bg,
              color: meta.text,
              borderRadius: 999,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}>
              L{lvl} {meta.shortName || meta.name}
            </span>
          )}
          {isSingleSku && (
            <span style={{
              fontFamily: T.font.mono,
              fontSize: 10,
              fontWeight: 700,
              color: T.status.warn.text,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
            }}>
              4-Seiten-Warnung
            </span>
          )}
          <span style={{ flex: 1 }} />
          <span style={{
            fontFamily: T.font.mono,
            fontSize: 11,
            fontWeight: 500,
            color: T.text.faint,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '0.04em',
          }}>
            {totalArticles} Art · {totalUnits} Stk
          </span>
        </div>

        {/* Article list — mirrors Focus item ordering:
            • Large-base ESKU (80×80 → rank 2, 58×64 / 57×63 → rank 1)
              goes BEFORE Mixed so worker lays it as the pallet base.
            • Non-base ESKU (rank 0) gets MERGED with Mixed and re-sorted
              by level via sortItemsForPallet — so an L1 ESKU (e.g. 80×63
              Thermo) lands in the L1 group together with L1 Mixed
              instead of being dumped after L5 Produktion. */}
        {(() => {
          const base80    = (eskuAssigned || []).filter((it) => largeBaseRank(it) === 2);
          const baseOther = (eskuAssigned || []).filter((it) => largeBaseRank(it) === 1);
          const restEsku  = (eskuAssigned || []).filter((it) => largeBaseRank(it) === 0);
          const combined = sortItemsForPallet([...(items || []), ...restEsku]);
          const ordered = [
            ...base80.map((it) => ({ it, isEsku: true })),
            ...baseOther.map((it) => ({ it, isEsku: true })),
            ...combined.map((it) => ({ it, isEsku: it.isEinzelneSku === true })),
          ];
          return (
            <ul style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}>
              {ordered.map(({ it, isEsku }, j) => (
                <BetaArticleRow key={`${isEsku ? 'e' : 'm'}-${j}`} item={it} pos={j + 1} isEsku={isEsku} />
              ))}
            </ul>
          );
        })()}
      </div>
    </section>
  );
}

function BetaArticleRow({ item, pos, isEsku = false }) {
  const lvl = getDisplayLevel(item) || item.level || 1;
  const meta = LEVEL_META[lvl] || LEVEL_META[1];
  const units = item.units;
  const esku = isEsku || item.isEinzelneSku === true;
  const [expanded, setExpanded] = useState(false);

  return (
    <li style={{
      listStyle: 'none',
      background: esku ? T.accent.bg : '#FFFFFF',
      borderRadius: 14,
      overflow: 'hidden',
    }}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        style={{
          display: 'grid',
          gridTemplateColumns: '34px 38px 64px minmax(80px, auto) 1fr minmax(120px, auto) 16px',
          alignItems: 'center',
          gap: 12,
          padding: '11px 14px',
          cursor: 'pointer',
        }}
      >
        {/* Position number */}
        <span style={{
          fontFamily: T.font.mono,
          fontSize: 11,
          fontWeight: 500,
          color: T.text.faint,
          fontVariantNumeric: 'tabular-nums',
          textAlign: 'right',
        }}>
          {String(pos).padStart(2, '0')}
        </span>

        {/* ESKU badge — visible marker for Einzelne-SKU rows */}
        {esku ? (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '2px 6px',
            background: T.accent.main,
            color: '#FFFFFF',
            fontFamily: T.font.mono,
            fontSize: 9.5,
            fontWeight: 800,
            letterSpacing: '0.1em',
            borderRadius: 4,
            justifySelf: 'start',
          }}>
            ESKU
          </span>
        ) : <span />}

        {/* Units */}
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
          padding: '2px 8px',
          background: meta.bg,
          color: meta.text,
          borderRadius: 999,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          justifySelf: 'start',
          whiteSpace: 'nowrap',
        }}>
          L{lvl} {meta.shortName || meta.name}
        </span>

        {/* Title — single line truncate */}
        <span
          title={item.title || ''}
          style={{
            fontSize: 13,
            fontWeight: 400,
            color: T.text.primary,
            letterSpacing: '-0.005em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {formatItemTitle(item.title || '—')}
        </span>

        {/* Code — ESKU shows sku + fnsku stacked; Mixed shows single code line */}
        {isEsku || item.isEinzelneSku ? (
          <span
            title={[item.sku, item.fnsku].filter(Boolean).join(' · ') || ''}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: 2,
              minWidth: 0,
              overflow: 'hidden',
            }}
          >
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
              {item.sku || item.fnsku || '—'}
            </span>
            {item.sku && item.fnsku && item.fnsku !== item.sku && (
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
                {item.fnsku}
              </span>
            )}
          </span>
        ) : (
          <span
            title={item.code || item.useItem || item.fnsku || ''}
            style={{
              fontFamily: T.font.mono,
              fontSize: 12,
              color: T.text.subtle,
              textAlign: 'right',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {item.code || item.useItem || item.fnsku || '—'}
          </span>
        )}

        {/* Expand chevron */}
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: T.text.faint,
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 180ms cubic-bezier(0.16,1,0.3,1)',
          }}
        >
          <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
            <path d="M2 1l4 3.5-4 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </div>

      {expanded && (
        <BetaArticleDetail item={item} level={lvl} meta={meta} isEsku={esku} />
      )}
    </li>
  );
}

function BetaArticleDetail({ item, level, meta, isEsku }) {
  const codes: Array<[string, string | null | undefined]> = [
    ['FNSKU',    item.fnsku],
    ['SKU',      item.sku],
    ['EAN',      item.ean],
    ['ASIN',     item.asin],
    ['Use-Item', item.useItem],
  ];
  const visibleCodes = codes.filter(([, v]) => v);
  const flags = (item.placementMeta?.flags || []) as unknown[];
  const eskuCartons = isEsku
    ? (item.placementMeta?.cartonsHere ?? item.einzelneSku?.cartonsCount ?? null)
    : null;
  const eskuPacksPerCarton = isEsku ? (item.einzelneSku?.packsPerCarton ?? null) : null;
  const lst = (() => {
    const t = item.title || '';
    if (!t) return null;
    if (/\bmit\s+lst\b/i.test(t)) return 'mit LST';
    if (/\bohne\s+lst\b/i.test(t)) return 'ohne LST';
    if (/\bohne\s+(?:sepa[-\s]*)?lastschrift(?:text)?\b/i.test(t)) return 'ohne LST';
    if (/\b(?:sepa[-\s]*)?lastschrift(?:text)?\b/i.test(t)) return 'mit LST';
    if (/\bsepa[-\s]*druck\b/i.test(t)) return 'mit LST';
    return null;
  })();

  return (
    <div style={{
      padding: '12px 18px 14px 18px',
      borderTop: `1px dashed ${T.border.subtle}`,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      animation: 'mp-prf-rise 220ms cubic-bezier(0.16,1,0.3,1)',
    }}>
      <BetaDetailField label="Titel" value={item.title || '—'} multiline />

      {visibleCodes.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '8px 18px',
        }}>
          {visibleCodes.map(([k, v]) => (
            <BetaDetailField key={k} label={k} value={String(v)} mono />
          ))}
        </div>
      )}

      {item.dimStr && (
        <BetaDetailField label="Maße" value={item.dimStr} mono />
      )}

      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '6px 8px',
        alignItems: 'center',
      }}>
        <BetaDetailPill>
          <span style={{ width: 6, height: 6, background: meta.color, borderRadius: 2, marginRight: 5 }} />
          L{level} {meta.name}
        </BetaDetailPill>
        {item.units != null && !isEsku && (
          <BetaDetailPill>× {item.units.toLocaleString('de-DE')} Stück</BetaDetailPill>
        )}
        {isEsku && eskuCartons != null && (
          <BetaDetailPill accent>⬢ ESKU · {eskuCartons} Karton{eskuCartons === 1 ? '' : 's'}</BetaDetailPill>
        )}
        {isEsku && eskuPacksPerCarton != null && (
          <BetaDetailPill>{eskuPacksPerCarton} Einh./Karton</BetaDetailPill>
        )}
        {lst && <BetaDetailPill>{lst}</BetaDetailPill>}
        {flags.map((f, k) => (
          <BetaDetailPill key={k} warn>{String(f)}</BetaDetailPill>
        ))}
      </div>
    </div>
  );
}

function BetaDetailField({ label, value, mono, multiline }: any) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{
        fontFamily: T.font.mono,
        fontSize: 10,
        fontWeight: 600,
        color: T.text.faint,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        marginBottom: 3,
      }}>
        {label}
      </div>
      <div style={{
        fontFamily: mono ? T.font.mono : 'inherit',
        fontSize: 13,
        fontWeight: 500,
        color: T.text.primary,
        wordBreak: mono ? 'break-all' : 'break-word',
        lineHeight: multiline ? 1.45 : 1.3,
        letterSpacing: '-0.005em',
      }}>
        {value}
      </div>
    </div>
  );
}

function BetaDetailPill({ children, accent, warn }: any) {
  const palette = warn
    ? { bg: T.status.warn.bg, color: T.status.warn.text, border: T.status.warn.border }
    : accent
    ? { bg: T.accent.bg, color: T.accent.text, border: T.accent.border }
    : { bg: T.bg.surface, color: T.text.secondary, border: T.border.primary };
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      fontFamily: T.font.mono,
      fontSize: 10.5,
      fontWeight: 600,
      padding: '2px 8px',
      background: palette.bg,
      color: palette.color,
      border: `1px solid ${palette.border}`,
      borderRadius: 999,
      letterSpacing: '0.04em',
    }}>
      {children}
    </span>
  );
}

function shortPalletId(p) {
  if (!p) return '';
  if (typeof p === 'string') {
    const m = p.match(/^([A-Za-z]+\d+)/);
    return m ? m[1] : p;
  }
  if (typeof p.number === 'number') return `P${p.number}`;
  return shortPalletId(p.id || '');
}

function BetaFingerprintBare({ pallets, palletStates, onClick }) {
  if (!pallets || pallets.length === 0) return null;
  return (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      gap: 12,
    }}>
      {pallets.map((p) => (
        <BetaFingerprintCell
          key={p.id}
          pallet={p}
          state={palletStates?.[p.id]}
          onClick={() => onClick(p.id)}
        />
      ))}
    </div>
  );
}

function BetaFingerprintCell({ pallet, state, onClick }) {
  const [hover, setHover] = useState(false);
  const lvl = pallet.level;
  const meta = lvl != null ? LEVEL_META[lvl] : null;
  const baseColor = meta?.color || T.bg.surface3;
  const hasFlag = state && Array.isArray(state.flags) && state.flags.length > 0;
  const rawFill = state?.fillPct ?? pallet.fillPct ?? 0;
  const fillPct = Math.max(0, Math.min(1, rawFill));
  const overFill = rawFill > 1;
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${pallet.id} · ${meta?.name || 'Unbekannt'} · ${Math.round(rawFill * 100)}% Füllung${hasFlag ? ' · ' + state.flags.length + ' Hinweis(e)' : ''}`}
      style={{
        position: 'relative',
        width: 44,
        height: 63,
        background: `${baseColor}1F`,
        border: 0,
        borderRadius: 12,
        cursor: 'pointer',
        padding: 0,
        flexShrink: 0,
        overflow: 'hidden',
        transition: 'transform 180ms cubic-bezier(0.16, 1, 0.3, 1), filter 180ms ease',
        transform: hover ? 'translateY(-2px)' : 'translateY(0)',
        filter: hover ? 'brightness(1.06)' : 'none',
      }}
    >
      {/* Fill from bottom up to fillPct */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: `${fillPct * 100}%`,
          background: overFill ? T.status.danger.main : baseColor,
          transition: 'height 480ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      />
      {hasFlag && (
        <span style={{
          position: 'absolute',
          top: 6, right: 6,
          width: 8, height: 8,
          borderRadius: '50%',
          background: T.status.warn.main,
          border: `2px solid #FFFFFF`,
        }} />
      )}
    </button>
  );
}

function BetaMetricsLine({ stats }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: 0,
    }}>
      <BetaMetric value={stats.palletCount} label="Paletten" />
      <BetaMetricSep />
      <BetaMetric value={stats.articles} label="Artikel" />
      <BetaMetricSep />
      <BetaMetric value={stats.weightKg.toLocaleString('de-DE')} label="kg" />
    </div>
  );
}

function BetaMetric({ value, label }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'baseline',
      gap: 6,
      padding: '0 4px',
    }}>
      <span style={{
        fontSize: 16,
        fontWeight: 600,
        color: T.text.primary,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '-0.012em',
      }}>
        {value}
      </span>
      <span style={{
        fontSize: 10.5,
        color: T.text.faint,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        fontFamily: T.font.mono,
        fontWeight: 600,
      }}>
        {label}
      </span>
    </span>
  );
}

function BetaMetricSep() {
  return (
    <span style={{
      width: 1,
      height: 16,
      background: T.border.primary,
      margin: '0 14px',
    }} />
  );
}

function BetaSearchInput({ value, onChange, placeholder }) {
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      padding: '8px 14px',
      background: '#F4F5F7',
      borderRadius: 999,
      minWidth: 240,
    }}>
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none"
           stroke={T.text.faint} strokeWidth="1.6" strokeLinecap="round">
        <circle cx="6" cy="6" r="4" />
        <path d="M9 9l3 3" />
      </svg>
      <input
        data-pruefen-search
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          all: 'unset',
          flex: 1,
          fontFamily: T.font.ui,
          fontSize: 12.5,
          color: T.text.primary,
          minWidth: 0,
        }}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Suche leeren"
          style={{
            all: 'unset',
            cursor: 'pointer',
            color: T.text.faint,
            display: 'inline-flex',
            padding: 2,
          }}
        >
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
               stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      )}
      <span style={{
        fontFamily: T.font.mono,
        fontSize: 10.5,
        fontWeight: 600,
        color: T.text.faint,
        background: '#FFFFFF',
        borderRadius: 4,
        padding: '2px 6px',
        letterSpacing: '0.04em',
      }}>
        /
      </span>
    </div>
  );
}

function BetaFilterChip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: 'unset',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        padding: '8px 14px',
        background: active ? T.accent.bg : '#F4F5F7',
        borderRadius: 999,
        fontFamily: T.font.ui,
        fontSize: 12.5,
        fontWeight: 600,
        color: active ? T.accent.text : T.text.subtle,
        letterSpacing: '-0.005em',
        transition: 'background 200ms ease, color 200ms ease',
      }}
    >
      <span style={{
        width: 6, height: 6,
        borderRadius: '50%',
        background: active ? 'var(--accent)' : T.text.faint,
      }} />
      {children}
    </button>
  );
}

function BetaHinweiseCard({ hinweise, acked, onAckOne, onAckAll, onJumpToPallet, naked = false }: any) {
  const total = hinweise.rows.length;
  const worstSev: 'high' | 'medium' | 'low' =
    hinweise.high.length > 0 ? 'high'
    : hinweise.medium.length > 0 ? 'medium'
    : 'low';
  const sevColor = worstSev === 'high' ? T.status.danger.text
    : worstSev === 'medium' ? T.status.warn.text
    : T.text.subtle;
  const sevIcon = worstSev === 'high' ? <BetaXIcon />
    : worstSev === 'medium' ? <BetaWarnIcon />
    : null;

  const hasUnackedAckable = hinweise.rows.some((r) => r.ackable && !acked.has(r.ackKey || ''));
  const [open, setOpen] = useState(false);

  const inner = (
    <BetaWhitePanel padding="18px 22px">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          style={{
            all: 'unset',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            width: '100%',
          }}
        >
          <BetaEyebrow color={sevColor} icon={sevIcon}>
            {total} Hinweis{total === 1 ? '' : 'e'}
          </BetaEyebrow>

          {!open && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {hinweise.high.length > 0 && (
                <BetaHinweiseCountChip
                  count={hinweise.high.length}
                  color={T.status.danger.main}
                  bg={T.status.danger.bg}
                />
              )}
              {hinweise.medium.length > 0 && (
                <BetaHinweiseCountChip
                  count={hinweise.medium.length}
                  color={T.status.warn.main}
                  bg={T.status.warn.bg}
                />
              )}
              {hinweise.low.length > 0 && (
                <BetaHinweiseCountChip
                  count={hinweise.low.length}
                  color={T.text.faint}
                  bg={T.bg.surface2}
                />
              )}
            </div>
          )}

          <span style={{ flex: 1 }} />

          <span
            aria-hidden
            style={{
              display: 'inline-flex',
              transition: 'transform 220ms cubic-bezier(0.16,1,0.3,1)',
              transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
              color: T.text.faint,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3.5 5.5L7 9l3.5-3.5" stroke="currentColor"
                    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>

        {open && (
          <>
            {hinweise.high.length > 0 && (
              <BetaHinweiseGroup
                label="Blockierend"
                color={T.status.danger.text}
                rows={hinweise.high}
                acked={acked}
                onAckOne={onAckOne}
                onJumpToPallet={onJumpToPallet}
              />
            )}
            {hinweise.medium.length > 0 && (
              <BetaHinweiseGroup
                label="Warnungen"
                color={T.status.warn.text}
                rows={hinweise.medium}
                acked={acked}
                onAckOne={onAckOne}
                onJumpToPallet={onJumpToPallet}
              />
            )}
            {hinweise.low.length > 0 && (
              <BetaHinweiseGroup
                label="Informationen"
                color={T.text.subtle}
                rows={hinweise.low}
                acked={acked}
                onAckOne={onAckOne}
                onJumpToPallet={onJumpToPallet}
              />
            )}

            {hasUnackedAckable && (
              <div style={{ marginTop: 14, textAlign: 'right' }}>
                <button
                  type="button"
                  onClick={onAckAll}
                  style={betaGhostLinkStyle}
                >
                  Alle akzeptieren
                </button>
              </div>
            )}
          </>
        )}
      </BetaWhitePanel>
  );
  return naked ? inner : <BetaPaperCard>{inner}</BetaPaperCard>;
}

function BetaHinweiseCountChip({ count, color, bg }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: '3px 9px',
      background: bg,
      borderRadius: 999,
      fontFamily: T.font.mono,
      fontSize: 11,
      fontWeight: 700,
      color,
      letterSpacing: '0.02em',
      fontVariantNumeric: 'tabular-nums',
    }}>
      <span style={{
        width: 5, height: 5,
        borderRadius: '50%',
        background: color,
      }} />
      {count}
    </span>
  );
}

function BetaHinweiseGroup({ label, color, rows, acked, onAckOne, onJumpToPallet }) {
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{
        fontFamily: T.font.mono,
        fontSize: 10,
        fontWeight: 700,
        color,
        textTransform: 'uppercase',
        letterSpacing: '0.16em',
        marginBottom: 8,
      }}>
        {label} · {rows.length}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((r) => (
          <BetaHinweiseRow
            key={r.key}
            row={r}
            isAcked={r.ackable ? acked.has(r.ackKey || '') : false}
            onAck={() => r.ackKey && onAckOne(r.ackKey)}
            onJumpToPallet={onJumpToPallet}
          />
        ))}
      </div>
    </div>
  );
}

function BetaHinweiseRow({ row, isAcked, onAck, onJumpToPallet }) {
  const bgColor = row.severity === 'high' ? T.status.danger.bg
    : row.severity === 'medium' ? T.status.warn.bg
    : T.bg.surface2;
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr auto',
      gap: 12,
      padding: '14px 18px',
      background: bgColor,
      borderRadius: 16,
      opacity: isAcked ? 0.55 : 1,
      transition: 'opacity 220ms ease',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <div style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          flexWrap: 'wrap',
        }}>
          {row.position && (
            <button
              type="button"
              onClick={() => row.target?.palletId && onJumpToPallet(row.target.palletId)}
              disabled={!row.target?.palletId}
              style={{
                all: 'unset',
                cursor: row.target?.palletId ? 'pointer' : 'default',
                fontFamily: T.font.mono,
                fontSize: 11.5,
                fontWeight: 700,
                color: T.text.subtle,
                letterSpacing: '0.04em',
                textDecoration: row.target?.palletId ? 'underline dotted' : 'none',
                textUnderlineOffset: 2,
              }}
            >
              {row.position}
            </button>
          )}
          <span style={{
            fontSize: 13,
            fontWeight: 500,
            color: T.text.primary,
            letterSpacing: '-0.005em',
            minWidth: 0,
          }}>
            {row.title}
          </span>
        </div>
        {row.reasons && row.reasons.length > 0 && (
          <div style={{
            fontSize: 11.5,
            color: T.text.subtle,
            lineHeight: 1.45,
            letterSpacing: '-0.005em',
          }}>
            {row.reasons.join(' · ')}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        {row.ackable && (
          isAcked ? (
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 10.5,
              fontWeight: 700,
              fontFamily: T.font.mono,
              color: T.status.success.text,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}>
              <BetaCheckIcon /> Akzeptiert
            </span>
          ) : (
            <button
              type="button"
              onClick={onAck}
              style={{
                all: 'unset',
                cursor: 'pointer',
                fontFamily: T.font.ui,
                fontSize: 11.5,
                fontWeight: 600,
                color: T.text.primary,
                padding: '5px 12px',
                background: '#FFFFFF',
                borderRadius: 999,
                letterSpacing: '-0.005em',
              }}
            >
              Akzeptieren
            </button>
          )
        )}
      </div>
    </div>
  );
}

function BetaFocusPill({ isBlocked, stats, unackedHigh, validErrors, onStartFocus }) {
  const message = validErrors > 0
    ? `${validErrors} Fehler — Validierung nötig`
    : unackedHigh > 0
      ? `${unackedHigh} Hinweis${unackedHigh === 1 ? '' : 'e'} offen`
      : `Bereit · ${stats.palletCount} Pal · ${stats.articles} Art`;
  return (
    <div style={{
      position: 'fixed',
      bottom: 18,
      left: '50%',
      transform: 'translateX(-50%)',
      marginLeft: 'calc(var(--sidebar-width) / 2)',
      zIndex: 50,
      background: '#F8F8F8',
      border: '2px solid #FFFFFF',
      borderRadius: 50,
      boxShadow: '0 0 89.7px 0 rgba(0, 0, 0, 0.05)',
      padding: '6px 6px 6px 22px',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 18,
      whiteSpace: 'nowrap',
      fontFamily: T.font.ui,
      animation: 'mp-prf-rise 480ms cubic-bezier(0.16,1,0.3,1) 200ms backwards',
    }}>
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        fontFamily: T.font.mono,
        fontSize: 11.5,
        fontWeight: 600,
        color: T.text.subtle,
        letterSpacing: '0.04em',
      }}>
        <span aria-hidden style={{
          width: 6, height: 6,
          borderRadius: '50%',
          background: isBlocked ? T.status.warn.main : T.accent.main,
          boxShadow: `0 0 0 3px ${(isBlocked ? T.status.warn.main : T.accent.main) + '22'}`,
        }} />
        <span style={{
          color: T.text.primary,
          fontWeight: 700,
        }}>
          {message}
        </span>
      </span>
      <button
        type="button"
        onClick={onStartFocus}
        disabled={isBlocked}
        title={isBlocked ? 'Hinweise zuerst akzeptieren' : 'Focus-Modus starten (F)'}
        style={{
          ...betaAccentPillStyle,
          opacity: isBlocked ? 0.5 : 1,
          cursor: isBlocked ? 'not-allowed' : 'pointer',
        }}
        onMouseEnter={isBlocked ? undefined : betaAccentPillHover}
        onMouseLeave={isBlocked ? undefined : betaAccentPillLeave}
      >
        Focus
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
          <path d="M3 7h8m0 0L7.5 3.5M11 7l-3.5 3.5" stroke="currentColor"
                strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <BetaKbd>F</BetaKbd>
      </button>
    </div>
  );
}

/* ── shared beta styles ──────────────────────────────────────────────── */
const betaAccentPillStyle: React.CSSProperties = {
  all: 'unset',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  padding: '11px 22px',
  background: 'var(--accent)',
  color: '#FFFFFF',
  borderRadius: 999,
  fontFamily: T.font.ui,
  fontSize: 14,
  fontWeight: 600,
  letterSpacing: '-0.005em',
  cursor: 'pointer',
  transition: 'transform 200ms cubic-bezier(0.16, 1, 0.3, 1), filter 200ms ease',
};

function betaAccentPillHover(e: React.MouseEvent<HTMLButtonElement>) {
  e.currentTarget.style.transform = 'translateY(-1px)';
  e.currentTarget.style.filter = 'brightness(1.05)';
}

function betaAccentPillLeave(e: React.MouseEvent<HTMLButtonElement>) {
  e.currentTarget.style.transform = 'none';
  e.currentTarget.style.filter = 'none';
}

const betaGhostLinkStyle: React.CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  fontFamily: T.font.ui,
  fontSize: 12.5,
  fontWeight: 500,
  color: T.text.subtle,
  letterSpacing: '-0.005em',
  padding: '4px 8px',
  textDecoration: 'underline dotted',
  textUnderlineOffset: 3,
};

function betaCopyToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackBetaCopy(text));
    return;
  }
  fallbackBetaCopy(text);
}
function fallbackBetaCopy(text: string) {
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
  } catch { /* ignore */ }
}