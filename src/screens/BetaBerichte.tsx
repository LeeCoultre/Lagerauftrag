/* Berichte v2.4 — Beta redesign (minimalist).
 *
 * Linear/Raycast-inspired: no card chrome, no recharts, no grids of
 * KPI boxes. Hierarchy comes from typography (one hero number,
 * supporting line, hairline rows) and a single accent colour.
 *
 *   ┌ Header (Eyebrow + H1) + Export
 *   ├ Period selector — text links with underline on active
 *   ├ HERO: Warenwert € (giant) + supporting row (Artikel · Einheiten · u/h)
 *   ├ Verteilung nach Ebenen — single column, hairline rows
 *   ├ Aktivität — compact 30-day grid
 *   └ Footer: coverage · updated
 *
 * Gated by useBetaDesign(); classic Berichte stays byte-identical.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { downloadAuftraegeXlsx, getReportsAggregates } from '@/marathonApi.js';
import {
  Page, Topbar, T,
} from '@/components/ui.jsx';
import type { LevelBucket, ReportsAggregates } from '@/types/api';

/* ───── Period presets ──────────────────────────────────────────────── */

interface Preset { id: string; label: string; days: number; }
const PRESETS: ReadonlyArray<Preset> = [
  { id: 'today',   label: 'Heute',   days: 1 },
  { id: 'week',    label: 'Woche',   days: 7 },
  { id: 'month',   label: 'Monat',   days: 30 },
  { id: 'quarter', label: 'Quartal', days: 90 },
];

const LEVEL_LABEL: Record<number, string> = {
  1: 'Thermo',
  2: 'Veit',
  3: 'Heipa',
  4: 'Produktion',
  5: 'Klebeband',
  6: 'Sonstige',
  7: 'Tacho',
};

const numDE = new Intl.NumberFormat('de-DE');
const euroDE0 = new Intl.NumberFormat('de-DE', {
  style: 'currency', currency: 'EUR', maximumFractionDigits: 0,
});
const euroDE2 = new Intl.NumberFormat('de-DE', {
  style: 'currency', currency: 'EUR', maximumFractionDigits: 2,
});

/* ───── Component ──────────────────────────────────────────────────── */

