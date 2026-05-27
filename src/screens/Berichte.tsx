/* Berichte v2 — «Report Studio».

   Magazine-spread design (matches Upload / Pruefen / Focus / Live /
   Historie / Suche / Einstellungen / Warteschlange):
     • Eyebrow + clamp(36–52) H1 + Lead — wide breathing room
     • StudioFrame (bare) brackets the form with corner-marks +
       mono eyebrow «Report Studio · Zeitraum & Format»
     • Hero KPI strip — 5 magazine numbers with comparison badges vs
       the equally-long previous period (% delta, success/warn tone)
     • Daily Throughput sparkline — one bar per day in the picked
       range, today highlighted
     • Operator breakdown — horizontal mini-bars, click filters the
       preview locally (xlsx-export keeps the full range — backend
       has no operator filter yet)
     • Multi-format export — xlsx (backend), CSV / JSON generated in
       the browser from the same data
     • Date-presets row — 9 chips (Heute · Gestern · Diese Woche · …
       · Quartal · Jahr · Alles)
     • Recent exports — last 8 in localStorage, click re-applies all
       parameters (range + format)
     • Live row preview — first 5 rows with the actual values that
       will land in the file
     • Keyboard cockpit — D download · 1-9 presets · / focus from-input

   Backend unchanged — only /api/exports/auftraege.xlsx is server-side,
   CSV + JSON are client-side from /api/history (limit 200).
*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { downloadAuftraegeXlsx, getHistory } from '@/marathonApi.js';
import {
  Page, Topbar, Eyebrow, Lead, StudioFrame, T,
} from '@/components/ui.jsx';
import BerichteAnalytics from './BerichteAnalytics.jsx';
import BetaBerichte from './BetaBerichte';
import { useBetaDesign } from '@/hooks/useBetaDesign';

const RECENT_KEY = 'marathon.berichte.recent';
const RECENT_MAX = 8;
const HISTORY_LIMIT = 200;

const FORMATS = [
  { id: 'xlsx', label: 'xlsx',  icon: '📊', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { id: 'csv',  label: 'CSV',   icon: '📄', mime: 'text/csv' },
  { id: 'json', label: 'JSON',  icon: '🧬', mime: 'application/json' },
];

/* ════════════════════════════════════════════════════════════════════════ */
export default function BerichteScreen() {
  // v2.4 redesign lives behind the global beta-design toggle so the
  // classic Report Studio remains byte-identical for users who haven't
  // opted in. The two screens share /api/reports/aggregates but render
  // entirely different layouts; no cross-pollination of state.
  const { beta } = useBetaDesign();
  if (beta) return <BetaBerichte />;
  return <ClassicBerichteScreen />;
}

