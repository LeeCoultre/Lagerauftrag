/* Warteschlange v2 — «Cockpit der Schicht».

   Magazine-spread design (matches Upload / Pruefen / Focus):
     • Eyebrow + clamp(36–52) PageH1 + Lead — wide breathing room
     • Hero KPI strip — total Aufträge / Paletten / Artikel / EH / ETA
     • In-Bearbeitung banner when a workflow is already active
     • Smart-sort pills (FIFO / Klein / Groß / Einfach zuerst) — single
       backend round-trip via reorderQueueTo
     • Search + status filter chips (auto-show ≥ 5 entries)
     • Native HTML5 drag-to-reorder with hairline drop-target line
     • Per-row fingerprint: mixed / single-SKU / ESKU counts, LST flags,
       level-distribution sparkbars, per-Auftrag ETA from
       estimateOrderSeconds()
     • Keyboard cockpit: j/k navigate · ⏎ start · x remove ·
       ⌘↑/⌘↓ reorder · / focus search · Esc clear search/select
     • Compact DropStrip stays so .docx anhängen never disappears
*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppState } from '@/state.jsx';
import {
  Page, Topbar, Card, Eyebrow, PageH1, Lead,
  Badge, Button, EmptyState, T,
} from '@/components/ui.jsx';
import {
  estimateOrderSeconds, getDisplayLevel, LEVEL_META,
  sortPallets, formatItemTitle,
} from '@/utils/auftragHelpers.js';
import { getAuftrag } from '@/marathonApi.js';
import { useBetaDesign } from '@/hooks/useBetaDesign';
import type { LegacyAuftrag } from '@/types/state';

/* ════════════════════════════════════════════════════════════════════════ */
const SORT_MODES = [
  { id: 'fifo',   label: 'FIFO',           hint: 'Reihenfolge wie hochgeladen' },
  { id: 'small',  label: 'Klein zuerst',   hint: 'Wenige Paletten zuerst' },
  { id: 'large',  label: 'Groß zuerst',    hint: 'Viele Paletten zuerst' },
  { id: 'simple', label: 'Einfach zuerst', hint: 'Wenig ESKU & Single-SKU zuerst' },
];

const FILTER_MODES = [
  { id: 'all',  label: 'Alle' },
  { id: 'ok',   label: 'Validiert' },
  { id: 'warn', label: 'Warnungen' },
  { id: 'err',  label: 'Fehler' },
];

const LST_OHNE_FULL  = /\bohne\s+(?:sepa[-\s]*)?lastschrift(?:text)?\b/i;
const LST_FULL_POS   = /\b(?:sepa[-\s]*)?lastschrift(?:text)?\b/i;
const LST_SEPA_DRUCK = /\bsepa[-\s]*druck\b/i;

/* ════════════════════════════════════════════════════════════════════════
   Top-level router — branches on the global beta-design flag. Classic body
   below is byte-identical to the pre-beta cockpit; beta body lives at the
   end of the file (see BetaWarteschlange).
   ════════════════════════════════════════════════════════════════════════ */
export default function WarteschlangeScreen({ onRoute }) {
  const { beta } = useBetaDesign();
  if (beta) return <BetaWarteschlange onRoute={onRoute} />;
  return <ClassicWarteschlange onRoute={onRoute} />;
}

/* ════════════════════════════════════════════════════════════════════════ */
function ClassicWarteschlange({ onRoute }) {
  const {
    queue, current,
    addFiles, startEntry,
    removeFromQueue, reorderQueue, reorderQueueTo, clearQueue,
    joinable, joinAndClaimFirst,
  } = useAppState();

  const [over, setOver]               = useState(false);
  const [busy, setBusy]               = useState(false);
  const [sortMode, setSortMode]       = useState('fifo');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode]   = useState('all');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [dragFromIdx, setDragFromIdx] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);
  const [expandedId, setExpandedId]   = useState<string | null>(null);
  const [flash, setFlash]             = useState<string | null>(null);

  const inputRef  = useRef<HTMLInputElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  /* ── enrichment per entry ──────────────────────────────────────
     Queued items arrive WITHOUT `parsed` in the list payload (server
     slims everything except the caller's active Auftrag). For counts
     we use the precomputed Summary fields; fingerprint + ETA need
     full pallets[] and gracefully degrade to null when absent. */
  const entries = useMemo(
    () => queue.map((entry) => {
      const pallets       = entry.parsed?.pallets || [];
      const eskuItems     = entry.parsed?.einzelneSkuItems || [];
      const palletCount   = entry.palletCount ?? pallets.length;
      const articleCount  = entry.articleCount
        ?? pallets.reduce((s, p) => s + (p.items?.length || 0), 0);
      const units         = entry.unitsCount ?? entry.parsed?.meta?.totalUnits ?? 0;
      const fp            = pallets.length ? computeFingerprint(pallets, eskuItems) : null;
      const etaSec        = pallets.length ? estimateOrderSeconds(pallets) : null;
      return {
        ...entry,
        _fp: fp,
        _etaSec: etaSec,
        _palletCount: palletCount,
        _articleCount: articleCount,
        _units: units,
      };
    }),
    [queue],
  );

  /* ── visible list (sort + filter + search) ───────────────────── */
  const visible = useMemo(
    () => filterAndSearch(entries, searchQuery, filterMode)
      .map((e, i) => ({ ...e, _displayIdx: i })),
    [entries, searchQuery, filterMode],
  );

  /* Keep selectedIdx in range as the visible list shrinks. */
  useEffect(() => {
    if (selectedIdx >= visible.length) {
      setSelectedIdx(Math.max(0, visible.length - 1));
    }
  }, [visible.length, selectedIdx]);

  /* Queue head — first non-error row in true queue order (NOT visible
     order). Error rows are skipped so a broken parse doesn't lock the
     shift. Used by both UI gating and Enter hotkey to enforce the rule
     that Sortieren is binding. */
  const headId = useMemo(
    () => queue.find((q) => q.status !== 'error')?.id ?? null,
    [queue],
  );

  /* Close the open Vorschau if the expanded entry left the queue. */
  useEffect(() => {
    if (expandedId && !queue.some((q) => q.id === expandedId)) {
      setExpandedId(null);
    }
  }, [queue, expandedId]);

  /* Auto-dismiss flash messages after 2.5s. */
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  /* ── totals for the hero KPI strip ───────────────────────────── */
  const totals = useMemo(
    () => entries.reduce((acc: { pallets: number; articles: number; units: number; etaSec: number }, e) => ({
      pallets:  acc.pallets  + e._palletCount,
      articles: acc.articles + e._articleCount,
      units:    acc.units    + Number(e._units || 0),
      etaSec:   acc.etaSec   + (e._etaSec ?? 0),
    }), { pallets: 0, articles: 0, units: 0, etaSec: 0 }),
    [entries],
  );

  /* ── file handling ───────────────────────────────────────────── */
  const acceptFiles = useCallback(async (fl: FileList | File[] | null) => {
    const arr = Array.from(fl || []).filter((f: File) => /\.docx$/i.test(f.name));
    if (!arr.length) return;
    setBusy(true);
    try {
      const built = await addFiles(arr);
      if (!current && queue.length === 0 && built[0]?.status === 'ready') {
        setTimeout(() => startEntry(built[0].id), 100);
      }
    } finally {
      setBusy(false);
    }
  }, [addFiles, current, queue.length, startEntry]);

  /* ── smart-sort: build a permutation, send via reorderQueueTo ── */
  const applySort = useCallback((mode) => {
    setSortMode(mode);
    if (mode === 'fifo') return;
    const sorted = sortEntries(entries, mode);
    const orderedIds = sorted.map((e) => e.id);
    reorderQueueTo(orderedIds);
  }, [entries, reorderQueueTo]);

  /* ── drag-and-drop reorder ───────────────────────────────────── */
  const onDragStart = (idx) => (e) => {
    e.dataTransfer.effectAllowed = 'move';
    /* setData is required in Firefox to actually start the drag */
    e.dataTransfer.setData('text/plain', String(idx));
    setDragFromIdx(idx);
  };
  const onDragOver = (idx) => (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragFromIdx === null) return;
    if (idx !== dragOverIdx) setDragOverIdx(idx);
  };
  const onDrop = (idx) => (e) => {
    e.preventDefault();
    if (dragFromIdx !== null && dragFromIdx !== idx) {
      const from = visible[dragFromIdx];
      const to   = visible[idx];
      const fromQ = queue.findIndex((q) => q.id === from?.id);
      const toQ   = queue.findIndex((q) => q.id === to?.id);
      if (fromQ >= 0 && toQ >= 0) reorderQueue(fromQ, toQ);
    }
    setDragFromIdx(null);
    setDragOverIdx(null);
  };
  const onDragEnd = () => {
    setDragFromIdx(null);
    setDragOverIdx(null);
  };

  /* ── keyboard cockpit ────────────────────────────────────────── */
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable;

      if (e.key === '/' && !inField) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'Escape') {
        if (document.activeElement === searchRef.current) {
          searchRef.current?.blur();
          if (searchQuery) setSearchQuery('');
          return;
        }
      }
      if (inField) return;
      if (!visible.length) return;

      /* Meta/Ctrl+Arrow checks MUST come before plain arrow keys —
         otherwise the plain branch swallows the keydown and the meta
         variant becomes dead code (caught by no-dupe-else-if). */
      if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowDown') {
        e.preventDefault();
        const target = visible[selectedIdx];
        const idx = queue.findIndex((q) => q.id === target?.id);
        if (idx >= 0 && idx < queue.length - 1) reorderQueue(idx, idx + 1);
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowUp') {
        e.preventDefault();
        const target = visible[selectedIdx];
        const idx = queue.findIndex((q) => q.id === target?.id);
        if (idx > 0) reorderQueue(idx, idx - 1);
      } else if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(visible.length - 1, i + 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const target = visible[selectedIdx];
        if (!target || current || target.status === 'error') return;
        if (headId && target.id !== headId) {
          setFlash('Reihenfolge beachten — erst den obersten Auftrag starten.');
          return;
        }
        startEntry(target.id);
        if (onRoute) onRoute('workspace');
      } else if (e.key === 'x' || e.key === 'Delete') {
        e.preventDefault();
        const target = visible[selectedIdx];
        if (target) removeFromQueue(target.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    visible, selectedIdx, queue, current, searchQuery, headId,
    startEntry, removeFromQueue, reorderQueue, onRoute,
  ]);

  const hasQueue = entries.length > 0;
  const showToolbar = entries.length >= 2;
  const showSearchRow = entries.length >= 5;
  const noResults = hasQueue && visible.length === 0;
  const today = useMemo(() => new Date(), []);

  return (
    <Page>
      <Topbar
        crumbs={[{ label: 'Warteschlange' }]}
        right={
          <span style={{
            fontSize: 12.5,
            color: T.text.subtle,
            fontVariantNumeric: 'tabular-nums',
            fontFamily: T.font.mono,
            letterSpacing: '0.02em',
          }}>
            {hasQueue ? `${entries.length} ${entries.length === 1 ? 'Auftrag' : 'Aufträge'}` : 'Leer'}
          </span>
        }
      />

      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '72px 40px 96px' }}>
        {/* HEADER */}
        <header style={{ marginBottom: 48 }}>
          <Eyebrow>
            Schicht · {today.toLocaleDateString('de-DE', {
              day: '2-digit', month: '2-digit', year: 'numeric',
            })}
          </Eyebrow>
          <h1 style={{
            fontFamily: T.font.ui,
            fontSize: 'clamp(36px, 2.8vw, 52px)',
            fontWeight: 600,
            letterSpacing: '-0.025em',
            lineHeight: 1.1,
            color: T.text.primary,
            margin: 0,
          }}>
            Warteschlange
          </h1>
          <Lead style={{ marginTop: 16, maxWidth: 720, fontSize: 16 }}>
            Cockpit deiner Schicht. Reihenfolge entscheiden, Schwerpunkte
            erkennen, mit einem Tastendruck starten. Was oben steht, läuft
            als Nächstes.
          </Lead>
        </header>

        {/* IN-BEARBEITUNG BANNER */}
        {current && (
          <CurrentBanner current={current} onRoute={onRoute} />
        )}

        {/* AKTIVE SITZUNGEN ANDERER WORKER — BEITRETEN */}
        {!current && joinable.length > 0 && (
          <JoinableBanner
            joinable={joinable}
            onJoin={async (id) => {
              const ok = await joinAndClaimFirst(id);
              if (ok && onRoute) onRoute('workspace');
            }}
          />
        )}

        {/* HERO KPI STRIP */}
        {hasQueue && (
          <KpiStrip
            entries={entries.length}
            totals={totals}
          />
        )}

        {/* TOOLBAR (sort + clear) */}
        {showToolbar && (
          <Toolbar
            sortMode={sortMode}
            onSortMode={applySort}
            queueLen={entries.length}
            onClear={clearQueue}
          />
        )}

        {/* SEARCH + FILTER (≥5 entries) */}
        {showSearchRow && (
          <SearchFilterRow
            search={searchQuery}
            onSearch={setSearchQuery}
            filterMode={filterMode}
            onFilter={setFilterMode}
            searchRef={searchRef}
          />
        )}

        {/* DROP STRIP — always present when queue exists */}
        {hasQueue && (
          <div style={{ marginBottom: 20 }}>
            <DropStrip
              over={over}
              busy={busy}
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); acceptFiles(e.dataTransfer.files); }}
            />
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".docx"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { acceptFiles(e.target.files); e.target.value = ''; }}
        />

        {/* QUEUE LIST */}
        {hasQueue && !noResults && (
          <div style={{ display: 'grid', gap: 14 }}>
            {visible.map((entry, displayIdx) => (
              <QueueRowCard
                key={entry.id}
                entry={entry}
                queueIdx={queue.findIndex((q) => q.id === entry.id)}
                isHead={entry.id === headId}
                isSelected={displayIdx === selectedIdx}
                hasCurrent={!!current}
                isExpanded={expandedId === entry.id}
                isDragging={dragFromIdx === displayIdx}
                isDropAbove={dragFromIdx !== null && dragOverIdx === displayIdx && dragFromIdx > displayIdx}
                isDropBelow={dragFromIdx !== null && dragOverIdx === displayIdx && dragFromIdx < displayIdx}
                onSelect={() => setSelectedIdx(displayIdx)}
                onToggleExpand={() => setExpandedId((cur) => (cur === entry.id ? null : entry.id))}
                onStart={() => {
                  if (headId && entry.id !== headId) {
                    setFlash('Reihenfolge beachten — erst den obersten Auftrag starten.');
                    return;
                  }
                  startEntry(entry.id);
                  if (onRoute) onRoute('workspace');
                }}
                onRemove={() => removeFromQueue(entry.id)}
                onUp={(() => {
                  const qi = queue.findIndex((q) => q.id === entry.id);
                  return qi > 0 ? () => reorderQueue(qi, qi - 1) : null;
                })()}
                onDown={(() => {
                  const qi = queue.findIndex((q) => q.id === entry.id);
                  return qi >= 0 && qi < queue.length - 1 ? () => reorderQueue(qi, qi + 1) : null;
                })()}
                onDragStart={onDragStart(displayIdx)}
                onDragOver={onDragOver(displayIdx)}
                onDrop={onDrop(displayIdx)}
                onDragEnd={onDragEnd}
              />
            ))}
          </div>
        )}

        {/* NO RESULTS (search/filter cleared everything) */}
        {noResults && (
          <Card style={{ padding: '40px 32px', textAlign: 'center' }}>
            <div style={{
              fontSize: 14,
              color: T.text.subtle,
              marginBottom: 16,
            }}>
              Keine Aufträge passen zu Suche oder Filter.
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setSearchQuery(''); setFilterMode('all'); }}
            >
              Filter zurücksetzen
            </Button>
          </Card>
        )}

        {/* EMPTY STATE */}
        {!hasQueue && (
          <EmptyHero onClick={() => inputRef.current?.click()} busy={busy} over={over}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); acceptFiles(e.dataTransfer.files); }}
          />
        )}

        {/* KEYBOARD CHEAT-SHEET */}
        {hasQueue && <KbdHints />}
      </main>

      {/* FLASH — strict-order violation, drag-to-top hint, etc. */}
      {flash && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            left: '50%',
            bottom: 32,
            transform: 'translateX(-50%)',
            padding: '12px 20px',
            background: T.text.primary,
            color: T.bg.page,
            fontFamily: T.font.ui,
            fontSize: 13,
            letterSpacing: '-0.005em',
            borderRadius: T.radius.md,
            boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
            zIndex: 1000,
          }}
        >
          {flash}
        </div>
      )}

      <style>{`
        @keyframes mr-q-pulse {
          0%   { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.0); }
          50%  { box-shadow: 0 0 0 6px ${T.accent.bg}; }
          100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.0); }
        }
        @keyframes mr-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </Page>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Helper computations
   ════════════════════════════════════════════════════════════════════════ */

function computeFingerprint(pallets, eskuItems) {
  let mixed = 0;
  let singleSku = 0;
  for (const p of pallets) {
    if (p.hasFourSideWarning) singleSku++;
    else mixed++;
  }

  let mitLst = 0;
  let ohneLst = 0;
  const allTitles = pallets.flatMap((p) => p.items || []).map((it) => it.title || '');
  for (const t of allTitles) {
    if (/\bmit\s+lst\b/i.test(t)) mitLst++;
    else if (/\bohne\s+lst\b/i.test(t)) ohneLst++;
    else if (LST_OHNE_FULL.test(t)) ohneLst++;
    else if (LST_FULL_POS.test(t) || LST_SEPA_DRUCK.test(t)) mitLst++;
  }

  /* Level distribution by article count (not units — articles is a better
     "shape" signal at the queue glance level). */
  const lvlCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const p of pallets) {
    for (const it of (p.items || [])) {
      const lvl = getDisplayLevel(it);
      if (lvlCounts[lvl] !== undefined) lvlCounts[lvl] += 1;
    }
  }
  for (const it of (eskuItems || [])) {
    const lvl = getDisplayLevel(it);
    if (lvlCounts[lvl] !== undefined) lvlCounts[lvl] += 1;
  }

  return {
    mixed, singleSku,
    eskuCount: (eskuItems || []).length,
    mitLst, ohneLst,
    lvlCounts,
  };
}

function complexityScore(e) {
  /* Higher = more complex. Pallets are the dominant signal; ESKU items
     and Single-SKU pallets each add a smaller bump. `_fp` may be null
     for queued entries that arrived without parsed (race with refetch
     after create), so default missing flags to 0. */
  const fp = e._fp || { eskuCount: 0, singleSku: 0 };
  return e._palletCount * 4
       + fp.eskuCount * 1.2
       + fp.singleSku * 1.5;
}

function sortEntries(entries, mode) {
  const arr = [...entries];
  if (mode === 'small')   arr.sort((a, b) => a._palletCount - b._palletCount);
  if (mode === 'large')   arr.sort((a, b) => b._palletCount - a._palletCount);
  if (mode === 'simple')  arr.sort((a, b) => complexityScore(a) - complexityScore(b));
  return arr;
}

function filterAndSearch(entries, search, filterMode) {
  let arr = entries;
  if (filterMode === 'ok') {
    arr = arr.filter((e) => e.status !== 'error'
      && (e.validation?.errorCount || 0) === 0
      && (e.validation?.warningCount || 0) === 0);
  } else if (filterMode === 'warn') {
    arr = arr.filter((e) => e.status !== 'error' && (e.validation?.warningCount || 0) > 0);
  } else if (filterMode === 'err') {
    arr = arr.filter((e) => e.status === 'error' || (e.validation?.errorCount || 0) > 0);
  }
  const q = search.trim().toLowerCase();
  if (q) {
    arr = arr.filter((e) => {
      const fba = (e.parsed?.meta?.sendungsnummer || e.parsed?.meta?.fbaCode || '').toLowerCase();
      const fn  = (e.fileName || '').toLowerCase();
      return fba.includes(q) || fn.includes(q);
    });
  }
  return arr;
}

function fmtDuration(sec) {
  if (!sec || sec < 60) return '< 1 min';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${String(r).padStart(2, '0')} min` : `${h}h`;
}

