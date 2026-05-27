/* Historie v2 — «Archiv & Performance».

   Magazine-spread design (matches Upload / Pruefen / Focus / Live):
     • Eyebrow + clamp(36–52) H1 + Lead — wide breathing room
     • Hero KPI strip (5 numbers): Aufträge / Paletten / Artikel / Gesamt /
       Ø-Dauer — throughput surfaces as the headline metric
     • «Bestleistungen» — 3 record cards (schnellster Auftrag, beste
       Min/Palette, beste Min/Artikel), clickable to jump to that row
     • 14-Tage Trend — daily completion sparkline + Ø-duration mini-tick,
       hover-tooltip with date and totals
     • Toolbar — search · date-range pills (Heute / Woche / Monat / Alle) ·
       sort dropdown · xlsx export (calls existing downloadAuftraegeXlsx)
     • Per-user breakdown bar — appears when >1 user in scope; click pill
       to filter feed
     • Card-row v2 — FBA hero, pallet-timings sparkline, comparison
       badge (−18% vs Ø / +22% vs Ø), throughput EH/min, user-pill
     • Expanded detail — timing-Gantt for Palettenzeiten + lazy articles
     • Keyboard cockpit — j/k navigate · Enter expand · / focus search ·
       e export

   Backend unchanged — all analytics computed client-side from existing
   /api/history Summary fields. Detail (parsed pallets) is still
   lazy-fetched on row open via /api/auftraege/{id}.
*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppState } from '@/state.jsx';
import { getAuftrag, downloadAuftraegeXlsx } from '@/marathonApi.js';
import {
  Page, Topbar, Card, Eyebrow, Lead, EmptyState, Button, Badge, T,
} from '@/components/ui.jsx';
import { LEVEL_META, getDisplayLevel } from '@/utils/auftragHelpers.js';
import { useBetaDesign } from '@/hooks/useBetaDesign';

const RANGE_PRESETS = [
  { id: 'today', label: 'Heute' },
  { id: 'week',  label: 'Woche' },
  { id: 'month', label: 'Monat' },
  { id: 'all',   label: 'Alle' },
];

const SORT_OPTIONS = [
  { id: 'newest',   label: 'Neueste' },
  { id: 'oldest',   label: 'Älteste' },
  { id: 'longest',  label: 'Längste Dauer' },
  { id: 'shortest', label: 'Kürzeste Dauer' },
  { id: 'pallets',  label: 'Meiste Paletten' },
];

const TREND_DAYS = 14;

/* ════════════════════════════════════════════════════════════════════════
   Top-level router — branches on the global beta-design flag. Classic body
   below is byte-identical to the pre-beta archive; beta body lives at the
   end of the file (see BetaHistorie).
   ════════════════════════════════════════════════════════════════════════ */
export default function HistorieScreen() {
  const { beta } = useBetaDesign();
  if (beta) return <BetaHistorie />;
  return <ClassicHistorie />;
}

/* ════════════════════════════════════════════════════════════════════════ */
function ClassicHistorie() {
  const { history, removeHistoryEntry, clearHistory } = useAppState();

  const [openId, setOpenId]       = useState(null);
  const [search, setSearch]       = useState('');
  const [range, setRange]         = useState('all');
  const [sort, setSort]           = useState('newest');
  const [userFilter, setUserFilter] = useState(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [exporting, setExporting] = useState(false);

  const searchRef = useRef<HTMLInputElement | null>(null);

  /* Enrich each entry with throughput + comparison values. */
  const enriched = useMemo(
    () => history.map((h) => {
      const dur = h.durationSec ?? 0;
      const minPerPallet  = h.palletCount  > 0 && dur > 0 ? dur / h.palletCount  / 60 : null;
      const minPerArticle = h.articleCount > 0 && dur > 0 ? dur / h.articleCount / 60 : null;
      const ehPerMin      = dur > 0
        ? (sumUnitsFromTimings(h)
           ?? estimateUnitsFromArticles(h.articleCount))
          / (dur / 60)
        : null;
      return {
        ...h,
        _minPerPallet: minPerPallet,
        _minPerArticle: minPerArticle,
        _ehPerMin: ehPerMin,
      };
    }),
    [history],
  );

  /* Personal medians (over the entire history scope, not just visible). */
  const stats = useMemo(() => {
    if (!enriched.length) return { medianDur: 0, medianMinPerPallet: 0, medianMinPerArticle: 0 };
    return {
      medianDur:           median(enriched.map((e) => e.durationSec).filter(Boolean)),
      medianMinPerPallet:  median(enriched.map((e) => e._minPerPallet).filter((v) => v != null)),
      medianMinPerArticle: median(enriched.map((e) => e._minPerArticle).filter((v) => v != null)),
    };
  }, [enriched]);

  /* Personal records — across full history, not filtered. */
  const records = useMemo(() => computeRecords(enriched), [enriched]);

  /* Per-user breakdown across full history scope. */
  const userBreakdown = useMemo(() => {
    const m = new Map();
    for (const e of enriched) {
      const u = e.assignedToUserName || '—';
      m.set(u, (m.get(u) || 0) + 1);
    }
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }, [enriched]);

  /* Date-range filter helper. */
  const rangeStart = useMemo(() => {
    const now = new Date();
    if (range === 'today') {
      const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime();
    }
    if (range === 'week') {
      const d = new Date(now); d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - 7); return d.getTime();
    }
    if (range === 'month') {
      const d = new Date(now); d.setHours(0, 0, 0, 0);
      d.setMonth(d.getMonth() - 1); return d.getTime();
    }
    return null;
  }, [range]);

  /* Visible (filtered + sorted) list. */
  const visible = useMemo(() => {
    let arr = enriched;
    if (rangeStart != null) arr = arr.filter((e) => (e.finishedAt || 0) >= rangeStart);
    if (userFilter) arr = arr.filter((e) => (e.assignedToUserName || '—') === userFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      arr = arr.filter((e) => {
        return (e.fbaCode  || '').toLowerCase().includes(q)
            || (e.fileName || '').toLowerCase().includes(q);
      });
    }
    return sortEntries(arr, sort);
  }, [enriched, rangeStart, userFilter, search, sort]);

  /* Visible KPIs (recompute over filter scope so the strip mirrors what
     the user sees in the list, not the entire archive). */
  const totals = useMemo(() => {
    const t = visible.reduce((acc, h) => ({
      orders:   acc.orders + 1,
      pallets:  acc.pallets + (h.palletCount || 0),
      articles: acc.articles + (h.articleCount || 0),
      seconds:  acc.seconds + (h.durationSec || 0),
    }), { orders: 0, pallets: 0, articles: 0, seconds: 0 });
    t.avgSec = t.orders > 0 ? Math.round(t.seconds / t.orders) : 0;
    return t;
  }, [visible]);

  /* 14-day trend over full history scope. */
  const trend = useMemo(() => buildTrend(enriched, TREND_DAYS), [enriched]);

  /* Clamp selectedIdx as visible shrinks. */
  useEffect(() => {
    if (selectedIdx >= visible.length) setSelectedIdx(Math.max(0, visible.length - 1));
  }, [visible.length, selectedIdx]);

  /* Keyboard cockpit. */
  const onExport = useCallback(async () => {
    try {
      setExporting(true);
      const params: { from?: string } = {};
      if (rangeStart) params.from = new Date(rangeStart).toISOString().slice(0, 10);
      await downloadAuftraegeXlsx(params);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unbekannter Fehler';
      alert('Export fehlgeschlagen: ' + msg);
    } finally {
      setExporting(false);
    }
  }, [rangeStart]);

  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable;
      if (e.key === '/' && !inField) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'Escape' && document.activeElement === searchRef.current) {
        searchRef.current?.blur();
        if (search) setSearch('');
        return;
      }
      if (inField) return;
      if (e.key === 'e' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (!exporting) onExport();
        return;
      }
      if (!visible.length) return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(visible.length - 1, i + 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const target = visible[selectedIdx];
        if (target) setOpenId((id) => id === target.id ? null : target.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, selectedIdx, search, exporting, onExport]);

  const hasAny = enriched.length > 0;
  const noResults = hasAny && visible.length === 0;

  return (
    <Page>
      <Topbar
        crumbs={[{ label: 'Historie' }]}
        right={
          <span style={{
            fontSize: 12.5,
            color: T.text.subtle,
            fontFamily: T.font.mono,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '0.02em',
          }}>
            {hasAny ? `${enriched.length} Einträge im Archiv` : 'Archiv leer'}
          </span>
        }
      />

      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '72px 40px 96px' }}>
        {/* HEADER */}
        <header style={{ marginBottom: 48 }}>
          <Eyebrow>Archiv · {enriched.length} {enriched.length === 1 ? 'Auftrag' : 'Aufträge'}</Eyebrow>
          <h1 style={{
            fontFamily: T.font.ui,
            fontSize: 'clamp(36px, 2.8vw, 52px)',
            fontWeight: 600,
            letterSpacing: '-0.025em',
            lineHeight: 1.1,
            color: T.text.primary,
            margin: 0,
          }}>
            Historie
          </h1>
          <Lead style={{ marginTop: 16, maxWidth: 720, fontSize: 16 }}>
            Alle abgeschlossenen Aufträge. Wer was wann geschafft hat,
            wo Rekorde gefallen sind, welcher Auftrag aus der Reihe tanzt.
            Ein Klick holt Palettenzeiten und Artikel-Details.
          </Lead>
        </header>

        {!hasAny ? (
          <EmptyState
            icon={
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
                <path d="M3 12a9 9 0 1 0 2.4-6.15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <path d="M3 4v4.5h4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
            title="Noch keine Aufträge abgeschlossen"
            description="Sobald du den ersten Lagerauftrag durchgearbeitet hast, erscheint er hier mit allen Details."
          />
        ) : (
          <>
            {/* HERO KPI STRIP — visible scope */}
            <KpiStrip totals={totals} />

            {/* PERSONAL RECORDS */}
            {records.fastest && (
              <RecordsRow
                records={records}
                onJump={(id) => { setOpenId(id); }}
              />
            )}

            {/* 14-DAY TREND */}
            <TrendCard trend={trend} />

            {/* TOOLBAR */}
            <Toolbar
              search={search}
              onSearch={setSearch}
              range={range}
              onRange={setRange}
              sort={sort}
              onSort={setSort}
              onExport={onExport}
              exporting={exporting}
              onClear={clearHistory}
              hasAny={hasAny}
              searchRef={searchRef}
            />

            {/* PER-USER BREAKDOWN */}
            {userBreakdown.length > 1 && (
              <UserBar
                items={userBreakdown}
                active={userFilter}
                onPick={setUserFilter}
              />
            )}

            {/* LIST */}
            {noResults ? (
              <Card style={{ padding: '40px 32px', textAlign: 'center' }}>
                <div style={{ fontSize: 14, color: T.text.subtle, marginBottom: 16 }}>
                  Keine Einträge passen zu Suche oder Filter.
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setSearch(''); setRange('all'); setUserFilter(null); }}
                >
                  Filter zurücksetzen
                </Button>
              </Card>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                {visible.map((entry, idx) => (
                  <RowCard
                    key={entry.id}
                    entry={entry}
                    idx={idx}
                    isSelected={idx === selectedIdx}
                    isOpen={openId === entry.id}
                    showUser={userBreakdown.length > 1}
                    medianDur={stats.medianDur}
                    onSelect={() => setSelectedIdx(idx)}
                    onToggle={() => {
                      setSelectedIdx(idx);
                      setOpenId(openId === entry.id ? null : entry.id);
                    }}
                    onRemove={() => removeHistoryEntry(entry.id)}
                  />
                ))}
              </div>
            )}

            <KbdHints />
          </>
        )}
      </main>
    </Page>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Helpers
   ════════════════════════════════════════════════════════════════════════ */