function ClassicBerichteScreen() {
  const today = new Date();
  const todayIso = isoDate(today);

  /* Default: this month so the user lands on a useful preview. */
  const [from, setFrom] = useState(isoDate(startOfMonth(today)));
  const [to,   setTo]   = useState(todayIso);
  const [format, setFormat] = useState('xlsx');
  const [operatorFilter, setOperatorFilter] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [recentOpen,  setRecentOpen]  = useState(false);
  const [status, setStatus] = useState<{ kind: 'pending' | 'success' | 'error'; message: string } | null>(null);
  const [recent, setRecent] = useState(() => readRecent());

  const fromInputRef = useRef<HTMLInputElement | null>(null);

  /* ── data ─────────────────────────────────────────────────── */
  const historyQ = useQuery({
    queryKey: ['history', HISTORY_LIMIT, 0],
    queryFn:  () => getHistory(HISTORY_LIMIT, 0),
    staleTime: 60_000,
  });
  const allItems = historyQ.data?.items || [];

  /* Convert ISO strings → ms once so all subsequent filters stay numeric. */
  const normalized = useMemo(
    () => allItems.map((h) => ({
      ...h,
      _finishedMs: h.finishedAt ? Date.parse(h.finishedAt) : null,
    })),
    [allItems],
  );

  /* Current-period range (ms) */
  const fromMs = useMemo(
    () => from ? new Date(from + 'T00:00:00').getTime() : -Infinity,
    [from],
  );
  const toMs = useMemo(
    () => to ? new Date(to + 'T23:59:59.999').getTime() : Infinity,
    [to],
  );

  /* Previous-period range — same length, ending right before `from`. */
  const prevRange = useMemo(() => {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
    const span = toMs - fromMs;
    return { fromMs: fromMs - span, toMs: fromMs - 1 };
  }, [fromMs, toMs]);

  /* Filter items by current range. Operator filter is LOCAL — backend
     export ignores it (no API param), but visualisation/preview
     respect it so the user sees what their click means. */
  const items = useMemo(
    () => normalized.filter((h) => {
      if (h._finishedMs == null) return false;
      if (h._finishedMs < fromMs || h._finishedMs > toMs) return false;
      if (operatorFilter && h.assignedToUserName !== operatorFilter) return false;
      return true;
    }),
    [normalized, fromMs, toMs, operatorFilter],
  );

  /* Items for the previous period — for comparison badges. */
  const prevItems = useMemo(() => {
    if (!prevRange) return [];
    return normalized.filter((h) => {
      if (h._finishedMs == null) return false;
      if (h._finishedMs < prevRange.fromMs || h._finishedMs > prevRange.toMs) return false;
      if (operatorFilter && h.assignedToUserName !== operatorFilter) return false;
      return true;
    });
  }, [normalized, prevRange, operatorFilter]);

  const summary     = useMemo(() => summarize(items),     [items]);
  const summaryPrev = useMemo(() => summarize(prevItems), [prevItems]);

  /* ── presets ──────────────────────────────────────────────── */
  const presets = useMemo(() => buildPresets(today), [today]);
  const activePreset = matchPreset(from, to, presets);

  const applyPreset = (p) => {
    setFrom(p.from);
    setTo(p.to);
  };

  /* ── per-day throughput buckets ───────────────────────────── */
  const dailyBuckets = useMemo(
    () => buildDaily(items, fromMs, toMs),
    [items, fromMs, toMs],
  );
  /* Same bucketing for previous period — enables a future overlay,
     and feeds nothing today; kept here as a hook for symmetry. */

  /* ── operator breakdown ───────────────────────────────────── */
  const operatorBreakdown = useMemo(
    () => buildOperatorBreakdown(normalized, fromMs, toMs),
    [normalized, fromMs, toMs],
  );

  /* ── export action ────────────────────────────────────────── */
  const onDownload = useCallback(async () => {
    setStatus({ kind: 'pending', message: `${format.toUpperCase()} wird erstellt…` });
    try {
      let rowCount = 0;
      if (format === 'xlsx') {
        const res = await downloadAuftraegeXlsx({
          from: from || undefined,
          to:   to   || undefined,
        });
        rowCount = res.rowCount || 0;
      } else if (format === 'csv') {
        rowCount = downloadCsv(items, { from, to });
      } else if (format === 'json') {
        rowCount = downloadJson(items, { from, to });
      }
      setStatus({
        kind: 'success',
        message: rowCount === 0
          ? 'Datei ist leer — keine Aufträge im Bereich.'
          : `${rowCount} ${rowCount === 1 ? 'Zeile' : 'Zeilen'} exportiert.`,
      });
      setRecent((prev) => {
        const entry = {
          id: cryptoId(), ts: Date.now(),
          from, to, format, rowCount,
          presetLabel: activePreset?.label || null,
        };
        const next = [entry, ...prev].slice(0, RECENT_MAX);
        writeRecent(next);
        return next;
      });
    } catch (e) {
      setStatus({ kind: 'error', message: (e instanceof Error ? e.message : null) || 'Download fehlgeschlagen' });
    }
  }, [format, from, to, items, activePreset]);

  /* ── keyboard cockpit ─────────────────────────────────────── */
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable;
      if (e.key === '/' && !inField) {
        e.preventDefault();
        fromInputRef.current?.focus();
        return;
      }
      if (inField) return;
      if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        if (status?.kind !== 'pending') onDownload();
        return;
      }
      const num = parseInt(e.key, 10);
      if (!Number.isNaN(num) && num >= 1 && num <= presets.length) {
        e.preventDefault();
        applyPreset(presets[num - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
   
  }, [onDownload, presets, status]);

  const onApplyRecent = (entry) => {
    setFrom(entry.from);
    setTo(entry.to);
    setFormat(entry.format);
    setRecentOpen(false);
  };
  const onClearRecent = () => {
    setRecent([]);
    writeRecent([]);
  };

  return (
    <Page>
      <Topbar
        crumbs={[{ label: 'Berichte' }]}
        right={
          <span style={{
            fontSize: 12.5,
            color: T.text.subtle,
            fontFamily: T.font.mono,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '0.02em',
          }}>
            {historyQ.isLoading ? 'lädt…' : `${normalized.length} im Speicher`}
          </span>
        }
      />

      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '72px 40px 96px' }}>
        {/* HEADER */}
        <header style={{ marginBottom: 32 }}>
          <Eyebrow>Export · openpyxl XLSX · CSV · JSON</Eyebrow>
          <h1 style={{
            fontFamily: T.font.ui,
            fontSize: 'clamp(36px, 2.8vw, 52px)',
            fontWeight: 600,
            letterSpacing: '-0.025em',
            lineHeight: 1.1,
            color: T.text.primary,
            margin: 0,
          }}>
            Berichte
          </h1>
          <Lead style={{ marginTop: 16, maxWidth: 720, fontSize: 16 }}>
            Lade abgeschlossene Aufträge im gewählten Zeitraum herunter —
            mit Live-Vorschau aus der Historie, Vergleich zum Vorzeitraum,
            Tagesverlauf und Operator-Verteilung. Drei Formate, eine
            Aktion.
          </Lead>
        </header>

        {/* ANALYTIK — global overview, independent from the export date
            range below. User sees "how are we doing" first, then drills
            into a specific date window for the export. */}
        <BerichteAnalytics />

        {/* HERO KPI STRIP — scoped to the export date range */}
        <KpiStrip current={summary} previous={summaryPrev} />

        {/* STUDIO FRAME — main form */}
        <StudioFrame
          bare
          gap={16}
          label="Report Studio · Zeitraum & Format"
          status={activePreset ? activePreset.label.toUpperCase() : 'Custom'}
          style={{ marginTop: 16 }}
        >
          {/* Date presets */}
          <PresetRow
            presets={presets}
            active={activePreset?.id || null}
            onPick={applyPreset}
          />

          {/* Date range + format + download */}
          <ControlRow
            from={from} setFrom={setFrom}
            to={to} setTo={setTo}
            todayIso={todayIso}
            format={format} setFormat={setFormat}
            onDownload={onDownload}
            status={status}
            fromInputRef={fromInputRef}
          />

          {/* Throughput sparkline + operator breakdown */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)',
            gap: 14,
          }}>
            <ThroughputCard buckets={dailyBuckets} />
            <OperatorCard
              items={operatorBreakdown}
              active={operatorFilter}
              onPick={setOperatorFilter}
            />
          </div>

          {/* Live row preview */}
          <PreviewCard
            items={items}
            open={previewOpen}
            onToggle={() => setPreviewOpen((o) => !o)}
          />

          {/* Recent exports */}
          {recent.length > 0 && (
            <RecentCard
              items={recent}
              open={recentOpen}
              onToggle={() => setRecentOpen((o) => !o)}
              onApply={onApplyRecent}
              onClear={onClearRecent}
            />
          )}
        </StudioFrame>

        <KbdHints />
      </main>
    </Page>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Hero KPI strip — 5 numbers with comparison badge vs prev period
   ════════════════════════════════════════════════════════════════════════ */