function fmtRel(ts) {
  if (!ts) return '';
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60)  return 'gerade eben';
  if (sec < 3600) return `vor ${Math.round(sec / 60)} min`;
  if (sec < 86400) return `vor ${Math.round(sec / 3600)} h`;
  return new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

/* ════════════════════════════════════════════════════════════════════════
   Sub-components
   ════════════════════════════════════════════════════════════════════════ */

function CurrentBanner({ current, onRoute }) {
  const fba = current.parsed?.meta?.sendungsnummer
    || current.parsed?.meta?.fbaCode
    || current.fileName;
  const totalP = current.parsed?.pallets?.length || 0;
  const cur    = (current.currentPalletIdx ?? 0) + 1;
  const pct    = totalP ? Math.round(((current.currentPalletIdx ?? 0) / totalP) * 100) : 0;

  return (
    <div style={{
      marginBottom: 36,
      padding: '20px 24px',
      background: T.bg.surface,
      border: `1px solid ${T.border.primary}`,
      borderRadius: T.radius.lg,
      display: 'grid',
      gridTemplateColumns: '1fr auto',
      alignItems: 'center',
      gap: 24,
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Live progress hairline along the top */}
      <div style={{
        position: 'absolute',
        top: 0, left: 0,
        height: 2,
        width: `${pct}%`,
        background: T.accent.main,
        transition: 'width 280ms cubic-bezier(0.16, 1, 0.3, 1)',
      }} />

      <div style={{ minWidth: 0 }}>
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11,
          fontWeight: 600,
          fontFamily: T.font.mono,
          color: T.accent.text,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          marginBottom: 6,
        }}>
          <span style={{
            width: 6, height: 6,
            borderRadius: '50%',
            background: T.accent.main,
            animation: 'mr-q-pulse 1800ms ease-in-out infinite',
          }} />
          In Bearbeitung
        </div>
        <div style={{
          fontFamily: T.font.mono,
          fontSize: 18,
          fontWeight: 500,
          color: T.text.primary,
          letterSpacing: '-0.01em',
        }}>
          {fba}
        </div>
        <div style={{
          marginTop: 4,
          fontSize: 13,
          color: T.text.subtle,
          fontVariantNumeric: 'tabular-nums',
        }}>
          Palette {cur} von {totalP} · {pct}% erledigt
        </div>
      </div>

      <Button
        variant="primary"
        size="md"
        onClick={() => onRoute && onRoute('workspace')}
        title="Zurück zum Workflow"
      >
        Fortsetzen
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M3 6h6m0 0L6 3m3 3L6 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Button>
    </div>
  );
}

/* Aktive Sessions anderer Worker — kompaktes Banner, in jeder Zeile
   ein "Übernehmen" auf die nächste freie Palette. Sichtbar nur, wenn
   der aktuelle Worker keine eigene aktive Sitzung hat (sonst lenkt es
   nur ab und der Worker kann ohnehin nicht parallel beitreten).      */
function JoinableBanner({ joinable, onJoin }) {
  return (
    <div style={{ marginBottom: 32, display: 'grid', gap: 12 }}>
      <div style={{
        fontSize: 11, fontWeight: 600, fontFamily: T.font.mono,
        color: T.text.subtle, textTransform: 'uppercase',
        letterSpacing: '0.12em',
      }}>
        Aktive Sitzungen · Beitreten
      </div>
      {joinable.map((entry) => {
        const fba = entry.fbaCode || entry.fileName;
        const total = entry.palletCount ?? 0;
        const occupied = new Set(
          (entry.palletClaims ?? [])
            .filter((c) => c.state === 'active' || c.state === 'completed')
            .map((c) => c.palletIdx),
        );
        const freeCount = Math.max(0, total - occupied.size);
        const primary = entry.assignedToUserName || 'Andere';
        return (
          <div key={entry.id} style={{
            padding: '16px 20px',
            background: T.bg.surface,
            border: `1px dashed ${T.accent.border}`,
            borderRadius: T.radius.lg,
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            alignItems: 'center',
            gap: 24,
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{
                fontFamily: T.font.mono, fontSize: 11, fontWeight: 600,
                color: T.accent.text, letterSpacing: '0.12em',
                textTransform: 'uppercase', marginBottom: 4,
              }}>
                Läuft · {primary}
              </div>
              <div style={{
                fontFamily: T.font.mono, fontSize: 16, fontWeight: 500,
                color: T.text.primary,
              }}>
                {fba}
              </div>
              <div style={{
                marginTop: 4, fontSize: 12, color: T.text.subtle,
                fontVariantNumeric: 'tabular-nums',
              }}>
                {freeCount} freie Palette{freeCount === 1 ? '' : 'n'} · {total} insgesamt
              </div>
            </div>
            <Button
              variant="primary"
              size="md"
              onClick={() => onJoin(entry.id)}
              disabled={freeCount === 0}
              title={freeCount === 0
                ? 'Alle Paletten in Bearbeitung'
                : 'Nächste freie Palette übernehmen'}
            >
              Übernehmen
            </Button>
          </div>
        );
      })}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
function KpiStrip({ entries, totals }) {
  return (
    <div style={{
      marginBottom: 32,
      padding: '24px 28px',
      background: T.bg.surface,
      border: `1px solid ${T.border.primary}`,
      borderRadius: T.radius.lg,
      display: 'grid',
      gridTemplateColumns: 'repeat(5, 1fr)',
      gap: 8,
    }}>
      <Kpi label="Aufträge" value={entries} />
      <Kpi label="Paletten" value={totals.pallets} />
      <Kpi label="Artikel"  value={totals.articles} />
      <Kpi label="Einheiten" value={totals.units.toLocaleString('de-DE')} />
      <Kpi label="Geschätzt" value={`≈ ${fmtDuration(totals.etaSec)}`} accent />
    </div>
  );
}

function Kpi({ label, value, accent }: { label?: React.ReactNode; value?: React.ReactNode; accent?: boolean }) {
  return (
    <div>
      <div style={{
        fontSize: 10.5,
        fontFamily: T.font.mono,
        fontWeight: 600,
        color: T.text.subtle,
        textTransform: 'uppercase',
        letterSpacing: '0.10em',
        marginBottom: 6,
      }}>
        {label}
      </div>
      <div style={{
        fontFamily: T.font.ui,
        fontSize: 26,
        fontWeight: 500,
        letterSpacing: '-0.02em',
        color: accent ? T.accent.text : T.text.primary,
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1.1,
      }}>
        {value}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
function Toolbar({ sortMode, onSortMode, queueLen, onClear }) {
  return (
    <div style={{
      marginBottom: 16,
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
    }}>
      <span style={{
        fontSize: 11,
        fontWeight: 600,
        fontFamily: T.font.mono,
        color: T.text.subtle,
        textTransform: 'uppercase',
        letterSpacing: '0.10em',
        marginRight: 4,
      }}>
        Sortieren
      </span>
      {SORT_MODES.map((m) => (
        <SortPill
          key={m.id}
          active={sortMode === m.id}
          onClick={() => onSortMode(m.id)}
          title={m.hint}
        >
          {m.label}
        </SortPill>
      ))}
      <span style={{ flex: 1 }} />
      {queueLen >= 2 && (
        <Button variant="ghost" size="sm" onClick={onClear}>
          Alle entfernen
        </Button>
      )}
    </div>
  );
}

function SortPill({ children, active, onClick, title }: { children?: React.ReactNode; active?: boolean; onClick?: () => void; title?: string }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 30,
        padding: '0 12px',
        fontSize: 12.5,
        fontWeight: 500,
        fontFamily: T.font.ui,
        background: active ? T.accent.bg : (hover ? T.bg.surface3 : T.bg.surface),
        border: `1px solid ${active ? T.accent.border : T.border.primary}`,
        color: active ? T.accent.text : T.text.secondary,
        borderRadius: T.radius.full,
        cursor: 'pointer',
        transition: 'all 150ms ease',
      }}
    >
      {children}
    </button>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
function SearchFilterRow({ search, onSearch, filterMode, onFilter, searchRef }) {
  return (
    <div style={{
      marginBottom: 16,
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      flexWrap: 'wrap',
    }}>
      <div style={{
        flex: '1 1 280px',
        maxWidth: 360,
        position: 'relative',
      }}>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none"
          style={{
            position: 'absolute',
            left: 12, top: '50%',
            transform: 'translateY(-50%)',
            color: T.text.faint,
          }}
        >
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.6" />
          <path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input
          ref={searchRef}
          type="text"
          placeholder="Suchen — FBA-Code oder Dateiname  ·  /"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          style={{
            width: '100%',
            height: 36,
            padding: '0 36px 0 34px',
            fontSize: 13,
            fontFamily: T.font.ui,
            color: T.text.primary,
            background: T.bg.surface,
            border: `1px solid ${T.border.primary}`,
            borderRadius: T.radius.md,
            outline: 'none',
            transition: 'border-color 150ms',
          }}
          onFocus={(e) => { e.target.style.borderColor = T.accent.main; }}
          onBlur={(e)  => { e.target.style.borderColor = T.border.primary; }}
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearch('')}
            title="Suche leeren"
            style={{
              position: 'absolute',
              right: 8, top: '50%',
              transform: 'translateY(-50%)',
              width: 22, height: 22,
              display: 'inline-flex',
              alignItems: 'center', justifyContent: 'center',
              background: 'transparent',
              border: 'none',
              borderRadius: T.radius.sm,
              color: T.text.faint,
              cursor: 'pointer',
            }}
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      <span style={{ flex: 1 }} />
      {FILTER_MODES.map((f) => (
        <SortPill
          key={f.id}
          active={filterMode === f.id}
          onClick={() => onFilter(f.id)}
        >
          {f.label}
        </SortPill>
      ))}
    </div>
  );
}

/* ══════ Drop strip (unchanged shape, slightly bigger paddings) ══════════ */
function DropStrip({ over, busy, onClick, onDragOver, onDragLeave, onDrop }) {
  const borderColor = over ? T.accent.main : T.border.strong;
  const bgColor = over ? T.accent.bg : T.bg.surface;
  return (
    <div
      onClick={onClick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        padding: '20px 26px',
        background: bgColor,
        border: `1px dashed ${borderColor}`,
        borderRadius: T.radius.lg,
        cursor: busy ? 'wait' : 'pointer',
        transition: 'background 200ms, border-color 200ms',
      }}
    >
      <span style={{
        width: 44, height: 44,
        borderRadius: T.radius.md,
        background: over ? '#fff' : T.bg.surface3,
        border: `1px solid ${over ? T.accent.border : T.border.primary}`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: over ? T.accent.main : T.text.subtle,
        flexShrink: 0,
        transition: 'all 200ms',
      }}>
        {busy ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ animation: 'mr-spin 800ms linear infinite' }}>
            <path d="M21 12a9 9 0 1 1-6.2-8.55" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <div style={{ flex: 1, lineHeight: 1.4 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: T.text.primary }}>
          {over ? 'Datei jetzt loslassen' : busy ? 'Wird verarbeitet…' : 'Weitere Datei anhängen'}
        </div>
        <div style={{ fontSize: 13, color: T.text.subtle, marginTop: 3 }}>
          .docx · Drag &amp; Drop oder klicken
        </div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        disabled={busy}
      >
        Datei auswählen
      </Button>
    </div>
  );
}

/* ════════ Empty state — magazine-spread, matches Upload vocabulary ═════ */
function EmptyHero({ onClick, busy, over, onDragOver, onDragLeave, onDrop }) {
  return (
    <div style={{ marginTop: 4 }}>
      {/* Sub-eyebrow — secondary hero pulse, distinct from the page-level H1 */}
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 10.5,
        fontFamily: T.font.mono,
        fontWeight: 600,
        color: T.text.subtle,
        textTransform: 'uppercase',
        letterSpacing: '0.10em',
        marginBottom: 10,
      }}>
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: T.accent.main }} />
        Schicht beginnt
      </div>

      <h2 style={{
        margin: 0,
        fontFamily: T.font.ui,
        fontSize: 'clamp(24px, 1.9vw, 32px)',
        fontWeight: 500,
        letterSpacing: '-0.02em',
        lineHeight: 1.15,
        color: T.text.primary,
      }}>
        Lege deinen ersten Auftrag ab
      </h2>
      <p style={{
        margin: '10px 0 22px',
        fontSize: 15,
        color: T.text.muted,
        lineHeight: 1.55,
        maxWidth: 560,
      }}>
        Eine <code style={{
          fontFamily: T.font.mono,
          fontSize: 13.5,
          padding: '1px 6px',
          background: T.bg.surface3,
          border: `1px solid ${T.border.primary}`,
          borderRadius: 4,
          color: T.text.secondary,
        }}>.docx</code>-Datei genügt — Marathon übernimmt den Rest. Mehrere
        Aufträge werden in der hier gewählten Reihenfolge abgearbeitet.
      </p>

      {/* Hero drop row — 1px hairline (matches Upload), accent on hover */}
      <div
        onClick={onClick}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        style={{
          minHeight: 120,
          padding: '24px 28px',
          display: 'flex',
          alignItems: 'center',
          gap: 24,
          background: over ? T.accent.bg : T.bg.surface,
          border: `1px ${over ? 'solid' : 'dashed'} ${over ? T.accent.main : T.border.strong}`,
          borderRadius: 14,
          cursor: busy ? 'wait' : 'pointer',
          transition: 'background 240ms cubic-bezier(0.16, 1, 0.3, 1), border-color 240ms cubic-bezier(0.16, 1, 0.3, 1), transform 240ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 240ms cubic-bezier(0.16, 1, 0.3, 1)',
          transform: over ? 'scale(1.005)' : 'scale(1)',
          boxShadow: 'none',
          marginBottom: 28,
        }}
      >
        <span style={{
          width: 52, height: 52,
          flexShrink: 0,
          borderRadius: T.radius.md,
          background: over ? '#fff' : T.bg.surface3,
          border: `1px solid ${over ? T.accent.border : T.border.primary}`,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: over ? T.accent.main : T.text.subtle,
          transition: 'all 200ms',
        }}>
          {busy ? (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" style={{ animation: 'mr-spin 800ms linear infinite' }}>
              <path d="M21 12a9 9 0 1 1-6.2-8.55" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
        <div style={{ flex: 1, lineHeight: 1.5, minWidth: 0 }}>
          <div style={{
            fontSize: 17,
            fontWeight: 500,
            color: over ? T.accent.text : T.text.primary,
            letterSpacing: '-0.01em',
          }}>
            {over ? 'Jetzt loslassen' : busy ? 'Wird verarbeitet…' : '.docx hier ablegen'}
          </div>
          <div style={{
            marginTop: 4,
            fontSize: 13,
            color: over ? T.accent.text : T.text.subtle,
            opacity: over ? 0.8 : 1,
          }}>
            Drag &amp; Drop, klicken oder mehrere Dateien gleichzeitig
          </div>
        </div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClick(); }}
          disabled={busy}
          style={{
            padding: '9px 16px',
            fontSize: 13,
            fontWeight: 500,
            color: T.text.secondary,
            background: T.bg.surface,
            border: `1px solid ${T.border.strong}`,
            borderRadius: 6,
            cursor: busy ? 'wait' : 'pointer',
            fontFamily: T.font.ui,
            transition: 'all 160ms',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            if (busy) return;
            e.currentTarget.style.borderColor = T.accent.main;
            e.currentTarget.style.color = T.accent.main;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = T.border.strong;
            e.currentTarget.style.color = T.text.secondary;
          }}
        >
          Datei wählen
        </button>
      </div>

      {/* Tips row — magazine-style 3-card grid (matches Theme-Studio + Live) */}
      <div style={{
        fontSize: 10.5,
        fontFamily: T.font.mono,
        fontWeight: 600,
        color: T.text.subtle,
        textTransform: 'uppercase',
        letterSpacing: '0.10em',
        marginBottom: 10,
      }}>
        Tipps
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 12,
      }}>
        <TipCard
          eyebrow="Sequenziell"
          title="Mehrere Aufträge gleichzeitig"
          body="Lege mehrere .docx-Dateien auf einmal ab — sie landen in der hier sichtbaren Reihenfolge."
        />
        <TipCard
          eyebrow="Überall"
          title="Drop auf der ganzen Seite"
          body="Drag &amp; Drop funktioniert auch außerhalb dieses Felds. Sobald der Cursor die Seite betritt, öffnet sich ein Overlay."
        />
        <TipCard
          eyebrow="Reihenfolge"
          title="Smart-Sort &amp; Drag"
          body="Sobald zwei Aufträge bereit sind, kannst du sie nach Aufwand sortieren oder per Drag verschieben."
        />
      </div>
    </div>
  );
}