function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sumUnitsFromTimings(_h?: unknown): number | null {
  /* History Summary doesn't ship units; return null so the throughput
     falls back to articleCount-based estimate. */
  return null;
}
function estimateUnitsFromArticles(articleCount: number) {
  /* Conservative units-per-article default for archive throughput
     display only. The exact number is fine for the row badge — what
     matters is relative comparison, not absolute accuracy. */
  return (articleCount || 0) * 8;
}

function computeRecords(enriched) {
  const valid = enriched.filter((e) => (e.durationSec || 0) > 60);
  if (!valid.length) return { fastest: null, bestPerPallet: null, bestPerArticle: null };

  const fastest        = valid.reduce((best, e) => !best || e.durationSec < best.durationSec ? e : best, null);
  const bestPerPallet  = valid.filter((e) => e._minPerPallet  != null)
    .reduce((best, e) => !best || e._minPerPallet  < best._minPerPallet  ? e : best, null);
  const bestPerArticle = valid.filter((e) => e._minPerArticle != null)
    .reduce((best, e) => !best || e._minPerArticle < best._minPerArticle ? e : best, null);

  return { fastest, bestPerPallet, bestPerArticle };
}

interface TrendBucket { ms: number; label: string; shortDay: string; count: number; totalSec: number }

function buildTrend(enriched, days) {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const buckets: TrendBucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    buckets.push({
      ms: d.getTime(),
      label: d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }),
      shortDay: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][d.getDay()],
      count: 0,
      totalSec: 0,
    });
  }
  const minMs = buckets[0].ms;
  const maxMs = buckets[buckets.length - 1].ms + 86_400_000;
  for (const e of enriched) {
    const t = e.finishedAt;
    if (!t || t < minMs || t >= maxMs) continue;
    const idx = Math.floor((t - minMs) / 86_400_000);
    const b = buckets[idx];
    if (!b) continue;
    b.count += 1;
    b.totalSec += (e.durationSec || 0);
  }
  return buckets.map((b) => ({
    ...b,
    avgSec: b.count ? Math.round(b.totalSec / b.count) : 0,
  }));
}

function sortEntries(arr, sort) {
  const c = [...arr];
  if (sort === 'newest')   c.sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  if (sort === 'oldest')   c.sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
  if (sort === 'longest')  c.sort((a, b) => (b.durationSec || 0) - (a.durationSec || 0));
  if (sort === 'shortest') c.sort((a, b) => (a.durationSec || 0) - (b.durationSec || 0));
  if (sort === 'pallets')  c.sort((a, b) => (b.palletCount || 0) - (a.palletCount || 0));
  return c;
}