function KpiStrip({ current, previous }) {
  const avgSec = current.orders > 0 ? Math.round(current.seconds / current.orders) : 0;
  const avgSecPrev = previous.orders > 0 ? Math.round(previous.seconds / previous.orders) : 0;

  return (
    <div style={{
      padding: '24px 28px',
      background: T.bg.surface,
      border: `1px solid ${T.border.primary}`,
      borderRadius: T.radius.lg,
      display: 'grid',
      gridTemplateColumns: 'repeat(5, 1fr)',
      gap: 8,
    }}>
      <Kpi label="Aufträge"  value={current.orders}                           prev={previous.orders} />
      <Kpi label="Paletten"  value={current.pallets}                          prev={previous.pallets} />
      <Kpi label="Artikel"   value={current.articles.toLocaleString('de-DE')} prev={previous.articles} rawValue={current.articles} />
      <Kpi label="Dauer Σ"   value={fmtHm(current.seconds)}                   prev={previous.seconds} rawValue={current.seconds} compareAs="duration" />
      <Kpi label="Ø Auftrag" value={avgSec ? fmtHm(avgSec) : '—'}             prev={avgSecPrev} rawValue={avgSec} compareAs="duration" accent />
    </div>
  );
}

function Kpi({ label, value, prev, rawValue, compareAs, accent }: { label?: React.ReactNode; value?: React.ReactNode; prev?: number | null; rawValue?: number; compareAs?: 'pct' | 'abs' | 'duration'; accent?: boolean }) {
  const cur = typeof rawValue === 'number' ? rawValue : (typeof value === 'number' ? value : 0);
  const showComparison = prev != null && (cur > 0 || prev > 0);
  const delta = (prev != null && prev > 0) ? Math.round(((cur - prev) / prev) * 100) : null;
  /* For duration metrics, less = better — flip the success/warn tone. */
  const positive = compareAs === 'duration' ? (delta != null && delta < 0) : (delta != null && delta > 0);

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
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 8,
        flexWrap: 'wrap',
      }}>
        {value}
        {showComparison && delta != null && Math.abs(delta) >= 1 && (
          <span style={{
            fontSize: 10.5,
            fontFamily: T.font.mono,
            fontWeight: 700,
            padding: '2px 6px',
            borderRadius: T.radius.full,
            background: positive ? T.status.success.bg : T.status.warn.bg,
            color:      positive ? T.status.success.text : T.status.warn.text,
            border: `1px solid ${positive ? T.status.success.border : T.status.warn.border}`,
            letterSpacing: '0.02em',
          }} title={`Vorzeitraum: ${prev}`}>
            {delta > 0 ? '+' : ''}{delta}%
          </span>
        )}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Preset chips
   ════════════════════════════════════════════════════════════════════════ */