function TipCard({ eyebrow, title, body }) {
  return (
    <div style={{
      padding: '16px 18px',
      background: T.bg.surface,
      border: `1px solid ${T.border.primary}`,
      borderRadius: T.radius.md,
    }}>
      <div style={{
        fontSize: 10,
        fontFamily: T.font.mono,
        fontWeight: 600,
        color: T.accent.text,
        textTransform: 'uppercase',
        letterSpacing: '0.10em',
        marginBottom: 6,
      }}>
        {eyebrow}
      </div>
      <div style={{
        fontSize: 14,
        fontWeight: 500,
        color: T.text.primary,
        letterSpacing: '-0.01em',
        marginBottom: 4,
      }}>
        {title}
      </div>
      <div style={{
        fontSize: 12.5,
        color: T.text.subtle,
        lineHeight: 1.5,
      }}>
        {body}
      </div>
    </div>
  );
}

/* ════════ Queue row card ═══════════════════════════════════════════════ */
function QueueRowCard({
  entry, queueIdx, isHead, isSelected, hasCurrent, isExpanded,
  isDragging, isDropAbove, isDropBelow,
  onSelect, onToggleExpand, onStart, onRemove, onUp, onDown,
  onDragStart, onDragOver, onDrop, onDragEnd,
}) {
  const fba = entry.parsed?.meta?.sendungsnummer
    || entry.parsed?.meta?.fbaCode
    || entry.fileName;
  const isError = entry.status === 'error';
  const validErrors = entry.validation?.errorCount || 0;
  const validWarns  = entry.validation?.warningCount || 0;
  const fp = entry._fp;

  /* Visual state stack */
  const borderColor = isHead
    ? T.accent.main
    : isSelected
    ? T.text.primary
    : T.border.primary;
  const bg = isHead ? T.accent.bg : T.bg.surface;
  const dropLineColor = T.accent.main;

  /* Start button is reachable only on the head row; everything else is
     visually disabled with an explanatory tooltip. Error rows stay
     disabled regardless (they can't be started anyway). */
  const startEnabled = isHead && !hasCurrent && !isError;
  const startTitle = isError
    ? 'Auftrag mit Parse-Fehler kann nicht gestartet werden.'
    : hasCurrent
    ? 'Aktiver Auftrag noch nicht abgeschlossen.'
    : !isHead
    ? 'Erst die obenstehenden Aufträge starten. Reihenfolge mit ↑/↓ oder „Sortieren" anpassen.'
    : undefined;

  return (
    <div style={{ display: 'grid', gap: 0 }}>
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={() => {
        onSelect?.();
        if (!isError) onToggleExpand?.();
      }}
      style={{
        position: 'relative',
        padding: '20px 24px',
        background: bg,
        borderStyle: 'solid',
        borderColor,
        borderTopWidth: 1,
        borderLeftWidth: 1,
        borderRightWidth: 1,
        borderBottomWidth: isExpanded ? 0 : 1,
        borderRadius: isExpanded
          ? `${T.radius.lg}px ${T.radius.lg}px 0 0`
          : T.radius.lg,
        boxShadow: 'none',
        opacity: isDragging ? 0.4 : 1,
        cursor: 'pointer',
        transition: 'border-color 150ms, background 150ms, box-shadow 200ms, opacity 150ms',
        display: 'grid',
        gridTemplateColumns: 'auto auto 1fr auto',
        alignItems: 'center',
        gap: 16,
      }}
    >
      {/* Drop-target hairline */}
      {isDropAbove && (
        <div style={{
          position: 'absolute',
          top: -2, left: 8, right: 8,
          height: 2, background: dropLineColor,
          borderRadius: 1,
        }} />
      )}
      {isDropBelow && (
        <div style={{
          position: 'absolute',
          bottom: -2, left: 8, right: 8,
          height: 2, background: dropLineColor,
          borderRadius: 1,
        }} />
      )}

      {/* Drag handle */}
      <span
        title="Ziehen zum Verschieben"
        style={{
          width: 18, height: 28,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: T.text.faint,
          cursor: 'grab',
          flexShrink: 0,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
          <circle cx="2" cy="2"  r="1.2" />
          <circle cx="8" cy="2"  r="1.2" />
          <circle cx="2" cy="7"  r="1.2" />
          <circle cx="8" cy="7"  r="1.2" />
          <circle cx="2" cy="12" r="1.2" />
          <circle cx="8" cy="12" r="1.2" />
        </svg>
      </span>

      {/* Position number */}
      <span style={{
        flex: '0 0 36px',
        fontSize: 12.5,
        fontFamily: T.font.mono,
        color: isHead ? T.accent.text : T.text.faint,
        fontVariantNumeric: 'tabular-nums',
        fontWeight: 500,
        textAlign: 'right',
      }}>
        {String(queueIdx + 1).padStart(2, '0')}
      </span>

      {/* MAIN body */}
      <div style={{ minWidth: 0 }}>
        {/* Title row: FBA + status badges */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 6,
          flexWrap: 'wrap',
        }}>
          <span style={{
            fontFamily: T.font.mono,
            fontSize: 17,
            fontWeight: 500,
            color: T.text.primary,
            letterSpacing: '-0.01em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 320,
          }}>
            {fba}
          </span>
          {isError ? <Badge tone="danger">Parse-Fehler</Badge>
            : validErrors > 0 ? <Badge tone="danger">{validErrors} Fehler</Badge>
            : validWarns > 0 ? <Badge tone="warn">{validWarns} Warnungen</Badge>
            : <Badge tone="success">Validiert</Badge>}
          {isHead && <Badge tone="accent">Nächster</Badge>}
        </div>

        {/* Sub line: filename + relative time */}
        <div style={{
          fontSize: 12.5,
          color: T.text.faint,
          marginBottom: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}>
          <span style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 360,
          }} title={entry.fileName}>
            {entry.fileName}
          </span>
          {entry.addedAt && (
            <>
              <span style={{ color: T.border.strong }}>·</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {fmtRel(entry.addedAt)}
              </span>
            </>
          )}
        </div>

        {/* Fingerprint row: level bars + flag pills.
            `fp` is null for queued entries whose `parsed` isn't in the
            client cache yet (list endpoint slims parsed during the
            brief window between create and refetch settle). Render
            nothing in that case — the row's other stats stay visible. */}
        {!isError && fp && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            flexWrap: 'wrap',
            marginBottom: 12,
          }}>
            <LevelBars lvlCounts={fp.lvlCounts} />
            <FingerprintFlags fp={fp} />
          </div>
        )}

        {/* Stats row */}
        <div style={{
          display: 'flex',
          gap: 22,
          fontSize: 12.5,
          color: T.text.subtle,
          fontVariantNumeric: 'tabular-nums',
          flexWrap: 'wrap',
        }}>
          <Stat label="Paletten"  value={entry._palletCount} />
          <Stat label="Artikel"   value={entry._articleCount} />
          <Stat label="Einheiten" value={entry._units.toLocaleString('de-DE')} />
          {!isError && (
            <Stat
              label="ETA"
              value={`≈ ${fmtDuration(entry._etaSec)}`}
              accent
            />
          )}
        </div>
      </div>

      {/* Actions */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        flexShrink: 0,
      }} onClick={(e) => e.stopPropagation()}>
        <IconBtn onClick={onUp} disabled={!onUp} title="Nach oben">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 9l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </IconBtn>
        <IconBtn onClick={onDown} disabled={!onDown} title="Nach unten">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </IconBtn>
        <IconBtn onClick={onRemove} title="Entfernen">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </IconBtn>
        <span style={{ width: 8 }} />
        <Button
          size="sm"
          variant={startEnabled ? 'primary' : 'ghost'}
          onClick={onStart}
          disabled={!startEnabled}
          title={startTitle}
        >
          {startEnabled ? 'Starten' : 'Wählen'}
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 6h6m0 0L6 3m3 3L6 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Button>
      </div>
    </div>
    {isExpanded && !isError && (
      <PalletPreviewPanel entry={entry} borderColor={borderColor} />
    )}
    </div>
  );
}

/* ════════ Pallet-Vorschau panel ════════════════════════════════════════
   Inline accordion under a queue row. Read-only — surfaces what the
   worker will see in Pruefen so they can prioritize without entering
   the workflow. Detail is lazy-fetched (queue-list payload is slim)
   and cached forever — queue rows are immutable until startEntry.
   Visually the panel reads as a continuation of the queue-row card:
   it carries the same outer border colour, snaps under the row with
   no double-border seam, and uses a flat surface tone so it doesn't
   compete with the row's accent. */
type PreviewItem = {
  title?: string;
  units?: number;
  fnsku?: string;
  sku?: string;
  ean?: string;
  level?: number;
  category?: string;
  useItem?: string | null;
};
type PreviewPallet = {
  id?: string;
  hasFourSideWarning?: boolean;
  items?: PreviewItem[];
  einzelneSkuItems?: unknown[];
};