function fmtDurationLong(sec) {
  if (!sec || sec < 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h}h ${String(m).padStart(2, '0')} min`;
}
function fmtDurationShort(sec) {
  if (!sec || sec < 0) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtMmSs(sec) {
  if (sec == null || sec < 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtTimestamp(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}
function fmtRelative(ms) {
  if (!ms) return '—';
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60)    return 'gerade eben';
  if (sec < 3600)  return `vor ${Math.round(sec / 60)} min`;
  if (sec < 86400) return `vor ${Math.round(sec / 3600)} h`;
  const d = Math.round(sec / 86400);
  if (d < 7)       return `vor ${d} T`;
  return new Date(ms).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

/* ════════════════════════════════════════════════════════════════════════
   Sub-components
   ════════════════════════════════════════════════════════════════════════ */
function KpiStrip({ totals }) {
  return (
    <div style={{
      marginBottom: 24,
      padding: '24px 28px',
      background: T.bg.surface,
      border: `1px solid ${T.border.primary}`,
      borderRadius: T.radius.lg,
      display: 'grid',
      gridTemplateColumns: 'repeat(5, 1fr)',
      gap: 8,
    }}>
      <Kpi label="Aufträge"  value={totals.orders} />
      <Kpi label="Paletten"  value={totals.pallets} />
      <Kpi label="Artikel"   value={totals.articles.toLocaleString('de-DE')} />
      <Kpi label="Gesamt"    value={fmtDurationLong(totals.seconds)} />
      <Kpi label="Ø Auftrag" value={totals.avgSec ? fmtDurationLong(totals.avgSec) : '—'} accent />
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
function RecordsRow({ records, onJump }) {
  const cards = [
    {
      key: 'fastest',
      label: 'Schnellster Auftrag',
      icon: '🥇',
      entry: records.fastest,
      value: records.fastest ? fmtDurationShort(records.fastest.durationSec) : '—',
      sub: records.fastest ? `${records.fastest.palletCount} Paletten · ${records.fastest.articleCount} Artikel` : null,
    },
    {
      key: 'bestPallet',
      label: 'Beste Min/Palette',
      icon: '⚡',
      entry: records.bestPerPallet,
      value: records.bestPerPallet ? `${records.bestPerPallet._minPerPallet.toFixed(1)} min` : '—',
      sub: records.bestPerPallet ? `${records.bestPerPallet.palletCount} Paletten gesamt` : null,
    },
    {
      key: 'bestArticle',
      label: 'Beste Min/Artikel',
      icon: '📈',
      entry: records.bestPerArticle,
      value: records.bestPerArticle ? `${records.bestPerArticle._minPerArticle.toFixed(2)} min` : '—',
      sub: records.bestPerArticle ? `${records.bestPerArticle.articleCount} Artikel gesamt` : null,
    },
  ];
  return (
    <div style={{
      marginBottom: 24,
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 1fr)',
      gap: 12,
    }}>
      {cards.map((c) => (
        <RecordCard
          key={c.key}
          card={c}
          onClick={c.entry ? () => onJump(c.entry.id) : null}
        />
      ))}
    </div>
  );
}

function RecordCard({ card, onClick }) {
  const [hover, setHover] = useState(false);
  const clickable = !!onClick;
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '18px 20px',
        background: T.bg.surface,
        border: `1px solid ${clickable && hover ? T.accent.border : T.border.primary}`,
        borderRadius: T.radius.lg,
        cursor: clickable ? 'pointer' : 'default',
        transition: 'all 160ms ease',
        boxShadow: 'none',
        transform: clickable && hover ? 'translateY(-1px)' : 'none',
      }}
    >
      <div style={{
        display: 'flex',
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
        <span style={{ fontSize: 14 }}>{card.icon}</span>
        {card.label}
      </div>
      <div style={{
        fontFamily: T.font.ui,
        fontSize: 28,
        fontWeight: 500,
        letterSpacing: '-0.025em',
        color: T.text.primary,
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1.1,
      }}>
        {card.value}
      </div>
      {card.entry && (
        <div style={{
          marginTop: 8,
          fontSize: 12.5,
          color: T.text.muted,
          fontFamily: T.font.mono,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {card.entry.fbaCode || card.entry.fileName}
        </div>
      )}
      {card.sub && (
        <div style={{
          marginTop: 4,
          fontSize: 11.5,
          color: T.text.faint,
        }}>
          {card.sub}
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
function TrendCard({ trend }) {
  const max = Math.max(1, ...trend.map((b) => b.count));
  const totalCount = trend.reduce((s, b) => s + b.count, 0);
  const totalSec   = trend.reduce((s, b) => s + b.totalSec, 0);
  const avgSec     = totalCount ? Math.round(totalSec / totalCount) : 0;

  return (
    <Card padding={20} style={{
      marginBottom: 24,
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div>
          <div style={{
            fontSize: 10.5,
            fontFamily: T.font.mono,
            fontWeight: 600,
            color: T.text.subtle,
            textTransform: 'uppercase',
            letterSpacing: '0.10em',
          }}>
            14-Tage Trend
          </div>
          <div style={{
            fontSize: 12,
            color: T.text.faint,
            marginTop: 2,
          }}>
            Aufträge pro Tag · ø {avgSec ? fmtDurationLong(avgSec) : '—'} Dauer
          </div>
        </div>
        <span style={{
          fontSize: 12,
          color: T.text.subtle,
          fontVariantNumeric: 'tabular-nums',
          fontFamily: T.font.mono,
        }}>
          {totalCount} Aufträge
        </span>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${trend.length}, 1fr)`,
        gap: 5,
        height: 80,
        alignItems: 'end',
      }}>
        {trend.map((b) => (
          <TrendBar key={b.ms} bucket={b} max={max} />
        ))}
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${trend.length}, 1fr)`,
        gap: 5,
        fontSize: 10,
        fontFamily: T.font.mono,
        color: T.text.faint,
        textAlign: 'center',
      }}>
        {trend.map((b, i) => (
          <span key={b.ms}>{i % 2 === 0 ? b.label : '·'}</span>
        ))}
      </div>
    </Card>
  );
}

function TrendBar({ bucket, max }) {
  const [hover, setHover] = useState(false);
  const h = bucket.count ? Math.max(4, Math.round((bucket.count / max) * 70)) : 3;
  const isToday = (() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return bucket.ms === today.getTime();
  })();
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
      }}
    >
      <div style={{
        height: h,
        borderRadius: 3,
        background: bucket.count
          ? (isToday ? T.accent.main : 'var(--accent)')
          : T.border.subtle,
        opacity: bucket.count
          ? (isToday ? 1 : Math.max(0.45, bucket.count / max))
          : 1,
        transition: 'opacity 160ms, transform 160ms',
        transform: hover ? 'scaleY(1.04)' : 'none',
        transformOrigin: 'bottom',
      }} />
      {hover && bucket.count > 0 && (
        <div style={{
          position: 'absolute',
          bottom: h + 6,
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '5px 10px',
          fontSize: 11,
          fontFamily: T.font.mono,
          color: T.text.primary,
          background: T.bg.surface,
          border: `1px solid ${T.border.primary}`,
          borderRadius: T.radius.sm,
          whiteSpace: 'nowrap',
          boxShadow: T.shadow.card,
          pointerEvents: 'none',
          zIndex: 4,
        }}>
          <div style={{ fontWeight: 600 }}>
            {bucket.shortDay}, {bucket.label}
          </div>
          <div style={{ marginTop: 3, color: T.text.subtle }}>
            {bucket.count} {bucket.count === 1 ? 'Auftrag' : 'Aufträge'} · ø {fmtDurationLong(bucket.avgSec)}
          </div>
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
function Toolbar({
  search, onSearch, range, onRange, sort, onSort,
  onExport, exporting, onClear, hasAny, searchRef,
}) {
  return (
    <div style={{
      marginBottom: 14,
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 10,
    }}>
      {/* Search */}
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
          placeholder="FBA oder Dateiname  ·  /"
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

      {/* Range pills */}
      {RANGE_PRESETS.map((p) => (
        <Chip key={p.id} active={range === p.id} onClick={() => onRange(p.id)}>
          {p.label}
        </Chip>
      ))}

      <span style={{ flex: 1 }} />

      {/* Sort dropdown */}
      <SortSelect value={sort} onChange={onSort} />

      {/* Export */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onExport}
        disabled={exporting}
        title="xlsx-Export (E)"
      >
        {exporting ? 'lädt…' : 'xlsx Export'}
        {!exporting && (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 1.5v7m0 0L3 6m3 2.5L9 6M2 10.5h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </Button>

      {hasAny && (
        <Button variant="ghost" size="sm" onClick={onClear}>
          Alle löschen
        </Button>
      )}
    </div>
  );
}

function Chip({ children, active, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
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

function SortSelect({ value, onChange }) {
  return (
    <label style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 12,
      color: T.text.subtle,
      fontFamily: T.font.mono,
      letterSpacing: '0.04em',
    }}>
      <span>Sort:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          height: 30,
          padding: '0 26px 0 10px',
          fontSize: 12.5,
          fontFamily: T.font.ui,
          color: T.text.primary,
          background: T.bg.surface,
          border: `1px solid ${T.border.primary}`,
          borderRadius: T.radius.full,
          outline: 'none',
          cursor: 'pointer',
          appearance: 'none',
          backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6' fill='none'><path d='M1 1l4 4 4-4' stroke='%239CA3AF' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/></svg>")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 10px center',
        }}
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */
function UserBar({ items, active, onPick }) {
  const total = items.reduce((s, x) => s + x.count, 0);
  return (
    <div style={{
      marginBottom: 18,
      padding: '10px 14px',
      background: T.bg.surface,
      border: `1px solid ${T.border.primary}`,
      borderRadius: T.radius.full,
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      flexWrap: 'wrap',
    }}>
      <span style={{
        fontSize: 10.5,
        fontFamily: T.font.mono,
        fontWeight: 600,
        color: T.text.subtle,
        textTransform: 'uppercase',
        letterSpacing: '0.10em',
      }}>
        Operatoren
      </span>
      <UserPill
        active={active === null}
        onClick={() => onPick(null)}
        label="Alle"
        count={total}
      />
      {items.map((u) => (
        <UserPill
          key={u.name}
          active={active === u.name}
          onClick={() => onPick(active === u.name ? null : u.name)}
          label={u.name}
          count={u.count}
        />
      ))}
    </div>
  );
}

function UserPill({ active, onClick, label, count }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 24,
        padding: '0 10px',
        fontSize: 11.5,
        fontWeight: 500,
        fontFamily: T.font.ui,
        background: active ? T.accent.bg : (hover ? T.bg.surface3 : 'transparent'),
        border: `1px solid ${active ? T.accent.border : 'transparent'}`,
        color: active ? T.accent.text : T.text.secondary,
        borderRadius: T.radius.full,
        cursor: 'pointer',
        transition: 'all 150ms',
      }}
    >
      {label}
      <span style={{
        fontFamily: T.font.mono,
        fontSize: 10.5,
        color: active ? T.accent.text : T.text.faint,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {count}
      </span>
    </button>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Row card — magazine-spread variant
   ════════════════════════════════════════════════════════════════════════ */
function RowCard({
  entry, idx, isSelected, isOpen, showUser, medianDur,
  onSelect, onToggle, onRemove,
}) {
  const fba = entry.fbaCode || entry.fileName;
  const isCancelled = entry.status === 'cancelled';
  // Per-pallet seconds come from the backend in effective form
  // (lunch + non-working hours stripped). Falls back to wall-clock for
  // legacy rows that pre-date the work-schedule rollout.
  const palTimings = useMemo(() => {
    const eff = (entry.palletEffectiveSeconds || {}) as Record<string, number>;
    const keys = Object.keys(eff);
    if (keys.length > 0) return keys.map((k) => eff[k]).filter((v) => v > 0);
    return (Object.values(entry.palletTimings || {}) as Array<{ startedAt?: number; finishedAt?: number }>)
      .map((t) => (t.startedAt && t.finishedAt) ? Math.round((t.finishedAt - t.startedAt) / 1000) : null)
      .filter((v) => v != null);
  }, [entry.palletEffectiveSeconds, entry.palletTimings]);
  const ehPerMin = entry._ehPerMin;
  const cmpPct = medianDur > 0 && entry.durationSec
    ? Math.round(((entry.durationSec - medianDur) / medianDur) * 100)
    : null;

  const borderColor = isCancelled
    ? T.status.danger.border
    : (isSelected ? T.text.primary : T.border.primary);
  const borderWidth = isCancelled ? 2 : 1;

  return (
    <div
      onClick={() => { onSelect(); onToggle(); }}
      style={{
        background: isCancelled ? T.status.danger.bg : T.bg.surface,
        border: `${borderWidth}px solid ${borderColor}`,
        borderRadius: T.radius.lg,
        cursor: 'pointer',
        transition: 'border-color 150ms, box-shadow 200ms',
        overflow: 'hidden',
        boxShadow: 'none',
      }}
    >
      <div style={{
        padding: '20px 24px',
        display: 'grid',
        gridTemplateColumns: 'auto 1fr auto',
        alignItems: 'center',
        gap: 16,
      }}>
        {/* Position */}
        <span style={{
          flex: '0 0 36px',
          fontSize: 12.5,
          fontFamily: T.font.mono,
          color: T.text.faint,
          fontVariantNumeric: 'tabular-nums',
          fontWeight: 500,
          textAlign: 'right',
        }}>
          {String(idx + 1).padStart(2, '0')}
        </span>

        {/* MAIN */}
        <div style={{ minWidth: 0 }}>
          {/* Title row */}
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
            {isCancelled && (
              <Badge tone="danger">Storniert</Badge>
            )}
            {showUser && entry.assignedToUserName && (
              <Badge tone="neutral">{entry.assignedToUserName}</Badge>
            )}
            {!isCancelled && cmpPct != null && Math.abs(cmpPct) >= 5 && (
              <ComparisonBadge pct={cmpPct} />
            )}
          </div>

          {/* Sub */}
          <div style={{
            fontSize: 12.5,
            color: T.text.faint,
            marginBottom: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
          }}>
            <span title={entry.fileName} style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 360,
            }}>
              {entry.fileName}
            </span>
            <span style={{ color: T.border.strong }}>·</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }} title={fmtTimestamp(entry.finishedAt)}>
              {fmtRelative(entry.finishedAt)}
            </span>
          </div>

          {/* Pallet-Timings sparkline */}
          {palTimings.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <PalletSparkline timings={palTimings} totalCount={entry.palletCount} />
            </div>
          )}

          {/* Stats */}
          <div style={{
            display: 'flex',
            gap: 22,
            fontSize: 12.5,
            color: T.text.subtle,
            fontVariantNumeric: 'tabular-nums',
            flexWrap: 'wrap',
          }}>
            <Stat label="Paletten" value={entry.palletCount} />
            <Stat label="Artikel"  value={entry.articleCount} />
            <Stat label="Dauer"    value={fmtDurationShort(entry.durationSec)} accent />
            {ehPerMin != null && Number.isFinite(ehPerMin) && (
              <Stat label="EH/min" value={ehPerMin.toFixed(1)} />
            )}
          </div>
        </div>

        {/* Actions */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
        }} onClick={(e) => e.stopPropagation()}>
          <ChevronToggle open={isOpen} onClick={onToggle} />
          <IconBtn
            onClick={onRemove}
            title="Eintrag entfernen"
            danger
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </IconBtn>
        </div>
      </div>

      {/* Expanded detail */}
      {isOpen && (
        <ExpandedDetail entry={entry} onClose={() => onToggle()} />
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label?: React.ReactNode; value?: React.ReactNode; accent?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
      <span style={{ color: T.text.faint }}>{label}</span>
      <span style={{
        color: accent ? T.accent.text : T.text.secondary,
        fontWeight: 500,
        fontFamily: accent ? T.font.mono : 'inherit',
      }}>
        {value}
      </span>
    </span>
  );
}

function ComparisonBadge({ pct }) {
  const faster = pct < 0;
  const palette = faster ? T.status.success : T.status.warn;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '2px 8px',
      fontSize: 11,
      fontWeight: 700,
      fontFamily: T.font.mono,
      background: palette.bg,
      color: palette.text,
      border: `1px solid ${palette.border}`,
      borderRadius: T.radius.full,
      letterSpacing: '0.02em',
    }} title={`Differenz zum Median deiner Aufträge`}>
      {faster ? '−' : '+'}{Math.abs(pct)}% vs Ø
    </span>
  );
}

function PalletSparkline({ timings, totalCount }) {
  const max = Math.max(...timings, 1);
  return (
    <div
      title={`Palettenzeiten: ${timings.length} von ${totalCount} mit Daten`}
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        height: 22,
        gap: 2,
      }}
    >
      {timings.map((t, i) => {
        const h = Math.max(2, Math.round((t / max) * 22));
        const isPeak = t === max && timings.length > 1;
        return (
          <span
            key={i}
            title={`${i + 1}. Palette · ${fmtMmSs(t)}`}
            style={{
              width: 5,
              height: h,
              background: isPeak ? T.status.warn.main : T.accent.main,
              opacity: isPeak ? 1 : Math.max(0.4, t / max),
              borderRadius: 1.5,
            }}
          />
        );
      })}
    </div>
  );
}

function ChevronToggle({ open, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={open ? 'Schließen' : 'Details öffnen'}
      style={{
        width: 30, height: 30,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        border: 'none',
        borderRadius: T.radius.sm,
        color: T.text.subtle,
        cursor: 'pointer',
        transition: 'transform 200ms ease',
        transform: open ? 'rotate(180deg)' : 'rotate(0)',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

function IconBtn({ children, onClick, title, danger }: { children?: React.ReactNode; onClick?: (e: React.MouseEvent) => void; title?: string; danger?: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 30, height: 30,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: hover ? (danger ? T.status.danger.bg : T.bg.surface3) : 'transparent',
        border: 'none',
        borderRadius: T.radius.sm,
        color: hover ? (danger ? T.status.danger.text : T.text.primary) : T.text.faint,
        cursor: 'pointer',
        transition: 'background 150ms, color 150ms',
      }}
    >
      {children}
    </button>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Expanded detail — Gantt timing + lazy article fetch
   ════════════════════════════════════════════════════════════════════════ */
function ExpandedDetail({ entry }: { entry: { id: string; fileName?: string | null; palletCount?: number; articleCount?: number; durationSec?: number | null; palletTimings?: Record<string, { startedAt?: number; finishedAt?: number }>; palletEffectiveSeconds?: Record<string, number>; status?: string }; onClose?: () => void }) {
  const detailQ = useQuery({
    queryKey: ['auftrag', entry.id],
    queryFn: () => getAuftrag(entry.id),
    staleTime: Infinity,
    refetchInterval: false,
  });

  const cancellation = (detailQ.data?.parsed as { cancellation?: {
    items: Array<{ palletId: string | null; itemIdx: number | null; code: string | null; title: string | null; reason: string | null }>;
    note: string | null;
    at: string;
    by: { id: string; name: string } | null;
  } } | null | undefined)?.cancellation || null;

  /* Lookup map for inline highlight: `${palletId}|${itemIdx}` → reason.
     palletId/itemIdx may be null (ESKU); those entries surface in the
     dedicated Stornierung block only, not in the article table. */
  const cancelByKey = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const it of cancellation?.items || []) {
      if (it.palletId != null && it.itemIdx != null) {
        m.set(`${it.palletId}|${it.itemIdx}`, it.reason);
      }
    }
    return m;
  }, [cancellation]);

  const articles = useMemo(() => {
    const pallets = detailQ.data?.parsed?.pallets || [];
    return pallets.flatMap((p) =>
      (p.items || []).map((it, i) => ({
        palletId: p.id,
        itemIdx:  i,
        sku:      it.sku,
        fnsku:    it.fnsku,
        title:    it.title,
        units:    it.units,
        useItem:  it.useItem,
        level:    getDisplayLevel(it),
      })),
    );
  }, [detailQ.data]);

  const palletGantt = useMemo(() => {
    /* Build [{id, level, durSec, startMs, endMs}] in pallet order.
       Duration prefers backend-computed effective seconds (lunch +
       non-work hours stripped); wall-clock startMs/endMs stay for the
       gantt-bar layout so the visual gap of an overnight Auftrag is
       still visible. */
    const pallets = detailQ.data?.parsed?.pallets || [];
    const lookup = new Map(pallets.map((p) => [p.id, p]));
    const eff = (entry.palletEffectiveSeconds || {}) as Record<string, number>;
    const rows: { id: string; level: number; durSec: number; startMs: number; endMs: number }[] = [];
    for (const [id, t] of Object.entries((entry.palletTimings || {}) as Record<string, { startedAt?: number; finishedAt?: number }>)) {
      if (!t.startedAt || !t.finishedAt) continue;
      const p = lookup.get(id);
      const items = p?.items || [];
      const lvl = items.length ? primaryLevelOf(items) : 1;
      const durSec = (eff[id] != null && eff[id] > 0)
        ? eff[id]
        : Math.round((t.finishedAt - t.startedAt) / 1000);
      rows.push({
        id,
        level: lvl,
        durSec,
        startMs: t.startedAt,
        endMs:   t.finishedAt,
      });
    }
    rows.sort((a, b) => a.startMs - b.startMs);
    return rows;
  }, [entry.palletTimings, entry.palletEffectiveSeconds, detailQ.data]);

  const ganttTotal = palletGantt.reduce((s, r) => s + r.durSec, 0);

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        padding: '4px 24px 24px',
        background: T.bg.surface2,
        cursor: 'default',
        borderTop: `1px solid ${T.border.subtle}`,
      }}
    >
      {cancellation && (
        <CancellationBlock cancellation={cancellation} />
      )}

      {/* Palette-Gantt */}
      <SectionLabel
        title="Palettenzeiten"
        sub={`${palletGantt.length} von ${entry.palletCount} ${palletGantt.length === 1 ? 'Palette' : 'Paletten'} mit Daten · ${fmtDurationShort(ganttTotal)} kumuliert`}
      />
      {palletGantt.length === 0 ? (
        <div style={{
          padding: '14px 16px',
          fontSize: 12.5,
          color: T.text.faint,
          background: T.bg.surface,
          border: `1px dashed ${T.border.strong}`,
          borderRadius: T.radius.md,
          marginBottom: 24,
        }}>
          Keine Palettenzeiten erfasst.
        </div>
      ) : (
        <PalletGantt rows={palletGantt} totalSec={ganttTotal} />
      )}

      {/* Articles */}
      <div style={{ marginTop: 24 }}>
        <SectionLabel
          title="Artikel"
          sub={detailQ.isLoading ? 'lädt…' : `${articles.length} insgesamt`}
        />
        {detailQ.isError ? (
          <div style={{
            padding: '12px 14px',
            background: T.status.danger.bg,
            border: `1px solid ${T.status.danger.border}`,
            borderRadius: T.radius.md,
            color: T.status.danger.text,
            fontSize: 12.5,
          }}>
            Konnte Artikel nicht laden: {detailQ.error?.message || 'Fehler'}
          </div>
        ) : (
          <div style={{
            border: `1px solid ${T.border.primary}`,
            background: T.bg.surface,
            borderRadius: T.radius.md,
            overflow: 'hidden',
            maxHeight: 320,
            overflowY: 'auto',
          }}>
            <div style={articlesHeader}>
              <span>Palette</span>
              <span>Name</span>
              <span>Code</span>
              <span>Use-Item</span>
              <span style={{ textAlign: 'right' }}>Menge</span>
            </div>
            {detailQ.isLoading && (
              <div style={{ padding: '24px 14px', textAlign: 'center', fontSize: 12.5, color: T.text.faint }}>
                Artikel werden geladen…
              </div>
            )}
            {!detailQ.isLoading && articles.length === 0 && (
              <div style={{ padding: '24px 14px', textAlign: 'center', fontSize: 12.5, color: T.text.faint }}>
                Keine Artikel-Daten gespeichert.
              </div>
            )}
            {articles.slice(0, 200).map((a, j) => {
              const meta = LEVEL_META[a.level] || LEVEL_META[1];
              const cancelKey = `${a.palletId}|${a.itemIdx}`;
              const isCancelled = cancelByKey.has(cancelKey);
              const cancelReason = isCancelled ? cancelByKey.get(cancelKey) : null;
              return (
                <div
                  key={j}
                  style={{
                    borderBottom: j < articles.length - 1 ? `1px solid ${T.border.subtle}` : 'none',
                    background: isCancelled ? T.status.danger.bg : 'transparent',
                  }}
                >
                  <div style={articlesRow}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: T.font.mono, fontSize: 11.5 }}>
                      <span style={{
                        width: 6, height: 6,
                        borderRadius: '50%',
                        background: isCancelled ? T.status.danger.main : meta.color,
                        flexShrink: 0,
                      }} />
                      <span style={{ color: isCancelled ? T.status.danger.text : T.text.faint }}>{a.palletId}</span>
                    </span>
                    <span style={{
                      color: isCancelled ? T.status.danger.text : T.text.primary,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontWeight: isCancelled ? 600 : 400,
                    }}>
                      {a.title || '—'}
                    </span>
                    <span style={{ fontFamily: T.font.mono, fontSize: 11.5, color: isCancelled ? T.status.danger.text : T.text.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.fnsku || a.sku || '—'}
                    </span>
                    <span style={{ fontFamily: T.font.mono, fontSize: 11.5, color: T.text.subtle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.useItem || '—'}
                    </span>
                    <span style={{ fontWeight: 600, color: isCancelled ? T.status.danger.text : T.text.primary, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {a.units || 0}
                    </span>
                  </div>
                  {isCancelled && (
                    <div style={{
                      padding: '0 14px 8px 28px',
                      fontSize: 11.5,
                      fontFamily: T.font.mono,
                      color: T.status.danger.text,
                      letterSpacing: '0.02em',
                    }}>
                      <span style={{ fontWeight: 700, textTransform: 'uppercase' }}>Storniert</span>
                      {cancelReason ? <span> · {cancelReason}</span> : null}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function PalletGantt({ rows, totalSec }) {
  const max = Math.max(...rows.map((r) => r.durSec), 1);
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      padding: '4px 0 8px',
    }}>
      {rows.map((r) => {
        const meta = LEVEL_META[r.level] || LEVEL_META[1];
        const widthPct = (r.durSec / max) * 100;
        const sharePct = totalSec > 0 ? (r.durSec / totalSec) * 100 : 0;
        return (
          <div key={r.id} style={{
            display: 'grid',
            gridTemplateColumns: '90px 1fr 80px',
            alignItems: 'center',
            gap: 12,
          }}>
            <span style={{
              fontFamily: T.font.mono,
              fontSize: 11.5,
              fontWeight: 500,
              color: T.text.primary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }} title={r.id}>
              {r.id}
            </span>
            <div style={{
              position: 'relative',
              height: 18,
              background: T.bg.surface3,
              borderRadius: 4,
              overflow: 'hidden',
            }}>
              <div
                title={`${meta.shortName} · ${fmtMmSs(r.durSec)} · ${sharePct.toFixed(0)}% Anteil`}
                style={{
                  width: `${widthPct}%`,
                  height: '100%',
                  background: meta.color,
                  borderRadius: 4,
                  transition: 'width 320ms cubic-bezier(0.16, 1, 0.3, 1)',
                }}
              />
            </div>
            <span style={{
              fontFamily: T.font.mono,
              fontSize: 11.5,
              fontWeight: 500,
              color: T.text.primary,
              fontVariantNumeric: 'tabular-nums',
              textAlign: 'right',
            }}>
              {fmtMmSs(r.durSec)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function primaryLevelOf(items) {
  /* Cheap inline reducer to avoid importing primaryLevel for one use. */
  const counts = {};
  for (const it of items) {
    const lvl = getDisplayLevel(it);
    counts[lvl] = (counts[lvl] || 0) + (it.units || 0);
  }
  let best = 1, bestN = -1;
  for (const [lvl, n] of Object.entries(counts) as Array<[string, number]>) {
    if (n > bestN) { bestN = n; best = parseInt(lvl, 10); }
  }
  return best;
}

/* Storniert-Block — shown at the top of ExpandedDetail when the
   Auftrag was aborted from Focus. Surfaces the operator's reason
   trail (who, when, optional global note, optional per-article
   reasons) so a reviewer can see WHY the row was stornert without
   scrolling through palette/Artikel sections that may be empty. */
function CancellationBlock({ cancellation }: {
  cancellation: {
    items: Array<{ palletId: string | null; itemIdx: number | null; code: string | null; title: string | null; reason: string | null }>;
    note: string | null;
    at: string;
    by: { id: string; name: string } | null;
  };
}) {
  const at = cancellation.at ? new Date(cancellation.at) : null;
  const atFmt = at && !isNaN(at.getTime())
    ? at.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;
  const items = cancellation.items || [];
  return (
    <div style={{
      marginTop: 8,
      marginBottom: 22,
      padding: '14px 16px',
      background: T.status.danger.bg,
      border: `1px solid ${T.status.danger.border}`,
      borderRadius: T.radius.md,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginBottom: 8,
        flexWrap: 'wrap',
      }}>
        <span style={{
          fontSize: 10.5,
          fontFamily: T.font.mono,
          fontWeight: 700,
          color: T.status.danger.text,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
        }}>
          Storniert
        </span>
        {cancellation.by?.name && (
          <span style={{ fontSize: 12, color: T.text.subtle }}>
            durch <strong style={{ color: T.text.primary }}>{cancellation.by.name}</strong>
          </span>
        )}
        {atFmt && (
          <span style={{ fontSize: 12, color: T.text.faint, fontVariantNumeric: 'tabular-nums' }}>
            · {atFmt}
          </span>
        )}
      </div>
      {cancellation.note && (
        <div style={{
          fontSize: 13,
          color: T.text.primary,
          marginBottom: items.length ? 10 : 0,
          whiteSpace: 'pre-wrap',
        }}>
          {cancellation.note}
        </div>
      )}
      {items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map((it, i) => (
            <div
              key={i}
              style={{
                display: 'grid',
                gridTemplateColumns: '90px 1fr',
                gap: 10,
                fontSize: 12.5,
                lineHeight: 1.4,
              }}
            >
              <span style={{
                fontFamily: T.font.mono,
                fontSize: 11.5,
                color: T.status.danger.text,
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {it.palletId || 'ESKU'}
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{
                  color: T.text.primary,
                  fontWeight: 500,
                  marginRight: 6,
                }}>
                  {it.title || it.code || '—'}
                </span>
                {it.code && it.code !== it.title && (
                  <span style={{ fontFamily: T.font.mono, fontSize: 11.5, color: T.text.subtle, marginRight: 6 }}>
                    · {it.code}
                  </span>
                )}
                {it.reason && (
                  <span style={{ color: T.status.danger.text, fontStyle: 'italic' }}>
                    — {it.reason}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ title, sub }: { title?: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{
        fontSize: 10.5,
        fontFamily: T.font.mono,
        fontWeight: 600,
        color: T.text.subtle,
        textTransform: 'uppercase',
        letterSpacing: '0.10em',
      }}>
        {title}
      </div>
      {sub && (
        <div style={{
          fontSize: 12,
          color: T.text.faint,
          marginTop: 2,
          fontFamily: T.font.ui,
        }}>
          {sub}
        </div>
      )}
    </div>
  );
}

const articlesHeader: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '90px minmax(0, 2.4fr) 1.2fr 1.2fr 70px',
  padding: '8px 14px',
  background: T.bg.surface2,
  borderBottom: `1px solid ${T.border.primary}`,
  fontSize: 11,
  fontWeight: 600,
  fontFamily: T.font.mono,
  color: T.text.subtle,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  position: 'sticky',
  top: 0,
};

const articlesRow: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '90px minmax(0, 2.4fr) 1.2fr 1.2fr 70px',
  padding: '9px 14px',
  fontSize: 12.5,
  color: T.text.secondary,
  alignItems: 'center',
};

/* ──────────────────────────────────────────────────────────────────────── */
function KbdHints() {
  const items = [
    { k: 'j / k', v: 'Navigieren' },
    { k: '⏎',    v: 'Details öffnen' },
    { k: '/',    v: 'Suche' },
    { k: 'e',    v: 'xlsx Export' },
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
   Visual language mirrors BetaWarteschlange / BetaPruefen: paper-island
   #F4F5F7 cards with halo + 2px white rim, Outfit font (via [data-beta=1]
   in index.css), big mono numbers, hairline dividers between rows.
   Details open in a centered modal drawer (no inline expand bloat).
   Toolbar (search + range + sort + export + clear) lives in a fixed
   bottom-floating dock.
   ════════════════════════════════════════════════════════════════════════ */

const BH_PAPER_BG     = '#F4F5F7';
const BH_PAPER_RIM    = '#FFFFFF';
const BH_PAPER_RADIUS = 32;
const BH_INNER_RADIUS = 24;
const BH_DRAWER_WIDTH = 760;

/* ──────────────────────────────────────────────────────────────────────── */
function BetaHistorie() {
  const { history, removeHistoryEntry, clearHistory } = useAppState();

  const [drawerEntryId, setDrawerEntryId] = useState<string | null>(null);
  const [search, setSearch]               = useState('');
  const [range, setRange]                 = useState('all');
  const [sort, setSort]                   = useState('newest');
  const [userFilter, setUserFilter]       = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx]     = useState(0);
  const [exporting, setExporting]         = useState(false);

  const searchRef = useRef<HTMLInputElement | null>(null);

  /* enrichment — same shape as classic */
  const enriched = useMemo(
    () => history.map((h) => {
      const dur = h.durationSec ?? 0;
      const minPerPallet  = h.palletCount  > 0 && dur > 0 ? dur / h.palletCount  / 60 : null;
      const minPerArticle = h.articleCount > 0 && dur > 0 ? dur / h.articleCount / 60 : null;
      const ehPerMin      = dur > 0
        ? (sumUnitsFromTimings(h) ?? estimateUnitsFromArticles(h.articleCount)) / (dur / 60)
        : null;
      return { ...h, _minPerPallet: minPerPallet, _minPerArticle: minPerArticle, _ehPerMin: ehPerMin };
    }),
    [history],
  );

  const stats = useMemo(() => {
    if (!enriched.length) return { medianDur: 0, medianMinPerPallet: 0, medianMinPerArticle: 0 };
    return {
      medianDur:           median(enriched.map((e) => e.durationSec).filter(Boolean)),
      medianMinPerPallet:  median(enriched.map((e) => e._minPerPallet).filter((v) => v != null)),
      medianMinPerArticle: median(enriched.map((e) => e._minPerArticle).filter((v) => v != null)),
    };
  }, [enriched]);

  const records = useMemo(() => computeRecords(enriched), [enriched]);

  const userBreakdown = useMemo(() => {
    const m = new Map();
    for (const e of enriched) {
      const u = e.assignedToUserName || '—';
      m.set(u, (m.get(u) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  }, [enriched]);

  const rangeStart = useMemo(() => {
    const now = new Date();
    if (range === 'today') { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
    if (range === 'week')  { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 7); return d.getTime(); }
    if (range === 'month') { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() - 1); return d.getTime(); }
    return null;
  }, [range]);

  const visible = useMemo(() => {
    let arr = enriched;
    if (rangeStart != null) arr = arr.filter((e) => (e.finishedAt || 0) >= rangeStart);
    if (userFilter) arr = arr.filter((e) => (e.assignedToUserName || '—') === userFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      arr = arr.filter((e) => {
        return (e.fbaCode || '').toLowerCase().includes(q)
            || (e.fileName || '').toLowerCase().includes(q);
      });
    }
    return sortEntries(arr, sort);
  }, [enriched, rangeStart, userFilter, search, sort]);

  const trend = useMemo(() => buildTrend(enriched, TREND_DAYS), [enriched]);

  useEffect(() => {
    if (selectedIdx >= visible.length) setSelectedIdx(Math.max(0, visible.length - 1));
  }, [visible.length, selectedIdx]);

  /* close drawer if the entry leaves visible scope */
  useEffect(() => {
    if (drawerEntryId && !enriched.some((e) => e.id === drawerEntryId)) {
      setDrawerEntryId(null);
    }
  }, [enriched, drawerEntryId]);

  /* body scroll lock while drawer open */
  useEffect(() => {
    if (!drawerEntryId) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [drawerEntryId]);

  const onExport = useCallback(async () => {
    try {
      setExporting(true);
      const params: { from?: string } = {};
      if (rangeStart) params.from = new Date(rangeStart).toISOString().slice(0, 10);
      await downloadAuftraegeXlsx(params);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unbekannter Fehler';
      alert('Export fehlgeschlagen: ' + msg);
    } finally {
      setExporting(false);
    }
  }, [rangeStart]);

  /* keyboard cockpit — Esc closes drawer first */
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
        if (drawerEntryId) { setDrawerEntryId(null); return; }
        if (document.activeElement === searchRef.current) {
          searchRef.current?.blur();
          if (search) setSearch('');
          return;
        }
      }
      if (inField) return;
      if (e.key === 'e' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (!exporting) onExport();
        return;
      }
      if (!visible.length) return;
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(visible.length - 1, i + 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const target = visible[selectedIdx];
        if (target) setDrawerEntryId(target.id);
      } else if (e.key === 'x' || e.key === 'Delete') {
        e.preventDefault();
        const target = visible[selectedIdx];
        if (target && window.confirm(`Eintrag ${target.fbaCode || target.fileName} löschen?`)) {
          removeHistoryEntry(target.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, selectedIdx, search, exporting, drawerEntryId, onExport, removeHistoryEntry]);

  const hasAny = enriched.length > 0;
  const noResults = hasAny && visible.length === 0;
  const drawerEntry = useMemo(
    () => (drawerEntryId ? enriched.find((e) => e.id === drawerEntryId) || null : null),
    [enriched, drawerEntryId],
  );

  return (
    <Page>
      <BetaHistorieStyles />

      <main style={{
        maxWidth: 1080,
        margin: '0 auto',
        padding: '32px 32px 180px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        fontFamily: T.font.ui,
      }}>
        {!hasAny ? (
          <BetaHistorieEmpty />
        ) : (
          <>
            {/* HERO — Records + Trend in one paper-island */}
            <BetaPaperCard>
              {records.fastest && (
                <BetaWhitePanel padding="28px 32px">
                  <BetaEyebrow dot color={T.accent.text}>Persönliche Rekorde</BetaEyebrow>
                  <div style={{
                    marginTop: 16,
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, 1fr)',
                    gap: 14,
                  }}>
                    <BetaRecordCard
                      icon="🥇"
                      label="Schnellster Auftrag"
                      value={fmtDurationShort(records.fastest.durationSec)}
                      entryFba={records.fastest.fbaCode || records.fastest.fileName}
                      sub={`${records.fastest.palletCount} Paletten · ${records.fastest.articleCount} Artikel`}
                      onClick={() => setDrawerEntryId(records.fastest!.id)}
                    />
                    {records.bestPerPallet && (
                      <BetaRecordCard
                        icon="⚡"
                        label="Beste Min/Palette"
                        value={`${records.bestPerPallet._minPerPallet.toFixed(1)} min`}
                        entryFba={records.bestPerPallet.fbaCode || records.bestPerPallet.fileName}
                        sub={`${records.bestPerPallet.palletCount} Paletten gesamt`}
                        onClick={() => setDrawerEntryId(records.bestPerPallet!.id)}
                      />
                    )}
                    {records.bestPerArticle && (
                      <BetaRecordCard
                        icon="📈"
                        label="Beste Min/Artikel"
                        value={`${records.bestPerArticle._minPerArticle.toFixed(2)} min`}
                        entryFba={records.bestPerArticle.fbaCode || records.bestPerArticle.fileName}
                        sub={`${records.bestPerArticle.articleCount} Artikel gesamt`}
                        onClick={() => setDrawerEntryId(records.bestPerArticle!.id)}
                      />
                    )}
                  </div>
                </BetaWhitePanel>
              )}
              <BetaWhitePanel padding="20px 32px 22px">
                <BetaTrendStrip trend={trend} />
              </BetaWhitePanel>
            </BetaPaperCard>

            {/* SECTION EYEBROW */}
            <div style={{ paddingLeft: 4, marginTop: 6 }}>
              <BetaEyebrow>
                Aufträge · {visible.length} sichtbar von {enriched.length} gesamt
              </BetaEyebrow>
            </div>

            {/* LIST */}
            {noResults ? (
              <BetaPaperCard>
                <BetaWhitePanel padding="36px 32px">
                  <div style={{ textAlign: 'center', color: T.text.subtle, fontSize: 13.5 }}>
                    Keine Aufträge passen zu Suche oder Filter.
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}>
                    <button
                      type="button"
                      onClick={() => { setSearch(''); setRange('all'); setUserFilter(null); }}
                      style={{
                        all: 'unset',
                        cursor: 'pointer',
                        padding: '8px 16px',
                        borderRadius: 999,
                        background: BH_PAPER_BG,
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
            ) : (
              <BetaPaperCard>
                <BetaWhitePanel padding="6px 8px">
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {visible.map((entry, idx) => (
                      <BetaHistorieRow
                        key={entry.id}
                        entry={entry}
                        idx={idx}
                        isSelected={idx === selectedIdx}
                        isLast={idx === visible.length - 1}
                        showUser={userBreakdown.length > 1}
                        medianDur={stats.medianDur}
                        onSelect={() => setSelectedIdx(idx)}
                        onOpen={() => { setSelectedIdx(idx); setDrawerEntryId(entry.id); }}
                        onRemove={() => {
                          if (window.confirm(`Eintrag ${entry.fbaCode || entry.fileName} löschen?`)) {
                            removeHistoryEntry(entry.id);
                          }
                        }}
                      />
                    ))}
                  </ul>
                </BetaWhitePanel>
              </BetaPaperCard>
            )}

            <BetaHistorieKbdHints />
          </>
        )}
      </main>

      {/* BOTTOM DOCK */}
      {hasAny && (
        <BetaHistorieDock
          entryCount={enriched.length}
          visibleCount={visible.length}
          search={search}
          onSearch={setSearch}
          searchRef={searchRef}
          range={range}
          onRange={setRange}
          sort={sort}
          onSort={setSort}
          userFilter={userFilter}
          onUserFilter={setUserFilter}
          userBreakdown={userBreakdown}
          onExport={onExport}
          exporting={exporting}
          onClear={clearHistory}
        />
      )}

      {/* DRAWER */}
      {drawerEntry && (
        <BetaHistorieDrawer
          entry={drawerEntry}
          onClose={() => setDrawerEntryId(null)}
        />
      )}
    </Page>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Beta atoms — local clones of the Warteschlange atoms.
   ════════════════════════════════════════════════════════════════════════ */

function BetaHistorieStyles() {
  return (
    <style>{`
      @keyframes mb-h-rise {
        0%   { opacity: 0; transform: translateY(8px); }
        100% { opacity: 1; transform: translateY(0); }
      }
      @keyframes mb-h-drawer-in {
        0%   { opacity: 0; transform: translate(-50%, -48%) scale(0.96); }
        100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      }
      @keyframes mb-h-backdrop-in {
        0%   { opacity: 0; }
        100% { opacity: 1; }
      }
      @keyframes mb-h-spin {
        to { transform: rotate(360deg); }
      }
      @keyframes mb-h-menu-in {
        0%   { opacity: 0; transform: translateY(6px) scale(0.97); }
        100% { opacity: 1; transform: translateY(0)   scale(1);    }
      }
      @media (max-width: 900px) {
        .mb-h-drawer { width: calc(100vw - 24px) !important; max-height: calc(100vh - 24px) !important; }
        .mb-h-backdrop { background: rgba(15,23,42,0.42) !important; }
      }
      .mb-h-row:hover .mb-h-row-actions { opacity: 1; }
      .mb-h-row:hover .mb-h-row-fba    { color: ${T.text.primary}; }
    `}</style>
  );
}

function BetaPaperCard({ children, glow = false, padding = 8 }: { children?: React.ReactNode; glow?: boolean; padding?: number }) {
  return (
    <div style={{
      padding,
      background: BH_PAPER_BG,
      border: `2px solid ${BH_PAPER_RIM}`,
      borderRadius: BH_PAPER_RADIUS,
      boxShadow: glow
        ? '0 0 0 0.5px rgba(255,91,31,0.18), 0 16px 48px rgba(255,91,31,0.10), 0 0 89.7px rgba(0,0,0,0.05)'
        : '0 0 89.7px rgba(0,0,0,0.05)',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      {children}
    </div>
  );
}

function BetaWhitePanel({ children, padding }: { children?: React.ReactNode; padding?: string }) {
  return (
    <div style={{
      background: '#FFFFFF',
      borderRadius: BH_INNER_RADIUS,
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
      background: dim ? 'transparent' : BH_PAPER_BG,
      borderRadius: 6,
      lineHeight: 1,
      letterSpacing: '0.04em',
    }}>{children}</span>
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
      padding: '3px 9px',
      borderRadius: 999,
      background: palette.bg,
      color: palette.color,
      fontFamily: T.font.mono,
      fontSize: 10,
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '0.10em',
    }}>
      {children}
    </span>
  );
}

function BetaRowAction({ onClick, disabled, title, children }: any) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        all: 'unset',
        cursor: disabled ? 'not-allowed' : 'pointer',
        width: 28, height: 28,
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
        e.currentTarget.style.background = BH_PAPER_BG;
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

/* ════════════════════════════════════════════════════════════════════════
   Records hero
   ════════════════════════════════════════════════════════════════════════ */

function BetaRecordCard({ icon, label, value, entryFba, sub, onClick }: {
  icon: React.ReactNode; label: React.ReactNode; value: React.ReactNode;
  entryFba?: string | null; sub?: string | null;
  onClick?: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        all: 'unset',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '18px 20px',
        background: hover ? '#FFFFFF' : BH_PAPER_BG,
        borderRadius: 18,
        boxShadow: hover
          ? '0 8px 28px rgba(15,23,42,0.10)'
          : 'inset 0 0 0 1px rgba(15,23,42,0.04)',
        transform: hover ? 'translateY(-1px)' : 'translateY(0)',
        transition: 'background 200ms ease, box-shadow 200ms ease, transform 200ms cubic-bezier(0.16,1,0.3,1)',
      }}
    >
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 10.5,
        fontFamily: T.font.mono,
        fontWeight: 700,
        color: T.text.subtle,
        textTransform: 'uppercase',
        letterSpacing: '0.14em',
      }}>
        <span style={{ fontSize: 14 }} aria-hidden>{icon}</span>
        <span>{label}</span>
      </div>
      <div style={{
        fontFamily: T.font.ui,
        fontSize: 'clamp(24px, 2.6vw, 32px)',
        fontWeight: 600,
        letterSpacing: '-0.025em',
        color: T.text.primary,
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1.05,
      }}>
        {value}
      </div>
      {entryFba && (
        <div style={{
          fontFamily: T.font.mono,
          fontSize: 12,
          color: T.text.muted,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {entryFba}
        </div>
      )}
      {sub && (
        <div style={{ fontSize: 11.5, color: T.text.faint }}>
          {sub}
        </div>
      )}
    </button>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   14-day trend strip
   ════════════════════════════════════════════════════════════════════════ */

function BetaTrendStrip({ trend }: { trend: Array<TrendBucket & { avgSec: number }> }) {
  const max = Math.max(1, ...trend.map((b) => b.count));
  const totalCount = trend.reduce((s, b) => s + b.count, 0);
  const totalSec   = trend.reduce((s, b) => s + b.totalSec, 0);
  const avgSec     = totalCount ? Math.round(totalSec / totalCount) : 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <BetaEyebrow>14-Tage Trend</BetaEyebrow>
          <span style={{ fontSize: 12, color: T.text.faint }}>
            Aufträge pro Tag · ø {avgSec ? fmtDurationLong(avgSec) : '—'} Dauer
          </span>
        </div>
        <span style={{
          fontSize: 12,
          color: T.text.subtle,
          fontVariantNumeric: 'tabular-nums',
          fontFamily: T.font.mono,
        }}>
          {totalCount} Aufträge gesamt
        </span>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${trend.length}, 1fr)`,
        gap: 6,
        height: 72,
        alignItems: 'end',
      }}>
        {trend.map((b) => (
          <BetaTrendBar key={b.ms} bucket={b} max={max} />
        ))}
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${trend.length}, 1fr)`,
        gap: 6,
        fontSize: 10,
        fontFamily: T.font.mono,
        color: T.text.faint,
        textAlign: 'center',
        letterSpacing: '0.04em',
      }}>
        {trend.map((b, i) => (
          <span key={b.ms}>{i % 2 === 0 ? b.label : '·'}</span>
        ))}
      </div>
    </div>
  );
}

function BetaTrendBar({ bucket, max }: { bucket: TrendBucket & { avgSec: number }; max: number }) {
  const [hover, setHover] = useState(false);
  const h = bucket.count ? Math.max(4, Math.round((bucket.count / max) * 64)) : 3;
  const isToday = (() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return bucket.ms === today.getTime();
  })();
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
      }}
    >
      <div style={{
        height: h,
        borderRadius: 4,
        background: bucket.count
          ? (isToday ? T.accent.main : 'var(--accent)')
          : 'rgba(15,23,42,0.06)',
        opacity: bucket.count
          ? (isToday ? 1 : Math.max(0.5, bucket.count / max))
          : 1,
        transition: 'opacity 160ms ease, transform 200ms cubic-bezier(0.16,1,0.3,1)',
        transform: hover ? 'scaleY(1.04)' : 'none',
        transformOrigin: 'bottom',
      }} />
      {hover && bucket.count > 0 && (
        <div style={{
          position: 'absolute',
          bottom: h + 8,
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '6px 10px',
          fontSize: 11,
          fontFamily: T.font.mono,
          color: T.text.primary,
          background: '#FFFFFF',
          border: `1px solid rgba(15,23,42,0.08)`,
          borderRadius: 8,
          whiteSpace: 'nowrap',
          boxShadow: '0 8px 22px rgba(15,23,42,0.10)',
          pointerEvents: 'none',
          zIndex: 4,
        }}>
          <div style={{ fontWeight: 700 }}>
            {bucket.shortDay}, {bucket.label}
          </div>
          <div style={{ marginTop: 3, color: T.text.subtle }}>
            {bucket.count} {bucket.count === 1 ? 'Auftrag' : 'Aufträge'} · ø {fmtDurationLong(bucket.avgSec)}
          </div>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   List rows
   ════════════════════════════════════════════════════════════════════════ */

function BetaHistorieRow({
  entry, idx, isSelected, isLast, showUser, medianDur,
  onSelect, onOpen, onRemove,
}: any) {
  const fba = entry.fbaCode || entry.fileName;
  const isCancelled = entry.status === 'cancelled';
  const palTimings = useMemo(() => {
    const eff = (entry.palletEffectiveSeconds || {}) as Record<string, number>;
    const keys = Object.keys(eff);
    if (keys.length > 0) return keys.map((k) => eff[k]).filter((v): v is number => v > 0);
    return (Object.values(entry.palletTimings || {}) as Array<{ startedAt?: number; finishedAt?: number }>)
      .map((t) => (t.startedAt && t.finishedAt) ? Math.round((t.finishedAt - t.startedAt) / 1000) : null)
      .filter((v): v is number => v != null);
  }, [entry.palletEffectiveSeconds, entry.palletTimings]);
  const ehPerMin = entry._ehPerMin;
  const cmpPct = medianDur > 0 && entry.durationSec
    ? Math.round(((entry.durationSec - medianDur) / medianDur) * 100)
    : null;

  return (
    <li
      className="mb-h-row"
      onClick={() => { onSelect(); onOpen(); }}
      style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: 'auto auto 1fr auto auto',
        alignItems: 'center',
        gap: 14,
        padding: '14px 16px',
        cursor: 'pointer',
        borderRadius: BH_INNER_RADIUS - 6,
        background: isSelected ? BH_PAPER_BG : 'transparent',
        borderBottom: isLast ? 'none' : '1px solid rgba(15,23,42,0.06)',
        transition: 'background 160ms ease',
      }}
    >
      {/* cancellation hairline */}
      {isCancelled && (
        <span aria-hidden style={{
          position: 'absolute',
          left: 4, top: 8, bottom: 8,
          width: 3,
          borderRadius: 2,
          background: T.status.danger.main,
        }} />
      )}

      {/* position */}
      <span style={{
        fontFamily: T.font.mono,
        fontSize: 12,
        fontWeight: 500,
        color: T.text.faint,
        fontVariantNumeric: 'tabular-nums',
        textAlign: 'right',
        minWidth: 22,
        paddingLeft: isCancelled ? 6 : 0,
      }}>
        {String(idx + 1).padStart(2, '0')}
      </span>

      {/* pallet timings mini-spark */}
      {palTimings.length > 0
        ? <BetaPalletTimingsBar timings={palTimings} totalCount={entry.palletCount} />
        : <span style={{ width: 64, height: 18 }} />}

      {/* main: FBA + filename + badges */}
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}>
          <span
            className="mb-h-row-fba"
            title={String(fba || '')}
            style={{
              fontFamily: T.font.mono,
              fontSize: 14.5,
              fontWeight: 500,
              color: isCancelled ? T.status.danger.text : T.text.secondary,
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
          {isCancelled && <BetaStatusPill tone="danger">Storniert</BetaStatusPill>}
          {showUser && entry.assignedToUserName && (
            <span style={{
              fontFamily: T.font.mono,
              fontSize: 10.5,
              color: T.text.faint,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              fontWeight: 600,
            }}>
              {entry.assignedToUserName}
            </span>
          )}
          {!isCancelled && cmpPct != null && Math.abs(cmpPct) >= 5 && (
            <BetaStatusPill tone={cmpPct < 0 ? 'success' : 'warn'}>
              {cmpPct < 0 ? '−' : '+'}{Math.abs(cmpPct)}% Ø
            </BetaStatusPill>
          )}
        </div>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11.5,
          color: T.text.faint,
          fontVariantNumeric: 'tabular-nums',
        }}>
          <span title={entry.fileName} style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 220,
          }}>
            {entry.fileName}
          </span>
          <BetaMetaDot />
          <span title={fmtTimestamp(entry.finishedAt)}>{fmtRelative(entry.finishedAt)}</span>
        </div>
      </div>

      {/* signals */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        fontSize: 12,
        color: T.text.subtle,
        fontVariantNumeric: 'tabular-nums',
        fontFamily: T.font.mono,
      }}>
        <span><span style={{ fontWeight: 600, color: T.text.secondary }}>{entry.palletCount}</span> Pal</span>
        <span><span style={{ fontWeight: 600, color: T.text.secondary }}>{entry.articleCount}</span> Art</span>
        <span style={{ color: T.accent.text, fontWeight: 600 }}>
          {fmtDurationShort(entry.durationSec)}
        </span>
        {ehPerMin != null && Number.isFinite(ehPerMin) && (
          <span>{ehPerMin.toFixed(1)} EH/min</span>
        )}
      </div>

      {/* hover-reveal actions */}
      <div
        className="mb-h-row-actions"
        onClick={(e) => e.stopPropagation()}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 2,
          opacity: isSelected ? 1 : 0,
          transition: 'opacity 160ms ease',
        }}
      >
        <BetaRowAction onClick={onOpen} title="Details öffnen (⏎)">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
               stroke="currentColor" strokeWidth="1.5">
            <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" />
            <circle cx="8" cy="8" r="2" />
          </svg>
        </BetaRowAction>
        <BetaRowAction onClick={onRemove} title="Eintrag löschen (x)">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
            <path d="M2 4h10M5 4V2.5h4V4M3.5 4l.5 8h6l.5-8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </BetaRowAction>
      </div>
    </li>
  );
}

function BetaPalletTimingsBar({ timings, totalCount }: { timings: number[]; totalCount: number }) {
  const max = Math.max(...timings, 1);
  return (
    <span
      title={`Palettenzeiten: ${timings.length} von ${totalCount} mit Daten`}
      style={{
        display: 'inline-flex',
        alignItems: 'flex-end',
        height: 18,
        gap: 1.5,
        minWidth: 64,
      }}
    >
      {timings.map((t, i) => {
        const h = Math.max(2, Math.round((t / max) * 16));
        const isPeak = t === max && timings.length > 1;
        return (
          <span
            key={i}
            title={`P${i + 1} · ${fmtMmSs(t)}`}
            style={{
              width: 4,
              height: h,
              background: isPeak ? T.status.warn.main : T.accent.main,
              opacity: isPeak ? 1 : Math.max(0.45, t / max),
              borderRadius: 1.5,
            }}
          />
        );
      })}
    </span>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Bottom dock
   ════════════════════════════════════════════════════════════════════════ */

function BetaHistorieDock({
  entryCount, visibleCount,
  search, onSearch, searchRef,
  range, onRange, sort, onSort,
  userFilter, onUserFilter, userBreakdown,
  onExport, exporting, onClear,
}: any) {
  const [openMenu, setOpenMenu] = useState<'range' | 'sort' | 'user' | null>(null);

  useEffect(() => {
    if (!openMenu) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('[data-h-dock-menu]')) setOpenMenu(null);
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

  const currentRange = RANGE_PRESETS.find((r) => r.id === range) || RANGE_PRESETS[3];
  const currentSort  = SORT_OPTIONS.find((s) => s.id === sort)  || SORT_OPTIONS[0];

  return (
    <div style={{
      position: 'fixed',
      bottom: 18,
      left: '50%',
      transform: 'translateX(-50%)',
      maxWidth: 'calc(100vw - 24px)',
      zIndex: 60,
      pointerEvents: 'auto',
    }}>
      <BetaPaperCard padding={6}>
        <BetaWhitePanel padding="6px 8px">
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'nowrap',
          }}>
            {/* Export */}
            <button
              type="button"
              onClick={onExport}
              disabled={exporting}
              title="xlsx-Export der sichtbaren Aufträge (E)"
              style={{
                all: 'unset',
                cursor: exporting ? 'wait' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 14px 7px 10px',
                borderRadius: 999,
                background: BH_PAPER_BG,
                color: T.text.secondary,
                fontFamily: T.font.ui,
                fontSize: 12.5,
                fontWeight: 600,
                opacity: exporting ? 0.6 : 1,
                transition: 'background 160ms ease, color 160ms ease',
              }}
              onMouseEnter={(e) => {
                if (exporting) return;
                e.currentTarget.style.background = '#FFFFFF';
                e.currentTarget.style.color = T.text.primary;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = BH_PAPER_BG;
                e.currentTarget.style.color = T.text.secondary;
              }}
            >
              <span style={{
                width: 22, height: 22,
                borderRadius: 999,
                background: '#FFFFFF',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: T.text.subtle,
                flexShrink: 0,
              }}>
                {exporting ? (
                  <svg width="11" height="11" viewBox="0 0 14 14" fill="none"
                       style={{ animation: 'mb-h-spin 800ms linear infinite' }}>
                    <circle cx="7" cy="7" r="5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.6" />
                    <path d="M12 7a5 5 0 0 0-5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none"
                       stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 1.5v7m0 0L3 6m3 2.5L9 6M2 10.5h8" />
                  </svg>
                )}
              </span>
              <span>{exporting ? 'lädt…' : 'xlsx'}</span>
            </button>

            <BetaDockSep />

            {/* Search */}
            <BetaSearchInput
              value={search}
              onChange={onSearch}
              refEl={searchRef}
              placeholder="FBA / Datei…"
            />

            <BetaDockSep />

            {/* Range */}
            <BetaDockMenu
              data-attr="range"
              label="Zeitraum"
              current={currentRange.label}
              open={openMenu === 'range'}
              onToggle={() => setOpenMenu((c) => c === 'range' ? null : 'range')}
              icon={
                <svg width="12" height="12" viewBox="0 0 14 14" fill="none"
                     stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="10" height="9" rx="1.5" />
                  <path d="M2 5.5h10M4.5 2v2.5M9.5 2v2.5" />
                </svg>
              }
              options={RANGE_PRESETS.map((m) => ({ id: m.id, label: m.label, active: range === m.id }))}
              onPick={(id) => { onRange(id); setOpenMenu(null); }}
            />

            <BetaDockSep />

            {/* Sort */}
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
              options={SORT_OPTIONS.map((m) => ({ id: m.id, label: m.label, active: sort === m.id }))}
              onPick={(id) => { onSort(id); setOpenMenu(null); }}
            />

            {/* User filter — only when >1 operator */}
            {userBreakdown.length > 1 && (
              <>
                <BetaDockSep />
                <BetaDockMenu
                  label="Operator"
                  current={userFilter || 'Alle'}
                  open={openMenu === 'user'}
                  onToggle={() => setOpenMenu((c) => c === 'user' ? null : 'user')}
                  icon={
                    <svg width="12" height="12" viewBox="0 0 14 14" fill="none"
                         stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="7" cy="5" r="2.4" />
                      <path d="M2.5 12c.6-2.4 2.5-3.5 4.5-3.5s3.9 1.1 4.5 3.5" />
                    </svg>
                  }
                  options={[
                    { id: '__all', label: 'Alle', hint: `${entryCount}`, active: !userFilter },
                    ...userBreakdown.map((u: { name: string; count: number }) => ({
                      id: u.name, label: u.name, hint: `${u.count}`, active: userFilter === u.name,
                    })),
                  ]}
                  onPick={(id) => {
                    onUserFilter(id === '__all' ? null : id);
                    setOpenMenu(null);
                  }}
                />
              </>
            )}

            {/* Clear all */}
            {entryCount >= 2 && (
              <>
                <BetaDockSep />
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`${entryCount} Einträge wirklich aus der Historie löschen?\n\nDas wirft nur die UI-Zeilen weg — das Audit-Log bleibt erhalten.`)) {
                      onClear();
                    }
                  }}
                  title="Alle aus Historie löschen"
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
        </BetaWhitePanel>
      </BetaPaperCard>
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

function BetaSearchInput({ value, onChange, refEl, placeholder }: any) {
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 10px',
      background: BH_PAPER_BG,
      borderRadius: 999,
      minWidth: 180,
      flex: '0 1 220px',
      maxWidth: 240,
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
    <div data-h-dock-menu style={{ position: 'relative', display: 'inline-block' }}>
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
          background: open ? BH_PAPER_BG : 'transparent',
          color: open ? T.text.primary : T.text.secondary,
          fontFamily: T.font.ui,
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '-0.005em',
          transition: 'background 160ms ease, color 160ms ease',
          maxWidth: 180,
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.background = BH_PAPER_BG;
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = 'transparent';
        }}
      >
        {icon && <span style={{ display: 'inline-flex', color: T.text.faint }}>{icon}</span>}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {current}
        </span>
        <svg
          width="9" height="9" viewBox="0 0 10 10" fill="none"
          style={{
            color: T.text.faint,
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 200ms cubic-bezier(0.16,1,0.3,1)',
            flexShrink: 0,
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
            background: BH_PAPER_BG,
            border: `2px solid ${BH_PAPER_RIM}`,
            borderRadius: 18,
            boxShadow: '0 16px 48px rgba(15,23,42,0.18), 0 0 89.7px rgba(0,0,0,0.05)',
            animation: 'mb-h-menu-in 200ms cubic-bezier(0.16,1,0.3,1)',
          }}
        >
          <div style={{
            background: '#FFFFFF',
            borderRadius: 12,
            padding: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            maxHeight: 280,
            overflowY: 'auto',
          }}>
            {options.map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="menuitem"
                onClick={(e) => { e.stopPropagation(); onPick(opt.id); }}
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
                  if (!opt.active) e.currentTarget.style.background = BH_PAPER_BG;
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
                <span style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {opt.label}
                </span>
                {opt.hint && (
                  <span style={{
                    fontFamily: T.font.mono,
                    fontSize: 10.5,
                    color: T.text.faint,
                    fontWeight: 500,
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {opt.hint}
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

/* ════════════════════════════════════════════════════════════════════════
   Drawer — centered modal with Gantt + articles + cancellation
   ════════════════════════════════════════════════════════════════════════ */

function BetaHistorieDrawer({ entry, onClose }: { entry: any; onClose: () => void }) {
  const detailQ = useQuery({
    queryKey: ['auftrag', entry.id],
    queryFn: () => getAuftrag(entry.id),
    staleTime: Infinity,
    refetchInterval: false,
  });

  const fba = entry.fbaCode || entry.fileName;
  const isCancelled = entry.status === 'cancelled';

  const cancellation = (detailQ.data?.parsed as { cancellation?: {
    items: Array<{ palletId: string | null; itemIdx: number | null; code: string | null; title: string | null; reason: string | null }>;
    note: string | null;
    at: string;
    by: { id: string; name: string } | null;
  } } | null | undefined)?.cancellation || null;

  const cancelByKey = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const it of cancellation?.items || []) {
      if (it.palletId != null && it.itemIdx != null) {
        m.set(`${it.palletId}|${it.itemIdx}`, it.reason);
      }
    }
    return m;
  }, [cancellation]);

  const articles = useMemo(() => {
    const pallets = detailQ.data?.parsed?.pallets || [];
    return pallets.flatMap((p) =>
      (p.items || []).map((it, i) => ({
        palletId: p.id,
        itemIdx:  i,
        sku:      it.sku,
        fnsku:    it.fnsku,
        title:    it.title,
        units:    it.units,
        useItem:  it.useItem,
        level:    getDisplayLevel(it),
      })),
    );
  }, [detailQ.data]);

  const palletGantt = useMemo(() => {
    const pallets = detailQ.data?.parsed?.pallets || [];
    const lookup = new Map(pallets.map((p) => [p.id, p]));
    const rows: { id: string; level: number; durSec: number; startMs: number; endMs: number }[] = [];
    for (const [id, t] of Object.entries((entry.palletTimings || {}) as Record<string, { startedAt?: number; finishedAt?: number }>)) {
      if (!t.startedAt || !t.finishedAt) continue;
      const p = lookup.get(id);
      const items = p?.items || [];
      const lvl = items.length ? primaryLevelOf(items) : 1;
      rows.push({
        id,
        level: lvl,
        durSec: Math.round((t.finishedAt - t.startedAt) / 1000),
        startMs: t.startedAt,
        endMs:   t.finishedAt,
      });
    }
    rows.sort((a, b) => a.startMs - b.startMs);
    return rows;
  }, [entry.palletTimings, detailQ.data]);

  const ganttTotal = palletGantt.reduce((s, r) => s + r.durSec, 0);
  const ehPerMin = entry._ehPerMin;

  return (
    <>
      <div
        className="mb-h-backdrop"
        onClick={onClose}
        aria-hidden
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(15,23,42,0.32)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          zIndex: 1100,
          animation: 'mb-h-backdrop-in 200ms ease-out',
        }}
      />
      <div
        className="mb-h-drawer"
        role="dialog"
        aria-label="Auftrag-Details"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: BH_DRAWER_WIDTH,
          maxWidth: 'calc(100vw - 48px)',
          maxHeight: 'calc(100vh - 64px)',
          padding: 8,
          background: BH_PAPER_BG,
          border: `2px solid ${BH_PAPER_RIM}`,
          borderRadius: BH_PAPER_RADIUS,
          boxShadow: '0 0 0 0.5px rgba(255,91,31,0.10), 0 32px 96px rgba(15,23,42,0.28), 0 0 89.7px rgba(0,0,0,0.05)',
          zIndex: 1110,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          animation: 'mb-h-drawer-in 280ms cubic-bezier(0.16,1,0.3,1)',
        }}
      >
        {/* header */}
        <div style={{
          background: '#FFFFFF',
          borderRadius: BH_INNER_RADIUS,
          padding: '20px 24px 18px',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 14,
          flexShrink: 0,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <BetaEyebrow dot color={isCancelled ? T.status.danger.text : T.accent.text}>
              {isCancelled ? 'Storniert' : 'Abgeschlossen'}
            </BetaEyebrow>
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
              <span title={entry.fileName}>{entry.fileName}</span>
              <BetaMetaDot />
              <span title={fmtTimestamp(entry.finishedAt)}>{fmtRelative(entry.finishedAt)}</span>
              {entry.assignedToUserName && (
                <>
                  <BetaMetaDot />
                  <span style={{ color: T.text.primary, fontWeight: 600 }}>
                    {entry.assignedToUserName}
                  </span>
                </>
              )}
            </div>
            <div style={{
              marginTop: 10,
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              flexWrap: 'wrap',
              fontFamily: T.font.mono,
              fontSize: 13,
              color: T.text.subtle,
              fontVariantNumeric: 'tabular-nums',
            }}>
              <span><span style={{ color: T.text.primary, fontWeight: 700, fontSize: 16 }}>{entry.palletCount}</span> Paletten</span>
              <BetaMetaDot />
              <span><span style={{ color: T.text.primary, fontWeight: 700, fontSize: 16 }}>{entry.articleCount}</span> Artikel</span>
              <BetaMetaDot />
              <span style={{ color: T.accent.text, fontWeight: 700, fontSize: 16 }}>
                {fmtDurationShort(entry.durationSec)}
              </span>
              {ehPerMin != null && Number.isFinite(ehPerMin) && (
                <>
                  <BetaMetaDot />
                  <span>≈{ehPerMin.toFixed(1)} EH/min</span>
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
              background: BH_PAPER_BG,
              color: T.text.subtle,
              flexShrink: 0,
              transition: 'background 160ms ease, color 160ms ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = T.text.primary;
              e.currentTarget.style.color = '#FFFFFF';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = BH_PAPER_BG;
              e.currentTarget.style.color = T.text.subtle;
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* body — scrollable */}
        <div style={{
          background: '#FFFFFF',
          borderRadius: BH_INNER_RADIUS,
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '18px 22px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 22,
        }}>
          {/* Cancellation */}
          {cancellation && (
            <BetaCancellationBlock cancellation={cancellation} />
          )}

          {/* Gantt */}
          <section>
            <BetaEyebrow>
              Palettenzeiten · {palletGantt.length} von {entry.palletCount} mit Daten · {fmtDurationShort(ganttTotal)} kumuliert
            </BetaEyebrow>
            <div style={{ marginTop: 12 }}>
              {palletGantt.length === 0 ? (
                <div style={{
                  padding: '14px 16px',
                  fontSize: 12.5,
                  color: T.text.faint,
                  background: BH_PAPER_BG,
                  borderRadius: 14,
                }}>
                  Keine Palettenzeiten erfasst.
                </div>
              ) : (
                <BetaGantt rows={palletGantt} totalSec={ganttTotal} />
              )}
            </div>
          </section>

          {/* Articles */}
          <section>
            <BetaEyebrow>
              Artikel · {detailQ.isLoading ? 'lädt…' : `${articles.length}`}
            </BetaEyebrow>
            <div style={{ marginTop: 12 }}>
              {detailQ.isLoading ? (
                <div style={{
                  padding: '20px 8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  color: T.text.subtle,
                  fontSize: 13,
                }}>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"
                       style={{ animation: 'mb-h-spin 800ms linear infinite' }}>
                    <circle cx="7" cy="7" r="5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.6" />
                    <path d="M12 7a5 5 0 0 0-5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                  Artikel werden geladen…
                </div>
              ) : detailQ.isError ? (
                <div style={{
                  padding: '14px 16px',
                  fontSize: 12.5,
                  color: T.status.danger.text,
                  background: T.status.danger.bg,
                  borderRadius: 14,
                }}>
                  Konnte Artikel nicht laden: {(detailQ.error as Error)?.message || 'Fehler'}
                </div>
              ) : articles.length === 0 ? (
                <div style={{
                  padding: '14px 16px',
                  fontSize: 12.5,
                  color: T.text.faint,
                  background: BH_PAPER_BG,
                  borderRadius: 14,
                }}>
                  Keine Artikel-Daten gespeichert.
                </div>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {articles.slice(0, 300).map((a, j) => (
                    <BetaArticleRow
                      key={j}
                      pos={j + 1}
                      article={a}
                      cancelReason={cancelByKey.get(`${a.palletId}|${a.itemIdx}`) ?? null}
                      isCancelled={cancelByKey.has(`${a.palletId}|${a.itemIdx}`)}
                    />
                  ))}
                  {articles.length > 300 && (
                    <li style={{ padding: '8px 12px', fontSize: 11.5, color: T.text.faint }}>
                      … {articles.length - 300} weitere ausgeblendet
                    </li>
                  )}
                </ul>
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function BetaGantt({ rows, totalSec }: { rows: Array<{ id: string; level: number; durSec: number }>; totalSec: number }) {
  const max = Math.max(...rows.map((r) => r.durSec), 1);
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      padding: '4px 0',
    }}>
      {rows.map((r) => {
        const meta = LEVEL_META[r.level] || LEVEL_META[1];
        const widthPct = (r.durSec / max) * 100;
        const sharePct = totalSec > 0 ? (r.durSec / totalSec) * 100 : 0;
        return (
          <div key={r.id} style={{
            display: 'grid',
            gridTemplateColumns: '78px 1fr 70px',
            alignItems: 'center',
            gap: 12,
          }}>
            <span style={{
              fontFamily: T.font.mono,
              fontSize: 11.5,
              fontWeight: 600,
              color: T.text.primary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }} title={r.id}>
              {r.id}
            </span>
            <div
              title={`${meta.shortName || meta.name} · ${fmtMmSs(r.durSec)} · ${sharePct.toFixed(0)}% Anteil`}
              style={{
                position: 'relative',
                height: 16,
                background: BH_PAPER_BG,
                borderRadius: 4,
                overflow: 'hidden',
              }}
            >
              <div style={{
                width: `${widthPct}%`,
                height: '100%',
                background: meta.color,
                borderRadius: 4,
                transition: 'width 320ms cubic-bezier(0.16, 1, 0.3, 1)',
              }} />
            </div>
            <span style={{
              fontFamily: T.font.mono,
              fontSize: 12,
              fontWeight: 500,
              color: T.text.primary,
              fontVariantNumeric: 'tabular-nums',
              textAlign: 'right',
            }}>
              {fmtMmSs(r.durSec)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function BetaArticleRow({ pos, article, isCancelled, cancelReason }: {
  pos: number;
  article: { palletId: string; sku?: string; fnsku?: string; title?: string; units?: number; useItem?: string; level: number };
  isCancelled: boolean;
  cancelReason: string | null;
}) {
  const meta = LEVEL_META[article.level] || LEVEL_META[1];
  return (
    <li style={{
      padding: '8px 10px',
      borderRadius: 10,
      background: isCancelled ? T.status.danger.bg : 'transparent',
    }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '24px 14px 78px minmax(0, 1.8fr) minmax(0, 1.1fr) 60px',
        alignItems: 'center',
        gap: 10,
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
          title={`L${article.level} ${meta.name}`}
          style={{
            width: 12, height: 12,
            borderRadius: 4,
            background: meta.color,
            opacity: 0.9,
          }}
        />
        <span style={{
          fontFamily: T.font.mono,
          fontSize: 11.5,
          color: isCancelled ? T.status.danger.text : T.text.faint,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {article.palletId}
        </span>
        <span
          title={article.title || ''}
          style={{
            color: isCancelled ? T.status.danger.text : T.text.primary,
            fontWeight: isCancelled ? 600 : 400,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            letterSpacing: '-0.005em',
          }}
        >
          {article.title || '—'}
        </span>
        <span style={{
          fontFamily: T.font.mono,
          fontSize: 11.5,
          color: isCancelled ? T.status.danger.text : T.text.subtle,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {article.fnsku || article.sku || '—'}
        </span>
        <span style={{
          fontFamily: T.font.mono,
          fontSize: 12,
          fontWeight: 600,
          color: isCancelled ? T.status.danger.text : T.text.primary,
          fontVariantNumeric: 'tabular-nums',
          textAlign: 'right',
        }}>
          × {article.units || 0}
        </span>
      </div>
      {isCancelled && (
        <div style={{
          marginTop: 4,
          paddingLeft: 48,
          fontSize: 11,
          fontFamily: T.font.mono,
          color: T.status.danger.text,
          letterSpacing: '0.02em',
        }}>
          <span style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.10em' }}>Storniert</span>
          {cancelReason ? <span> · {cancelReason}</span> : null}
        </div>
      )}
    </li>
  );
}

function BetaCancellationBlock({ cancellation }: {
  cancellation: {
    items: Array<{ palletId: string | null; itemIdx: number | null; code: string | null; title: string | null; reason: string | null }>;
    note: string | null;
    at: string;
    by: { id: string; name: string } | null;
  };
}) {
  const at = cancellation.at ? new Date(cancellation.at) : null;
  const atFmt = at && !isNaN(at.getTime())
    ? at.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;
  const items = cancellation.items || [];
  return (
    <section style={{
      padding: '14px 16px',
      background: T.status.danger.bg,
      borderRadius: 14,
      border: `1px solid ${T.status.danger.border}`,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginBottom: 8,
        flexWrap: 'wrap',
      }}>
        <BetaStatusPill tone="danger">Storniert</BetaStatusPill>
        {cancellation.by?.name && (
          <span style={{ fontSize: 12, color: T.text.subtle }}>
            durch <strong style={{ color: T.text.primary }}>{cancellation.by.name}</strong>
          </span>
        )}
        {atFmt && (
          <span style={{ fontSize: 12, color: T.text.faint, fontVariantNumeric: 'tabular-nums' }}>
            · {atFmt}
          </span>
        )}
      </div>
      {cancellation.note && (
        <div style={{
          fontSize: 13,
          color: T.text.primary,
          marginBottom: items.length ? 10 : 0,
          whiteSpace: 'pre-wrap',
          lineHeight: 1.4,
        }}>
          {cancellation.note}
        </div>
      )}
      {items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map((it, i) => (
            <div
              key={i}
              style={{
                display: 'grid',
                gridTemplateColumns: '78px 1fr',
                gap: 10,
                fontSize: 12.5,
                lineHeight: 1.4,
              }}
            >
              <span style={{
                fontFamily: T.font.mono,
                fontSize: 11.5,
                color: T.status.danger.text,
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {it.palletId || 'ESKU'}
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ color: T.text.primary, fontWeight: 500, marginRight: 6 }}>
                  {it.title || it.code || '—'}
                </span>
                {it.code && it.code !== it.title && (
                  <span style={{ fontFamily: T.font.mono, fontSize: 11.5, color: T.text.subtle, marginRight: 6 }}>
                    · {it.code}
                  </span>
                )}
                {it.reason && (
                  <span style={{ color: T.status.danger.text, fontStyle: 'italic' }}>
                    — {it.reason}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Empty + keyboard hints
   ════════════════════════════════════════════════════════════════════════ */

function BetaHistorieEmpty() {
  return (
    <BetaPaperCard glow>
      <BetaWhitePanel padding="56px 36px">
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 18,
          textAlign: 'center',
        }}>
          <span style={{
            width: 64, height: 64,
            borderRadius: 999,
            background: BH_PAPER_BG,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: T.text.subtle,
          }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
              <path d="M3 12a9 9 0 1 0 2.4-6.15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <path d="M3 4v4.5h4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <div>
            <div style={{
              fontFamily: T.font.ui,
              fontSize: 22,
              fontWeight: 600,
              color: T.text.primary,
              letterSpacing: '-0.018em',
              marginBottom: 6,
            }}>
              Noch keine abgeschlossenen Aufträge
            </div>
            <div style={{
              fontSize: 13.5,
              color: T.text.subtle,
              lineHeight: 1.5,
              maxWidth: 380,
              margin: '0 auto',
            }}>
              Sobald du den ersten Lagerauftrag durchgearbeitet hast,
              erscheint er hier mit Palettenzeiten, Artikeln und Rekorden.
            </div>
          </div>
        </div>
      </BetaWhitePanel>
    </BetaPaperCard>
  );
}

function BetaHistorieKbdHints() {
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
      <BetaKbdHint kbd={<BetaKbd>⏎</BetaKbd>}>Details</BetaKbdHint>
      <BetaKbdHint kbd={<BetaKbd>/</BetaKbd>}>Suchen</BetaKbdHint>
      <BetaKbdHint kbd={<BetaKbd>e</BetaKbd>}>xlsx Export</BetaKbdHint>
      <BetaKbdHint kbd={<BetaKbd>x</BetaKbd>}>Löschen</BetaKbdHint>
    </div>
  );
}

function BetaKbdHint({ kbd, children }: any) {
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