function PresetRow({ presets, active, onPick }) {
  return (
    <div style={{
      padding: '14px 18px',
      background: T.bg.surface,
      border: `1px solid ${T.border.primary}`,
      borderRadius: T.radius.md,
      display: 'flex',
      flexWrap: 'wrap',
      gap: 6,
      alignItems: 'center',
    }}>
      <span style={{
        fontSize: 10.5,
        fontFamily: T.font.mono,
        fontWeight: 600,
        color: T.text.subtle,
        textTransform: 'uppercase',
        letterSpacing: '0.10em',
        marginRight: 4,
      }}>
        Zeitraum
      </span>
      {presets.map((p, i) => (
        <Chip
          key={p.id}
          active={active === p.id}
          onClick={() => onPick(p)}
          shortcut={String(i + 1)}
        >
          {p.label}
        </Chip>
      ))}
    </div>
  );
}

function Chip({ active, onClick, children, shortcut }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 28,
        padding: '0 12px',
        fontSize: 12.5,
        fontWeight: 500,
        fontFamily: T.font.ui,
        color: active ? T.accent.text : T.text.secondary,
        background: active ? T.accent.bg : (hover ? T.bg.surface3 : T.bg.surface),
        border: `1px solid ${active ? T.accent.border : T.border.primary}`,
        borderRadius: T.radius.full,
        cursor: 'pointer',
        transition: 'all 150ms',
      }}
    >
      {children}
      {shortcut && (
        <span style={{
          fontSize: 9.5,
          fontFamily: T.font.mono,
          color: active ? T.accent.text : T.text.faint,
          opacity: 0.7,
          letterSpacing: '0.05em',
        }}>
          {shortcut}
        </span>
      )}
    </button>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Date range + format + download row
   ════════════════════════════════════════════════════════════════════════ */
function ControlRow({
  from, setFrom, to, setTo, todayIso,
  format, setFormat,
  onDownload, status,
  fromInputRef,
}) {
  return (
    <div style={{
      padding: '18px 22px',
      background: T.bg.surface,
      border: `1px solid ${T.border.primary}`,
      borderRadius: T.radius.md,
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto',
      gap: 16,
      alignItems: 'flex-end',
    }}>
      {/* From */}
      <div>
        <Label>Von</Label>
        <input
          ref={fromInputRef}
          type="date"
          value={from}
          max={todayIso}
          onChange={(e) => setFrom(e.target.value)}
          style={dateInputStyle}
        />
      </div>

      {/* To */}
      <div>
        <Label>Bis</Label>
        <input
          type="date"
          value={to}
          max={todayIso}
          onChange={(e) => setTo(e.target.value)}
          style={dateInputStyle}
        />
      </div>

      {/* Format pills + Download */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 8 }}>
          <Label>Format</Label>
          <div style={{ display: 'inline-flex', gap: 4 }}>
            {FORMATS.map((f) => (
              <FormatPill
                key={f.id}
                active={format === f.id}
                onClick={() => setFormat(f.id)}
                emoji={f.icon}
                label={f.label}
              />
            ))}
          </div>
        </div>

        <button
          onClick={onDownload}
          disabled={status?.kind === 'pending'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            height: 38,
            padding: '0 18px',
            background: T.accent.main,
            color: '#fff',
            border: 0,
            borderRadius: T.radius.md,
            fontSize: 13,
            fontWeight: 500,
            cursor: status?.kind === 'pending' ? 'wait' : 'pointer',
            opacity: status?.kind === 'pending' ? 0.7 : 1,
            fontFamily: T.font.ui,
            transition: 'background 160ms',
            marginTop: 18,
          }}
          onMouseEnter={(e) => { if (status?.kind !== 'pending') e.currentTarget.style.background = T.accent.hover; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = T.accent.main; }}
        >
          {status?.kind === 'pending' ? 'Wird erstellt…' : 'Herunterladen'}
          <svg width="14" height="14" viewBox="0 0 18 18" fill="none">
            <path d="M9 2v9m0 0l-3-3m3 3l3-3M3 14h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <Kbd onPrimary>D</Kbd>
        </button>
      </div>

      {/* Status row spanning full width */}
      {status && (
        <div style={{
          gridColumn: '1 / -1',
          marginTop: 4,
          fontSize: 12.5,
          fontWeight: 500,
          color: status.kind === 'error' ? T.status.danger.text
            : status.kind === 'success' ? T.status.success.text
            : T.text.subtle,
          fontFamily: T.font.mono,
        }}>
          {status.message}
        </div>
      )}
    </div>
  );
}

function FormatPill({ active, onClick, emoji, label }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 38,
        padding: '0 14px',
        fontSize: 12.5,
        fontWeight: active ? 600 : 500,
        color: active ? T.accent.text : T.text.secondary,
        background: active ? T.accent.bg : (hover ? T.bg.surface3 : T.bg.surface),
        border: `1px solid ${active ? T.accent.border : T.border.primary}`,
        borderRadius: T.radius.md,
        cursor: 'pointer',
        fontFamily: T.font.ui,
        transition: 'all 150ms',
      }}
    >
      <span style={{ fontSize: 13 }}>{emoji}</span>
      {label}
    </button>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Throughput sparkline
   ════════════════════════════════════════════════════════════════════════ */