function PalletPreviewPanel({
  entry, borderColor,
}: {
  entry: { id: string; parsed?: { pallets?: unknown[]; einzelneSkuItems?: unknown[] } | null | undefined };
  borderColor: string;
}) {
  /* Reuse Historie's ['auftrag', id] cache — same fetcher, same
     immutability assumption — so re-opening a row that was previewed
     before (or seen in Historie) hits cache without HTTP. */
  const detailQ = useQuery({
    queryKey: ['auftrag', entry.id],
    queryFn: () => getAuftrag(entry.id),
    staleTime: Infinity,
    refetchInterval: false,
    enabled: !entry.parsed?.pallets,
    initialData: entry.parsed?.pallets ? (entry as unknown as Awaited<ReturnType<typeof getAuftrag>>) : undefined,
  });

  const parsed = (detailQ.data?.parsed ?? entry.parsed) as
    | { pallets?: unknown[]; einzelneSkuItems?: unknown[] }
    | null
    | undefined;
  const pallets = (parsed?.pallets as PreviewPallet[] | undefined) || [];
  const einzelneSkuItems = (parsed?.einzelneSkuItems as unknown[]) || [];

  const sortedPallets = useMemo(
    () => (pallets.length ? (sortPallets(pallets) as PreviewPallet[]) : []),
    [pallets],
  );

  /* Shell sits flush against the row above: same border colour, no top
     border, no top radius — they read as one card. */
  const shell: React.CSSProperties = {
    borderStyle: 'solid',
    borderColor,
    borderTopWidth: 0,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderBottomLeftRadius: T.radius.lg,
    borderBottomRightRadius: T.radius.lg,
    background: T.bg.surface,
    fontFamily: T.font.ui,
    overflow: 'hidden',
  };

  if (detailQ.isPending && !parsed) {
    return (
      <div style={{ ...shell, padding: '20px 24px', display: 'flex', alignItems: 'center', gap: 10, color: T.text.subtle, fontSize: 13 }}>
        <Spinner /> Vorschau wird geladen…
      </div>
    );
  }
  if (detailQ.isError && !parsed) {
    return (
      <div style={{ ...shell, padding: '20px 24px', color: T.status.danger.text, fontSize: 13 }}>
        Vorschau konnte nicht geladen werden.
      </div>
    );
  }
  if (!sortedPallets.length) {
    return (
      <div style={{ ...shell, padding: '20px 24px', color: T.text.subtle, fontSize: 13 }}>
        Keine Paletten in diesem Auftrag.
      </div>
    );
  }

  const totalUnits = sortedPallets.reduce((s, p) => {
    return s + (p.items || []).reduce((u, it) => u + (Number(it.units) || 0), 0);
  }, 0);
  const totalItems = sortedPallets.reduce((s, p) => s + (p.items?.length || 0), 0);

  return (
    <div style={shell}>
      {/* Subtle separator line, then a compact summary band */}
      <div style={{
        height: 1,
        background: T.border.subtle,
        margin: '0 24px',
      }} />
      <div style={{
        padding: '14px 24px 6px',
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
      }}>
        <span style={{
          fontSize: 11,
          color: T.text.faint,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          fontWeight: 500,
        }}>
          Vorschau
        </span>
        <span style={{
          fontSize: 12,
          color: T.text.faint,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '-0.005em',
        }}>
          {sortedPallets.length} Paletten · {totalItems} Positionen · {totalUnits.toLocaleString('de-DE')} Einheiten
          {einzelneSkuItems.length > 0 && ` · ${einzelneSkuItems.length} ESKU`}
        </span>
      </div>

      <div style={{
        padding: '6px 0 8px',
        maxHeight: 460,
        overflowY: 'auto',
      }}>
        {sortedPallets.map((p, idx) => (
          <PalletPreviewSection
            key={p.id || idx}
            pallet={p}
            index={idx}
            isLast={idx === sortedPallets.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
function PalletPreviewSection({
  pallet, index, isLast,
}: {
  pallet: PreviewPallet;
  index: number;
  isLast: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const items = pallet.items || [];
  const eskuOnPallet = pallet.einzelneSkuItems?.length || 0;
  const totalUnits = items.reduce((s, it) => s + (Number(it.units) || 0), 0);
  const palletLabel = pallet.id || `P${index + 1}`;

  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!pallet.id || typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(pallet.id).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1400); },
      () => { /* clipboard denied — silent */ },
    );
  };

  return (
    <section style={{
      padding: '10px 24px 14px',
      borderBottom: isLast ? 'none' : `1px solid ${T.border.subtle}`,
    }}>
      {/* Header row: pallet label + badges */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        marginBottom: items.length ? 10 : 0,
      }}>
        <span style={{
          fontFamily: T.font.mono,
          fontSize: 11,
          fontWeight: 600,
          color: T.text.faint,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '0.04em',
          minWidth: 22,
        }}>
          {String(index + 1).padStart(2, '0')}
        </span>
        <button
          onClick={copy}
          title={pallet.id ? 'Paletten-ID kopieren' : ''}
          style={{
            fontFamily: T.font.mono,
            fontSize: 13.5,
            fontWeight: 500,
            color: T.text.primary,
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: pallet.id ? 'pointer' : 'default',
            letterSpacing: '-0.01em',
          }}
        >
          {palletLabel}
          {copied && (
            <span style={{ marginLeft: 8, fontSize: 11, color: T.accent.text, letterSpacing: 0 }}>
              kopiert
            </span>
          )}
        </button>
        <span style={{
          fontSize: 12,
          color: T.text.faint,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {items.length} Pos. · {totalUnits.toLocaleString('de-DE')} Einh.
        </span>
        <span style={{ flex: 1 }} />
        {pallet.hasFourSideWarning && <Badge tone="warn">4-Seiten</Badge>}
        {eskuOnPallet > 0 && <Badge tone="accent">ESKU {eskuOnPallet}</Badge>}
      </div>

      {/* Items list */}
      {items.length > 0 && (
        <ol style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'grid',
          gap: 0,
        }}>
          {items.map((it, i) => (
            <PalletPreviewItem key={i} item={it} />
          ))}
        </ol>
      )}
    </section>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
function PalletPreviewItem({ item }: { item: PreviewItem }) {
  const lvl = getDisplayLevel(item) as number;
  const meta = LEVEL_META[lvl] || LEVEL_META[1];
  const code = item.fnsku || item.sku || item.ean || '—';
  const title = formatItemTitle(item.title || '');
  const qty = Number(item.units) || 0;
  return (
    <li style={{
      display: 'grid',
      gridTemplateColumns: '24px minmax(0, 1fr) auto auto',
      alignItems: 'center',
      gap: 12,
      fontSize: 13,
      color: T.text.secondary,
      padding: '7px 0',
      borderTop: `1px solid ${T.border.subtle}`,
    }}>
      <span
        title={meta.name}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 18,
          fontFamily: T.font.mono,
          fontSize: 10.5,
          fontWeight: 600,
          borderRadius: T.radius.sm,
          background: meta.bg,
          color: meta.text,
          letterSpacing: '0.02em',
        }}
      >
        L{lvl}
      </span>
      <span
        title={item.title || ''}
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: T.text.primary,
          letterSpacing: '-0.005em',
        }}
      >
        {title || '—'}
      </span>
      <span style={{
        fontFamily: T.font.mono,
        fontSize: 11.5,
        color: T.text.faint,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {code}
      </span>
      <span style={{
        fontVariantNumeric: 'tabular-nums',
        fontFamily: T.font.mono,
        fontSize: 12,
        color: qty ? T.text.primary : T.text.faint,
        minWidth: 56,
        textAlign: 'right',
        letterSpacing: '-0.005em',
      }}>
        {qty ? `${qty.toLocaleString('de-DE')}×` : '—'}
      </span>
    </li>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
function Spinner() {
  /* SVG-native rotation — avoids needing a CSS keyframe declaration. */
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <g>
        <circle cx="7" cy="7" r="5" stroke={T.border.strong} strokeWidth="1.5" opacity="0.3" />
        <path d="M12 7a5 5 0 0 0-5-5" stroke={T.accent.main} strokeWidth="1.5" strokeLinecap="round" />
        <animateTransform
          attributeName="transform"
          attributeType="XML"
          type="rotate"
          from="0 7 7"
          to="360 7 7"
          dur="0.8s"
          repeatCount="indefinite"
        />
      </g>
    </svg>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
function LevelBars({ lvlCounts }: { lvlCounts?: Record<string, number> }) {
  const max = Math.max(1, ...(Object.values(lvlCounts || {}) as number[]));
  const W = 6;
  const GAP = 3;
  const H = 28;
  return (
    <div
      title="Level-Verteilung (L1 Thermo · L2 Veit · L3 Öko · L4 Klebe · L5 Produktion · L6 Kernöl · L7 Tacho)"
      style={{
        display: 'inline-flex',
        alignItems: 'flex-end',
        height: H,
        gap: GAP,
        flexShrink: 0,
      }}
    >
      {[1, 2, 3, 4, 5, 6, 7].map((lvl) => {
        const v = lvlCounts?.[lvl] || 0;
        const h = v ? Math.max(2, Math.round((v / max) * H)) : 2;
        const meta = LEVEL_META[lvl];
        return (
          <span
            key={lvl}
            style={{
              width: W,
              height: h,
              borderRadius: 2,
              background: v ? meta.color : T.border.subtle,
              transition: 'height 200ms',
            }}
          />
        );
      })}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
function FingerprintFlags({ fp }) {
  type Flag = { key: string; label: string; tone: 'neutral' | 'accent' | 'warn' | 'success' };
  const flags: Flag[] = [];
  if (fp.mixed > 0)
    flags.push({ key: 'mixed',  label: `${fp.mixed} Mixed`,           tone: 'neutral' });
  if (fp.singleSku > 0)
    flags.push({ key: 'single', label: `${fp.singleSku} Single-SKU`,  tone: 'neutral' });
  if (fp.eskuCount > 0)
    flags.push({ key: 'esku',   label: `${fp.eskuCount} ESKU`,        tone: 'accent' });
  if (fp.mitLst > 0)
    flags.push({ key: 'mitLst', label: `${fp.mitLst} mit LST`,        tone: 'warn' });
  if (fp.ohneLst > 0)
    flags.push({ key: 'ohne',   label: `${fp.ohneLst} ohne LST`,      tone: 'success' });

  if (!flags.length) return null;

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      flexWrap: 'wrap',
    }}>
      {flags.map((f) => (
        <Badge key={f.key} tone={f.tone}>{f.label}</Badge>
      ))}
    </span>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
function Stat({ label, value, accent }: { label?: React.ReactNode; value?: React.ReactNode; accent?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
      <span style={{ color: T.text.faint }}>{label}</span>
      <span style={{
        color: accent ? T.accent.text : T.text.secondary,
        fontWeight: 500,
      }}>
        {value}
      </span>
    </span>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
function IconBtn({ onClick, disabled, title, active, children }: { onClick?: (e: React.MouseEvent) => void; disabled?: boolean; title?: string; active?: boolean; children?: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  const lit = !disabled && (hover || active);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 30, height: 30,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: active ? T.bg.surface3 : lit ? T.bg.surface3 : 'transparent',
        border: '1px solid transparent',
        borderRadius: T.radius.sm,
        color: lit ? T.text.primary : T.text.subtle,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.3 : 1,
        transition: 'background 150ms, color 150ms',
      }}
    >
      {children}
    </button>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
function KbdHints() {
  const items = [
    { k: 'j / k',  v: 'Navigieren' },
    { k: '⏎',      v: 'Starten' },
    { k: '⌘ ↑/↓', v: 'Verschieben' },
    { k: 'x',      v: 'Entfernen' },
    { k: '/',      v: 'Suche' },
  ];
  return (
    <div style={{
      marginTop: 36,
      paddingTop: 20,
      borderTop: `1px solid ${T.border.subtle}`,
      display: 'flex',
      gap: 24,
      flexWrap: 'wrap',
      fontSize: 11.5,
      color: T.text.faint,
      fontFamily: T.font.mono,
      letterSpacing: '0.04em',
    }}>
      {items.map((it) => (
        <span key={it.k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Kbd>{it.k}</Kbd>
          <span>{it.v}</span>
        </span>
      ))}
    </div>
  );
}

function Kbd({ children }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 22, height: 18,
      padding: '0 6px',
      fontSize: 10.5,
      fontFamily: T.font.mono,
      color: T.text.secondary,
      background: T.bg.surface3,
      border: `1px solid ${T.border.primary}`,
      borderRadius: 3,
      lineHeight: 1,
    }}>
      {children}
    </span>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   ═══════════════════════ BETA — paper-island redesign ═══════════════════
   Activated when the global beta-design flag is on. Classic body above is
   untouched. Visual language mirrors BetaPruefen / BetaFocus: paper-island
   #F4F5F7 cards with halo + 2px white rim, Outfit font (via [data-beta=1]
   in index.css), big mono numbers, hairline dividers between rows. The
   inline-accordion preview is replaced with a slide-in side drawer so the
   list never grows by 600px when a worker peeks at a pallet shape.
   ════════════════════════════════════════════════════════════════════════ */

const BETA_PAPER_BG     = '#F4F5F7';
const BETA_PAPER_RIM    = '#FFFFFF';
const BETA_PAPER_RADIUS = 32;
const BETA_INNER_RADIUS = 24;
const BETA_DRAWER_WIDTH = 720;

/* ──────────────────────────────────────────────────────────────────────── */
function BetaWarteschlange({ onRoute }) {
  const {
    queue, current,
    addFiles, startEntry,
    removeFromQueue, reorderQueue, reorderQueueTo, clearQueue,
    joinable, joinAndClaimFirst,
  } = useAppState();

  const [over, setOver]               = useState(false);
  const [busy, setBusy]               = useState(false);
  const [sortMode, setSortMode]       = useState('fifo');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode]   = useState('all');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [dragFromIdx, setDragFromIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [drawerEntryId, setDrawerEntryId] = useState<string | null>(null);
  /* Inline-expansion state for the Nächster Auftrag mini card — keeps
     the preview within the block instead of opening the legacy drawer. */
  const [expandedNextId, setExpandedNextId] = useState<string | null>(null);
  const [flash, setFlash]             = useState<string | null>(null);

  const inputRef  = useRef<HTMLInputElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  /* enrichment per entry — same shape as classic */
  const entries = useMemo(
    () => queue.map((entry) => {
      const pallets       = entry.parsed?.pallets || [];
      const eskuItems     = entry.parsed?.einzelneSkuItems || [];
      const palletCount   = entry.palletCount ?? pallets.length;
      const articleCount  = entry.articleCount
        ?? pallets.reduce((s, p) => s + (p.items?.length || 0), 0);
      const units         = entry.unitsCount ?? entry.parsed?.meta?.totalUnits ?? 0;
      const fp            = pallets.length ? computeFingerprint(pallets, eskuItems) : null;
      const etaSec        = pallets.length ? estimateOrderSeconds(pallets) : null;
      return {
        ...entry,
        _fp: fp,
        _etaSec: etaSec,
        _palletCount: palletCount,
        _articleCount: articleCount,
        _units: units,
      };
    }),
    [queue],
  );

  const visible = useMemo(
    () => filterAndSearch(entries, searchQuery, filterMode)
      .map((e, i) => ({ ...e, _displayIdx: i })),
    [entries, searchQuery, filterMode],
  );

  useEffect(() => {
    if (selectedIdx >= visible.length) {
      setSelectedIdx(Math.max(0, visible.length - 1));
    }
  }, [visible.length, selectedIdx]);

  const headId = useMemo(
    () => queue.find((q) => q.status !== 'error')?.id ?? null,
    [queue],
  );

  /* Close the drawer if its entry left the queue. */
  useEffect(() => {
    if (drawerEntryId && !queue.some((q) => q.id === drawerEntryId)) {
      setDrawerEntryId(null);
    }
  }, [queue, drawerEntryId]);

  /* Auto-dismiss flash messages after 2.5s. */
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  /* Lock body scroll while the drawer is open (matches modal convention). */
  useEffect(() => {
    if (!drawerEntryId) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [drawerEntryId]);

  const totals = useMemo(
    () => entries.reduce((acc: { pallets: number; articles: number; units: number; etaSec: number }, e) => ({
      pallets:  acc.pallets  + e._palletCount,
      articles: acc.articles + e._articleCount,
      units:    acc.units    + Number(e._units || 0),
      etaSec:   acc.etaSec   + (e._etaSec ?? 0),
    }), { pallets: 0, articles: 0, units: 0, etaSec: 0 }),
    [entries],
  );

  const acceptFiles = useCallback(async (fl: FileList | File[] | null) => {
    const arr = Array.from(fl || []).filter((f: File) => /\.docx$/i.test(f.name));
    if (!arr.length) return;
    setBusy(true);
    try {
      const built = await addFiles(arr);
      if (!current && queue.length === 0 && built[0]?.status === 'ready') {
        setTimeout(() => startEntry(built[0].id), 100);
      }
    } finally {
      setBusy(false);
    }
  }, [addFiles, current, queue.length, startEntry]);

  const applySort = useCallback((mode) => {
    setSortMode(mode);
    if (mode === 'fifo') return;
    const sorted = sortEntries(entries, mode);
    const orderedIds = sorted.map((e) => e.id);
    reorderQueueTo(orderedIds);
  }, [entries, reorderQueueTo]);

  /* drag-and-drop reorder — same as classic, only the visual indicator differs */
  const onDragStart = (idx) => (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
    setDragFromIdx(idx);
  };
  const onDragOver = (idx) => (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragFromIdx === null) return;
    if (idx !== dragOverIdx) setDragOverIdx(idx);
  };
  const onDrop = (idx) => (e) => {
    e.preventDefault();
    if (dragFromIdx !== null && dragFromIdx !== idx) {
      const from = visible[dragFromIdx];
      const to   = visible[idx];
      const fromQ = queue.findIndex((q) => q.id === from?.id);
      const toQ   = queue.findIndex((q) => q.id === to?.id);
      if (fromQ >= 0 && toQ >= 0) reorderQueue(fromQ, toQ);
    }
    setDragFromIdx(null);
    setDragOverIdx(null);
  };
  const onDragEnd = () => {
    setDragFromIdx(null);
    setDragOverIdx(null);
  };

  /* keyboard cockpit — extended: Esc closes the drawer first, then clears
     search, then sheds selection */
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable;

      if (e.key === '/' && !inField) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'Escape') {
        if (drawerEntryId) {
          setDrawerEntryId(null);
          return;
        }
        if (document.activeElement === searchRef.current) {
          searchRef.current?.blur();
          if (searchQuery) setSearchQuery('');
          return;
        }
      }
      if (inField) return;
      if (!visible.length) return;

      if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowDown') {
        e.preventDefault();
        const target = visible[selectedIdx];
        const idx = queue.findIndex((q) => q.id === target?.id);
        if (idx >= 0 && idx < queue.length - 1) reorderQueue(idx, idx + 1);
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowUp') {
        e.preventDefault();
        const target = visible[selectedIdx];
        const idx = queue.findIndex((q) => q.id === target?.id);
        if (idx > 0) reorderQueue(idx, idx - 1);
      } else if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(visible.length - 1, i + 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const target = visible[selectedIdx];
        if (!target || current || target.status === 'error') return;
        if (headId && target.id !== headId) {
          setFlash('Reihenfolge beachten — erst den obersten Auftrag starten.');
          return;
        }
        startEntry(target.id);
        if (onRoute) onRoute('workspace');
      } else if (e.key === 'x' || e.key === 'Delete') {
        e.preventDefault();
        const target = visible[selectedIdx];
        if (target) removeFromQueue(target.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    visible, selectedIdx, queue, current, searchQuery, headId, drawerEntryId,
    startEntry, removeFromQueue, reorderQueue, onRoute,
  ]);

  const hasQueue = entries.length > 0;
  const noResults = hasQueue && visible.length === 0;
  const headEntry = visible.find((e) => e.id === headId) || null;
  const secondaryEntries = headEntry
    ? visible.filter((e) => e.id !== headEntry.id)
    : visible;
  const drawerEntry = useMemo(
    () => (drawerEntryId ? entries.find((e) => e.id === drawerEntryId) || null : null),
    [entries, drawerEntryId],
  );

  /* row handler factory — shared by NEXT card and secondary rows */
  const rowHandlers = (entry, displayIdx) => {
    const qi = queue.findIndex((q) => q.id === entry.id);
    return {
      onSelect: () => setSelectedIdx(displayIdx),
      onStart: () => {
        if (entry.status === 'error') return;
        if (headId && entry.id !== headId) {
          setFlash('Reihenfolge beachten — erst den obersten Auftrag starten.');
          return;
        }
        startEntry(entry.id);
        if (onRoute) onRoute('workspace');
      },
      onRemove: () => removeFromQueue(entry.id),
      onPreview: () => setDrawerEntryId(entry.id),
      onUp:   qi > 0 ? () => reorderQueue(qi, qi - 1) : null,
      onDown: qi >= 0 && qi < queue.length - 1 ? () => reorderQueue(qi, qi + 1) : null,
      onDragStart: onDragStart(displayIdx),
      onDragOver:  onDragOver(displayIdx),
      onDrop:      onDrop(displayIdx),
      onDragEnd,
      isDragging:  dragFromIdx === displayIdx,
      isDropAbove: dragFromIdx !== null && dragOverIdx === displayIdx && dragFromIdx > displayIdx,
      isDropBelow: dragFromIdx !== null && dragOverIdx === displayIdx && dragFromIdx < displayIdx,
    };
  };

  return (
    <Page>
      <BetaWarteschlangeStyles />

      <main style={{
        maxWidth: 1080,
        margin: '0 auto',
        padding: '32px 32px 180px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}>
        <input
          ref={inputRef}
          type="file"
          accept=".docx"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { acceptFiles(e.target.files); e.target.value = ''; }}
        />

        {/* HERO — when a workflow is in progress, the active Auftrag is the
            dominant card; the head-of-queue is rendered as a bare mini
            panel INSIDE the same paper island so «In Bearbeitung» and
            «Nächster Auftrag» read as one combined unit. When no workflow
            is active, the head-of-queue takes the full hero treatment so
            the worker sees what to start next. */}
        {current ? (
          (() => {
            const headDisplayIdx = headEntry
              ? visible.findIndex((e) => e.id === headEntry.id)
              : -1;
            const nextSlot = (hasQueue && !noResults && headEntry && headDisplayIdx >= 0) ? (
              <BetaNextMiniCard
                bare
                entry={headEntry}
                queueIdx={queue.findIndex((q) => q.id === headEntry.id)}
                isSelected={headDisplayIdx === selectedIdx}
                isExpanded={expandedNextId === headEntry.id}
                onToggleExpand={() => setExpandedNextId(
                  (prev) => prev === headEntry.id ? null : headEntry.id,
                )}
                {...rowHandlers(headEntry, headDisplayIdx)}
              />
            ) : null;
            return (
              <BetaCurrentHeroCard
                current={current}
                onRoute={onRoute}
                nextSlot={nextSlot}
              />
            );
          })()
        ) : hasQueue && !noResults && headEntry && (() => {
          const displayIdx = visible.findIndex((e) => e.id === headEntry.id);
          return (
            <BetaNextCard
              entry={headEntry}
              queueIdx={queue.findIndex((q) => q.id === headEntry.id)}
              isSelected={displayIdx === selectedIdx}
              hasCurrent={false}
              {...rowHandlers(headEntry, displayIdx)}
            />
          );
        })()}

        {/* AKTIVE SITZUNGEN ANDERER WORKER — BEITRETEN (Beta) */}
        {!current && joinable.length > 0 && (
          <BetaJoinableSection
            joinable={joinable}
            onJoin={async (id) => {
              const ok = await joinAndClaimFirst(id);
              if (ok && onRoute) onRoute('workspace');
            }}
          />
        )}

        {/* SECONDARY rows */}
        {hasQueue && !noResults && secondaryEntries.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 6 }}>
            <div style={{ paddingLeft: 4 }}>
              <BetaEyebrow>
                Danach · {secondaryEntries.length} {secondaryEntries.length === 1 ? 'weiterer' : 'weitere'}
              </BetaEyebrow>
            </div>
            <BetaPaperCard>
              <BetaWhitePanel padding="6px 8px">
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {secondaryEntries.map((entry, k) => {
                    const displayIdx = visible.findIndex((e) => e.id === entry.id);
                    return (
                      <BetaQueueRow
                        key={entry.id}
                        entry={entry}
                        queueIdx={queue.findIndex((q) => q.id === entry.id)}
                        isSelected={displayIdx === selectedIdx}
                        hasCurrent={!!current}
                        isFirst={k === 0}
                        isLast={k === secondaryEntries.length - 1}
                        {...rowHandlers(entry, displayIdx)}
                      />
                    );
                  })}
                </ul>
              </BetaWhitePanel>
            </BetaPaperCard>
          </div>
        )}

        {/* NO RESULTS */}
        {noResults && (
          <BetaPaperCard>
            <BetaWhitePanel padding="36px 32px">
              <div style={{ textAlign: 'center', color: T.text.subtle, fontSize: 13.5 }}>
                Keine Aufträge passen zu Suche oder Filter.
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}>
                <button
                  type="button"
                  onClick={() => { setSearchQuery(''); setFilterMode('all'); }}
                  style={{
                    all: 'unset',
                    cursor: 'pointer',
                    padding: '8px 16px',
                    borderRadius: 999,
                    background: BETA_PAPER_BG,
                    fontFamily: T.font.ui,
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: T.text.secondary,
                  }}
                >
                  Filter zurücksetzen
                </button>
              </div>
            </BetaWhitePanel>
          </BetaPaperCard>
        )}

        {/* EMPTY */}
        {!hasQueue && (
          <BetaQueueEmpty
            over={over}
            busy={busy}
            onPick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); acceptFiles(e.dataTransfer.files); }}
          />
        )}

        {hasQueue && <BetaKbdHints />}
      </main>

      {/* BOTTOM DOCK — floating island with search/sort/filter/upload */}
      <BetaActionDock
        entryCount={entries.length}
        showControls={entries.length >= 2}
        showSearch={entries.length >= 5}
        searchQuery={searchQuery} onSearch={setSearchQuery} searchRef={searchRef}
        sortMode={sortMode} onSortMode={applySort}
        filterMode={filterMode} onFilter={setFilterMode}
        onClearQueue={clearQueue}
        over={over} busy={busy}
        onPickFile={() => inputRef.current?.click()}
        onFileDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onFileDragLeave={() => setOver(false)}
        onFileDrop={(e) => { e.preventDefault(); setOver(false); acceptFiles(e.dataTransfer.files); }}
      />

      {/* DRAWER + backdrop */}
      {drawerEntry && (
        <BetaPreviewDrawer
          entry={drawerEntry}
          onClose={() => setDrawerEntryId(null)}
        />
      )}

      {/* FLASH */}
      {flash && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            left: '50%',
            bottom: 32,
            transform: 'translateX(-50%)',
            padding: '12px 20px',
            background: T.text.primary,
            color: '#FFFFFF',
            fontFamily: T.font.ui,
            fontSize: 13,
            letterSpacing: '-0.005em',
            borderRadius: 14,
            boxShadow: '0 18px 38px rgba(0,0,0,0.22)',
            zIndex: 1200,
          }}
        >
          {flash}
        </div>
      )}
    </Page>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Beta atoms — cloned from BetaPruefen for visual consistency.
   ════════════════════════════════════════════════════════════════════════ */