export default function BetaBerichte() {
  const [days, setDays] = useState<number>(30);
  const [exportOpen, setExportOpen] = useState(false);

  const aggQ = useQuery<ReportsAggregates>({
    queryKey: ['reportsAggregates', days],
    queryFn: () => getReportsAggregates({ days }),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const agg = aggQ.data;
  const isLoading = aggQ.isLoading && !agg;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setExportOpen(true);
      }
      if (e.key === 'Escape') setExportOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <Page>
      <Topbar
        crumbs={[
          { label: 'Workspace', muted: true },
          { label: 'Berichte' },
        ]}
        right={
          <button
            type="button"
            onClick={() => setExportOpen(true)}
            title="Export öffnen (⌘E)"
            style={linkBtnStyle}
          >
            Export
          </button>
        }
      />

      <main style={{
        maxWidth: 880,
        margin: '0 auto',
        padding: '56px 32px 96px',
      }}>
        {/* ── Section: Identity + Period selector ─────────────────── */}
        <div style={{ marginBottom: 56 }}>
          <div style={eyebrowStyle}>Analytics</div>
          <h1 style={{
            margin: '6px 0 0',
            fontFamily: T.font.ui,
            fontWeight: 700,
            fontSize: 28,
            letterSpacing: '-0.02em',
            color: T.text.primary,
            lineHeight: 1.1,
          }}>
            Berichte
          </h1>

          <div style={{
            marginTop: 24,
            display: 'flex',
            alignItems: 'baseline',
            gap: 22,
            fontFamily: T.font.ui,
            fontSize: 13.5,
            letterSpacing: '-0.005em',
          }}>
            {PRESETS.map((p) => {
              const active = days === p.days;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setDays(p.days)}
                  style={{
                    all: 'unset',
                    cursor: 'pointer',
                    color: active ? T.text.primary : T.text.subtle,
                    fontWeight: active ? 600 : 500,
                    borderBottom: active
                      ? `1.5px solid var(--accent)`
                      : '1.5px solid transparent',
                    paddingBottom: 3,
                    transition: 'color 160ms, border-color 160ms',
                  }}
                  onMouseEnter={(e) => {
                    if (!active) e.currentTarget.style.color = T.text.primary;
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.color = T.text.subtle;
                  }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Section: Hero number (Warenwert) ────────────────────── */}
        <Hero agg={agg} loading={isLoading} />

        {/* ── Section: Verteilung nach Ebenen ─────────────────────── */}
        <SectionHeader title="Verteilung" />
        <LevelList buckets={agg?.byLevel || []} loading={isLoading} />

        {/* ── Section: Aktivität ──────────────────────────────────── */}
        <SectionHeader title="Aktivität" trailing={`${agg?.heatmap.length ?? days} Tage`} />
        <Heatmap cells={agg?.heatmap || []} />

        {/* ── Footer ──────────────────────────────────────────────── */}
        <div style={{
          marginTop: 56,
          display: 'flex',
          justifyContent: 'space-between',
          fontFamily: T.font.ui,
          fontSize: 11.5,
          color: T.text.subtle,
        }}>
          <span>
            Abdeckung{' '}
            <span style={{ color: T.text.primary, fontVariantNumeric: 'tabular-nums' }}>
              {agg ? `${agg.itemsValueCoveragePct.toFixed(0)} %` : '—'}
            </span>
            {agg && agg.itemsValueCoveragePct < 100 && agg.articlesTotal > 0 && (
              <>
                {' · '}
                {agg.articlesTotal - Math.round(agg.articlesTotal * agg.itemsValueCoveragePct / 100)}
                {' Artikel ohne Preis'}
              </>
            )}
          </span>
          <span>
            {aggQ.dataUpdatedAt ? `aktualisiert · ${formatRelative(aggQ.dataUpdatedAt)}` : ''}
          </span>
        </div>
      </main>

      {exportOpen && <ExportDrawer onClose={() => setExportOpen(false)} />}
    </Page>
  );
}

/* ───── Hero ───────────────────────────────────────────────────────── */

function Hero({ agg, loading }: { agg: ReportsAggregates | undefined; loading: boolean }) {
  const heroValue = agg ? euroDE0.format(agg.itemsValueEur) : '—';
  const sublines: Array<{ value: string; label: string }> = agg
    ? [
        { value: numDE.format(agg.articlesTotal),                            label: 'Artikel' },
        { value: numDE.format(agg.unitsTotal),                               label: 'Einheiten' },
        { value: numDE.format(Math.round(agg.productivityUnitsPerHour)),     label: 'u/h' },
      ]
    : [
        { value: '—', label: 'Artikel' },
        { value: '—', label: 'Einheiten' },
        { value: '—', label: 'u/h' },
      ];

  return (
    <div style={{ marginBottom: 64 }}>
      <div style={eyebrowStyle}>Warenwert</div>
      <div style={{
        marginTop: 10,
        fontFamily: T.font.ui,
        fontSize: 64,
        fontWeight: 600,
        letterSpacing: '-0.04em',
        lineHeight: 1,
        color: loading ? T.text.subtle : T.text.primary,
        fontVariantNumeric: 'tabular-nums',
        transition: 'color 200ms',
      }}>
        {heroValue}
      </div>
      <div style={{
        marginTop: 18,
        display: 'flex',
        alignItems: 'baseline',
        gap: 18,
        fontFamily: T.font.ui,
        fontSize: 13,
      }}>
        {sublines.map((s, i) => (
          <span key={s.label} style={{
            display: 'inline-flex',
            alignItems: 'baseline',
            gap: 18,
          }}>
            {i > 0 && (
              <span aria-hidden style={{ color: T.border.strong, fontFamily: T.font.mono }}>·</span>
            )}
            <span style={{
              color: T.text.primary,
              fontWeight: 500,
              fontVariantNumeric: 'tabular-nums',
            }}>
              {s.value}
            </span>
            <span style={{ marginLeft: -12, color: T.text.subtle }}>
              {s.label}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ───── Section header ─────────────────────────────────────────────── */

function SectionHeader({ title, trailing }: { title: string; trailing?: string }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      marginBottom: 18,
      paddingBottom: 10,
      borderBottom: `1px solid ${T.border.subtle}`,
    }}>
      <div style={eyebrowStyle}>{title}</div>
      {trailing && (
        <span style={{
          fontFamily: T.font.ui,
          fontSize: 11,
          color: T.text.subtle,
        }}>
          {trailing}
        </span>
      )}
    </div>
  );
}

/* ───── Level list ─────────────────────────────────────────────────── */

function maxUnits(buckets: LevelBucket[]): number {
  return buckets.reduce((m, b) => (b.units > m ? b.units : m), 0);
}

function LevelList({ buckets, loading }: { buckets: LevelBucket[]; loading: boolean }) {
  if (loading) {
    return (
      <div style={{
        padding: '32px 0',
        fontFamily: T.font.ui,
        fontSize: 12.5,
        color: T.text.subtle,
        textAlign: 'center',
      }}>
        lade…
      </div>
    );
  }
  const maxU = maxUnits(buckets);
  const anyData = buckets.some((b) => b.units > 0);
  if (!anyData) {
    return (
      <div style={{
        padding: '32px 0',
        fontFamily: T.font.ui,
        fontSize: 12.5,
        color: T.text.subtle,
        textAlign: 'center',
      }}>
        Keine Daten im Zeitraum.
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 64 }}>
      {buckets
        .filter((b) => b.units > 0)
        .map((b, idx) => {
          const pct = maxU > 0 ? (b.units / maxU) * 100 : 0;
          return (
            <div
              key={b.level}
              style={{
                display: 'grid',
                gridTemplateColumns: '140px 1fr 200px',
                gap: 18,
                alignItems: 'center',
                padding: '14px 0',
                borderTop: idx === 0 ? 'none' : `1px solid ${T.border.subtle}`,
              }}
            >
              {/* Label */}
              <div style={{
                fontFamily: T.font.ui,
                fontSize: 14,
                fontWeight: 500,
                color: T.text.primary,
              }}>
                <span style={{
                  color: T.text.subtle,
                  fontFamily: T.font.mono,
                  fontSize: 11,
                  marginRight: 8,
                  letterSpacing: '0.04em',
                }}>
                  L{b.level}
                </span>
                {LEVEL_LABEL[b.level] || `Level ${b.level}`}
              </div>

              {/* Bar */}
              <div style={{
                position: 'relative',
                height: 4,
                background: T.bg.surface2,
                borderRadius: 999,
                overflow: 'hidden',
              }}>
                <div style={{
                  position: 'absolute',
                  inset: '0 auto 0 0',
                  width: `${pct}%`,
                  background: 'var(--accent)',
                  transition: 'width 280ms cubic-bezier(0.16, 1, 0.3, 1)',
                }} />
              </div>

              {/* Numbers */}
              <div style={{
                display: 'flex',
                gap: 16,
                justifyContent: 'flex-end',
                fontFamily: T.font.mono,
                fontSize: 13,
                color: T.text.primary,
                fontVariantNumeric: 'tabular-nums',
              }}>
                <span style={{ color: T.text.primary, fontWeight: 600 }}>
                  {numDE.format(b.units)}
                </span>
                <span style={{ color: T.text.subtle, minWidth: 80, textAlign: 'right' }}>
                  {b.costEur > 0
                    ? euroDE2.format(b.costEur)
                    : <span title="Kein Preis hinterlegt">—</span>}
                </span>
              </div>
            </div>
          );
        })}
    </div>
  );
}

/* ───── Heatmap ─────────────────────────────────────────────────────── */

function Heatmap({ cells }: { cells: { date: string; count: number; units: number }[] }) {
  const max = useMemo(() => cells.reduce((m, c) => (c.count > m ? c.count : m), 0), [cells]);
  if (!cells.length) {
    return (
      <div style={{
        padding: '32px 0',
        fontFamily: T.font.ui,
        fontSize: 12.5,
        color: T.text.subtle,
        textAlign: 'center',
        marginBottom: 64,
      }}>
        Keine Tage im Zeitraum.
      </div>
    );
  }
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(18px, 1fr))',
      gap: 4,
      marginBottom: 64,
    }}>
      {cells.map((c) => {
        const t = max > 0 ? c.count / max : 0;
        const bg = c.count === 0
          ? T.bg.surface2
          : `color-mix(in srgb, var(--accent) ${Math.round(20 + t * 80)}%, transparent)`;
        return (
          <div
            key={c.date}
            title={`${c.date} · ${c.count} Aufträge · ${c.units} Einheiten`}
            style={{
              aspectRatio: '1 / 1',
              minHeight: 14,
              borderRadius: 3,
              background: bg,
            }}
          />
        );
      })}
    </div>
  );
}