function ThroughputCard({ buckets }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const total = buckets.reduce((s, b) => s + b.count, 0);
  const avg = buckets.length ? Math.round(total / buckets.length) : 0;

  return (
    <div style={{
      padding: '18px 22px',
      background: T.bg.surface,
      border: `1px solid ${T.border.primary}`,
      borderRadius: T.radius.md,
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
            Tagesverlauf
          </div>
          <div style={{ fontSize: 12, color: T.text.faint, marginTop: 2 }}>
            Aufträge pro Tag · Σ {total} · ø {avg}/Tag
          </div>
        </div>
        <span style={{
          fontSize: 11,
          fontFamily: T.font.mono,
          color: T.text.faint,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {buckets.length} Tag{buckets.length === 1 ? '' : 'e'}
        </span>
      </div>

      {buckets.length === 0 ? (
        <div style={{
          padding: '24px 0',
          fontSize: 12.5,
          color: T.text.faint,
          textAlign: 'center',
        }}>
          Kein Zeitraum gewählt — wähle ein Preset oder Datum.
        </div>
      ) : (
        <>
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${Math.min(buckets.length, 31)}, 1fr)`,
            gap: 4,
            height: 76,
            alignItems: 'end',
          }}>
            {buckets.slice(-31).map((b) => (
              <ThroughputBar key={b.ms} bucket={b} max={max} />
            ))}
          </div>
          {buckets.length > 31 && (
            <div style={{
              fontSize: 10.5,
              fontFamily: T.font.mono,
              color: T.text.faint,
              textAlign: 'right',
            }}>
              Letzte 31 Tage des Bereichs
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ThroughputBar({ bucket, max }) {
  const [hover, setHover] = useState(false);
  const h = bucket.count ? Math.max(4, Math.round((bucket.count / max) * 70)) : 3;
  const today = (() => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();
  const isToday = bucket.ms === today;
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
          ? (isToday ? 1 : Math.max(0.4, bucket.count / max))
          : 1,
        transition: 'opacity 160ms',
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
          <div style={{ fontWeight: 600 }}>{bucket.label}</div>
          <div style={{ marginTop: 3, color: T.text.subtle }}>
            {bucket.count} Aufträge · ø {fmtHm(bucket.avgSec)}
          </div>
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Operator breakdown
   ════════════════════════════════════════════════════════════════════════ */
function OperatorCard({ items, active, onPick }) {
  const total = items.reduce((s, x) => s + x.count, 0);
  return (
    <div style={{
      padding: '18px 22px',
      background: T.bg.surface,
      border: `1px solid ${T.border.primary}`,
      borderRadius: T.radius.md,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
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
            Operatoren
          </div>
          <div style={{ fontSize: 12, color: T.text.faint, marginTop: 2 }}>
            {items.length === 0 ? 'Keine Aufträge im Zeitraum' :
             active ? `gefiltert · ${active}` : 'Klick filtert die Vorschau'}
          </div>
        </div>
        {active && (
          <button
            onClick={() => onPick(null)}
            style={{
              fontSize: 11,
              fontFamily: T.font.mono,
              color: T.text.faint,
              background: 'transparent',
              border: 0,
              cursor: 'pointer',
            }}
          >
            zurücksetzen
          </button>
        )}
      </div>
      {items.length === 0 ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((u) => {
            const pct = total > 0 ? u.count / total : 0;
            const isActive = active === u.name;
            return (
              <button
                key={u.name}
                onClick={() => onPick(isActive ? null : u.name)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 5,
                  padding: '6px 10px',
                  background: isActive ? T.accent.bg : 'transparent',
                  border: `1px solid ${isActive ? T.accent.border : 'transparent'}`,
                  borderRadius: T.radius.sm,
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'all 150ms',
                }}
              >
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  fontSize: 12,
                }}>
                  <span style={{
                    color: isActive ? T.accent.text : T.text.primary,
                    fontWeight: 500,
                  }}>
                    {u.name}
                  </span>
                  <span style={{
                    color: T.text.faint,
                    fontFamily: T.font.mono,
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {u.count} · {Math.round(pct * 100)}%
                  </span>
                </div>
                <div style={{
                  height: 4,
                  background: T.bg.surface3,
                  borderRadius: 2,
                  overflow: 'hidden',
                }}>
                  <div style={{
                    width: `${pct * 100}%`,
                    height: '100%',
                    background: isActive ? T.accent.main : 'var(--accent)',
                    transition: 'width 280ms cubic-bezier(0.16, 1, 0.3, 1)',
                  }} />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Preview — first 5 rows
   ════════════════════════════════════════════════════════════════════════ */
function PreviewCard({ items, open, onToggle }) {
  const sample = items.slice(0, 5);
  return (
    <div style={{
      padding: '14px 18px',
      background: T.bg.surface,
      border: `1px solid ${T.border.primary}`,
      borderRadius: T.radius.md,
    }}>
      <button
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          padding: 0,
          background: 'transparent',
          border: 0,
          cursor: 'pointer',
          fontFamily: T.font.ui,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 200ms ease',
        }}>
          <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={{
          fontSize: 11,
          fontFamily: T.font.mono,
          fontWeight: 600,
          color: T.text.subtle,
          textTransform: 'uppercase',
          letterSpacing: '0.10em',
        }}>
          Was kommt in die Datei?
        </span>
        <span style={{ flex: 1 }} />
        <span style={{
          fontSize: 12,
          color: T.text.faint,
          fontFamily: T.font.mono,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {items.length} {items.length === 1 ? 'Zeile' : 'Zeilen'}
        </span>
      </button>

      {open && (
        <div style={{
          marginTop: 12,
          border: `1px solid ${T.border.primary}`,
          borderRadius: T.radius.sm,
          overflow: 'hidden',
          background: T.bg.surface,
        }}>
          <div style={previewHeaderStyle}>
            <span>Datum</span>
            <span>Operator</span>
            <span>Sendungsnr.</span>
            <span style={{ textAlign: 'right' }}>Pal</span>
            <span style={{ textAlign: 'right' }}>Art</span>
            <span style={{ textAlign: 'right' }}>Dauer</span>
          </div>
          {sample.length === 0 && (
            <div style={{
              padding: '20px 14px',
              textAlign: 'center',
              fontSize: 12.5,
              color: T.text.faint,
            }}>
              Keine Aufträge im Zeitraum.
            </div>
          )}
          {sample.map((h, i) => (
            <div key={h.id || i} style={{
              ...previewRowStyle,
              borderBottom: i < sample.length - 1 ? `1px solid ${T.border.subtle}` : 'none',
            }}>
              <span style={{ fontFamily: T.font.mono, color: T.text.subtle }}>
                {fmtTimestamp(h.finishedAt)}
              </span>
              <span style={{ color: T.text.primary }}>
                {h.assignedToUserName || '—'}
              </span>
              <span style={{
                fontFamily: T.font.mono,
                color: T.text.primary,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }} title={h.fileName || ''}>
                {h.fbaCode || h.fileName || '—'}
              </span>
              <span style={{
                fontFamily: T.font.mono,
                color: T.text.primary,
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {h.palletCount}
              </span>
              <span style={{
                fontFamily: T.font.mono,
                color: T.text.primary,
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {h.articleCount}
              </span>
              <span style={{
                fontFamily: T.font.mono,
                color: T.accent.text,
                fontWeight: 500,
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {fmtHm(h.durationSec || 0)}
              </span>
            </div>
          ))}
          {items.length > 5 && (
            <div style={{
              padding: '10px 14px',
              fontSize: 11.5,
              fontFamily: T.font.mono,
              color: T.text.faint,
              borderTop: `1px solid ${T.border.subtle}`,
              background: T.bg.surface2,
            }}>
              + {items.length - 5} weitere {items.length - 5 === 1 ? 'Zeile' : 'Zeilen'} · alle landen in der Datei
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Recent exports — localStorage list, click re-applies parameters
   ════════════════════════════════════════════════════════════════════════ */
function RecentCard({ items, open, onToggle, onApply, onClear }) {
  return (
    <div style={{
      padding: '14px 18px',
      background: T.bg.surface,
      border: `1px solid ${T.border.primary}`,
      borderRadius: T.radius.md,
    }}>
      <button
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          padding: 0,
          background: 'transparent',
          border: 0,
          cursor: 'pointer',
          fontFamily: T.font.ui,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 200ms ease',
        }}>
          <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={{
          fontSize: 11,
          fontFamily: T.font.mono,
          fontWeight: 600,
          color: T.text.subtle,
          textTransform: 'uppercase',
          letterSpacing: '0.10em',
        }}>
          Letzte Exporte
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: T.text.faint, fontFamily: T.font.mono }}>
          {items.length}
        </span>
      </button>

      {open && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {items.map((e) => (
            <button
              key={e.id}
              onClick={() => onApply(e)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '8px 10px',
                background: T.bg.surface,
                border: `1px solid ${T.border.subtle}`,
                borderRadius: T.radius.sm,
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: T.font.ui,
                transition: 'all 150ms',
              }}
              onMouseEnter={(ev) => { ev.currentTarget.style.borderColor = T.accent.border; }}
              onMouseLeave={(ev) => { ev.currentTarget.style.borderColor = T.border.subtle; }}
            >
              <span style={{
                padding: '2px 8px',
                fontSize: 10,
                fontFamily: T.font.mono,
                fontWeight: 700,
                background: T.bg.surface3,
                border: `1px solid ${T.border.primary}`,
                color: T.text.secondary,
                borderRadius: T.radius.full,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                flexShrink: 0,
              }}>
                {e.format}
              </span>
              <span style={{
                fontSize: 12,
                fontFamily: T.font.mono,
                color: T.text.primary,
                flex: 1,
              }}>
                {e.presetLabel || rangeText(e.from, e.to)}
              </span>
              <span style={{
                fontSize: 11.5,
                fontFamily: T.font.mono,
                color: T.text.faint,
                fontVariantNumeric: 'tabular-nums',
              }}>
                {e.rowCount} Zeilen
              </span>
              <span style={{
                fontSize: 11,
                fontFamily: T.font.mono,
                color: T.text.faint,
                fontVariantNumeric: 'tabular-nums',
              }}>
                {fmtRel(e.ts)}
              </span>
            </button>
          ))}
          {items.length > 0 && (
            <button
              onClick={onClear}
              style={{
                marginTop: 4,
                padding: '4px 10px',
                fontSize: 11,
                fontFamily: T.font.mono,
                color: T.text.faint,
                background: 'transparent',
                border: 0,
                cursor: 'pointer',
                alignSelf: 'flex-end',
              }}
            >
              Verlauf leeren
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Keyboard hints
   ════════════════════════════════════════════════════════════════════════ */
function KbdHints() {
  const items = [
    { k: '1 – 9', v: 'Zeitraum-Preset' },
    { k: 'D',     v: 'Herunterladen' },
    { k: '/',     v: 'Datum fokussieren' },
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

function Kbd({ children, onPrimary }: { children?: React.ReactNode; onPrimary?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 22, height: 18,
      padding: '0 6px',
      fontSize: 10.5,
      fontFamily: T.font.mono,
      color: onPrimary ? '#fff' : T.text.secondary,
      background: onPrimary ? 'var(--bg-glass-on-accent)' : T.bg.surface3,
      border: `1px solid ${onPrimary ? 'var(--bg-glass-on-accent-border)' : T.border.primary}`,
      borderRadius: 3,
      lineHeight: 1,
    }}>
      {children}
    </span>
  );
}

function Label({ children }) {
  return (
    <span style={{
      display: 'block',
      fontSize: 10.5,
      fontFamily: T.font.mono,
      fontWeight: 600,
      color: T.text.subtle,
      textTransform: 'uppercase',
      letterSpacing: '0.10em',
      marginBottom: 6,
    }}>
      {children}
    </span>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Helpers — presets / buckets / breakdowns / formatting / persistence
   ════════════════════════════════════════════════════════════════════════ */
function summarize(items) {
  return items.reduce((acc, h) => ({
    orders:   acc.orders + 1,
    pallets:  acc.pallets + (h.palletCount || 0),
    articles: acc.articles + (h.articleCount || 0),
    seconds:  acc.seconds + (h.durationSec || 0),
  }), { orders: 0, pallets: 0, articles: 0, seconds: 0 });
}

function buildPresets(today) {
  const todayIso = isoDate(today);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayIso = isoDate(yesterday);
  const weekStart = startOfWeek(today);
  const lastWeekStart = new Date(weekStart); lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const lastWeekEnd   = new Date(weekStart); lastWeekEnd.setDate(lastWeekEnd.getDate() - 1);
  const monthStart = startOfMonth(today);
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastMonthEnd   = new Date(today.getFullYear(), today.getMonth(), 0);
  const quarterStart   = startOfQuarter(today);
  const yearStart      = new Date(today.getFullYear(), 0, 1);

  return [
    { id: 'today',     label: 'Heute',         from: todayIso,             to: todayIso },
    { id: 'yesterday', label: 'Gestern',       from: yesterdayIso,         to: yesterdayIso },
    { id: 'week',      label: 'Diese Woche',   from: isoDate(weekStart),   to: todayIso },
    { id: 'last-week', label: 'Letzte Woche',  from: isoDate(lastWeekStart), to: isoDate(lastWeekEnd) },
    { id: 'month',     label: 'Diesen Monat',  from: isoDate(monthStart),  to: todayIso },
    { id: 'last-month',label: 'Letzten Monat', from: isoDate(lastMonthStart), to: isoDate(lastMonthEnd) },
    { id: 'quarter',   label: 'Quartal',       from: isoDate(quarterStart), to: todayIso },
    { id: 'year',      label: 'Jahr',          from: isoDate(yearStart),   to: todayIso },
    { id: 'all',       label: 'Alles',         from: '',                   to: '' },
  ];
}

function matchPreset(from, to, presets) {
  return presets.find((p) => p.from === from && p.to === to) || null;
}

function buildDaily(items, fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    /* "Alles" preset: derive bounds from items themselves. */
    if (items.length === 0) return [];
    const min = Math.min(...items.map((h) => h._finishedMs).filter(Boolean));
    const max = Math.max(...items.map((h) => h._finishedMs).filter(Boolean));
    return buildDailyExplicit(items, min, max);
  }
  return buildDailyExplicit(items, fromMs, toMs);
}

interface DailyBucket { ms: number; label: string; count: number; totalSec: number; avgSec: number }

function buildDailyExplicit(items, fromMs, toMs) {
  const start = new Date(fromMs); start.setHours(0, 0, 0, 0);
  const end   = new Date(toMs);   end.setHours(0, 0, 0, 0);
  const buckets: DailyBucket[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const ms = d.getTime();
    buckets.push({
      ms,
      label: d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }),
      count: 0,
      totalSec: 0,
      avgSec: 0,
    });
    if (buckets.length > 365) break; /* safety */
  }
  for (const h of items) {
    if (h._finishedMs == null) continue;
    const day = new Date(h._finishedMs); day.setHours(0, 0, 0, 0);
    const idx = buckets.findIndex((b) => b.ms === day.getTime());
    if (idx >= 0) {
      buckets[idx].count += 1;
      buckets[idx].totalSec += (h.durationSec || 0);
    }
  }
  for (const b of buckets) {
    b.avgSec = b.count ? Math.round(b.totalSec / b.count) : 0;
  }
  return buckets;
}

function buildOperatorBreakdown(items, fromMs, toMs) {
  const m = new Map();
  for (const h of items) {
    if (h._finishedMs == null) continue;
    if (h._finishedMs < fromMs || h._finishedMs > toMs) continue;
    const name = h.assignedToUserName || '—';
    m.set(name, (m.get(name) || 0) + 1);
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
}

function fmtHm(sec) {
  if (!sec || sec < 0) return '0m';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function fmtTimestamp(input) {
  if (!input) return '—';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtRel(ts) {
  if (!ts) return '—';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return 'jetzt';
  const min = Math.floor(sec / 60);
  if (min < 60) return `vor ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `vor ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `vor ${d} T`;
  return new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

function rangeText(from, to) {
  if (!from && !to) return 'Alles';
  return `${from || '…'} → ${to || 'heute'}`;
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function startOfWeek(d) {
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const out = new Date(d);
  out.setDate(out.getDate() - diff);
  out.setHours(0, 0, 0, 0);
  return out;
}
function startOfQuarter(d) {
  const q = Math.floor(d.getMonth() / 3);
  return new Date(d.getFullYear(), q * 3, 1);
}

/* ─── Recent exports persistence ─────────────────────────────── */
function readRecent() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(0, RECENT_MAX) : [];
  } catch { return []; }
}
function writeRecent(arr) {
  try { window.localStorage.setItem(RECENT_KEY, JSON.stringify(arr)); } catch { /* quota */ }
}

function cryptoId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/* ─── Client-side CSV / JSON download ────────────────────────── */
function downloadCsv(items, { from, to }) {
  if (!items.length) return 0;
  const headers = ['Datum', 'Operator', 'Sendungsnummer', 'Datei', 'Paletten', 'Artikel', 'Dauer (Min)'];
  const rows = items.map((h) => [
    h.finishedAt ? new Date(h.finishedAt).toLocaleString('de-DE') : '',
    h.assignedToUserName || '',
    h.fbaCode || '',
    h.fileName || '',
    h.palletCount || 0,
    h.articleCount || 0,
    Math.round((h.durationSec || 0) / 60),
  ]);
  const csv = [headers, ...rows]
    .map((r) => r.map((c) => csvCell(c)).join(','))
    .join('\r\n');
  triggerDownload(`marathon-auftraege-${from || 'all'}-${to || 'now'}.csv`,
    new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  return items.length;
}

function csvCell(v) {
  const s = String(v ?? '');
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadJson(items, { from, to }) {
  if (!items.length) return 0;
  const out = items.map((h) => ({
    finished_at: h.finishedAt,
    operator: h.assignedToUserName,
    sendungsnummer: h.fbaCode,
    file_name: h.fileName,
    pallet_count: h.palletCount,
    article_count: h.articleCount,
    duration_sec: h.durationSec,
  }));
  triggerDownload(`marathon-auftraege-${from || 'all'}-${to || 'now'}.json`,
    new Blob([JSON.stringify({
      exportedAt: new Date().toISOString(),
      range: { from: from || null, to: to || null },
      items: out,
    }, null, 2)], { type: 'application/json' }));
  return items.length;
}

function triggerDownload(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ─── Inline styles reused by date inputs and preview rows ───── */
const dateInputStyle = {
  width: '100%',
  height: 38,
  padding: '0 12px',
  fontSize: 13,
  fontFamily: T.font.ui,
  color: T.text.primary,
  background: T.bg.surface,
  border: `1px solid ${T.border.primary}`,
  borderRadius: T.radius.md,
  outline: 'none',
};

const previewHeaderStyle = {
  display: 'grid',
  gridTemplateColumns: '120px 100px minmax(0, 1.4fr) 50px 50px 70px',
  padding: '8px 14px',
  background: T.bg.surface2,
  borderBottom: `1px solid ${T.border.primary}`,
  fontSize: 10.5,
  fontFamily: T.font.mono,
  fontWeight: 600,
  color: T.text.subtle,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  gap: 12,
};

const previewRowStyle = {
  display: 'grid',
  gridTemplateColumns: '120px 100px minmax(0, 1.4fr) 50px 50px 70px',
  padding: '8px 14px',
  fontSize: 12.5,
  alignItems: 'center',
  gap: 12,
};