/* Beta-Variante der "Beitreten"-Section. Visuell konsistent mit dem
   Hero-Stil (BetaPaperCard + BetaEyebrow), aber jede Zeile ist ein
   klickbarer Übernehmen-Trigger, der joinAndClaimFirst auslöst. */
function BetaJoinableSection({ joinable, onJoin }: { joinable: LegacyAuftrag[]; onJoin: (id: string) => void }) {
  return (
    <div style={{ marginTop: 6, marginBottom: 18 }}>
      <div style={{ paddingLeft: 4, marginBottom: 8 }}>
        <BetaEyebrow color={T.accent.text} dot>
          Aktive Sitzungen · Beitreten · {joinable.length}
        </BetaEyebrow>
      </div>
      <BetaPaperCard>
        <BetaWhitePanel padding="6px 8px">
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {joinable.map((entry, k) => {
              const fba = entry.fbaCode || entry.fileName;
              const total = entry.palletCount ?? 0;
              const occupied = new Set(
                (entry.palletClaims ?? [])
                  .filter((c) => c.state === 'active' || c.state === 'completed')
                  .map((c) => c.palletIdx),
              );
              const freeCount = Math.max(0, total - occupied.size);
              const primary = entry.assignedToUserName || 'Andere';
              const isLast = k === joinable.length - 1;
              return (
                <li
                  key={entry.id}
                  onClick={() => freeCount > 0 && onJoin(entry.id)}
                  style={{
                    padding: '10px 12px',
                    borderBottom: isLast ? undefined : `1px dashed ${T.border.subtle}`,
                    cursor: freeCount > 0 ? 'pointer' : 'not-allowed',
                    opacity: freeCount > 0 ? 1 : 0.55,
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    alignItems: 'center',
                    gap: 16,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      fontFamily: T.font.mono, fontSize: 14, fontWeight: 500,
                      color: T.text.primary,
                    }}>
                      {fba}
                    </div>
                    <div style={{
                      marginTop: 2, fontSize: 11, color: T.text.subtle,
                    }}>
                      {primary} · {freeCount} freie Palette{freeCount === 1 ? '' : 'n'} · {total} gesamt
                    </div>
                  </div>
                  <span style={{
                    padding: '6px 14px',
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: freeCount > 0 ? T.accent.text : T.text.muted,
                    background: freeCount > 0 ? T.accent.bg : T.bg.surface2,
                    border: `1px solid ${freeCount > 0 ? T.accent.border : T.border.subtle}`,
                    borderRadius: T.radius.full,
                  }}>
                    {freeCount > 0 ? 'Übernehmen →' : 'Voll'}
                  </span>
                </li>
              );
            })}
          </ul>
        </BetaWhitePanel>
      </BetaPaperCard>
    </div>
  );
}

function BetaWarteschlangeStyles() {
  return (
    <style>{`
      @keyframes mb-q-rise {
        0%   { opacity: 0; transform: translateY(8px); }
        100% { opacity: 1; transform: translateY(0); }
      }
      @keyframes mb-q-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(255,91,31,0.0); }
        50%      { box-shadow: 0 0 0 8px rgba(255,91,31,0.18); }
      }
      @keyframes mb-q-drawer-in {
        0%   { opacity: 0; transform: translate(-50%, -48%) scale(0.96); }
        100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      }
      @keyframes mb-q-backdrop-in {
        0%   { opacity: 0; }
        100% { opacity: 1; }
      }
      @keyframes mb-q-spin {
        to { transform: rotate(360deg); }
      }
      @keyframes mb-q-menu-in {
        0%   { opacity: 0; transform: translateY(6px) scale(0.97); }
        100% { opacity: 1; transform: translateY(0)   scale(1);    }
      }
      @media (max-width: 900px) {
        .mb-q-drawer { width: calc(100vw - 24px) !important; max-height: calc(100vh - 24px) !important; }
        .mb-q-backdrop { background: rgba(15,23,42,0.42) !important; }
      }
      .mb-q-row:hover .mb-q-row-actions { opacity: 1; }
      .mb-q-row:hover .mb-q-row-fba    { color: ${T.text.primary}; }
    `}</style>
  );
}

function BetaPaperCard({ children, glow = false, flat = false, padding = 8 }: { children?: React.ReactNode; glow?: boolean; flat?: boolean; padding?: number }) {
  const shadow = flat
    ? 'none'
    : glow
      ? '0 0 0 0.5px rgba(255,91,31,0.18), 0 16px 48px rgba(255,91,31,0.10), 0 0 89.7px rgba(0,0,0,0.05)'
      : '0 0 89.7px rgba(0,0,0,0.05)';
  return (
    <div style={{
      padding,
      background: BETA_PAPER_BG,
      border: `2px solid ${BETA_PAPER_RIM}`,
      borderRadius: BETA_PAPER_RADIUS,
      boxShadow: shadow,
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
      borderRadius: BETA_INNER_RADIUS,
      padding: padding || '22px 26px',
    }}>
      {children}
    </div>
  );
}

function BetaEyebrow({ children, color, dot }: { children?: React.ReactNode; color?: string; dot?: boolean }) {
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 10.5,
      fontWeight: 700,
      fontFamily: T.font.mono,
      color: color || T.text.faint,
      textTransform: 'uppercase',
      letterSpacing: '0.18em',
    }}>
      {dot && (
        <span style={{
          width: 7, height: 7,
          borderRadius: '50%',
          background: color || T.accent.main,
        }} />
      )}
      <span>{children}</span>
    </div>
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

function BetaKbd({ children, dim = false }: { children?: React.ReactNode; dim?: boolean }) {
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
      color: dim ? T.text.faint : T.text.secondary,
      background: dim ? 'transparent' : BETA_PAPER_BG,
      borderRadius: 6,
      lineHeight: 1,
      letterSpacing: '0.04em',
    }}>{children}</span>
  );
}

function BetaBigCopy({ value, rawValue, size = 'lg' }: { value: React.ReactNode; rawValue: string; size?: 'lg' | 'md' }) {
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
      style={{
        all: 'unset',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '6px 10px',
        marginLeft: -10,
        background: copied ? T.status.success.bg : 'transparent',
        borderRadius: 12,
        transition: 'background 220ms ease',
      }}
    >
      <span style={{
        fontFamily: T.font.mono,
        fontSize: size === 'lg' ? 'clamp(28px, 3.8vw, 44px)' : 'clamp(18px, 2vw, 22px)',
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
  } catch { /* silent */ }
}

/* ════════════════════════════════════════════════════════════════════════
   Action Dock — fixed-bottom floating paper-island that consolidates
   upload + search + sort + filter + bulk-remove in one compact row.
   Replaces the old cockpit; keeps the controls always within thumb-reach
   without competing with the queue content above.
   ════════════════════════════════════════════════════════════════════════ */

function BetaActionDock({
  entryCount,
  showControls, showSearch,
  searchQuery, onSearch, searchRef,
  sortMode, onSortMode,
  filterMode, onFilter,
  onClearQueue,
  over, busy,
  onPickFile, onFileDragOver, onFileDragLeave, onFileDrop,
}) {
  /* When queue is empty the EmptyState big dropzone is the primary CTA —
     hide the dock so it doesn't compete. */
  const [openMenu, setOpenMenu] = useState<'sort' | 'filter' | null>(null);

  /* Click-outside + Esc close. Capture-phase mousedown so a click on a
     menu item still gets to fire its own handler before the outside
     listener fires on the document target. */
  useEffect(() => {
    if (!openMenu) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('[data-dock-menu]')) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  if (entryCount === 0) return null;

  const currentSort   = SORT_MODES.find((m) => m.id === sortMode)   || SORT_MODES[0];
  const currentFilter = FILTER_MODES.find((m) => m.id === filterMode) || FILTER_MODES[0];

  return (
    <div style={{
      position: 'fixed',
      bottom: 18,
      left: '50%',
      transform: 'translateX(-50%)',
      maxWidth: 'calc(100vw - 24px)',
      zIndex: 60,
      pointerEvents: 'auto',
      borderRadius: BETA_PAPER_RADIUS,
      boxShadow: 'rgba(0, 0, 0, 0.05) 0px 0px 89.7px 0px',
    }}>
      <BetaPaperCard padding={8}>
        <div style={{
          padding: '4px 6px',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexWrap: 'nowrap',
        }}>
            <BetaDockUploadButton
              over={over} busy={busy}
              onPickFile={onPickFile}
              onDragOver={onFileDragOver}
              onDragLeave={onFileDragLeave}
              onDrop={onFileDrop}
            />

            {showSearch && (
              <>
                <BetaDockSep />
                <BetaSearchInput
                  value={searchQuery}
                  onChange={onSearch}
                  refEl={searchRef}
                  placeholder="FBA / Datei…"
                  compact
                />
              </>
            )}

            {showControls && (
              <>
                <BetaDockSep />
                <BetaDockMenu
                  label="Sortieren"
                  current={currentSort.label}
                  open={openMenu === 'sort'}
                  onToggle={() => setOpenMenu((c) => c === 'sort' ? null : 'sort')}
                  icon={
                    <svg width="12" height="12" viewBox="0 0 14 14" fill="none"
                         stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 4h8M4 7h6M5 10h4" />
                    </svg>
                  }
                  options={SORT_MODES.map((m) => ({
                    id: m.id, label: m.label, hint: m.hint, active: sortMode === m.id,
                  }))}
                  onPick={(id) => { onSortMode(id); setOpenMenu(null); }}
                />
              </>
            )}

            {showSearch && (
              <>
                <BetaDockSep />
                <BetaDockMenu
                  label="Filter"
                  current={currentFilter.label}
                  open={openMenu === 'filter'}
                  onToggle={() => setOpenMenu((c) => c === 'filter' ? null : 'filter')}
                  icon={
                    <svg width="12" height="12" viewBox="0 0 14 14" fill="none"
                         stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2 3h10l-3.5 4.5V11l-3 1.5V7.5z" />
                    </svg>
                  }
                  options={FILTER_MODES.map((m) => ({
                    id: m.id, label: m.label, hint: null, active: filterMode === m.id,
                  }))}
                  onPick={(id) => { onFilter(id); setOpenMenu(null); }}
                />
              </>
            )}

            {entryCount >= 2 && (
              <>
                <BetaDockSep />
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`${entryCount} Aufträge wirklich aus der Warteschlange entfernen?`)) {
                      onClearQueue();
                    }
                  }}
                  title={`Alle ${entryCount} aus Warteschlange entfernen`}
                  style={{
                    all: 'unset',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 32, height: 32,
                    borderRadius: 999,
                    color: T.text.subtle,
                    transition: 'background 160ms ease, color 160ms ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = T.status.danger.bg;
                    e.currentTarget.style.color = T.status.danger.text;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = T.text.subtle;
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                    <path d="M2 4h10M5 4V2.5h4V4M3.5 4l.5 8h6l.5-8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </>
            )}
        </div>
      </BetaPaperCard>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
/* Dock menu — compact pill trigger that opens a popover upward.            */
function BetaDockMenu({
  label, current, open, onToggle, options, onPick, icon,
}: {
  label: string;
  current: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  options: Array<{ id: string; label: React.ReactNode; hint?: string | null; active?: boolean }>;
  onPick: (id: string) => void;
  icon?: React.ReactNode;
}) {
  return (
    <div data-dock-menu style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={onToggle}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '7px 12px',
          borderRadius: 999,
          background: open ? '#FFFFFF' : 'transparent',
          color: open ? T.text.primary : T.text.secondary,
          fontFamily: T.font.ui,
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '-0.005em',
          transition: 'background 160ms ease, color 160ms ease',
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.background = '#FFFFFF';
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = 'transparent';
        }}
      >
        {icon && (
          <span style={{
            display: 'inline-flex',
            color: T.text.faint,
          }}>
            {icon}
          </span>
        )}
        <span>{current}</span>
        <svg
          width="9" height="9" viewBox="0 0 10 10" fill="none"
          style={{
            color: T.text.faint,
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 200ms cubic-bezier(0.16,1,0.3,1)',
          }}
        >
          <path d="M2.5 4l2.5 2.5L7.5 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            left: 0,
            minWidth: 200,
            padding: 6,
            background: BETA_PAPER_BG,
            border: `2px solid ${BETA_PAPER_RIM}`,
            borderRadius: 18,
            boxShadow: '0 16px 48px rgba(15,23,42,0.18), 0 0 89.7px rgba(0,0,0,0.05)',
            animation: 'mb-q-menu-in 200ms cubic-bezier(0.16,1,0.3,1)',
          }}
        >
          <div style={{
            background: '#FFFFFF',
            borderRadius: 12,
            padding: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}>
            {options.map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="menuitem"
                onClick={(e) => { e.stopPropagation(); onPick(opt.id); }}
                title={opt.hint || undefined}
                style={{
                  all: 'unset',
                  cursor: 'pointer',
                  display: 'grid',
                  gridTemplateColumns: '14px 1fr auto',
                  alignItems: 'center',
                  gap: 10,
                  padding: '9px 12px',
                  borderRadius: 10,
                  background: opt.active ? T.accent.bg : 'transparent',
                  color: opt.active ? T.accent.text : T.text.primary,
                  fontFamily: T.font.ui,
                  fontSize: 12.5,
                  fontWeight: opt.active ? 600 : 500,
                  letterSpacing: '-0.005em',
                  transition: 'background 140ms ease',
                }}
                onMouseEnter={(e) => {
                  if (!opt.active) e.currentTarget.style.background = BETA_PAPER_BG;
                }}
                onMouseLeave={(e) => {
                  if (!opt.active) e.currentTarget.style.background = 'transparent';
                }}
              >
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 14, height: 14,
                  color: opt.active ? T.accent.text : 'transparent',
                }}>
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                    <path d="M2.5 6.5l2 2 5-5.5" stroke="currentColor" strokeWidth="2"
                          strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span>{opt.label}</span>
                {opt.hint && (
                  <span style={{
                    fontSize: 10.5,
                    color: T.text.faint,
                    fontWeight: 500,
                    letterSpacing: 0,
                  }}>
                    {opt.hint.length > 22 ? opt.hint.slice(0, 22) + '…' : opt.hint}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BetaDockSep() {
  return (
    <span aria-hidden style={{
      width: 1,
      height: 22,
      background: 'rgba(15,23,42,0.08)',
      margin: '0 4px',
      flexShrink: 0,
    }} />
  );
}

function BetaDockUploadButton({ over, busy, onPickFile, onDragOver, onDragLeave, onDrop }) {
  return (
    <button
      type="button"
      onClick={onPickFile}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      title=".docx anhängen oder hierher ziehen"
      style={{
        all: 'unset',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 14px 7px 10px',
        borderRadius: 999,
        background: over ? T.accent.bg : '#FFFFFF',
        boxShadow: over ? `inset 0 0 0 1.5px var(--accent)` : 'none',
        transition: 'background 180ms ease, box-shadow 180ms ease',
        flexShrink: 0,
      }}
    >
      <span style={{
        width: 24, height: 24,
        borderRadius: 999,
        background: over ? 'var(--accent)' : BETA_PAPER_BG,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: over ? '#FFFFFF' : T.text.subtle,
        flexShrink: 0,
        transition: 'background 180ms ease, color 180ms ease',
      }}>
        {busy ? (
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none"
               style={{ animation: 'mb-q-spin 800ms linear infinite' }}>
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.6" />
            <path d="M12 7a5 5 0 0 0-5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none"
               stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 10V3M4 6l3-3 3 3" />
          </svg>
        )}
      </span>
      <span style={{
        fontFamily: T.font.ui,
        fontSize: 12.5,
        fontWeight: 600,
        color: over ? T.accent.text : T.text.primary,
        letterSpacing: '-0.005em',
        transition: 'color 180ms ease',
      }}>
        {busy ? 'Lädt…' : (over ? 'Loslassen' : '.docx')}
      </span>
    </button>
  );
}

function BetaKpiMetric({ value, label, accent = false }: { value: React.ReactNode; label: React.ReactNode; accent?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'baseline',
      gap: 8,
      padding: '0 8px',
    }}>
      <span style={{
        fontSize: 'clamp(22px, 2.4vw, 30px)',
        fontWeight: 600,
        color: accent ? T.accent.text : T.text.primary,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '-0.022em',
        fontFamily: T.font.ui,
      }}>
        {value}
      </span>
      <span style={{
        fontSize: 10.5,
        color: T.text.faint,
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        fontFamily: T.font.mono,
        fontWeight: 600,
      }}>
        {label}
      </span>
    </span>
  );
}