/* ───── Export drawer ──────────────────────────────────────────────── */

function ExportDrawer({ onClose }: { onClose: () => void }) {
  const today = new Date();
  const isoToday = today.toISOString().slice(0, 10);
  const isoMonthStart = new Date(today.getFullYear(), today.getMonth(), 1)
    .toISOString().slice(0, 10);
  const [from, setFrom] = useState(isoMonthStart);
  const [to, setTo] = useState(isoToday);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const fromRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { fromRef.current?.focus(); }, []);

  const onExport = async () => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const r = await downloadAuftraegeXlsx({ from, to });
      setStatus(`✓ ${r.rowCount} Zeilen exportiert`);
      window.setTimeout(onClose, 1200);
    } catch (e: any) {
      setStatus(`Fehler: ${e?.message || 'Export fehlgeschlagen'}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.28)',
          zIndex: 50,
        }}
      />
      <aside style={{
        position: 'fixed',
        right: 0, top: 0, bottom: 0,
        width: 360,
        background: T.bg.surface,
        borderLeft: `1px solid ${T.border.subtle}`,
        zIndex: 51,
        padding: '40px 32px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
      }}>
        <div>
          <div style={eyebrowStyle}>Export</div>
          <div style={{
            marginTop: 8,
            fontFamily: T.font.ui,
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            color: T.text.primary,
          }}>
            Aufträge als XLSX
          </div>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={eyebrowStyle}>Von</span>
          <input
            ref={fromRef}
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            style={inputStyle}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={eyebrowStyle}>Bis</span>
          <input
            type="date"
            value={to}
            min={from}
            max={isoToday}
            onChange={(e) => setTo(e.target.value)}
            style={inputStyle}
          />
        </label>

        {status && (
          <div style={{
            padding: '10px 12px',
            borderRadius: 8,
            background: status.startsWith('✓') ? T.status.success.bg : T.status.danger.bg,
            color: status.startsWith('✓') ? T.status.success.text : T.status.danger.text,
            border: `1px solid ${status.startsWith('✓') ? T.status.success.main : T.status.danger.main}`,
            fontFamily: T.font.ui,
            fontSize: 12.5,
          }}>
            {status}
          </div>
        )}

        <div style={{ display: 'flex', gap: 12, marginTop: 'auto' }}>
          <button type="button" onClick={onClose} style={linkBtnStyle}>
            Abbrechen
          </button>
          <button
            type="button"
            onClick={onExport}
            disabled={busy}
            style={{
              ...linkBtnStyle,
              flex: 1,
              background: 'var(--accent)',
              color: '#fff',
              borderColor: 'var(--accent)',
              opacity: busy ? 0.6 : 1,
              cursor: busy ? 'wait' : 'pointer',
              textAlign: 'center',
            }}
          >
            {busy ? 'Lade…' : 'Herunterladen'}
          </button>
        </div>
      </aside>
    </>
  );
}

/* ───── Style tokens ───────────────────────────────────────────────── */

function formatRelative(ts: number): string {
  const ageSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (ageSec < 60) return `${ageSec}s`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)} min`;
  return `${Math.floor(ageSec / 3600)} h`;
}

const eyebrowStyle: React.CSSProperties = {
  fontFamily: T.font.ui,
  fontSize: 11,
  fontWeight: 500,
  color: T.text.subtle,
  textTransform: 'uppercase',
  letterSpacing: 1.2,
};

const linkBtnStyle: React.CSSProperties = {
  padding: '7px 14px',
  fontFamily: T.font.ui,
  fontWeight: 500,
  fontSize: 12.5,
  color: T.text.primary,
  background: 'transparent',
  border: `1px solid ${T.border.subtle}`,
  borderRadius: 6,
  cursor: 'pointer',
  letterSpacing: '-0.005em',
  transition: 'background 140ms, border-color 140ms',
};

const inputStyle: React.CSSProperties = {
  padding: '10px 12px',
  fontFamily: T.font.mono,
  fontSize: 13,
  fontWeight: 500,
  color: T.text.primary,
  background: T.bg.surface,
  border: `1px solid ${T.border.subtle}`,
  borderRadius: 6,
  outline: 'none',
};