function BetaKpiSep() {
  return (
    <span aria-hidden style={{
      width: 1,
      height: 22,
      background: 'rgba(15,23,42,0.10)',
      margin: '0 14px',
      alignSelf: 'center',
    }} />
  );
}

function BetaSearchInput({ value, onChange, refEl, placeholder, compact = false }: any) {
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: compact ? 6 : 8,
      padding: compact ? '6px 10px' : '7px 14px',
      background: '#FFFFFF',
      borderRadius: 999,
      minWidth: compact ? 180 : 240,
      flex: compact ? '0 1 220px' : '1 1 240px',
      maxWidth: compact ? 240 : 360,
    }}>
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none"
           stroke={T.text.faint} strokeWidth="1.6" strokeLinecap="round">
        <circle cx="6" cy="6" r="4" />
        <path d="M9 9l3 3" />
      </svg>
      <input
        ref={refEl}
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
      <BetaKbd dim>/</BetaKbd>
    </div>
  );
}

function BetaSortChip({ active, onClick, title, children }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      style={{
        all: 'unset',
        cursor: 'pointer',
        padding: '7px 13px',
        borderRadius: 999,
        background: active ? T.text.primary : (hover ? '#FFFFFF' : 'transparent'),
        color: active ? '#FFFFFF' : T.text.secondary,
        fontFamily: T.font.ui,
        fontSize: 12,
        fontWeight: active ? 600 : 500,
        letterSpacing: '-0.005em',
        transition: 'background 160ms ease, color 160ms ease',
      }}
    >
      {children}
    </button>
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
        padding: '7px 12px',
        borderRadius: 999,
        background: active ? T.accent.bg : 'transparent',
        fontFamily: T.font.ui,
        fontSize: 12,
        fontWeight: 600,
        color: active ? T.accent.text : T.text.subtle,
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

function BetaDropPill({ over, busy, onPickFile, onDragOver, onDragLeave, onDrop }) {
  return (
    <button
      type="button"
      onClick={onPickFile}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        all: 'unset',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 22px',
        borderRadius: BETA_INNER_RADIUS,
        background: over ? T.accent.bg : '#FFFFFF',
        boxShadow: over ? `inset 0 0 0 2px var(--accent)` : 'inset 0 0 0 1px rgba(15,23,42,0.06)',
        transition: 'background 200ms ease, box-shadow 200ms ease',
      }}
    >
      <span style={{
        width: 32, height: 32,
        borderRadius: 999,
        background: over ? 'var(--accent)' : BETA_PAPER_BG,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: over ? '#FFFFFF' : T.text.subtle,
        transition: 'background 200ms ease, color 200ms ease',
      }}>
        {busy ? (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"
               style={{ animation: 'mb-q-spin 800ms linear infinite' }}>
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.6" />
            <path d="M12 7a5 5 0 0 0-5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"
               stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 10V3M4 6l3-3 3 3M2.5 11.5h9" />
          </svg>
        )}
      </span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{
          fontFamily: T.font.ui,
          fontSize: 13.5,
          fontWeight: 600,
          color: over ? T.accent.text : T.text.primary,
          letterSpacing: '-0.005em',
        }}>
          {busy ? '.docx wird verarbeitet…' : (over ? 'Loslassen — Datei hinzufügen' : '.docx anhängen oder hierher ziehen')}
        </span>
        <span style={{
          fontFamily: T.font.mono,
          fontSize: 10.5,
          color: T.text.faint,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}>
          Lagerauftrag · mehrere möglich
        </span>
      </div>
      <span style={{ flex: 1 }} />
      <span style={{
        padding: '7px 13px',
        borderRadius: 999,
        background: BETA_PAPER_BG,
        fontFamily: T.font.ui,
        fontSize: 12,
        fontWeight: 600,
        color: T.text.secondary,
      }}>
        Datei wählen
      </span>
    </button>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Current-Auftrag hero — dominant paper-island when a workflow is active.
   Same visual rhythm as BetaNextCard (big mono FBA, hairline-divided rows,
   primary CTA) but tailored for in-progress data (palette x/y, progress
   bar, Fortsetzen instead of Starten).
   ════════════════════════════════════════════════════════════════════════ */

function BetaCurrentHeroCard({ current, onRoute, nextSlot = null }: {
  current: any;
  onRoute?: (r: string) => void;
  /* Optional second panel rendered INSIDE the same paper-island —
     used to merge the "Nächster Auftrag" mini card under the current
     hero so both cards share one paper rim. Pass a <BetaNextMiniCard
     bare ... /> here. */
  nextSlot?: React.ReactNode;
}) {
  const fba = current.parsed?.meta?.sendungsnummer
    || current.parsed?.meta?.fbaCode
    || current.fileName;
  const fileName = current.fileName;
  const pallets  = current.parsed?.pallets || [];
  const totalP   = pallets.length;
  const curIdx   = current.currentPalletIdx ?? 0;
  const curNum   = curIdx + 1;
  const pct      = totalP ? Math.round((curIdx / totalP) * 100) : 0;
  const totalArticles = pallets.reduce((s, p) => s + (p.items?.length || 0), 0);
  const totalUnits    = current.parsed?.meta?.totalUnits
    ?? pallets.reduce((s, p) => s + (p.items || []).reduce((u, it) => u + (Number(it.units) || 0), 0), 0);
  const remainingSec = pallets.length
    ? estimateOrderSeconds(pallets.slice(curIdx))
    : null;

  return (
    <BetaPaperCard flat>
      {/* In Bearbeitung — bare panel: no white surface so the section
          blends into the paper-island bg. Only the Nächster Auftrag mini
          (rendered via nextSlot) keeps its white card, giving the
          combined island a clear figure/ground hierarchy: current step
          sits ON the paper, next-up sits ABOVE it. */}
      <div style={{ padding: '28px 32px 26px' }}>
        {/* eyebrow + status row */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          marginBottom: 14,
          flexWrap: 'wrap',
        }}>
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 10.5,
            fontWeight: 700,
            fontFamily: T.font.mono,
            color: T.accent.text,
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
          }}>
            <span style={{
              width: 8, height: 8,
              borderRadius: '50%',
              background: T.accent.main,
              boxShadow: `0 0 0 0 ${T.accent.main}`,
              animation: 'mb-q-pulse 1800ms ease-in-out infinite',
            }} />
            In Bearbeitung
          </span>
          <BetaStatusPill tone="accent">Live · {pct}%</BetaStatusPill>
        </div>

        {/* big mono FBA */}
        <BetaBigCopy value={fba} rawValue={String(fba || '')} />

        {/* meta line — filename + remaining time */}
        <div style={{
          marginTop: 6,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          fontSize: 12.5,
          color: T.text.subtle,
          fontVariantNumeric: 'tabular-nums',
        }}>
          <span title={fileName} style={{
            maxWidth: 360,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {fileName}
          </span>
          {remainingSec != null && (
            <>
              <BetaMetaDot />
              <span style={{ color: T.accent.text, fontWeight: 600 }}>
                noch ≈ {fmtDuration(remainingSec)}
              </span>
            </>
          )}
        </div>

        {/* progress bar */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          marginTop: 20,
        }}>
          <span style={{
            flex: 1,
            height: 10,
            borderRadius: 5,
            background: BETA_PAPER_BG,
            overflow: 'hidden',
            position: 'relative',
          }}>
            <span style={{
              display: 'block',
              height: '100%',
              width: `${pct}%`,
              background: T.accent.main,
              borderRadius: 5,
              transition: 'width 320ms cubic-bezier(0.16,1,0.3,1)',
            }} />
          </span>
          <span style={{
            minWidth: 56,
            textAlign: 'right',
            fontFamily: T.font.mono,
            fontSize: 16,
            fontWeight: 600,
            color: T.text.primary,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.012em',
          }}>
            {pct}%
          </span>
        </div>

        {/* stats + CTA */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          flexWrap: 'wrap',
          marginTop: 18,
        }}>
          <BetaStat value={totalP} label="Paletten" />
          <BetaStat value={totalArticles.toLocaleString('de-DE')} label="Artikel" />
          <BetaStat value={(Number(totalUnits) || 0).toLocaleString('de-DE')} label="Einheiten" />
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => onRoute && onRoute('workspace')}
            style={{
              all: 'unset',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 10,
              padding: '12px 22px',
              borderRadius: 999,
              background: T.accent.main,
              color: '#FFFFFF',
              fontFamily: T.font.ui,
              fontSize: 13.5,
              fontWeight: 600,
              letterSpacing: '-0.005em',
              transition: 'transform 160ms ease',
            }}
          >
            Fortsetzen
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M3 6h6m0 0L6 3m3 3L6 9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
      {/* Optional Nächster-Auftrag panel — shares this paper island so
          both cards read as one cohesive «what you're on + what's next»
          unit instead of two visually-disconnected stacks. */}
      {nextSlot}
    </BetaPaperCard>
  );
}

/* ────────────────────────────────────────────────────────────────────────
   Mini next-up card — compact paper-island shown when a workflow is active.
   Reminds the worker which Auftrag will come next without competing with
   the Fortsetzen hero. Cannot be started directly (current must finish);
   surfaces Vorschau + reorder + remove inline.
   ──────────────────────────────────────────────────────────────────────── */

function BetaNextMiniCard({
  entry, queueIdx, isSelected,
  onSelect, onRemove, onPreview, onUp, onDown,
  onDragStart, onDragOver, onDrop, onDragEnd,
  isDragging, isDropAbove, isDropBelow,
  /* `bare` — render the inner WhitePanel directly without an outer
     BetaPaperCard. Used when this mini sits inside another paper
     island (e.g. merged under BetaCurrentHeroCard via nextSlot). */
  bare = false,
  /* Inline expansion — when true, the card unfolds the same content the
     old Vorschau drawer used to show (pallets list with positions). No
     popup, no overlay; the block grows in place. */
  isExpanded = false,
  onToggleExpand,
}: any) {
  const fba = entry.parsed?.meta?.sendungsnummer
    || entry.parsed?.meta?.fbaCode
    || entry.fileName;
  const isError = entry.status === 'error';
  const validErrors = entry.validation?.errorCount || 0;
  const validWarns  = entry.validation?.warningCount || 0;
  const fp = entry._fp;

  /* Lazy-load the full parsed pallets ONLY when expanded — keeps the
     queue list cheap when many entries are collapsed. Mirrors the
     BetaPreviewDrawer's data flow so the inline view and the (now
     removed) popup show identical content. */
  const detailQ = useQuery({
    queryKey: ['auftrag', entry.id],
    queryFn: () => getAuftrag(entry.id),
    staleTime: Infinity,
    refetchInterval: false,
    enabled: isExpanded && !entry.parsed?.pallets,
    initialData: entry.parsed?.pallets ? (entry as unknown as Awaited<ReturnType<typeof getAuftrag>>) : undefined,
  });
  const parsed = (detailQ.data?.parsed ?? entry.parsed) as
    | { pallets?: PreviewPallet[]; einzelneSkuItems?: unknown[]; meta?: Record<string, unknown> }
    | null | undefined;
  const expandedPallets = parsed?.pallets || [];
  const sortedExpandedPallets = useMemo(
    () => (expandedPallets.length ? (sortPallets(expandedPallets) as PreviewPallet[]) : []),
    [expandedPallets],
  );
  const eskuExpanded = (parsed?.einzelneSkuItems as unknown[])?.length || 0;
  const expandedTotalUnits = sortedExpandedPallets.reduce(
    (s, p) => s + (p.items || []).reduce((u, it) => u + (Number(it.units) || 0), 0),
    0,
  );
  const expandedTotalItems = sortedExpandedPallets.reduce((s, p) => s + (p.items?.length || 0), 0);

  const inner = (
    <BetaWhitePanel padding="16px 22px">
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            flexWrap: 'wrap',
          }}>
            <div style={{ minWidth: 0, flex: '1 1 240px' }}>
              <BetaEyebrow dot color={T.text.faint}>
                Nächster Auftrag · {String(queueIdx + 1).padStart(2, '0')}
              </BetaEyebrow>
              <div style={{
                marginTop: 4,
                display: 'flex',
                alignItems: 'baseline',
                gap: 12,
                flexWrap: 'wrap',
              }}>
                <span
                  title={String(fba || '')}
                  style={{
                    fontFamily: T.font.mono,
                    fontSize: 'clamp(18px, 1.9vw, 22px)',
                    fontWeight: 600,
                    color: T.text.primary,
                    letterSpacing: '-0.018em',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: 320,
                  }}
                >
                  {fba}
                </span>
                {isError ? (
                  <BetaStatusPill tone="danger">Parse-Fehler</BetaStatusPill>
                ) : validErrors > 0 ? (
                  <BetaStatusPill tone="danger">{validErrors} Fehler</BetaStatusPill>
                ) : validWarns > 0 ? (
                  <BetaStatusPill tone="warn">{validWarns} Warn</BetaStatusPill>
                ) : null}
              </div>
              <div style={{
                marginTop: 4,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                fontSize: 12,
                color: T.text.subtle,
                fontVariantNumeric: 'tabular-nums',
              }}>
                <span>{entry._palletCount} Pal</span>
                <BetaMetaDot />
                <span>{entry._articleCount} Art</span>
                <BetaMetaDot />
                <span>{(entry._units || 0).toLocaleString('de-DE')} EH</span>
                {!isError && entry._etaSec != null && (
                  <>
                    <BetaMetaDot />
                    <span style={{ color: T.accent.text, fontWeight: 600 }}>
                      ≈ {fmtDuration(entry._etaSec)}
                    </span>
                  </>
                )}
                {fp && (
                  <>
                    <span style={{ width: 8 }} />
                    <BetaLDistBar lvlCounts={fp.lvlCounts} />
                  </>
                )}
              </div>
            </div>

            <span style={{ flex: 1 }} />

            {/* Actions */}
            <div
              onClick={(e) => e.stopPropagation()}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <BetaRowAction onClick={onUp || (() => {})} disabled={!onUp} title="Nach oben (⌘↑)">
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                  <path d="M3 9l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </BetaRowAction>
              <BetaRowAction onClick={onDown || (() => {})} disabled={!onDown} title="Nach unten (⌘↓)">
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                  <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </BetaRowAction>
              <BetaRowAction onClick={() => onRemove()} title="Entfernen (x)">
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                  <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </BetaRowAction>
            </div>

            {/* Chevron — sits OUTSIDE the actions cluster so its click
                bubbles up to the row's onClick (toggles expansion).
                Inside the cluster it would have been absorbed by
                stopPropagation, breaking the cue/affordance contract. */}
            <span aria-hidden style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28, height: 28,
              marginLeft: 4,
              color: T.text.faint,
              transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 220ms cubic-bezier(0.16, 1, 0.3, 1)',
            }}>
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </div>
          {/* Inline expansion — pallets list with same info the old
              Vorschau drawer carried. Lives inside the same white panel
              so the card grows in place without overlay/popup. */}
          {isExpanded && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                marginTop: 16,
                paddingTop: 16,
                borderTop: `1px solid ${T.border.subtle}`,
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              {/* Compact summary line — mirrors the drawer header stats */}
              <div style={{
                fontSize: 12,
                color: T.text.subtle,
                fontVariantNumeric: 'tabular-nums',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
              }}>
                <span>{sortedExpandedPallets.length} Paletten</span>
                <BetaMetaDot />
                <span>{expandedTotalItems} Positionen</span>
                <BetaMetaDot />
                <span>{expandedTotalUnits.toLocaleString('de-DE')} Einheiten</span>
                {eskuExpanded > 0 && (
                  <>
                    <BetaMetaDot />
                    <span style={{ color: T.accent.text, fontWeight: 600 }}>
                      {eskuExpanded} ESKU
                    </span>
                  </>
                )}
              </div>

              {/* Pallets list — reuses BetaDrawerPalletBlock so inline
                  view and the legacy drawer rendered identical content. */}
              {detailQ.isPending && !parsed ? (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 0', color: T.text.subtle, fontSize: 13,
                }}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"
                       style={{ animation: 'mb-q-spin 800ms linear infinite' }}>
                    <circle cx="7" cy="7" r="5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.6" />
                    <path d="M12 7a5 5 0 0 0-5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                  Vorschau wird geladen…
                </div>
              ) : detailQ.isError && !parsed ? (
                <div style={{ color: T.status.danger.text, fontSize: 13 }}>
                  Vorschau konnte nicht geladen werden.
                </div>
              ) : !sortedExpandedPallets.length ? (
                <div style={{ color: T.text.subtle, fontSize: 13 }}>
                  Keine Paletten in diesem Auftrag.
                </div>
              ) : (
                <ul style={{
                  listStyle: 'none', margin: 0, padding: 0,
                  display: 'flex', flexDirection: 'column', gap: 10,
                  maxHeight: 360, overflowY: 'auto',
                  /* Wheel-isolation — same trick as Focus's intensity tray
                     so scrolling the pallet list doesn't bubble up to
                     parent scroll handlers. */
                  overscrollBehavior: 'contain',
                }}
                onWheel={(e) => e.stopPropagation()}>
                  {sortedExpandedPallets.map((p, idx) => (
                    <BetaDrawerPalletBlock key={p.id || idx} pallet={p} index={idx} />
                  ))}
                </ul>
              )}
            </div>
          )}
    </BetaWhitePanel>
  );

  /* Whole-row click toggles the inline expansion (no popup). onSelect
     still fires for keyboard-nav consistency. Parse-error entries can't
     be expanded but stay clickable for actions/selection. */
  const handleRowClick = () => {
    onSelect?.();
    if (!isError) onToggleExpand?.();
  };

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={handleRowClick}
      title={isError
        ? 'Parse-Fehler — Vorschau nicht verfügbar'
        : isExpanded ? 'Zuklappen' : 'Klick zeigt Vorschau direkt im Block'}
      style={{
        position: 'relative',
        opacity: isDragging ? 0.4 : 1,
        cursor: isError ? 'default' : 'pointer',
      }}
    >
      {isDropAbove && <BetaDropLine position="above" />}
      {isDropBelow && <BetaDropLine position="below" />}
      {bare ? inner : <BetaPaperCard>{inner}</BetaPaperCard>}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   NEXT card — dominant head-of-queue treatment.
   ════════════════════════════════════════════════════════════════════════ */

function BetaNextCard({
  entry, queueIdx, isSelected, hasCurrent,
  onSelect, onStart, onRemove, onPreview, onUp, onDown,
  onDragStart, onDragOver, onDrop, onDragEnd,
  isDragging, isDropAbove, isDropBelow,
}) {
  const fba = entry.parsed?.meta?.sendungsnummer
    || entry.parsed?.meta?.fbaCode
    || entry.fileName;
  const fileName = entry.fileName;
  const isError = entry.status === 'error';
  const validErrors = entry.validation?.errorCount || 0;
  const validWarns  = entry.validation?.warningCount || 0;
  const fp = entry._fp;
  const startEnabled = !hasCurrent && !isError;
  const startTitle = isError
    ? 'Auftrag mit Parse-Fehler kann nicht gestartet werden.'
    : hasCurrent
    ? 'Aktiver Auftrag noch nicht abgeschlossen.'
    : 'Diesen Auftrag starten — ⏎';

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      style={{
        position: 'relative',
        opacity: isDragging ? 0.4 : 1,
        cursor: 'pointer',
      }}
    >
      {isDropAbove && <BetaDropLine position="above" />}
      {isDropBelow && <BetaDropLine position="below" />}

      <BetaPaperCard glow>
        <BetaWhitePanel padding="28px 32px 26px">
          {/* eyebrow + actions row */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            marginBottom: 14,
            flexWrap: 'wrap',
          }}>
            <BetaEyebrow dot color={T.accent.text}>
              Nächster Auftrag · {String(queueIdx + 1).padStart(2, '0')}
            </BetaEyebrow>
            {isError ? (
              <BetaStatusPill tone="danger">Parse-Fehler</BetaStatusPill>
            ) : validErrors > 0 ? (
              <BetaStatusPill tone="danger">{validErrors} Fehler</BetaStatusPill>
            ) : validWarns > 0 ? (
              <BetaStatusPill tone="warn">{validWarns} Warnungen</BetaStatusPill>
            ) : (
              <BetaStatusPill tone="success">Validiert</BetaStatusPill>
            )}
            {isSelected && (
              <span style={{
                fontFamily: T.font.mono,
                fontSize: 10,
                fontWeight: 700,
                color: T.text.faint,
                textTransform: 'uppercase',
                letterSpacing: '0.14em',
              }}>
                · Auswahl
              </span>
            )}
            <span style={{ flex: 1 }} />
            <BetaRowAction onClick={(e) => { e.stopPropagation(); onUp?.(); }} disabled={!onUp} title="Nach oben (⌘↑)">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                <path d="M3 9l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </BetaRowAction>
            <BetaRowAction onClick={(e) => { e.stopPropagation(); onDown?.(); }} disabled={!onDown} title="Nach unten (⌘↓)">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </BetaRowAction>
            <BetaRowAction onClick={(e) => { e.stopPropagation(); onRemove(); }} title="Entfernen (x)">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </BetaRowAction>
          </div>

          {/* big mono FBA */}
          <BetaBigCopy value={fba} rawValue={String(fba || '')} />

          {/* meta line — filename + relative time + ETA */}
          <div style={{
            marginTop: 6,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            fontSize: 12.5,
            color: T.text.subtle,
            fontVariantNumeric: 'tabular-nums',
          }}>
            <span title={fileName} style={{
              maxWidth: 360,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {fileName}
            </span>
            {entry.addedAt && (
              <>
                <BetaMetaDot />
                <span>{fmtRel(entry.addedAt)}</span>
              </>
            )}
            {!isError && entry._etaSec != null && (
              <>
                <BetaMetaDot />
                <span style={{ color: T.accent.text, fontWeight: 600 }}>
                  ≈ {fmtDuration(entry._etaSec)}
                </span>
              </>
            )}
          </div>

          {/* hairline */}
          <div style={{
            height: 1,
            background: 'rgba(15,23,42,0.08)',
            margin: '20px 0 16px',
          }} />

          {/* totals + level distribution */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 24,
            flexWrap: 'wrap',
          }}>
            <BetaStat value={entry._palletCount} label="Paletten" />
            <BetaStat value={entry._articleCount.toLocaleString('de-DE')} label="Artikel" />
            <BetaStat value={(entry._units || 0).toLocaleString('de-DE')} label="Einheiten" />
            <span style={{ flex: 1 }} />
            {fp && <BetaLDistBar lvlCounts={fp.lvlCounts} />}
          </div>

          {/* hairline */}
          <div style={{
            height: 1,
            background: 'rgba(15,23,42,0.08)',
            margin: '20px 0 18px',
          }} />

          {/* CTAs */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
          }}>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onStart(); }}
              disabled={!startEnabled}
              title={startTitle}
              style={{
                all: 'unset',
                cursor: startEnabled ? 'pointer' : 'not-allowed',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 10,
                padding: '12px 22px',
                borderRadius: 999,
                background: startEnabled ? T.accent.main : 'rgba(15,23,42,0.08)',
                color: startEnabled ? '#FFFFFF' : T.text.faint,
                fontFamily: T.font.ui,
                fontSize: 13.5,
                fontWeight: 600,
                letterSpacing: '-0.005em',
                boxShadow: startEnabled ? '0 8px 22px rgba(255,91,31,0.28)' : 'none',
                transition: 'transform 160ms ease, box-shadow 160ms ease',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M3 2.5l6 3.5-6 3.5z" fill="currentColor" />
              </svg>
              {startEnabled ? 'Starten' : (isError ? 'Nicht startbar' : 'Wartet')}
              {startEnabled && <BetaKbd>⏎</BetaKbd>}
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onPreview(); }}
              disabled={isError}
              style={{
                all: 'unset',
                cursor: isError ? 'not-allowed' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                padding: '11px 18px',
                borderRadius: 999,
                background: BETA_PAPER_BG,
                color: isError ? T.text.faint : T.text.secondary,
                fontFamily: T.font.ui,
                fontSize: 12.5,
                fontWeight: 600,
              }}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"
                   stroke="currentColor" strokeWidth="1.5">
                <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" />
                <circle cx="8" cy="8" r="2" />
              </svg>
              Vorschau
            </button>
          </div>
        </BetaWhitePanel>
      </BetaPaperCard>
    </div>
  );
}

function BetaStat({ value, label }: { value: React.ReactNode; label: React.ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
      <span style={{
        fontSize: 18,
        fontWeight: 600,
        color: T.text.primary,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '-0.012em',
      }}>
        {value}
      </span>
      <span style={{
        fontFamily: T.font.mono,
        fontSize: 10.5,
        color: T.text.faint,
        textTransform: 'uppercase',
        letterSpacing: '0.10em',
        fontWeight: 600,
      }}>
        {label}
      </span>
    </span>
  );
}

function BetaStatusPill({ tone, children }: { tone: 'success' | 'warn' | 'danger' | 'accent'; children?: React.ReactNode }) {
  const palette = tone === 'success'
    ? { bg: T.status.success.bg, color: T.status.success.text }
    : tone === 'warn'
    ? { bg: T.status.warn.bg, color: T.status.warn.text }
    : tone === 'danger'
    ? { bg: T.status.danger.bg, color: T.status.danger.text }
    : { bg: T.accent.bg, color: T.accent.text };
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '4px 10px',
      borderRadius: 999,
      background: palette.bg,
      color: palette.color,
      fontFamily: T.font.mono,
      fontSize: 10.5,
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '0.10em',
    }}>
      {children}
    </span>
  );
}

function BetaRowAction({ onClick, disabled, title, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        all: 'unset',
        cursor: disabled ? 'not-allowed' : 'pointer',
        width: 30, height: 30,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 999,
        background: 'transparent',
        color: disabled ? 'rgba(15,23,42,0.18)' : T.text.subtle,
        transition: 'background 160ms ease, color 160ms ease',
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = BETA_PAPER_BG;
        e.currentTarget.style.color = T.text.primary;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = disabled ? 'rgba(15,23,42,0.18)' : T.text.subtle;
      }}
    >
      {children}
    </button>
  );
}

function BetaLDistBar({ lvlCounts }: { lvlCounts?: Record<string, number> }) {
  if (!lvlCounts) return null;
  const lvls = [1, 2, 3, 4, 5, 6];
  const total = lvls.reduce((s, k) => s + (lvlCounts[k] || 0), 0);
  if (!total) return null;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      height: 10,
      padding: 2,
      background: BETA_PAPER_BG,
      borderRadius: 6,
    }}>
      {lvls.map((l) => {
        const c = lvlCounts[l] || 0;
        if (!c) return null;
        const meta = LEVEL_META[l];
        const pct = (c / total) * 100;
        return (
          <span
            key={l}
            title={`L${l} ${meta?.name || ''} · ${c}`}
            style={{
              display: 'inline-block',
              height: 6,
              width: Math.max(8, pct * 1.4),
              borderRadius: 2,
              background: meta?.color || T.text.faint,
            }}
          />
        );
      })}
    </span>
  );
}

function BetaDropLine({ position }: { position: 'above' | 'below' }) {
  return (
    <div style={{
      position: 'absolute',
      left: 8, right: 8,
      [position === 'above' ? 'top' : 'bottom']: -5,
      height: 2,
      background: T.accent.main,
      borderRadius: 1,
      pointerEvents: 'none',
    } as React.CSSProperties} />
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Secondary queue rows — compact, hairline-bordered, hover-reveal actions.
   ════════════════════════════════════════════════════════════════════════ */

function BetaQueueRow({
  entry, queueIdx, isSelected, hasCurrent, isFirst, isLast,
  onSelect, onStart, onRemove, onPreview, onUp, onDown,
  onDragStart, onDragOver, onDrop, onDragEnd,
  isDragging, isDropAbove, isDropBelow,
}) {
  const fba = entry.parsed?.meta?.sendungsnummer
    || entry.parsed?.meta?.fbaCode
    || entry.fileName;
  const isError = entry.status === 'error';
  const validWarns  = entry.validation?.warningCount || 0;
  const validErrors = entry.validation?.errorCount || 0;
  const fp = entry._fp;

  return (
    <li
      className="mb-q-row"
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: 'auto 36px 1fr auto auto',
        alignItems: 'center',
        gap: 14,
        padding: '14px 16px',
        cursor: 'pointer',
        borderRadius: BETA_INNER_RADIUS - 6,
        background: isSelected ? BETA_PAPER_BG : 'transparent',
        borderBottom: isLast ? 'none' : '1px solid rgba(15,23,42,0.06)',
        opacity: isDragging ? 0.4 : 1,
        transition: 'background 160ms ease',
      }}
    >
      {isDropAbove && <BetaDropLine position="above" />}
      {isDropBelow && <BetaDropLine position="below" />}

      {/* drag handle */}
      <span
        title="Ziehen zum Verschieben"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 16, height: 24,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: T.text.faint,
          cursor: 'grab',
          flexShrink: 0,
          opacity: 0.5,
        }}
      >
        <svg width="9" height="13" viewBox="0 0 10 14" fill="currentColor">
          <circle cx="2" cy="2"  r="1.1" />
          <circle cx="8" cy="2"  r="1.1" />
          <circle cx="2" cy="7"  r="1.1" />
          <circle cx="8" cy="7"  r="1.1" />
          <circle cx="2" cy="12" r="1.1" />
          <circle cx="8" cy="12" r="1.1" />
        </svg>
      </span>

      {/* position */}
      <span style={{
        fontFamily: T.font.mono,
        fontSize: 12,
        fontWeight: 500,
        color: T.text.faint,
        fontVariantNumeric: 'tabular-nums',
        textAlign: 'right',
      }}>
        {String(queueIdx + 1).padStart(2, '0')}
      </span>

      {/* main: FBA + filename */}
      <div style={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span
          className="mb-q-row-fba"
          title={String(fba || '')}
          style={{
            fontFamily: T.font.mono,
            fontSize: 14.5,
            fontWeight: 500,
            color: isError ? T.status.danger.text : T.text.secondary,
            letterSpacing: '-0.01em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 260,
            transition: 'color 160ms ease',
          }}
        >
          {fba}
        </span>
        <span style={{
          fontSize: 11.5,
          color: T.text.faint,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: 240,
        }} title={entry.fileName}>
          {entry.fileName}
        </span>
        {isError && (
          <BetaStatusPill tone="danger">Parse-Fehler</BetaStatusPill>
        )}
        {!isError && validErrors > 0 && (
          <BetaStatusPill tone="danger">{validErrors} Fehler</BetaStatusPill>
        )}
        {!isError && validErrors === 0 && validWarns > 0 && (
          <BetaStatusPill tone="warn">{validWarns} Warn</BetaStatusPill>
        )}
      </div>

      {/* signals: pallet count + level distribution + ETA */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        fontSize: 12,
        color: T.text.subtle,
        fontVariantNumeric: 'tabular-nums',
      }}>
        <span style={{
          fontFamily: T.font.mono,
          fontSize: 12,
          fontWeight: 600,
          color: T.text.secondary,
        }}>
          {entry._palletCount} Pal
        </span>
        {fp && <BetaLDistBar lvlCounts={fp.lvlCounts} />}
        {!isError && entry._etaSec != null && (
          <span style={{ minWidth: 50, textAlign: 'right' }}>
            ≈ {fmtDuration(entry._etaSec)}
          </span>
        )}
      </div>

      {/* hover-reveal actions */}
      <div
        className="mb-q-row-actions"
        onClick={(e) => e.stopPropagation()}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 2,
          opacity: isSelected ? 1 : 0,
          transition: 'opacity 160ms ease',
        }}
      >
        <BetaRowAction onClick={onUp || (() => {})} disabled={!onUp} title="Nach oben (⌘↑)">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
            <path d="M3 9l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </BetaRowAction>
        <BetaRowAction onClick={onDown || (() => {})} disabled={!onDown} title="Nach unten (⌘↓)">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
            <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </BetaRowAction>
        <BetaRowAction onClick={() => onPreview()} disabled={isError} title="Vorschau anzeigen">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
               stroke="currentColor" strokeWidth="1.4">
            <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" />
            <circle cx="8" cy="8" r="2" />
          </svg>
        </BetaRowAction>
        <BetaRowAction onClick={onRemove} title="Entfernen (x)">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </BetaRowAction>
      </div>
    </li>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Empty state — paper-island dropzone.
   ════════════════════════════════════════════════════════════════════════ */

function BetaQueueEmpty({ over, busy, onPick, onDragOver, onDragLeave, onDrop }) {
  return (
    <BetaPaperCard glow>
      <BetaWhitePanel padding="56px 36px">
        <div
          role="button"
          tabIndex={0}
          onClick={onPick}
          onKeyDown={(e) => { if (e.key === 'Enter') onPick(); }}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          style={{
            cursor: 'pointer',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 18,
            padding: '28px 24px',
            borderRadius: BETA_INNER_RADIUS - 6,
            background: over ? T.accent.bg : BETA_PAPER_BG,
            boxShadow: over ? 'inset 0 0 0 2px var(--accent)' : 'inset 0 0 0 1px rgba(15,23,42,0.05)',
            transition: 'background 220ms ease, box-shadow 220ms ease',
          }}
        >
          <span style={{
            width: 64, height: 64,
            borderRadius: 999,
            background: '#FFFFFF',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: over ? T.accent.text : T.text.subtle,
            boxShadow: '0 4px 16px rgba(15,23,42,0.06)',
          }}>
            {busy ? (
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none"
                   style={{ animation: 'mb-q-spin 800ms linear infinite' }}>
                <circle cx="11" cy="11" r="8" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
                <path d="M19 11a8 8 0 0 0-8-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 22 22" fill="none"
                   stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 16V4M6 9l5-5 5 5M4 18h14" />
              </svg>
            )}
          </span>
          <div style={{ textAlign: 'center' }}>
            <div style={{
              fontFamily: T.font.ui,
              fontSize: 22,
              fontWeight: 600,
              color: T.text.primary,
              letterSpacing: '-0.018em',
              marginBottom: 6,
            }}>
              {busy ? 'Wird verarbeitet…' : (over ? 'Loslassen — Datei hinzufügen' : 'Warteschlange ist leer')}
            </div>
            <div style={{
              fontSize: 13.5,
              color: T.text.subtle,
              lineHeight: 1.5,
              maxWidth: 380,
              margin: '0 auto',
            }}>
              Lagerauftrag (.docx) hierher ziehen oder Datei wählen — danach
              läuft der Workflow Schritt für Schritt.
            </div>
          </div>
          <span style={{
            padding: '10px 18px',
            borderRadius: 999,
            background: T.text.primary,
            color: '#FFFFFF',
            fontFamily: T.font.ui,
            fontSize: 13,
            fontWeight: 600,
          }}>
            Datei wählen
          </span>
        </div>
      </BetaWhitePanel>
    </BetaPaperCard>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Side drawer — slide-in preview. Reuses the same TanStack key as
   classic PalletPreviewPanel so the cache is shared.
   ════════════════════════════════════════════════════════════════════════ */

function BetaPreviewDrawer({ entry, onClose }) {
  const detailQ = useQuery({
    queryKey: ['auftrag', entry.id],
    queryFn: () => getAuftrag(entry.id),
    staleTime: Infinity,
    refetchInterval: false,
    enabled: !entry.parsed?.pallets,
    initialData: entry.parsed?.pallets ? (entry as unknown as Awaited<ReturnType<typeof getAuftrag>>) : undefined,
  });

  const parsed = (detailQ.data?.parsed ?? entry.parsed) as
    | { pallets?: PreviewPallet[]; einzelneSkuItems?: unknown[]; meta?: Record<string, unknown> }
    | null
    | undefined;
  const pallets = parsed?.pallets || [];
  const einzelneSkuItems = (parsed?.einzelneSkuItems as unknown[]) || [];
  const sortedPallets = useMemo(
    () => (pallets.length ? (sortPallets(pallets) as PreviewPallet[]) : []),
    [pallets],
  );
  const totalUnits = sortedPallets.reduce(
    (s, p) => s + (p.items || []).reduce((u, it) => u + (Number(it.units) || 0), 0),
    0,
  );
  const totalItems = sortedPallets.reduce((s, p) => s + (p.items?.length || 0), 0);
  const fba = entry.parsed?.meta?.sendungsnummer
    || entry.parsed?.meta?.fbaCode
    || entry.fileName;

  return (
    <>
      <div
        className="mb-q-backdrop"
        onClick={onClose}
        aria-hidden
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(15,23,42,0.32)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          zIndex: 1100,
          animation: 'mb-q-backdrop-in 200ms ease-out',
        }}
      />
      <div
        className="mb-q-drawer"
        role="dialog"
        aria-label="Auftrag-Vorschau"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: BETA_DRAWER_WIDTH,
          maxWidth: 'calc(100vw - 48px)',
          maxHeight: 'calc(100vh - 64px)',
          padding: 8,
          background: BETA_PAPER_BG,
          border: `2px solid ${BETA_PAPER_RIM}`,
          borderRadius: BETA_PAPER_RADIUS,
          boxShadow: '0 0 0 0.5px rgba(255,91,31,0.10), 0 32px 96px rgba(15,23,42,0.28), 0 0 89.7px rgba(0,0,0,0.05)',
          zIndex: 1110,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          animation: 'mb-q-drawer-in 280ms cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        {/* header — own white panel */}
        <div style={{
          background: '#FFFFFF',
          borderRadius: BETA_INNER_RADIUS,
          padding: '20px 24px 18px',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 14,
          flexShrink: 0,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <BetaEyebrow dot color={T.accent.text}>Vorschau</BetaEyebrow>
            <div style={{
              marginTop: 8,
              fontFamily: T.font.mono,
              fontSize: 'clamp(22px, 2.4vw, 30px)',
              fontWeight: 600,
              color: T.text.primary,
              letterSpacing: '-0.022em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }} title={String(fba || '')}>
              {fba}
            </div>
            <div style={{
              marginTop: 8,
              fontSize: 12.5,
              color: T.text.subtle,
              fontVariantNumeric: 'tabular-nums',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}>
              <span>{sortedPallets.length} Paletten</span>
              <BetaMetaDot />
              <span>{totalItems} Positionen</span>
              <BetaMetaDot />
              <span>{totalUnits.toLocaleString('de-DE')} Einheiten</span>
              {einzelneSkuItems.length > 0 && (
                <>
                  <BetaMetaDot />
                  <span style={{ color: T.accent.text, fontWeight: 600 }}>
                    {einzelneSkuItems.length} ESKU
                  </span>
                </>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            title="Schließen (Esc)"
            style={{
              all: 'unset',
              cursor: 'pointer',
              width: 36, height: 36,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 999,
              background: BETA_PAPER_BG,
              color: T.text.subtle,
              flexShrink: 0,
              transition: 'background 160ms ease, color 160ms ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = T.text.primary;
              e.currentTarget.style.color = '#FFFFFF';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = BETA_PAPER_BG;
              e.currentTarget.style.color = T.text.subtle;
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* body — scrollable white panel */}
        <div style={{
          background: '#FFFFFF',
          borderRadius: BETA_INNER_RADIUS,
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '16px 18px 22px',
        }}>
          {detailQ.isPending && !parsed ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '20px 8px',
              color: T.text.subtle,
              fontSize: 13,
            }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"
                   style={{ animation: 'mb-q-spin 800ms linear infinite' }}>
                <circle cx="7" cy="7" r="5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.6" />
                <path d="M12 7a5 5 0 0 0-5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              Vorschau wird geladen…
            </div>
          ) : detailQ.isError && !parsed ? (
            <div style={{ padding: '20px 8px', color: T.status.danger.text, fontSize: 13 }}>
              Vorschau konnte nicht geladen werden.
            </div>
          ) : !sortedPallets.length ? (
            <div style={{ padding: '20px 8px', color: T.text.subtle, fontSize: 13 }}>
              Keine Paletten in diesem Auftrag.
            </div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {sortedPallets.map((p, idx) => (
                <BetaDrawerPalletBlock key={p.id || idx} pallet={p} index={idx} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function BetaDrawerPalletBlock({ pallet, index }: { pallet: PreviewPallet; index: number }) {
  const items = pallet.items || [];
  const eskuOnPallet = (pallet as { einzelneSkuItems?: unknown[] }).einzelneSkuItems?.length || 0;
  const totalUnits = items.reduce((s, it) => s + (Number(it.units) || 0), 0);
  const lvl = (pallet as { level?: number }).level;
  const meta = lvl != null ? LEVEL_META[lvl] : null;

  return (
    <li style={{
      background: BETA_PAPER_BG,
      borderRadius: 18,
      padding: '14px 16px',
    }}>
        {/* header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: items.length ? 10 : 0,
          flexWrap: 'wrap',
        }}>
          <span style={{
            fontFamily: T.font.mono,
            fontSize: 11,
            fontWeight: 700,
            color: T.text.faint,
            letterSpacing: '0.04em',
          }}>
            {String(index + 1).padStart(2, '0')}
          </span>
          <span style={{
            fontFamily: T.font.mono,
            fontSize: 13,
            fontWeight: 600,
            color: T.text.primary,
            letterSpacing: '-0.01em',
          }}>
            {pallet.id || `P${index + 1}`}
          </span>
          {meta && (
            <span style={{
              fontFamily: T.font.mono,
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 7px',
              background: meta.bg,
              color: meta.text,
              borderRadius: 999,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}>
              L{lvl} {meta.shortName || meta.name}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <span style={{
            fontFamily: T.font.mono,
            fontSize: 11,
            color: T.text.faint,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {items.length} Pos · {totalUnits.toLocaleString('de-DE')} Stk
          </span>
          {pallet.hasFourSideWarning && (
            <BetaStatusPill tone="warn">4-Seiten</BetaStatusPill>
          )}
          {eskuOnPallet > 0 && (
            <BetaStatusPill tone="accent">ESKU {eskuOnPallet}</BetaStatusPill>
          )}
        </div>

        {/* items */}
        {items.length > 0 && (
          <ol style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}>
            {items.map((it, j) => (
              <BetaDrawerItem key={j} item={it} pos={j + 1} />
            ))}
          </ol>
        )}
    </li>
  );
}

function BetaDrawerItem({ item, pos }: { item: PreviewItem; pos: number }) {
  const lvl = getDisplayLevel(item) || (item as { level?: number }).level || 1;
  const meta = LEVEL_META[lvl] || LEVEL_META[1];
  const code = (item as { code?: string }).code || item.fnsku || item.sku || (item as { useItem?: string }).useItem || '';
  return (
    <li style={{
      display: 'grid',
      gridTemplateColumns: '22px 22px 1fr auto',
      alignItems: 'center',
      gap: 8,
      padding: '5px 6px',
      borderRadius: 8,
      fontSize: 12,
    }}>
      <span style={{
        fontFamily: T.font.mono,
        fontSize: 10.5,
        color: T.text.faint,
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
      }}>
        {String(pos).padStart(2, '0')}
      </span>
      <span
        title={`L${lvl} ${meta.name}`}
        style={{
          width: 14, height: 14,
          borderRadius: 4,
          background: meta.color,
          opacity: 0.85,
          alignSelf: 'center',
        }}
      />
      <span
        title={item.title || ''}
        style={{
          color: T.text.primary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          letterSpacing: '-0.005em',
        }}
      >
        {formatItemTitle(item.title || '—')}
      </span>
      <span style={{
        fontFamily: T.font.mono,
        fontSize: 11,
        color: T.text.subtle,
        fontVariantNumeric: 'tabular-nums',
        textAlign: 'right',
      }}>
        {item.units != null ? `× ${item.units}` : '—'}
        {code && (
          <span style={{ color: T.text.faint, marginLeft: 8 }}>{String(code).slice(-8)}</span>
        )}
      </span>
    </li>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Keyboard hints — paper-island bottom strip.
   ════════════════════════════════════════════════════════════════════════ */

function BetaKbdHints() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 18,
      padding: '14px 16px',
      marginTop: 10,
      flexWrap: 'wrap',
    }}>
      <BetaKbdHint kbd={<><BetaKbd>j</BetaKbd><BetaKbd>k</BetaKbd></>}>Navigieren</BetaKbdHint>
      <BetaKbdHint kbd={<BetaKbd>⏎</BetaKbd>}>Starten</BetaKbdHint>
      <BetaKbdHint kbd={<><BetaKbd>⌘</BetaKbd><BetaKbd>↑↓</BetaKbd></>}>Verschieben</BetaKbdHint>
      <BetaKbdHint kbd={<BetaKbd>x</BetaKbd>}>Entfernen</BetaKbdHint>
      <BetaKbdHint kbd={<BetaKbd>/</BetaKbd>}>Suchen</BetaKbdHint>
    </div>
  );
}

function BetaKbdHint({ kbd, children }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontFamily: T.font.mono,
      fontSize: 11,
      color: T.text.faint,
      textTransform: 'uppercase',
      letterSpacing: '0.10em',
    }}>
      <span style={{ display: 'inline-flex', gap: 3 }}>{kbd}</span>
      {children}
    </span>
  );
}