/* LYNNE Table — beta-designed product catalog grouped by ASIN.
 *
 * Each ASIN renders as its own paper-card container (no shared table).
 * Visual language mirrors BetaPruefen / BetaFocus.
 *
 * Beta-only via Sidebar gate; useBetaDesign() not needed here.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  Search,
  Package,
  RefreshCw,
  AlertTriangle,
  X as XIcon,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Boxes,
  SlidersHorizontal,
  Check,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';

import { Area, AreaChart, LabelList, ResponsiveContainer, YAxis } from 'recharts';

import { Page, T } from '@/components/ui';
import BoxIso from '@/components/BoxIso';
import BestellungPanel from '@/components/BestellungPanel';
import { composeBestellung } from '@/utils/bestellungGenerator';
import {
  adminCreateLynneProduct,
  adminCreateSkuDimension,
  adminDeleteLynneProduct,
  adminPatchLynneAsin,
  adminPatchLynneProduct,
  adminRenameLynneAsin,
  adminUpdateSkuDimension,
  getLynneProducts,
  lookupSkuDimensions,
} from '@/marathonApi';
import { useConfirm } from '@/components/ConfirmDialog';
import { useMe } from '@/hooks/useMe';
import Marktanalyse from './Marktanalyse';
import type {
  LynneAsinGroup,
  LynneCatalog,
  LynneChannel,
  LynneVariantPatch,
  SkuDimensionLookup,
} from '@/types/api';
import './lynne-table.css';


/* ─── Beta atoms (mirror of Pruefen) ────────────────────────────── */

function LynneStyles() {
  return (
    <style>{`
      @keyframes lt-rise-local {
        0%   { opacity: 0; transform: translateY(8px); }
        100% { opacity: 1; transform: translateY(0); }
      }
    `}</style>
  );
}

function PaperCard({ children, flat = false, style, className }: { children?: React.ReactNode; flat?: boolean; style?: React.CSSProperties; className?: string }) {
  return (
    <div className={className} style={{
      position: 'relative',
      padding: 8,
      background: '#F4F5F7',
      border: '2px solid #FFFFFF',
      borderRadius: 32,
      boxShadow: flat ? 'none' : '0 0 89.7px 0 rgba(0, 0, 0, 0.05)',
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      ...style,
    }}>
      {children}
    </div>
  );
}

function WhitePanel({ children, padding, style }: { children?: React.ReactNode; padding?: string; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: '#FFFFFF',
      borderRadius: 24,
      padding: padding || '22px 26px',
      ...style,
    }}>
      {children}
    </div>
  );
}

function Eyebrow({ children }: { children?: React.ReactNode }) {
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 10.5,
      fontWeight: 700,
      fontFamily: T.font.mono,
      color: T.text.faint,
      letterSpacing: '0.18em',
      textTransform: 'uppercase',
    }}>
      {children}
    </div>
  );
}

function MetaDot() {
  return (
    <span aria-hidden style={{
      width: 3, height: 3, borderRadius: '50%',
      background: 'rgba(15, 23, 42, 0.22)',
      flexShrink: 0,
    }} />
  );
}

function Metric({ value, label, dim = false }: { value: React.ReactNode; label: string; dim?: boolean }) {
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
        color: dim ? T.text.faint : T.text.primary,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '-0.012em',
      }}>
        {value}
      </span>
      <span style={{
        fontSize: 10.5,
        color: T.text.faint,
        letterSpacing: '0.08em',
        fontFamily: T.font.mono,
        fontWeight: 600,
      }}>
        {label}
      </span>
    </span>
  );
}

function MetricSep() {
  return (
    <span aria-hidden style={{
      width: 1,
      height: 16,
      background: T.border.primary,
      margin: '0 14px',
    }} />
  );
}

function SearchPill({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      padding: '8px 14px',
      background: '#FFFFFF',
      borderRadius: 999,
      minWidth: 280,
      flex: 1,
      maxWidth: 460,
    }}>
      <Search size={13} color={T.text.faint} strokeWidth={1.8} />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
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
          <XIcon size={11} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

function FilterPill({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder: string;
}) {
  const active = value !== '';
  return (
    <div style={{
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 7,
      padding: '8px 14px',
      background: active ? T.accent.bg : '#FFFFFF',
      borderRadius: 999,
      fontFamily: T.font.ui,
      fontSize: 12.5,
      fontWeight: 600,
      color: active ? T.accent.text : T.text.subtle,
      letterSpacing: '-0.005em',
      transition: 'background 200ms ease, color 200ms ease',
      cursor: 'pointer',
    }}>
      <span aria-hidden style={{
        width: 6, height: 6,
        borderRadius: '50%',
        background: active ? 'var(--accent)' : T.text.faint,
      }} />
      <span>{active ? options.find((o) => o.value === value)?.label || placeholder : placeholder}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={placeholder}
        style={{
          all: 'unset',
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          cursor: 'pointer',
          opacity: 0,
        }}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

/* ─── Field-toggle popover — operator-controlled article meta ────
   Optional inline meta on each ASIN row. Defaults reflect "rarely
   needed in daily work":
     brand       on  — useful for visual grouping
     channels    on  — PRIME/EV chips are scanned at a glance
     dimensions  off — Maße/Gewicht only when explicitly opted in
   Selection persists per-user in localStorage. */

type FieldKey = 'brand' | 'channels' | 'dimensions';
type FieldFlags = Record<FieldKey, boolean>;
const FIELDS_DEFAULT: FieldFlags = { brand: true, channels: true, dimensions: false };
const FIELDS_STORAGE_KEY = 'marathon.lynne.fields.v1';

const FIELD_OPTIONS: Array<{ key: FieldKey; label: string; hint: string }> = [
  { key: 'brand',      label: 'Marke',           hint: 'Marken-Badge neben der Beschreibung' },
  { key: 'channels',   label: 'Kanäle',          hint: 'PRIME · EV · EV-PRIME Punkte' },
  { key: 'dimensions', label: 'Maße & Gewicht',  hint: 'L × B × H und kg unter der Beschreibung' },
];

function FieldsButton({ value, onChange }: { value: FieldFlags; onChange: (f: FieldFlags) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const activeCount = (Object.keys(value) as FieldKey[]).filter((k) => value[k]).length;

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Felder anzeigen"
        aria-haspopup="true"
        aria-expanded={open}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          padding: '8px 14px',
          background: open ? T.accent.bg : '#FFFFFF',
          color: open ? T.accent.text : T.text.subtle,
          borderRadius: 999,
          fontFamily: T.font.ui,
          fontSize: 12.5,
          fontWeight: 600,
          letterSpacing: '-0.005em',
          transition: 'background 160ms ease, color 160ms ease',
        }}
      >
        <SlidersHorizontal size={13} strokeWidth={2} />
        <span>Felder</span>
        <span style={{
          fontFamily: T.font.mono,
          fontSize: 10.5,
          fontWeight: 700,
          color: open ? T.accent.text : T.text.faint,
          letterSpacing: '0.04em',
        }}>
          {activeCount}/{FIELD_OPTIONS.length}
        </span>
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            zIndex: 20,
            minWidth: 240,
            padding: 6,
            borderRadius: 18,
            background: '#FFFFFF',
            boxShadow: '0 10px 40px rgba(15, 23, 42, 0.12), 0 2px 6px rgba(15, 23, 42, 0.06)',
            border: `1px solid ${T.border.subtle}`,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <div style={{
            padding: '8px 10px 4px',
            fontFamily: T.font.mono,
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: T.text.faint,
          }}>
            Spalten / Meta
          </div>
          {FIELD_OPTIONS.map((opt) => {
            const checked = value[opt.key];
            return (
              <button
                key={opt.key}
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                onClick={() => onChange({ ...value, [opt.key]: !checked })}
                style={{
                  all: 'unset',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 12,
                  transition: 'background 120ms ease',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(15,23,42,0.04)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 16,
                  height: 16,
                  borderRadius: 5,
                  background: checked ? 'var(--accent)' : 'transparent',
                  border: checked ? '1px solid var(--accent)' : `1px solid ${T.border.primary}`,
                  color: '#FFFFFF',
                  flexShrink: 0,
                  transition: 'background 140ms ease, border-color 140ms ease',
                }}>
                  {checked && <Check size={11} strokeWidth={3} />}
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                  <span style={{
                    fontFamily: T.font.ui,
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: T.text.primary,
                  }}>
                    {opt.label}
                  </span>
                  <span style={{
                    fontFamily: T.font.ui,
                    fontSize: 11,
                    color: T.text.faint,
                  }}>
                    {opt.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}


function IconButton({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        all: 'unset',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 36,
        height: 36,
        borderRadius: 999,
        background: '#FFFFFF',
        color: T.text.subtle,
        transition: 'color 160ms ease',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = T.text.primary; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = T.text.subtle; }}
    >
      {children}
    </button>
  );
}


/* ─── Helpers ─────────────────────────────────────────────────────── */

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return '–';
  return n.toLocaleString('de-DE');
}

/* ─── Physical-level classifier (mirror of getLevel from auftragHelpers,
   tuned for LYNNE description strings which carry the format inline).
   Same 7-level hierarchy used everywhere else in Marathon. */

const LEVEL_META: Record<number, { name: string; color: string }> = {
  1: { name: 'Thermorollen', color: '#3B82F6' }, // blue
  2: { name: 'Veit',         color: '#EC4899' }, // pink
  3: { name: 'ÖKO Thermo',   color: '#06B6D4' }, // cyan
  4: { name: 'Klebeband',    color: '#A855F7' }, // violet
  5: { name: 'Produktion',   color: '#10B981' }, // green
  6: { name: 'Kernöl',       color: '#F59E0B' }, // amber
  7: { name: 'Tachorollen',  color: '#F97316' }, // orange
};

function classifyLynneGroup(group: LynneAsinGroup): number {
  // We classify by DESCRIPTION primarily — brand alone is misleading
  // in the LYNNE catalog (e.g. "TK THERMALKING" is the parent brand for
  // 268 products, most of which are L1 Thermorollen, not L5 Produktion).
  // Brand only contributes to ÖKO / VEIT bucketing because those brands
  // exclusively make those formats.
  const desc = (group.description || '').toLowerCase();
  const brand = (group.brand || '').toLowerCase();
  if (/\btacho/.test(desc)) return 7;
  if (/(kürbis|kernöl)/.test(desc)) return 6;
  if (/(klebeband|paketband|packband|absperrband|fragile|bruchgefahr)/.test(desc)) return 4;
  // L5 Produktion — only triggers on physical Produktion keywords IN
  // THE DESCRIPTION (sandsack, big bag, etc.). Brand prefix removed.
  if (/(big\s*bag|silosack|sandsack|sandsäcke|sandsaecke|säcke|bauschutt|holzsack|holzwolle|füllmaterial)/.test(desc)) return 5;
  if (/öko/.test(desc) || /eco\s*ro/.test(brand)) return 3;
  if (/\bveit\b/.test(brand)) return 2;
  return 1; // default Thermorollen
}


/* Channel color tokens:
     PRIME    → blue   (most common Amazon channel)
     EV       → gray   (Eigenversand, neutral)
     EV-PRIME → lavender (hybrid)
     OTHER    → slate  (catch-all, distinct from EV gray) */
const CHANNEL_COLOR: Record<LynneChannel, string> = {
  'PRIME':    '#3B7BFF',
  'EV':       '#EA580C',  // vivid orange
  'EV-PRIME': '#A78BFA',
  'OTHER':    '#475569',
};

/* Brand color tokens. Lookup is case-insensitive substring match
   on the brand string — handles typos in the source xlsx like
   "eco roolls". Brands not in this map render in a neutral chip. */
const BRAND_COLOR_RULES: Array<{ match: string; color: string }> = [
  { match: 'lynne',   color: '#6E4DFF' }, // purple
  { match: 'eco ro',  color: '#10B981' }, // green — matches "eco roll", "eco rolls", "eco roolls" (typo in source)
];

function brandColor(brand: string): string | null {
  if (!brand) return null;
  const needle = brand.toLowerCase();
  for (const rule of BRAND_COLOR_RULES) {
    if (needle.includes(rule.match)) return rule.color;
  }
  return null;
}

function BrandBadge({ brand }: { brand: string }) {
  if (!brand) return null;
  const color = brandColor(brand);
  const colored = color !== null;
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 7,
      height: 22,
      padding: '0 10px 0 8px',
      borderRadius: 999,
      background: colored
        ? `color-mix(in srgb, ${color} 10%, transparent)`
        : 'rgba(15, 23, 42, 0.04)',
      color: colored ? color : T.text.primary,
    }}>
      {/* Subtle "tag" icon — semantically distinguishes brand from channels */}
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
        <path d="M2 6.4l3.6-3.6h4v4l-3.6 3.6a1 1 0 01-1.4 0L2 7.8a1 1 0 010-1.4z"
              stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        <circle cx="7.6" cy="4.4" r="0.7" fill="currentColor" />
      </svg>
      <span style={{
        fontFamily: T.font.ui,
        fontSize: 11.5,
        fontWeight: 600,
        letterSpacing: '-0.005em',
        whiteSpace: 'nowrap',
        color: colored ? color : T.text.primary,
      }}>
        {brand}
      </span>
    </div>
  );
}

function ChannelChip({ channel, size = 7 }: { channel: LynneChannel; size?: number }) {
  const color = CHANNEL_COLOR[channel];
  return (
    <span
      title={channel}
      aria-label={channel}
      style={{
        display: 'inline-flex',
        width: size,
        height: size,
        borderRadius: 999,
        background: color,
        opacity: 0.85,
        flexShrink: 0,
      }}
    />
  );
}

type SortKey = 'asin' | 'description' | 'kennung' | 'perPallet' | 'woche' | 'lager';
type SortDir = 'asc' | 'desc';

interface SortState { key: SortKey; dir: SortDir }

const SORT_DEFAULTS: Record<SortKey, SortDir> = {
  asin: 'desc',  // ASIN column sorts by variantCount — desc shows fattest groups first
  description: 'asc',
  kennung: 'asc',
  perPallet: 'desc',
  woche: 'desc',
  lager: 'desc',
};

/* Column registry — single source of truth used by both the header
   and the row layout. `numeric` columns get right-aligned + mono.
   `sortable: false` columns disable click-to-sort. */
const COLUMNS: Array<{
  id: SortKey | 'iso' | 'chevron';
  label: string;
  numeric: boolean;
  sortable: boolean;
}> = [
  { id: 'iso',         label: '',            numeric: false, sortable: false },
  { id: 'asin',        label: 'ASIN',        numeric: false, sortable: true  },
  { id: 'description', label: 'Artikel',     numeric: false, sortable: true  },
  { id: 'perPallet',   label: 'Pro Pal.',    numeric: true,  sortable: true  },
  { id: 'woche',       label: 'Woche',       numeric: true,  sortable: true  },
  { id: 'lager',       label: 'Lager Graz',  numeric: true,  sortable: true  },
  { id: 'chevron',     label: '',            numeric: false, sortable: false },
];


/* ─── Column header — sticky sort bar ──────────────────────────── */

function ColumnHeader({ sort, onSort }: { sort: SortState; onSort: (key: SortKey) => void }) {
  return (
    <div className="lt-colhead">
      <div className="lt-grid">
        {COLUMNS.map((col) => {
          const isActive = col.id === sort.key;
          const isNumeric = col.numeric;
          const sortable = col.sortable && col.id !== 'chevron' && col.id !== 'iso';
          if (col.id === 'chevron' || col.id === 'iso') return <span key={col.id} />;
          return (
            <button
              key={col.id}
              type="button"
              className={[
                'lt-colhead-cell',
                isNumeric ? 'lt-colhead-num' : '',
                isActive ? 'lt-colhead-active' : '',
                !sortable ? 'lt-colhead-static' : '',
              ].filter(Boolean).join(' ')}
              onClick={sortable ? () => onSort(col.id as SortKey) : undefined}
              disabled={!sortable}
            >
              {col.label}
              {sortable && (
                <span aria-hidden style={{ display: 'inline-flex', width: 10, height: 10 }}>
                  {isActive
                    ? (sort.dir === 'desc'
                        ? <ArrowDown size={10} strokeWidth={2.6} />
                        : <ArrowUp size={10} strokeWidth={2.6} />)
                    : <ArrowUpDown size={10} strokeWidth={1.6} style={{ opacity: 0.35 }} />}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}


/* ─── Verkäufe — deterministic sales series per variant + mode.
   Newest point is real (lynne_products.weekly_sales for weekly modes;
   weekly × 4.33 as the monthly anchor for the monthly modes). All other
   points are seeded mocks (±15 % variance, seed = `${sku}|${mode}`) so
   toggling mode visibly changes the curve shape, and refresh always
   shows the same numbers per (sku, mode) pair. */

export type SalesMode = '4w' | '8w' | '6m' | '1y';

export const SALES_MODES: SalesMode[] = ['4w', '8w', '6m', '1y'];

interface SalesModeMeta {
  short:        string;   // ModePicker chip text
  long:         string;   // hero KpiChart title prefix
  pointCount:   number;
  granularity:  'week' | 'month';
  compareLabel: string;   // WowChip column header + tooltip
  realLabel:    string;   // tooltip on the newest point
  mockLabel:    string;   // tooltip on prior points
}

export const MODE_META: Record<SalesMode, SalesModeMeta> = {
  '4w': { short: '4W', long: '4 Wochen',  pointCount: 4,  granularity: 'week',  compareLabel: 'vs KW11',     realLabel: 'Real (Vorwoche)',    mockLabel: 'Mock ±15 % (seeded)' },
  '8w': { short: '8W', long: '8 Wochen',  pointCount: 8,  granularity: 'week',  compareLabel: 'vs KW07',     realLabel: 'Real (Vorwoche)',    mockLabel: 'Mock ±15 % (seeded)' },
  '6m': { short: '6M', long: '6 Monate',  pointCount: 6,  granularity: 'month', compareLabel: 'vs Dez',      realLabel: 'Aktuell (Vormonat)', mockLabel: 'Schätzung ±15 % (seeded)' },
  '1y': { short: '1J', long: '12 Monate', pointCount: 12, granularity: 'month', compareLabel: 'vs Jun',      realLabel: 'Aktuell (Vormonat)', mockLabel: 'Schätzung ±15 % (seeded)' },
};

const MONTHS_DE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

// Today = 2026-05-25 per CLAUDE.md → newest KW 14 (carryover from the
// existing fixture), newest month index = 4 (Mai). Keeping the KW14
// anchor preserves the rest of the codebase's expectations.
const NEWEST_KW = 14;
const NEWEST_MONTH_IDX = 4;

function generatePeriodLabels(mode: SalesMode): string[] {
  const meta = MODE_META[mode];
  if (meta.granularity === 'week') {
    return Array.from({ length: meta.pointCount }, (_, i) =>
      `KW${String(NEWEST_KW - i).padStart(2, '0')}`
    );
  }
  return Array.from({ length: meta.pointCount }, (_, i) =>
    MONTHS_DE[(NEWEST_MONTH_IDX - i + 12 * 5) % 12]   // + 12*5 guards against negatives for 1J
  );
}

function seededRng(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return () => {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    return h / 4294967296;
  };
}

function generateSeries(sku: string, latestWeekly: number, mode: SalesMode): number[] {
  const meta = MODE_META[mode];
  // Monthly anchor ≈ weekly × 4.33; weekly anchor stays as-is.
  const base = meta.granularity === 'month' ? latestWeekly * 4.33 : latestWeekly;
  const rng = seededRng(`${sku}|${mode}`);
  const out = [Math.max(0, Math.round(base))];
  for (let i = 0; i < meta.pointCount - 1; i++) {
    const variance = (rng() - 0.5) * 0.30;            // ±15 %
    out.push(Math.max(0, Math.round(base * (1 + variance))));
  }
  return out;                                          // newest-first
}


export interface VariantSalesRow {
  asin: string;
  sku: string;
  ean: string | null;
  channel: LynneChannel;
  brand: string;
  description: string;
  perPallet: number;
  // Original weekly velocity from the API — feeds iso/level
  // classification regardless of the active SalesMode (so monthly
  // modes don't inflate the synthetic LynneAsinGroup 4×).
  weeklyAnchor: number;
  // Today's sales — weeklyAnchor ÷ 7 with a small seeded ±15 % wiggle
  // so the column doesn't look like a flat-division artifact. Mock.
  heuteSales: number;
  // Mock FBA pipeline for the "Auffüllen" column. Mirrors the
  // "Bei Amazon auffüllen + Info" sheet (xlsx):
  //   fbaAvailable = aktueller Lagerbestand (verfügbar)
  //   fbaIncoming  = unterwegs / wird empfangen / reserviert (combined)
  //   maxStock     = wöchentliche Verkäufe × 8 (8-Wochen-Bedarf)
  //   auffuellen   = maxStock − (fbaAvailable + fbaIncoming)
  // Sign: + → niedriger Bestand, auffüllen; − → Überbestand.
  fbaAvailable: number;
  fbaIncoming: number;
  // Sales series for the active SalesMode — newest first, variable
  // length (2 / 4 / 8 / 6 / 12). series[0] is the "real" anchor (weekly
  // or weekly × 4.33 for monthly), the rest are seeded mocks.
  series: number[];
}

function generateHeuteSales(sku: string, weekly: number): number {
  if (weekly <= 0) return 0;
  const rng = seededRng(`${sku}|heute`);
  const variance = 0.85 + rng() * 0.30;                 // 0.85 … 1.15
  return Math.max(0, Math.round((weekly / 7) * variance));
}

// FBA pipeline mock. Real warehouse data clusters near the 8-week
// target (Maximal-Lagerbestand) — typical xlsx rows show "Auffüllen"
// within ±10 % of max, occasionally more for low-volume SKUs. We
// reproduce that distribution so the column values feel realistic:
//   total pipeline (verfügbar + unterwegs/reserviert) = 85 … 115 % of maxStock
//   split  ≈ 70-85 % verfügbar, rest pipeline-in-transit
// Seeded per SKU so values stay stable across re-renders.
function generateFbaPipeline(sku: string, weekly: number): { available: number; incoming: number } {
  if (weekly <= 0) return { available: 0, incoming: 0 };
  const rng = seededRng(`${sku}|fba`);
  const maxStock = weekly * 8;
  const totalPipeline = maxStock * (0.85 + rng() * 0.30);   // 0.85 … 1.15 × max
  const incomingRatio = 0.15 + rng() * 0.20;                // 0.15 … 0.35
  const incoming = Math.round(totalPipeline * incomingRatio);
  const available = Math.max(0, Math.round(totalPipeline - incoming));
  return { available, incoming };
}

// "Heute auffüllen" — matches the eponymous column in the
// Produktaufstellung xlsx (Bei Amazon auffüllen + Info sheet):
//   T = S − (P + Q + R)
// where S = 8-Wochen-Bedarf (max target), P = verfügbar, Q+R = pipeline.
// Positive value → Niedriger Bestand, auffüllen.
// Negative value → Überbestand, nicht auffüllen.
function computeAuffuellen(row: VariantSalesRow): number {
  const maxStock = row.weeklyAnchor * 8;
  return maxStock - row.fbaAvailable - row.fbaIncoming;
}


/* ─── Order-trigger logic ("Точка отправления").
   Translates the per-row "Auffüllen" need into one of four discrete
   action states so the warehouse can compose an order at a glance:

     URGENT  verfügbar < 4-Wochen-Alarm  → ship now, ≥ 1 pallet
     READY   auffuellen ≥ trigger        → include in next batch
     WAIT    0 < auffuellen < trigger    → accumulate, monitor
     OK      auffuellen ≤ 0              → overstock, no action

   trigger = max(perPallet, weekly × 2)
     ship only when both: ≥ 1 full pallet AND ≥ 2 weeks of accumulated
     deficit, so we avoid sending many tiny shipments.

   qty rounds the need UP to whole pallets (full-pallet rate ≪ parcel).
   This may overshoot the target by up to one pallet — acceptable trade. */

export type OrderState = 'urgent' | 'ready' | 'wait' | 'ok';

export interface OrderTrigger {
  state: OrderState;
  qty: number;          // suggested order units (full pallets)
  pallets: number;
  triggerSize: number;
  reason: string;
}

export function computeOrderTrigger(row: VariantSalesRow): OrderTrigger {
  const weekly = Math.max(0, row.weeklyAnchor);
  const perPallet = Math.max(1, row.perPallet || 1);
  const maxStock = weekly * 8;
  const minStock = weekly * 4;
  const need = maxStock - row.fbaAvailable - row.fbaIncoming;
  const triggerSize = Math.max(perPallet, weekly * 2);

  if (need <= 0) {
    return { state: 'ok', qty: 0, pallets: 0, triggerSize, reason: 'Überbestand — keine Bestellung' };
  }
  if (row.fbaAvailable < minStock) {
    const pallets = Math.max(1, Math.ceil(need / perPallet));
    return {
      state: 'urgent',
      qty: pallets * perPallet,
      pallets,
      triggerSize,
      reason: `Bestand ${formatNum(row.fbaAvailable)} < 4-Wochen-Alarm (${formatNum(minStock)})`,
    };
  }
  if (need >= triggerSize) {
    const pallets = Math.ceil(need / perPallet);
    return {
      state: 'ready',
      qty: pallets * perPallet,
      pallets,
      triggerSize,
      reason: `Bedarf ${formatNum(need)} ≥ Trigger (${formatNum(triggerSize)})`,
    };
  }
  return {
    state: 'wait',
    qty: 0,
    pallets: 0,
    triggerSize,
    reason: `Bedarf ${formatNum(need)} < Trigger (${formatNum(triggerSize)}) — sammeln`,
  };
}


/* ─── MiniLineChart — per-row 4-week trend.
   4 points (KW11 → KW14, chronological left→right), value label above
   each top point. Line colour follows slope (rising green / falling
   red / neutral accent), KW14 is anchored with a larger filled dot.
   Y-axis is clipped around the row's own range (±50/45 %) so a ±15 %
   swing fills most of the chart height — small but readable. */

/* ─── WowChip — KW14 vs KW13 coefficient.
   One compact pill per row, sits between the article description and
   the line chart. Colour follows the same tri-state palette as the
   chart's stroke (green/red/accent neutral) so the chip and the curve
   agree at a glance. */

function WowChip({ current, previous, compareLabel }: {
  current: number;
  previous: number;
  compareLabel: string;        // e.g. "vs KW13" / "vs Vormonat"
}) {
  // No previous baseline → can't compute a ratio; show a quiet dash.
  if (previous <= 0) {
    return (
      <span
        className="lt-wow-chip lt-wow-chip-flat"
        title={`Keine Vergleichsperiode (${compareLabel})`}
      >
        <span aria-hidden>—</span>
      </span>
    );
  }
  const ratio = (current - previous) / previous;
  const pct = Math.round(ratio * 100);
  const direction: 'up' | 'down' | 'flat' =
    ratio > 0.05 ? 'up' : ratio < -0.05 ? 'down' : 'flat';
  const arrow = direction === 'up' ? '↑' : direction === 'down' ? '↓' : '→';
  const sign = pct > 0 ? '+' : '';
  return (
    <span
      className={`lt-wow-chip lt-wow-chip-${direction}`}
      title={`${compareLabel} · ${sign}${pct} % (${formatNum(current)} / ${formatNum(previous)})`}
    >
      <span aria-hidden style={{ marginRight: 3 }}>{arrow}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{sign}{pct} %</span>
    </span>
  );
}


/* Catmull-Rom → cubic Bézier conversion, tension 0.5. Gives a smooth
   path through the original points without the over/undershoot of a
   plain cardinal spline. Endpoints are duplicated so the curve still
   starts/ends exactly on P0 / Pn. */
function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? pts[i + 1];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

function MiniLineChart({ series, width = 220, height = 56 }: {
  series: number[];                    // newest first; variable length 2…12
  width?: number;
  height?: number;
}) {
  if (series.length < 2) return null;
  // Reverse to chronological order — oldest left, newest right.
  const chrono = [...series].reverse();
  const newestIdx = chrono.length - 1;                  // anchor position

  const min = Math.min(...chrono);
  const max = Math.max(...chrono);
  const span = Math.max(1, max - min);
  // Amplitude amplifier — same trick as the hero KpiChart, so ±15 %
  // variance reads visibly even though all 4 values are huge integers.
  const yMin = Math.max(0, min - span * 0.5);
  const yMax = max + span * 0.45;
  const yRange = Math.max(1, yMax - yMin);

  const padX = 18;
  const padTop = 16;
  const padBottom = 8;

  const xs = chrono.map((_, i) => padX + (i * (width - 2 * padX)) / (chrono.length - 1));
  const ys = chrono.map((v) => padTop + (1 - (v - yMin) / yRange) * (height - padTop - padBottom));
  const points = xs.map((x, i) => ({ x, y: ys[i] }));

  // Trend colour + visual weight. Status compares the FIRST and LAST
  // points of the series — i.e. growth across the whole mode window:
  // 4W ⇒ heute vs 4 Wochen zurück, 8W ⇒ vs 8 Wochen, 6M/1J ⇒ vs Anfang
  // des Zeitraums. The WowChip beside the chart stays as "vs previous
  // period", so chip + chart deliberately answer different questions.
  const newestVal = chrono[newestIdx];                 // series[0]
  const oldestVal = chrono[0];                          // series[pointCount-1]
  const slope = oldestVal === 0 ? (newestVal > 0 ? 1 : 0) : (newestVal - oldestVal) / oldestVal;
  const direction: 'up' | 'down' | 'flat' =
    slope > 0.05 ? 'up' : slope < -0.05 ? 'down' : 'flat';
  const trendColor = direction === 'up' ? '#10B981' : direction === 'down' ? '#DC2626' : 'var(--accent)';
  const strokeW = direction === 'flat' ? 1.6 : 2.1;
  // Denser series → smaller non-anchor dots so the line stays the
  // dominant visual; anchor (newest) stays prominent at any density.
  const dotR = chrono.length >= 8 ? 1.4 : chrono.length >= 6 ? 1.7 : 2;

  const linePath = smoothPath(points);
  // Closed path for the subtle area fill: line → drop to baseline → close.
  const baselineY = height - 1;
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(2)} ${baselineY} L ${points[0].x.toFixed(2)} ${baselineY} Z`;

  // SVG gradient ids must be unique per chart; useId() yields colon-
  // delimited slugs in React 18 which break `url(#id)` references in
  // some browsers — strip the colons.
  const gradId = `mc-grad-${useId().replace(/:/g, '')}`;
  const showFill = direction !== 'flat';

  return (
    <div className="lt-mini-chart" style={{ width, height, position: 'relative' }}>
      <svg
        width={width}
        height={height}
        style={{ display: 'block', overflow: 'visible' }}
        aria-hidden
      >
        {showFill && (
          <>
            <defs>
              {/* Softer than before — top stop ~10 % so the wash hints
                  at direction without competing with the stroke. */}
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor={trendColor} stopOpacity={0.11} />
                <stop offset="65%"  stopColor={trendColor} stopOpacity={0.03} />
                <stop offset="100%" stopColor={trendColor} stopOpacity={0} />
              </linearGradient>
            </defs>
            <path d={areaPath} fill={`url(#${gradId})`} stroke="none" />
          </>
        )}
        <path d={linePath} stroke={trendColor} strokeWidth={strokeW} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        {xs.map((x, i) => {
          const last = i === xs.length - 1;          // newest — anchor
          return (
            <g key={i}>
              {last ? (
                <>
                  <circle cx={x} cy={ys[i]} r={5} fill={trendColor} opacity={0.18} />
                  <circle cx={x} cy={ys[i]} r={3} fill={trendColor} stroke="#FFFFFF" strokeWidth={1.4} />
                </>
              ) : (
                <circle cx={x} cy={ys[i]} r={dotR} fill="#FFFFFF" stroke={trendColor} strokeWidth={1.2} />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}


/* ─── Verkäufe column header — sortable, 4 cells ─────────────────── */

type VerkaufeSortKey = 'asin' | 'description' | 'heute' | 'fba' | 'order' | 'latest' | 'delta';
interface VerkaufeSortState { key: VerkaufeSortKey; dir: SortDir }

function VerkaeufeColumnHeader({ sort, onSort, mode }: {
  sort: VerkaufeSortState; onSort: (key: VerkaufeSortKey) => void; mode: SalesMode;
}) {
  const meta = MODE_META[mode];
  const baseCells: Array<{ id: VerkaufeSortKey; label: string; numeric?: boolean; emphasis?: boolean }> = [
    { id: 'asin',        label: 'ASIN' },
    { id: 'description', label: 'Artikel' },
    { id: 'heute',       label: 'Heute', numeric: true, emphasis: true },
    { id: 'fba',         label: 'Auffüllen', numeric: true },
    { id: 'order',       label: 'Bestellung', numeric: true },
  ];
  return (
    <div className="lt-colhead">
      <div className="lt-grid-verkaeufe">
        <span />{/* iso slot */}
        {baseCells.map((c) => {
          const isActive = c.id === sort.key;
          return (
            <button
              key={c.id}
              type="button"
              className={[
                'lt-colhead-cell',
                c.numeric ? 'lt-colhead-num' : '',
                isActive ? 'lt-colhead-active' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => onSort(c.id)}
            >
              <span className="lt-th-content">
                {c.emphasis && (
                  <span aria-hidden style={{
                    width: 5, height: 5, borderRadius: 999,
                    background: 'var(--accent)',
                    display: 'inline-block', marginRight: 4,
                  }} />
                )}
                <span style={{ color: c.emphasis ? T.text.primary : undefined }}>
                  {c.label}
                </span>
                <span aria-hidden style={{ display: 'inline-flex', width: 10, height: 10 }}>
                  {isActive
                    ? (sort.dir === 'desc'
                        ? <ArrowDown size={10} strokeWidth={2.6} />
                        : <ArrowUp size={10} strokeWidth={2.6} />)
                    : <ArrowUpDown size={10} strokeWidth={1.6} style={{ opacity: 0.35 }} />}
                </span>
              </span>
            </button>
          );
        })}
        {/* Combined chip + chart column header — sortable by the WoW/MoM
            %  delta (chip value), label combines compareLabel + Verlauf. */}
        {(() => {
          const isActive = sort.key === 'delta';
          return (
            <button
              type="button"
              className={[
                'lt-colhead-cell',
                isActive ? 'lt-colhead-active' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => onSort('delta')}
              style={{ justifyContent: 'flex-start', paddingLeft: 6 }}
            >
              <span className="lt-th-content">
                <span>{meta.compareLabel} · Verlauf</span>
                <span aria-hidden style={{ display: 'inline-flex', width: 10, height: 10 }}>
                  {isActive
                    ? (sort.dir === 'desc'
                        ? <ArrowDown size={10} strokeWidth={2.6} />
                        : <ArrowUp size={10} strokeWidth={2.6} />)
                    : <ArrowUpDown size={10} strokeWidth={1.6} style={{ opacity: 0.35 }} />}
                </span>
              </span>
            </button>
          );
        })()}
      </div>
    </div>
  );
}


/* ─── VariantSalesCard — one paper-island per SKU ────────────────── */

function VariantSalesCard({ row, dim, mode }: {
  row: VariantSalesRow;
  dim?: SkuDimensionLookup | null;
  mode: SalesMode;
}) {
  const meta = MODE_META[mode];
  // Synthetic LynneAsinGroup so GroupIso / classifyLynneGroup can reuse
  // their existing inputs — single-variant group for level + iso color.
  const syntheticGroup: LynneAsinGroup = {
    asin: row.asin,
    description: row.description,
    brand: row.brand,
    variantCount: 1,
    totalWeeklySales: row.weeklyAnchor,
    totalGrazStock: 0,
    perPallet: row.perPallet,
    variants: [{
      sku: row.sku, ean: row.ean, channel: row.channel,
      weeklySales: row.weeklyAnchor, grazStock: 0,
    }],
  };

  return (
    <PaperCard flat className="lt-card" style={{ gap: 0 }}>
      <WhitePanel padding="10px 18px" style={{ background: 'transparent' }}>
        <div className="lt-grid-verkaeufe">
          {/* Col 1 — iso */}
          <GroupIso group={syntheticGroup} dim={dim} />

          {/* Col 2 — ASIN + channel dot */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            minWidth: 0,
          }}>
            <span style={{
              fontFamily: T.font.mono,
              fontSize: 14,
              fontWeight: 600,
              color: T.text.primary,
              letterSpacing: '-0.015em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              {row.asin}
            </span>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <ChannelChip channel={row.channel} />
              <span style={{
                fontFamily: T.font.mono,
                fontSize: 10,
                fontWeight: 700,
                color: T.text.faint,
                letterSpacing: '0.10em',
              }}>
                {row.channel}
              </span>
            </div>
          </div>

          {/* Col 3 — description + brand badge */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            minWidth: 0,
          }}>
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span
                title={row.description}
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: T.text.primary,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {row.description || '—'}
              </span>
              <span style={{
                fontFamily: T.font.mono,
                fontSize: 11,
                color: T.text.subtle,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}>
                {row.sku}{row.ean ? ` · ${row.ean}` : ''}
              </span>
            </div>
            <BrandBadge brand={row.brand} />
            <span style={{ flex: 1, minWidth: 0 }} />
          </div>

          {/* Col 4 — Heute (today's sales, mocked ≈ weekly ÷ 7). */}
          <div
            title={`Heute: ${formatNum(row.heuteSales)} Stk (≈ Wochengeschwindigkeit ÷ 7)`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 6,
              paddingRight: 4,
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            <span aria-hidden style={{
              width: 6, height: 6, borderRadius: 999,
              background: 'var(--accent)',
              flexShrink: 0,
            }} />
            <span style={{
              fontFamily: T.font.mono,
              fontSize: 14,
              fontWeight: 700,
              color: row.heuteSales === 0 ? T.text.faint : T.text.primary,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '-0.015em',
            }}>
              {formatNum(row.heuteSales)}
            </span>
          </div>

          {/* Col 5 — "Auffüllen" (matches the eponymous column in the
              Produktaufstellung xlsx). Formula: maxStock(8 Wo.) −
              (verfügbar + pipeline). Sign:
                + → niedriger Bestand, auffüllen (red — action needed)
                − → Überbestand, nicht auffüllen (green — OK)            */}
          {(() => {
            const auffuellen = computeAuffuellen(row);
            const maxStock = row.weeklyAnchor * 8;
            const direction: 'up' | 'down' | 'flat' =
              auffuellen > 0 ? 'up' : auffuellen < 0 ? 'down' : 'flat';
            // up = needs replenish → red warning
            // down = overstock → green calm
            const color =
              direction === 'up'   ? '#B91C1C' :
              direction === 'down' ? '#047857' :
              T.text.faint;
            const sign = auffuellen > 0 ? '+' : '';
            return (
              <div
                title={
                  `Heute auffüllen: ${sign}${formatNum(auffuellen)} Stk\n` +
                  `Max-Bestand (8 Wo.): ${formatNum(maxStock)}\n` +
                  `Verfügbar: ${formatNum(row.fbaAvailable)}\n` +
                  `Pipeline (unterwegs + reserviert): ${formatNum(row.fbaIncoming)}\n` +
                  `Verkauf/Wo.: ${formatNum(row.weeklyAnchor)}`
                }
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  paddingRight: 4,
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                  fontFamily: T.font.mono,
                  fontSize: 13,
                  fontWeight: 700,
                  color,
                  fontVariantNumeric: 'tabular-nums',
                  letterSpacing: '-0.015em',
                }}
              >
                {sign}{formatNum(auffuellen)}
              </div>
            );
          })()}

          {/* Col 6 — Bestellung (order trigger). State chip + qty/pallets
              when actionable; "warten" / "—" otherwise. */}
          {(() => {
            const t = computeOrderTrigger(row);
            const STATE_LABEL: Record<OrderState, string> = {
              urgent: 'Senden!',
              ready:  'Bereit',
              wait:   'Warten',
              ok:     '—',
            };
            return (
              <div
                title={t.reason}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'flex-start',
                  gap: 8,
                  minWidth: 0,
                  whiteSpace: 'nowrap',
                }}
              >
                <span className={`lt-order-chip lt-order-chip-${t.state}`}>
                  {STATE_LABEL[t.state]}
                </span>
                {(t.state === 'urgent' || t.state === 'ready') && (
                  <span style={{
                    fontFamily: T.font.mono,
                    fontSize: 12,
                    fontWeight: 700,
                    color: T.text.primary,
                    fontVariantNumeric: 'tabular-nums',
                    letterSpacing: '-0.015em',
                  }}>
                    {formatNum(t.qty)}
                    <span style={{ color: T.text.faint, fontWeight: 500 }}>
                      {' '}· {t.pallets} Pal
                    </span>
                  </span>
                )}
              </div>
            );
          })()}

          {/* Col 7 — Combined: chip (% newest vs oldest in mode window)
              + line chart, side-by-side. Both compare the same two end
              points so chip text matches the curve's colour. Sort key
              'delta' acts on the chip's % value. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'flex-start' }}>
            <WowChip
              current={row.series[0]}
              previous={row.series[row.series.length - 1] ?? 0}
              compareLabel={meta.compareLabel}
            />
            <MiniLineChart series={row.series} />
          </div>
        </div>
      </WhitePanel>
    </PaperCard>
  );
}


/* ─── VerkaufeKpiChart — hero KPI + adaptive period chart.
   For 2W the AreaChart is replaced with a single large DeltaTile (a
   2-point area chart degenerates to a tilted line and reads as broken).
   For 4W/8W/6M/1J the chart adapts to whatever pointCount the mode
   carries, with labels and tooltips driven by `generatePeriodLabels`. */

function VerkaufeKpiChart({ total, perPeriod, mode }: {
  total: number;
  perPeriod: number[];
  mode: SalesMode;
}) {
  const meta = MODE_META[mode];
  // Period labels come newest-first; chart data is plotted chronologically
  // (oldest left → newest right) so we reverse both for `chartData`.
  const labelsNewestFirst = generatePeriodLabels(mode);
  const labels = [...labelsNewestFirst].reverse();
  const values = [...perPeriod].reverse();
  const chartData = labels.map((label, i) => ({
    label,
    value: values[i] ?? 0,
    isReal: i === labels.length - 1,
  }));
  const newestVal = chartData[chartData.length - 1]?.value ?? 0;
  const oldestVal = chartData[0]?.value ?? 0;

  // Trend slope drives the line stroke color (rising green, falling red)
  const slope = oldestVal === 0
    ? (newestVal > 0 ? 1 : 0)
    : (newestVal - oldestVal) / oldestVal;
  // trendColor — used ONLY for the small delta-pill in the hero block
  // (the ↑/↓ +N % chip beside the big total). The chart itself uses a
  // single monotone accent (chartColor) regardless of direction.
  const trendColor = slope > 0.05 ? '#10B981' : slope < -0.05 ? '#DC2626' : 'var(--accent)';
  const chartColor = 'var(--accent)';
  const deltaPct = oldestVal === 0
    ? null
    : Math.round(((newestVal - oldestVal) / oldestVal) * 100);
  const deltaContextLabel = `${labelsNewestFirst[0]} vs ${labelsNewestFirst[labelsNewestFirst.length - 1]}`;

  // Amplitude amplifier — clip Y axis to a narrow band around the actual
  // range so a ±15% week-over-week change visually fills 70%+ of chart
  // height. Without this the line looks almost flat (since the values
  // are ~22k and the variance is ~3k).
  const seriesValues = chartData.map((d) => d.value);
  const min = Math.min(...seriesValues);
  const max = Math.max(...seriesValues);
  const span = Math.max(1, max - min);
  const yMin = Math.max(0, min - span * 0.6);
  const yMax = max + span * 0.4;

  const gradId = 'kpi-grad-verkaufe';

  return (
    <div style={{
      display: 'flex',
      alignItems: 'stretch',
      gap: 28,
      padding: '22px 28px',
      borderRadius: 24,
      background: 'linear-gradient(135deg, #FFFFFF 0%, rgba(244,245,247,0.9) 100%)',
      border: '1px solid rgba(15, 23, 42, 0.06)',
      boxShadow: '0 4px 24px 0 rgba(15, 23, 42, 0.04)',
      width: '100%',
    }}>
      {/* Hero block — total + delta */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        gap: 8,
        minWidth: 260,
      }}>
        <span style={{
          fontSize: 10.5,
          fontFamily: T.font.mono,
          fontWeight: 700,
          color: T.text.faint,
          textTransform: 'uppercase',
          letterSpacing: '0.16em',
          whiteSpace: 'nowrap',
        }}>
          {meta.long}-Verkäufe
        </span>

        <div style={{ display: 'inline-flex', alignItems: 'baseline', gap: 10, lineHeight: 1 }}>
          <span style={{
            fontFamily: T.font.mono,
            fontSize: 'clamp(38px, 4.4vw, 56px)',
            fontWeight: 600,
            color: T.text.primary,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.03em',
          }}>
            {formatNum(total)}
          </span>
          <span style={{
            fontSize: 14,
            fontFamily: T.font.mono,
            fontWeight: 600,
            color: T.text.faint,
            letterSpacing: '0.04em',
          }}>
            Stk
          </span>
        </div>

        {deltaPct != null && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '4px 10px',
              borderRadius: 999,
              background: `color-mix(in srgb, ${trendColor} 12%, transparent)`,
              color: trendColor,
              fontFamily: T.font.mono,
              fontSize: 11.5,
              fontWeight: 700,
              letterSpacing: '0.02em',
            }}>
              <span aria-hidden>{deltaPct > 5 ? '↑' : deltaPct < -5 ? '↓' : '→'}</span>
              <span>{deltaPct >= 0 ? '+' : ''}{deltaPct}%</span>
            </span>
            <span style={{
              fontSize: 11,
              fontFamily: T.font.mono,
              color: T.text.subtle,
              letterSpacing: '0.04em',
            }}>
              {deltaContextLabel}
            </span>
          </div>
        )}
      </div>

      <span aria-hidden style={{
        width: 1,
        background: T.border.subtle,
        margin: '4px 0',
        flexShrink: 0,
      }} />

      {/* Chart column — minimalist, full temperature gradient */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        minWidth: 0,
      }}>
        <div style={{ width: '100%', height: 160 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 28, right: 18, bottom: 0, left: 18 }}>
              <defs>
                {/* Monotone accent gradient — chart visualisation is a
                    single colour regardless of direction; the small
                    delta pill on the hero block still carries the
                    green/red trend signal. */}
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor={chartColor} stopOpacity={0.63} />
                  <stop offset="55%"  stopColor={chartColor} stopOpacity={0.21} />
                  <stop offset="100%" stopColor={chartColor} stopOpacity={0.0} />
                </linearGradient>
              </defs>

              {/* YAxis hidden — only there to apply the amplified domain.
                  The narrow range exaggerates rises and falls visually. */}
              <YAxis hide domain={[yMin, yMax]} />

              <Area
                type="monotone"
                dataKey="value"
                stroke="none"
                fill={`url(#${gradId})`}
                dot={false}
                activeDot={false}
                isAnimationActive
                animationDuration={620}
              >
                {/* Value labels above each dot. KW14 (real) gets a
                    pill backdrop in trend color so it reads as the
                    anchor; mocks render as plain mono text with ~. */}
                <LabelList
                  dataKey="value"
                  position="top"
                  offset={12}
                  content={(props: { x?: number; y?: number; value?: number; index?: number }) => {
                    const x = Number(props.x ?? 0);
                    const y = Number(props.y ?? 0);
                    const i = props.index ?? 0;
                    const v = Number(props.value ?? 0);
                    const isReal = i === chartData.length - 1;
                    const isFirst = i === 0;
                    const label = (isReal ? '' : '~') + formatNum(v);
                    // Anchor edge labels to the chart's edge instead of
                    // the point's centre, so wide numbers like "5.638"
                    // on the last (newest) data point don't get clipped
                    // by the SVG's right edge.
                    const anchor: 'start' | 'middle' | 'end' =
                      isReal ? 'end' : isFirst ? 'start' : 'middle';
                    return (
                      <text
                        key={`lbl-${i}`}
                        x={x}
                        y={y - 14}
                        textAnchor={anchor}
                        style={{
                          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                          fontSize: isReal ? 15 : 11.5,
                          fontWeight: isReal ? 800 : 500,
                          fill: isReal ? '#0B1220' : '#94A3B8',
                          letterSpacing: '-0.015em',
                        }}
                      >
                        {label}
                      </text>
                    );
                  }}
                />
              </Area>
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* X-axis: period labels in N equal columns (oldest left →
            newest right). Newest gets an «AKTUELL» pill in trend color. */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${chartData.length}, 1fr)`,
          gap: 8,
          paddingTop: 6,
        }}>
          {chartData.map((d) => (
            <div key={d.label}
              title={`${d.label} · ${formatNum(d.value)} Stk · ${d.isReal ? meta.realLabel : meta.mockLabel}`}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 4,
              }}>
              {d.isReal && (
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: `color-mix(in srgb, ${chartColor} 14%, transparent)`,
                  color: chartColor,
                  fontFamily: T.font.mono,
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                }}>
                  <span aria-hidden style={{
                    width: 5, height: 5, borderRadius: 999,
                    background: chartColor,
                  }} />
                  Heute
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}


/* ─── Tab bar — switches between Katalog, Verkäufe and Marktanalyse views ── */

type View = 'katalog' | 'verkaeufe' | 'marktanalyse';

function TabBar({ value, onChange }: { value: View; onChange: (v: View) => void }) {
  const tabs: { id: View; label: string }[] = [
    { id: 'katalog',      label: 'Katalog' },
    { id: 'verkaeufe',    label: 'Verkäufe' },
    { id: 'marktanalyse', label: 'Marktanalyse' },
  ];
  return (
    <div style={{
      display: 'inline-flex',
      gap: 4,
      padding: 4,
      borderRadius: 999,
      background: 'rgba(15, 23, 42, 0.05)',
    }}>
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            style={{
              all: 'unset',
              cursor: 'pointer',
              padding: '7px 18px',
              borderRadius: 999,
              background: active ? '#FFFFFF' : 'transparent',
              boxShadow: active ? '0 1px 2px rgba(15, 23, 42, 0.06)' : 'none',
              fontFamily: T.font.ui,
              fontSize: 12.5,
              fontWeight: 600,
              color: active ? T.text.primary : T.text.subtle,
              transition: 'background 180ms ease, color 180ms ease, box-shadow 180ms ease',
              letterSpacing: '-0.005em',
            }}
            onMouseEnter={(e) => {
              if (!active) e.currentTarget.style.color = T.text.primary;
            }}
            onMouseLeave={(e) => {
              if (!active) e.currentTarget.style.color = T.text.subtle;
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}


/* ─── ModePicker — segmented control for the Verkäufe time-range.
   Visually identical to TabBar (pill background, white active chip);
   labels are the short MODE_META[].short codes. Sits in the Verkäufe
   toolbar alongside search/brand/channel filters. */

function ModePicker({ value, onChange }: { value: SalesMode; onChange: (m: SalesMode) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="Zeitraum"
      style={{
        display: 'inline-flex',
        gap: 4,
        padding: 4,
        borderRadius: 999,
        background: 'rgba(15, 23, 42, 0.05)',
      }}
    >
      {SALES_MODES.map((m) => {
        const active = m === value;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(m)}
            title={MODE_META[m].long}
            style={{
              all: 'unset',
              cursor: 'pointer',
              padding: '6px 12px',
              borderRadius: 999,
              background: active ? '#FFFFFF' : 'transparent',
              boxShadow: active ? '0 1px 2px rgba(15, 23, 42, 0.06)' : 'none',
              fontFamily: T.font.mono,
              fontSize: 11.5,
              fontWeight: 700,
              letterSpacing: '0.04em',
              color: active ? T.text.primary : T.text.subtle,
              transition: 'background 180ms ease, color 180ms ease, box-shadow 180ms ease',
            }}
            onMouseEnter={(e) => { if (!active) e.currentTarget.style.color = T.text.primary; }}
            onMouseLeave={(e) => { if (!active) e.currentTarget.style.color = T.text.subtle; }}
          >
            {MODE_META[m].short}
          </button>
        );
      })}
    </div>
  );
}


/* ─── Variant row field — small mono label above the value ──────── */

function VariantField({
  label,
  value,
  mono = false,
  primary = false,
  muted = false,
  align = 'left',
  trailing,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  primary?: boolean;
  muted?: boolean;
  align?: 'left' | 'right';
  trailing?: React.ReactNode;
}) {
  const valueColor = muted ? T.text.faint : (primary ? T.text.primary : T.text.secondary);
  return (
    <div style={{
      minWidth: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: 3,
      alignItems: align === 'right' ? 'flex-end' : 'flex-start',
    }}>
      <span style={{
        fontFamily: T.font.mono,
        fontSize: 9,
        fontWeight: 700,
        color: T.text.faint,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
      }}>
        {label}
      </span>
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        maxWidth: '100%',
      }}>
        {trailing}
        <span style={{
          fontFamily: mono ? T.font.mono : T.font.ui,
          fontSize: 13,
          fontWeight: 600,
          color: valueColor,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '-0.005em',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {value}
        </span>
      </span>
    </div>
  );
}


/* ─── Group isometry — actual carton shape per ASIN.
   Looks up real L×B×H from sku_dimensions; if found, the iso reflects
   the true format of the product. Falls back to a perPallet-driven
   generic ratio when dimensions aren't recorded for any variant. */

function GroupIso({ group, dim }: { group: LynneAsinGroup; dim?: SkuDimensionLookup | null }) {
  const level = classifyLynneGroup(group);
  const meta = LEVEL_META[level];

  let size: { l: number; w: number; h: number };
  const hasReal = dim && dim.lengthCm > 0 && dim.widthCm > 0 && dim.heightCm > 0;
  if (hasReal) {
    size = { l: dim!.lengthCm, w: dim!.widthCm, h: dim!.heightCm };
  } else {
    const perPallet = group.perPallet || 0;
    const h = perPallet === 0 ? 0.55
            : perPallet < 200 ? 0.60
            : perPallet < 400 ? 0.68
            : perPallet < 700 ? 0.74
            : 0.80;
    size = { l: 1, w: 0.85, h };
  }

  const dimText = hasReal
    ? `${dim!.lengthCm} × ${dim!.widthCm} × ${dim!.heightCm} cm`
    : 'Maße nicht in sku_dimensions hinterlegt';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 56,
        height: 48,
        flexShrink: 0,
        opacity: hasReal ? 1 : 0.85,
      }}
      title={`${meta.name} · ${dimText}`}
    >
      <BoxIso size={size} color={meta.color} px={48} edgeMode="prominent" />
    </div>
  );
}


/* ─── Inline mini-bar for LAGER ────────────────────────────────── */

function MiniBar({ value, max }: { value: number; max: number }) {
  if (max <= 0) return null;
  const pct = Math.max(0, Math.min(1, value / max));
  return (
    <span className="lt-bar-track" aria-hidden>
      <span className="lt-bar-fill" style={{ width: `${pct * 100}%` }} />
    </span>
  );
}


/* ─── Article card — one per ASIN group ─────────────────────────── */

function ArticleCard({
  group,
  isExpanded,
  onToggle,
  channelFilter,
  maxGrazStock,
  dim,
  fields,
  onEdit,
}: {
  group: LynneAsinGroup;
  isExpanded: boolean;
  onToggle: () => void;
  channelFilter: string;
  maxGrazStock: number;
  dim?: SkuDimensionLookup | null;
  fields: FieldFlags;
  onEdit?: (() => void) | null;
}) {
  const visibleVariants = channelFilter
    ? group.variants.filter((v) => v.channel === channelFilter)
    : group.variants;
  const channels = [...new Set(group.variants.map((v) => v.channel))];

  return (
    <PaperCard flat className="lt-card" style={{ gap: 0 }}>
      {/* Header row — clickable, toggles expansion */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'block',
        }}
      >
        <WhitePanel padding="10px 18px" style={{ background: 'transparent' }}>
          <div className="lt-grid">
            {/* Col 1 — isometric carton */}
            <GroupIso group={group} dim={dim} />

            {/* ASIN + variant-count badge */}
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              minWidth: 0,
            }}>
              <span style={{
                fontFamily: T.font.mono,
                fontSize: 14,
                fontWeight: 600,
                color: T.text.primary,
                letterSpacing: '-0.015em',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}>
                {group.asin}
              </span>
              {group.variantCount > 1 && (
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  height: 18,
                  padding: '0 7px',
                  borderRadius: 999,
                  background: 'rgba(15, 23, 42, 0.04)',
                  color: T.text.subtle,
                  fontFamily: T.font.mono,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  flexShrink: 0,
                }}>
                  ×{group.variantCount}
                </span>
              )}
            </div>

            {/* Beschreibung + Kennung (brand + channels) — snug inline,
                badge sits right next to the description text just like
                "×N" sits next to the ASIN. A flex-1 spacer afterwards
                eats remaining grid space so nothing drifts to the right.
                Maße/Gewicht erscheinen — sofern in sku_dimensions
                hinterlegt — als Mono-Zeile unter der Beschreibung. */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              minWidth: 0,
            }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                minWidth: 0,
              }}>
                <span
                  title={group.description}
                  style={{
                    minWidth: 0,
                    fontSize: 13,
                    fontWeight: 500,
                    color: T.text.primary,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {group.description || '—'}
                </span>
                {(fields.brand || fields.channels) && (
                  <div style={{
                    display: 'inline-flex',
                    gap: 6,
                    alignItems: 'center',
                    flexShrink: 0,
                  }}>
                    {fields.brand && <BrandBadge brand={group.brand} />}
                    {fields.channels && channels.map((ch) => (
                      <ChannelChip key={ch} channel={ch as LynneChannel} />
                    ))}
                  </div>
                )}
                <span style={{ flex: 1, minWidth: 0 }} />
              </div>
              {fields.dimensions && dim && dim.lengthCm > 0 && dim.widthCm > 0 && dim.heightCm > 0 && (
                <span
                  title={`Karton-Maße: ${dim.lengthCm} × ${dim.widthCm} × ${dim.heightCm} cm · ${dim.weightKg.toLocaleString('de-DE', { maximumFractionDigits: 2 })} kg`}
                  style={{
                    fontFamily: T.font.mono,
                    fontSize: 10.5,
                    fontWeight: 500,
                    color: T.text.faint,
                    letterSpacing: '0.02em',
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {dim.lengthCm} × {dim.widthCm} × {dim.heightCm} cm
                  {dim.weightKg > 0 && (
                    <>
                      <span style={{ margin: '0 6px', opacity: 0.5 }}>·</span>
                      {dim.weightKg.toLocaleString('de-DE', { maximumFractionDigits: 2 })} kg
                    </>
                  )}
                </span>
              )}
            </div>

            {/* Pro Pal. */}
            <span className="lt-col-num" style={{
              fontFamily: T.font.mono,
              fontSize: 14,
              fontWeight: 600,
              color: group.perPallet === 0 ? T.text.faint : T.text.primary,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '-0.012em',
            }}>
              {formatNum(group.perPallet)}
            </span>

            {/* Woche */}
            <span className="lt-col-num" style={{
              fontFamily: T.font.mono,
              fontSize: 14,
              fontWeight: 600,
              color: group.totalWeeklySales === 0 ? T.text.faint : T.text.primary,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '-0.012em',
            }}>
              {formatNum(group.totalWeeklySales)}
            </span>

            {/* Lager — value + mini bar */}
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 10,
            }}>
              <MiniBar value={group.totalGrazStock} max={maxGrazStock} />
              <span style={{
                fontFamily: T.font.mono,
                fontSize: 14,
                fontWeight: 600,
                color: group.totalGrazStock === 0 ? T.text.faint : T.text.primary,
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: '-0.012em',
                minWidth: 56,
                textAlign: 'right',
              }}>
                {formatNum(group.totalGrazStock)}
              </span>
            </span>

            {/* Last column: admin → pencil (opens edit drawer);
                non-admin → chevron (toggles expand via the row button).
                Both share the same circular slot so the layout doesn't
                shift between roles. The pencil swallows clicks so the
                row's onToggle doesn't also fire. */}
            {onEdit ? (
              <span
                role="button"
                tabIndex={0}
                aria-label="Artikel bearbeiten"
                title="Artikel bearbeiten"
                onClick={(e) => { e.stopPropagation(); e.preventDefault(); onEdit(); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation();
                    e.preventDefault();
                    onEdit();
                  }
                }}
                className="lt-card-edit-slot"
                style={{
                  display: 'inline-flex',
                  width: 24,
                  height: 24,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 999,
                  background: 'rgba(15, 23, 42, 0.04)',
                  color: T.text.subtle,
                  cursor: 'pointer',
                  transition: 'background 160ms ease, color 160ms ease',
                }}
              >
                <Pencil size={13} strokeWidth={2.2} />
              </span>
            ) : (
              <span aria-hidden style={{
                display: 'inline-flex',
                width: 24,
                height: 24,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 999,
                background: isExpanded ? T.accent.bg : 'rgba(15, 23, 42, 0.04)',
                color: isExpanded ? T.accent.text : T.text.subtle,
                transition: 'transform 220ms cubic-bezier(0.16,1,0.3,1), background 160ms ease, color 160ms ease',
                transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
              }}>
                <ChevronDown size={13} strokeWidth={2.4} />
              </span>
            )}
          </div>
        </WhitePanel>
      </button>

      {/* Variants list — same grid template as parent header.
          Columns align perfectly with the master ColumnHeader:
            ASIN slot   → Channel chip
            Artikel     → SKU
            Kennung     → EAN
            Pro Pal.    → (empty — perPallet is a parent-level metric)
            Woche       → variant.weeklySales
            Lager       → variant.grazStock
            Chevron     → (spacer) */}
      {isExpanded && visibleVariants.length > 0 && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: '6px 0 8px',
        }}>
          {visibleVariants.map((v) => (
            <div
              key={`${group.asin}__${v.sku}`}
              className="lt-grid"
              style={{
                background: '#FFFFFF',
                borderRadius: 16,
                padding: '10px 18px',
              }}
            >
              {/* Col 1 — iso spacer (empty, preserves alignment with parent) */}
              <span />

              {/* Col 2 — channel pill (under ASIN slot) — full PRIME/EV label
                  when the article is expanded, so each variant is obvious. */}
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
                alignItems: 'flex-start',
                minWidth: 0,
              }}>
                <span style={{
                  fontFamily: T.font.mono,
                  fontSize: 9,
                  fontWeight: 700,
                  color: T.text.faint,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                }}>
                  KANAL
                </span>
                <span className="lt-pill" data-channel={v.channel}>{v.channel}</span>
              </div>

              {/* Col 3 — SKU primary + EAN secondary stacked */}
              <div style={{
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
                alignItems: 'flex-start',
              }}>
                <span style={{
                  fontFamily: T.font.mono,
                  fontSize: 9,
                  fontWeight: 700,
                  color: T.text.faint,
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                }}>
                  SKU · EAN
                </span>
                <div style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 10,
                  maxWidth: '100%',
                  fontFamily: T.font.mono,
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  <span style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: T.text.primary,
                    letterSpacing: '-0.005em',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>
                    {v.sku}
                  </span>
                  <span style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: v.ean ? T.text.secondary : T.text.faint,
                    letterSpacing: '-0.005em',
                    whiteSpace: 'nowrap',
                  }}>
                    {v.ean || '—'}
                  </span>
                </div>
              </div>

              {/* Col 4 — Pro Pal. (empty, inherited from parent) */}
              <VariantField label="PRO PAL." align="right" value="—" muted />

              {/* Col 5 — Woche */}
              <VariantField
                label="WOCHE"
                align="right"
                mono
                value={formatNum(v.weeklySales)}
                muted={v.weeklySales === 0}
              />

              {/* Col 6 — Lager (with mini-bar) */}
              <VariantField
                label="LAGER"
                align="right"
                mono
                value={formatNum(v.grazStock)}
                muted={v.grazStock === 0}
                trailing={<MiniBar value={v.grazStock} max={maxGrazStock} />}
              />

              {/* Col 7 — chevron spacer */}
              <span />
            </div>
          ))}
        </div>
      )}

      {isExpanded && visibleVariants.length === 0 && (
        <div style={{
          padding: '14px 22px 18px',
          fontFamily: T.font.mono,
          fontSize: 11.5,
          color: T.text.faint,
          letterSpacing: '0.04em',
          textAlign: 'center',
        }}>
          Keine Variante für den Kanal-Filter «{channelFilter}»
        </div>
      )}
    </PaperCard>
  );
}


function EmptyState({ message, hint }: { message: string; hint?: React.ReactNode }) {
  return (
    <PaperCard>
      <WhitePanel padding="60px 28px">
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div style={{
            display: 'inline-flex',
            width: 46, height: 46,
            alignItems: 'center', justifyContent: 'center',
            borderRadius: 999,
            background: T.bg.surface2,
            color: T.text.faint,
          }}>
            <Package size={20} strokeWidth={1.6} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, color: T.text.primary }}>
            {message}
          </div>
          {hint}
        </div>
      </WhitePanel>
    </PaperCard>
  );
}


function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <PaperCard>
      <WhitePanel padding="48px 28px">
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div style={{
            display: 'inline-flex',
            width: 46, height: 46,
            alignItems: 'center', justifyContent: 'center',
            borderRadius: 999,
            background: T.status.danger.bg,
            color: T.status.danger.text,
          }}>
            <AlertTriangle size={20} strokeWidth={1.6} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, color: T.text.primary }}>
            Katalog konnte nicht geladen werden
          </div>
          <button
            type="button"
            onClick={onRetry}
            style={{
              all: 'unset',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              padding: '8px 16px',
              background: '#FFFFFF',
              border: `1px solid ${T.border.primary}`,
              borderRadius: 999,
              fontFamily: T.font.ui,
              fontSize: 12.5,
              fontWeight: 600,
              color: T.text.primary,
            }}
          >
            <RefreshCw size={13} strokeWidth={2} /> Erneut versuchen
          </button>
        </div>
      </WhitePanel>
    </PaperCard>
  );
}

function LoadingSkeleton() {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <PaperCard key={i} flat style={{ gap: 0 }}>
          <WhitePanel padding="18px 22px">
            <div className="lt-skel-row" style={{ height: 64, borderBottom: 'none' }} />
          </WhitePanel>
        </PaperCard>
      ))}
    </>
  );
}


/* ─── Edit drawer — admin-only ASIN editor ────────────────────────
   Modal overlay (single dialog, not a slide-in) following the Beta
   PaperCard / WhitePanel visual language. One drawer covers three
   intents:
     • mode='edit'   — pre-fills from `group`, supports rename, +SKU,
                       delete, asin-rename
     • mode='create' — blank form, primes a single fresh SKU row
   Saves call sequential admin endpoints — frontend keeps a `draft` and
   diffs against `original` to decide which mutations to issue. */

const ALL_CHANNELS: LynneChannel[] = ['PRIME', 'EV', 'EV-PRIME', 'OTHER'];

interface VariantDraft {
  rowId: string | null;     // null = newly added, not yet POSTed
  sku: string;
  ean: string;
  channel: LynneChannel;
  weeklySales: number;
  grazStock: number;
  _deleted: boolean;
}

interface DimDraft {
  id: number | null;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  weightKg: string;
}

interface AsinDraft {
  asin: string;
  description: string;
  brand: string;
  perPallet: number;
  variants: VariantDraft[];
  dim: DimDraft;
}

function emptyDim(): DimDraft {
  return { id: null, lengthCm: '', widthCm: '', heightCm: '', weightKg: '' };
}

function emptyVariant(): VariantDraft {
  return {
    rowId: null, sku: '', ean: '', channel: 'PRIME',
    weeklySales: 0, grazStock: 0, _deleted: false,
  };
}

function draftFromGroup(group: LynneAsinGroup, dim: SkuDimensionLookup | null): AsinDraft {
  return {
    asin: group.asin,
    description: group.description,
    brand: group.brand,
    perPallet: group.perPallet,
    variants: group.variants.map((v) => ({
      rowId: `${group.asin}__${v.sku}`,
      sku: v.sku,
      ean: v.ean ?? '',
      channel: v.channel,
      weeklySales: v.weeklySales,
      grazStock: v.grazStock,
      _deleted: false,
    })),
    dim: dim
      ? {
          id: dim.id,
          lengthCm: String(dim.lengthCm),
          widthCm: String(dim.widthCm),
          heightCm: String(dim.heightCm),
          weightKg: String(dim.weightKg),
        }
      : emptyDim(),
  };
}

function emptyDraft(): AsinDraft {
  return {
    asin: '',
    description: '',
    brand: '',
    perPallet: 0,
    variants: [emptyVariant()],
    dim: emptyDim(),
  };
}

function FormSection({ eyebrow, children }: { eyebrow: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{
        fontFamily: T.font.mono,
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: T.text.faint,
      }}>
        {eyebrow}
      </div>
      <div style={{
        background: '#FFFFFF',
        borderRadius: 18,
        padding: '16px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}>
        {children}
      </div>
    </div>
  );
}

function FormLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontFamily: T.font.mono,
      fontSize: 9.5,
      fontWeight: 700,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: T.text.faint,
    }}>
      {children}
    </span>
  );
}

function FormInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  mono = false,
  disabled = false,
}: {
  value: string | number;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'number';
  mono?: boolean;
  disabled?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      autoComplete="off"
      style={{
        all: 'unset',
        boxSizing: 'border-box',
        width: '100%',
        padding: '8px 12px',
        background: disabled ? 'rgba(15,23,42,0.03)' : '#F4F5F7',
        borderRadius: 10,
        fontFamily: mono ? T.font.mono : T.font.ui,
        fontSize: 13,
        color: disabled ? T.text.faint : T.text.primary,
        cursor: disabled ? 'not-allowed' : 'text',
        fontVariantNumeric: type === 'number' ? 'tabular-nums' : 'normal',
      }}
    />
  );
}

/* Read-only synced-value cell. Used for Verkauf/Wo. and Lager Graz —
   those columns are populated from Amazon Seller Central / JTL on the
   future sync layer, so manual edits would be clobbered on next pull. */
function SyncedNumber({ value, title }: { value: number; title?: string }) {
  return (
    <div
      title={title}
      style={{
        boxSizing: 'border-box',
        width: '100%',
        padding: '8px 12px',
        background: 'rgba(15, 23, 42, 0.03)',
        borderRadius: 10,
        fontFamily: T.font.mono,
        fontSize: 13,
        color: T.text.faint,
        fontVariantNumeric: 'tabular-nums',
        cursor: 'help',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 6,
      }}
    >
      <span aria-hidden style={{
        width: 5, height: 5, borderRadius: 999,
        background: 'rgba(15, 23, 42, 0.18)',
      }} />
      <span>{value.toLocaleString('de-DE')}</span>
    </div>
  );
}

function PrimaryButton({
  onClick, disabled, children,
}: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        all: 'unset',
        cursor: disabled ? 'not-allowed' : 'pointer',
        padding: '10px 18px',
        background: disabled ? 'rgba(15,23,42,0.1)' : 'var(--accent)',
        color: disabled ? T.text.faint : '#FFFFFF',
        borderRadius: 999,
        fontFamily: T.font.ui,
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: '-0.005em',
        transition: 'background 160ms ease',
      }}
    >
      {children}
    </button>
  );
}

function GhostButton({
  onClick, children,
}: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: 'unset',
        cursor: 'pointer',
        padding: '10px 18px',
        background: 'transparent',
        color: T.text.subtle,
        borderRadius: 999,
        fontFamily: T.font.ui,
        fontSize: 13,
        fontWeight: 600,
      }}
    >
      {children}
    </button>
  );
}

function EditAsinDrawer({
  mode,
  group,
  initialDim,
  onClose,
  onSaved,
}: {
  mode: 'edit' | 'create';
  group: LynneAsinGroup | null;
  initialDim: SkuDimensionLookup | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const confirm = useConfirm();
  const [draft, setDraft] = useState<AsinDraft>(() =>
    mode === 'edit' && group ? draftFromGroup(group, initialDim) : emptyDraft()
  );
  const [original] = useState<AsinDraft>(() =>
    mode === 'edit' && group ? draftFromGroup(group, initialDim) : emptyDraft()
  );
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // Close on Escape, with unsaved-changes guard.
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(original), [draft, original]);
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (dirty) {
        const ok = await confirm({
          message: 'Ungespeicherte Änderungen verwerfen?',
          confirmLabel: 'Verwerfen',
          cancelLabel: 'Weiter bearbeiten',
          danger: true,
        });
        if (!ok) return;
      }
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dirty, onClose, confirm]);

  const updateVariant = (idx: number, patch: Partial<VariantDraft>) =>
    setDraft((d) => ({
      ...d,
      variants: d.variants.map((v, i) => (i === idx ? { ...v, ...patch } : v)),
    }));
  const addVariant = () =>
    setDraft((d) => ({ ...d, variants: [...d.variants, emptyVariant()] }));
  const removeVariantAt = async (idx: number) => {
    const v = draft.variants[idx];
    if (v.rowId == null) {
      // unsaved row — drop immediately, no confirm
      setDraft((d) => ({ ...d, variants: d.variants.filter((_, i) => i !== idx) }));
      return;
    }
    const ok = await confirm({
      message: `Variante ${v.sku || '(ohne SKU)'} entfernen?`,
      detail: 'Wird beim Speichern endgültig aus der Datenbank gelöscht.',
      confirmLabel: 'Entfernen',
      danger: true,
    });
    if (!ok) return;
    updateVariant(idx, { _deleted: true });
  };
  const restoreVariantAt = (idx: number) => updateVariant(idx, { _deleted: false });

  const validate = (): string[] => {
    const errs: string[] = [];
    if (!draft.asin.trim()) errs.push('ASIN darf nicht leer sein');
    if (draft.asin.length > 20) errs.push('ASIN max. 20 Zeichen');
    if (draft.brand.length > 80) errs.push('Marke max. 80 Zeichen');
    if (draft.perPallet < 0) errs.push('Pro Pallet darf nicht negativ sein');
    const liveVariants = draft.variants.filter((v) => !v._deleted);
    if (liveVariants.length === 0) errs.push('Mindestens eine Variante erforderlich');
    const skus = new Set<string>();
    for (const v of liveVariants) {
      if (!v.sku.trim()) errs.push('Jede Variante braucht eine SKU');
      else if (skus.has(v.sku)) errs.push(`SKU "${v.sku}" doppelt`);
      else skus.add(v.sku);
      if (v.ean && !/^\d{8,14}$/.test(v.ean)) errs.push(`EAN "${v.ean}" muss 8–14 Ziffern haben`);
      // weeklySales / grazStock are synced from Amazon SC / JTL, not user-editable
    }
    const d = draft.dim;
    const dimVals = [d.lengthCm, d.widthCm, d.heightCm, d.weightKg];
    const anyDim = dimVals.some((x) => x.trim() !== '');
    if (anyDim) {
      const parsed = dimVals.map((x) => Number(x.replace(',', '.')));
      if (parsed.some((n) => !Number.isFinite(n) || n <= 0)) {
        errs.push('Maße: alle vier Felder müssen positive Zahlen sein');
      }
    }
    return errs;
  };

  const handleSave = async () => {
    const errs = validate();
    setErrors(errs);
    if (errs.length > 0) return;

    setSaving(true);
    try {
      const asin = draft.asin.trim();
      const liveVariants = draft.variants.filter((v) => !v._deleted);

      if (mode === 'create') {
        // POST every variant — one of them carries description/brand/perPallet
        // (backend takes them from each row; we keep them consistent client-side).
        for (let i = 0; i < liveVariants.length; i++) {
          const v = liveVariants[i];
          await adminCreateLynneProduct({
            asin,
            sku: v.sku.trim(),
            channel: v.channel,
            ean: v.ean.trim() || null,
            description: draft.description,
            brand: draft.brand,
            perPallet: draft.perPallet,
            weeklySales: v.weeklySales,
            grazStock: v.grazStock,
          });
        }
      } else {
        // edit mode
        // 1) ASIN rename if changed
        if (asin !== original.asin) {
          await adminRenameLynneAsin(original.asin, { newAsin: asin });
        }

        // 2) ASIN-level batch update if description / brand / perPallet changed
        if (
          draft.description !== original.description ||
          draft.brand !== original.brand ||
          draft.perPallet !== original.perPallet
        ) {
          await adminPatchLynneAsin(asin, {
            description: draft.description,
            brand: draft.brand,
            perPallet: draft.perPallet,
          });
        }

        // 3) Variants diff
        // delete first (PG can rebuild ids), then patch, then create
        const originalById = new Map(original.variants.map((v) => [v.rowId, v] as const));
        for (const v of draft.variants) {
          if (v.rowId && v._deleted) {
            // Translate id from the (possibly old) ASIN to the current ASIN if renamed
            const liveId = asin === original.asin ? v.rowId : `${asin}__${v.sku}`;
            await adminDeleteLynneProduct(liveId);
          }
        }
        for (const v of draft.variants) {
          if (v.rowId == null || v._deleted) continue;
          const orig = originalById.get(v.rowId);
          if (!orig) continue;
          const patch: LynneVariantPatch = {};
          if (v.sku !== orig.sku) patch.sku = v.sku.trim();
          if (v.channel !== orig.channel) patch.channel = v.channel;
          if ((v.ean || null) !== (orig.ean || null)) patch.ean = v.ean.trim() || null;
          if (v.weeklySales !== orig.weeklySales) patch.weeklySales = v.weeklySales;
          if (v.grazStock !== orig.grazStock) patch.grazStock = v.grazStock;
          if (Object.keys(patch).length > 0) {
            const liveId = asin === original.asin ? v.rowId : `${asin}__${orig.sku}`;
            await adminPatchLynneProduct(liveId, patch);
          }
        }
        for (const v of draft.variants) {
          if (v.rowId == null && !v._deleted) {
            await adminCreateLynneProduct({
              asin,
              sku: v.sku.trim(),
              channel: v.channel,
              ean: v.ean.trim() || null,
              description: draft.description,
              brand: draft.brand,
              perPallet: draft.perPallet,
              weeklySales: v.weeklySales,
              grazStock: v.grazStock,
            });
          }
        }
      }

      // 4) Dimensions
      const dimEdited =
        draft.dim.lengthCm !== original.dim.lengthCm ||
        draft.dim.widthCm !== original.dim.widthCm ||
        draft.dim.heightCm !== original.dim.heightCm ||
        draft.dim.weightKg !== original.dim.weightKg;
      const hasDimValues = [draft.dim.lengthCm, draft.dim.widthCm, draft.dim.heightCm, draft.dim.weightKg]
        .every((x) => x.trim() !== '');
      if (dimEdited && hasDimValues) {
        const skusForKey = draft.variants
          .filter((v) => !v._deleted && v.sku.trim())
          .map((v) => v.sku.trim());
        const eansForKey = draft.variants
          .filter((v) => !v._deleted && v.ean.trim())
          .map((v) => v.ean.trim());
        const payload = {
          fnskus: [],
          skus: skusForKey,
          eans: eansForKey,
          title: draft.description || null,
          lengthCm: Number(draft.dim.lengthCm.replace(',', '.')),
          widthCm: Number(draft.dim.widthCm.replace(',', '.')),
          heightCm: Number(draft.dim.heightCm.replace(',', '.')),
          weightKg: Number(draft.dim.weightKg.replace(',', '.')),
        };
        if (draft.dim.id != null) {
          await adminUpdateSkuDimension(draft.dim.id, payload);
        } else {
          await adminCreateSkuDimension(payload);
        }
      }

      onSaved();
      onClose();
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message ?? 'Speichern fehlgeschlagen';
      setErrors([msg]);
    } finally {
      setSaving(false);
    }
  };

  const handleCloseClick = async () => {
    if (dirty) {
      const ok = await confirm({
        message: 'Ungespeicherte Änderungen verwerfen?',
        confirmLabel: 'Verwerfen',
        cancelLabel: 'Weiter bearbeiten',
        danger: true,
      });
      if (!ok) return;
    }
    onClose();
  };

  const titleText = mode === 'create' ? 'Neuer Artikel' : `Artikel bearbeiten · ${original.asin}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        background: 'rgba(15, 23, 42, 0.32)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        animation: 'lt-rise-local 200ms ease-out',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) void handleCloseClick(); }}
    >
      <div style={{
        width: '100%',
        maxWidth: 760,
        maxHeight: '90vh',
        overflow: 'auto',
        background: '#F4F5F7',
        border: '2px solid #FFFFFF',
        borderRadius: 28,
        boxShadow: '0 24px 80px rgba(15, 23, 42, 0.18)',
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 6px 0',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Eyebrow>{mode === 'create' ? 'Erstellen' : 'Bearbeiten'}</Eyebrow>
            <h2 style={{
              margin: 0,
              fontFamily: T.font.ui,
              fontSize: 20,
              fontWeight: 600,
              color: T.text.primary,
              letterSpacing: '-0.02em',
            }}>
              {titleText}
            </h2>
          </div>
          <button
            type="button"
            onClick={handleCloseClick}
            aria-label="Schließen"
            style={{
              all: 'unset',
              cursor: 'pointer',
              width: 32, height: 32,
              borderRadius: 999,
              display: 'inline-flex',
              alignItems: 'center', justifyContent: 'center',
              color: T.text.subtle,
              background: '#FFFFFF',
            }}
          >
            <XIcon size={14} strokeWidth={2.2} />
          </button>
        </div>

        {errors.length > 0 && (
          <div style={{
            padding: '10px 14px',
            background: 'color-mix(in srgb, #DC2626 12%, transparent)',
            color: '#B91C1C',
            borderRadius: 14,
            fontFamily: T.font.ui,
            fontSize: 12.5,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}>
            {errors.map((e, i) => <span key={i}>• {e}</span>)}
          </div>
        )}

        {/* Stammdaten */}
        <FormSection eyebrow="Stammdaten">
          <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 10, alignItems: 'center' }}>
            <FormLabel>ASIN</FormLabel>
            <FormInput
              value={draft.asin}
              onChange={(v) => setDraft((d) => ({ ...d, asin: v.toUpperCase() }))}
              mono
              placeholder="B0XXXXXXXX"
            />
            <FormLabel>Beschreibung</FormLabel>
            <FormInput
              value={draft.description}
              onChange={(v) => setDraft((d) => ({ ...d, description: v }))}
              placeholder="z. B. Thermorolle 57×30m"
            />
            <FormLabel>Marke</FormLabel>
            <FormInput
              value={draft.brand}
              onChange={(v) => setDraft((d) => ({ ...d, brand: v }))}
              placeholder="LYNNE / TK / …"
            />
            <FormLabel>Pro Pallet</FormLabel>
            <FormInput
              type="number"
              value={draft.perPallet}
              onChange={(v) => setDraft((d) => ({ ...d, perPallet: Math.max(0, Number(v) || 0) }))}
              mono
            />
          </div>
        </FormSection>

        {/* Maße */}
        <FormSection eyebrow="Maße & Gewicht">
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 10,
          }}>
            {(['lengthCm', 'widthCm', 'heightCm', 'weightKg'] as const).map((k) => (
              <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <FormLabel>
                  {k === 'lengthCm' ? 'Länge (cm)'
                    : k === 'widthCm' ? 'Breite (cm)'
                    : k === 'heightCm' ? 'Höhe (cm)'
                    : 'Gewicht (kg)'}
                </FormLabel>
                <FormInput
                  type="number"
                  mono
                  value={draft.dim[k]}
                  onChange={(v) => setDraft((d) => ({ ...d, dim: { ...d.dim, [k]: v } }))}
                  placeholder="0"
                />
              </div>
            ))}
          </div>
          {!draft.dim.id && draft.dim.lengthCm === '' && (
            <div style={{
              fontFamily: T.font.mono,
              fontSize: 10.5,
              color: T.text.faint,
              letterSpacing: '0.04em',
            }}>
              Noch nicht in sku_dimensions hinterlegt — wird beim Speichern erstellt, sobald alle vier Felder ausgefüllt sind.
            </div>
          )}
        </FormSection>

        {/* Varianten */}
        <FormSection eyebrow={`Varianten · ${draft.variants.filter((v) => !v._deleted).length}`}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1.4fr 1.4fr 0.9fr 0.7fr 0.7fr 32px',
            gap: 8,
            paddingBottom: 4,
          }}>
            {['SKU', 'EAN', 'Kanal', 'Verkauf/Wo.', 'Lager Graz', ''].map((h, i) => (
              <div key={i} style={{
                fontFamily: T.font.mono,
                fontSize: 9,
                fontWeight: 700,
                color: T.text.faint,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                textAlign: i >= 3 && i <= 4 ? 'right' : 'left',
              }}>
                {h}
              </div>
            ))}
          </div>
          {draft.variants.map((v, idx) => {
            const isDeleted = v._deleted;
            return (
              <div key={idx} style={{
                display: 'grid',
                gridTemplateColumns: '1.4fr 1.4fr 0.9fr 0.7fr 0.7fr 32px',
                gap: 8,
                alignItems: 'center',
                opacity: isDeleted ? 0.45 : 1,
                textDecoration: isDeleted ? 'line-through' : 'none',
              }}>
                <FormInput
                  mono
                  disabled={isDeleted}
                  value={v.sku}
                  onChange={(val) => updateVariant(idx, { sku: val })}
                  placeholder="SKU"
                />
                <FormInput
                  mono
                  disabled={isDeleted}
                  value={v.ean}
                  onChange={(val) => updateVariant(idx, { ean: val })}
                  placeholder="EAN"
                />
                <div style={{ position: 'relative' }}>
                  <select
                    disabled={isDeleted}
                    value={v.channel}
                    onChange={(e) => updateVariant(idx, { channel: e.target.value as LynneChannel })}
                    style={{
                      all: 'unset',
                      boxSizing: 'border-box',
                      width: '100%',
                      padding: '8px 12px',
                      background: isDeleted ? 'rgba(15,23,42,0.03)' : '#F4F5F7',
                      borderRadius: 10,
                      fontFamily: T.font.mono,
                      fontSize: 12,
                      cursor: isDeleted ? 'not-allowed' : 'pointer',
                      color: T.text.primary,
                    }}
                  >
                    {ALL_CHANNELS.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                {/* Verkauf/Wo. & Lager Graz — read-only display. These come
                    from Amazon Seller Central (sales) and JTL (warehouse
                    stock); editing them manually would be overwritten on
                    the next sync. Shown so admins can see the current
                    value while editing description/brand/perPallet. */}
                <SyncedNumber value={v.weeklySales} title="Wird automatisch aus Amazon Seller Central synchronisiert" />
                <SyncedNumber value={v.grazStock} title="Wird automatisch aus JTL synchronisiert" />
                {isDeleted ? (
                  <button
                    type="button"
                    onClick={() => restoreVariantAt(idx)}
                    title="Wiederherstellen"
                    style={{
                      all: 'unset', cursor: 'pointer',
                      width: 28, height: 28,
                      borderRadius: 999,
                      display: 'inline-flex',
                      alignItems: 'center', justifyContent: 'center',
                      color: T.text.subtle,
                    }}
                  >
                    <RefreshCw size={13} strokeWidth={2} />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void removeVariantAt(idx)}
                    title="Variante entfernen"
                    style={{
                      all: 'unset', cursor: 'pointer',
                      width: 28, height: 28,
                      borderRadius: 999,
                      display: 'inline-flex',
                      alignItems: 'center', justifyContent: 'center',
                      color: T.text.faint,
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = '#DC2626'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = T.text.faint; }}
                  >
                    <Trash2 size={13} strokeWidth={2} />
                  </button>
                )}
              </div>
            );
          })}
          <button
            type="button"
            onClick={addVariant}
            style={{
              all: 'unset',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              padding: '8px 14px',
              color: 'var(--accent)',
              fontFamily: T.font.ui,
              fontSize: 12.5,
              fontWeight: 600,
              alignSelf: 'flex-start',
            }}
          >
            <Plus size={13} strokeWidth={2.4} />
            <span>SKU hinzufügen</span>
          </button>
          <div style={{
            fontFamily: T.font.mono,
            fontSize: 10,
            color: T.text.faint,
            letterSpacing: '0.04em',
            lineHeight: 1.5,
          }}>
            Verkauf/Wo. · Lager Graz — Sync aus Amazon Seller Central und JTL,
            nicht manuell editierbar
          </div>
        </FormSection>

        {/* Footer */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 8,
          padding: '4px 6px',
        }}>
          <GhostButton onClick={handleCloseClick}>Abbrechen</GhostButton>
          <PrimaryButton onClick={() => void handleSave()} disabled={saving || !dirty}>
            {saving ? 'Speichert …' : (mode === 'create' ? 'Anlegen' : 'Speichern')}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}


/* ─── Screen ─────────────────────────────────────────────────────── */

export default function LynneTable() {
  const [globalFilter, setGlobalFilter] = useState('');
  const [brand, setBrand] = useState<string>('');
  const [channel, setChannel] = useState<string>('');
  const DEFAULT_SORT: SortState = { key: 'lager', dir: 'desc' };
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [view, setView] = useState<View>(() => {
    try {
      const saved = localStorage.getItem('marathon.lynne.view.v1');
      if (saved === 'katalog' || saved === 'verkaeufe') return saved;
    } catch { /* ignore */ }
    return 'katalog';
  });
  useEffect(() => {
    try { localStorage.setItem('marathon.lynne.view.v1', view); } catch { /* ignore */ }
  }, [view]);
  const [salesMode, setSalesMode] = useState<SalesMode>(() => {
    try {
      const saved = localStorage.getItem('marathon.lynne.salesMode.v1');
      if (saved && (SALES_MODES as readonly string[]).includes(saved)) {
        return saved as SalesMode;
      }
    } catch { /* ignore */ }
    return '4w';
  });
  useEffect(() => {
    try { localStorage.setItem('marathon.lynne.salesMode.v1', salesMode); } catch { /* ignore */ }
  }, [salesMode]);

  const [fields, setFields] = useState<FieldFlags>(() => {
    try {
      const raw = localStorage.getItem(FIELDS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return { ...FIELDS_DEFAULT, ...parsed };
        }
      }
    } catch { /* ignore */ }
    return FIELDS_DEFAULT;
  });
  useEffect(() => {
    try { localStorage.setItem(FIELDS_STORAGE_KEY, JSON.stringify(fields)); } catch { /* ignore */ }
  }, [fields]);

  const [bestellungOpen, setBestellungOpen] = useState<boolean>(false);

  /* Admin-only edit state. `editing` carries either { mode: 'edit', asin }
     or { mode: 'create' } when the drawer is open; null when closed. */
  const me = useMe().data;
  const isAdmin = me?.role === 'admin';
  const [editing, setEditing] = useState<
    | { mode: 'edit'; asin: string }
    | { mode: 'create' }
    | null
  >(null);

  /* 3-state cycle on a column header:
       1st click → column's natural direction (desc for numbers, asc for text)
       2nd click → flipped direction
       3rd click → reset to the global default sort (Lager desc) */
  const handleSort = (key: SortKey) => {
    setSort((prev) => {
      if (prev.key !== key) {
        return { key, dir: SORT_DEFAULTS[key] };
      }
      const naturalDir = SORT_DEFAULTS[key];
      if (prev.dir === naturalDir) {
        return { key, dir: naturalDir === 'desc' ? 'asc' : 'desc' };
      }
      return DEFAULT_SORT;
    });
  };

  const { data, isLoading, isError, refetch } = useQuery<LynneCatalog>({
    queryKey: ['lynne-products'],
    queryFn: getLynneProducts,
    staleTime: 30 * 60_000,
  });

  const allItems = data?.items ?? [];

  /* Batch-lookup carton dimensions for every variant we know about,
     then index by ASIN. The waterfall picks the first variant in the
     group that has any hit (SKU first, then EAN) — physically all
     variants under one ASIN share the same packaging. */
  const dimQueryKeys = useMemo(() => {
    const set = new Set<string>();
    for (const g of allItems) {
      for (const v of g.variants) {
        if (v.sku) set.add(v.sku);
        if (v.ean) set.add(v.ean);
      }
    }
    return [...set].sort();
  }, [allItems]);

  const dimQuery = useQuery({
    queryKey: ['lynne-dims', dimQueryKeys.length],
    queryFn: () => lookupSkuDimensions(dimQueryKeys),
    enabled: dimQueryKeys.length > 0,
    staleTime: 30 * 60_000,
  });

  const dimsByAsin = useMemo(() => {
    const map = new Map<string, SkuDimensionLookup>();
    const lookups = dimQuery.data?.lookups ?? {};
    for (const g of allItems) {
      for (const v of g.variants) {
        const hit = (v.sku && lookups[v.sku]) || (v.ean && lookups[v.ean]);
        if (hit) { map.set(g.asin, hit); break; }
      }
    }
    return map;
  }, [allItems, dimQuery.data]);

  const brands = useMemo(() => {
    const set = new Set<string>();
    for (const g of allItems) if (g.brand) set.add(g.brand);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [allItems]);

  /* ── Filter pipeline: facets → text search ───────────────────── */
  const filtered = useMemo(() => {
    const needle = globalFilter.trim().toLowerCase();
    return allItems.filter((g) => {
      if (brand && g.brand !== brand) return false;
      if (channel && !g.variants.some((v) => v.channel === channel)) return false;
      if (!needle) return true;
      if (g.asin.toLowerCase().includes(needle)) return true;
      if (g.description.toLowerCase().includes(needle)) return true;
      if (g.brand.toLowerCase().includes(needle)) return true;
      for (const v of g.variants) {
        if (v.sku.toLowerCase().includes(needle)) return true;
        if (v.ean && v.ean.toLowerCase().includes(needle)) return true;
      }
      return false;
    });
  }, [allItems, globalFilter, brand, channel]);

  /* ── Sort ─────────────────────────────────────────────────────── */
  const sorted = useMemo(() => {
    const arr = [...filtered];
    const mult = sort.dir === 'desc' ? -1 : 1;
    const numeric = (n: number) => (Number.isFinite(n) ? n : 0);
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sort.key) {
        case 'asin':
          // Sort the ASIN column by variant count (number of SKUs under
          // the ASIN), not by ASIN alphabet — that's the metric a worker
          // actually cares about: which catalog entry has the most SKUs.
          cmp = numeric(a.variantCount) - numeric(b.variantCount);
          break;
        case 'description':
          cmp = a.description.localeCompare(b.description);
          break;
        case 'kennung':
          cmp = (a.brand || '').localeCompare(b.brand || '');
          break;
        case 'perPallet':
          cmp = numeric(a.perPallet) - numeric(b.perPallet);
          break;
        case 'woche':
          cmp = numeric(a.totalWeeklySales) - numeric(b.totalWeeklySales);
          break;
        case 'lager':
          cmp = numeric(a.totalGrazStock) - numeric(b.totalGrazStock);
          break;
      }
      if (cmp !== 0) return cmp * mult;
      return a.asin.localeCompare(b.asin);
    });
    return arr;
  }, [filtered, sort]);

  /* Max Lager used to scale the inline mini-bars on each card. */
  const maxGrazStock = useMemo(() => {
    let m = 0;
    for (const g of filtered) if (g.totalGrazStock > m) m = g.totalGrazStock;
    return m;
  }, [filtered]);

  /* ─── Verkäufe view data layer ──────────────────────────────────
     Flat list of all variants with a 4-week sales series. W1 is real
     (lynne_products.weekly_sales for the SKU's group), W2-W4 are
     mocked ±15% via a seeded RNG keyed by SKU — values stay stable
     across refreshes. */
  const dimsBySku = useMemo(() => {
    const map = new Map<string, SkuDimensionLookup>();
    const lookups = dimQuery.data?.lookups ?? {};
    for (const g of allItems) {
      for (const v of g.variants) {
        const hit = (v.sku && lookups[v.sku]) || (v.ean && lookups[v.ean]);
        if (hit) map.set(v.sku, hit);
      }
    }
    return map;
  }, [allItems, dimQuery.data]);

  const allVariants: VariantSalesRow[] = useMemo(() => {
    const rows: VariantSalesRow[] = [];
    for (const g of allItems) {
      for (const v of g.variants) {
        const fba = generateFbaPipeline(v.sku, v.weeklySales);
        rows.push({
          asin: g.asin,
          sku: v.sku,
          ean: v.ean,
          channel: v.channel,
          brand: g.brand,
          description: g.description,
          perPallet: g.perPallet,
          weeklyAnchor: v.weeklySales,
          heuteSales: generateHeuteSales(v.sku, v.weeklySales),
          fbaAvailable: fba.available,
          fbaIncoming: fba.incoming,
          series: generateSeries(v.sku, v.weeklySales, salesMode),
        });
      }
    }
    return rows;
  }, [allItems, salesMode]);

  const VERKAUFE_DEFAULT_SORT: VerkaufeSortState = { key: 'latest', dir: 'desc' };
  const VERKAUFE_NATURAL_DIR: Record<VerkaufeSortKey, SortDir> = {
    asin: 'asc', description: 'asc', heute: 'desc', fba: 'desc', order: 'desc', latest: 'desc', delta: 'desc',
  };
  const [verkaufSort, setVerkaufSort] = useState<VerkaufeSortState>(VERKAUFE_DEFAULT_SORT);
  const handleVerkaufeSort = (key: VerkaufeSortKey) => {
    setVerkaufSort((prev) => {
      if (prev.key !== key) return { key, dir: VERKAUFE_NATURAL_DIR[key] };
      const natural = VERKAUFE_NATURAL_DIR[key];
      if (prev.dir === natural) return { key, dir: natural === 'desc' ? 'asc' : 'desc' };
      return VERKAUFE_DEFAULT_SORT;
    });
  };

  const filteredVariants = useMemo(() => {
    const needle = globalFilter.trim().toLowerCase();
    return allVariants.filter((v) => {
      if (brand && v.brand !== brand) return false;
      if (channel && v.channel !== channel) return false;
      if (!needle) return true;
      if (v.sku.toLowerCase().includes(needle)) return true;
      if (v.asin.toLowerCase().includes(needle)) return true;
      if (v.ean && v.ean.toLowerCase().includes(needle)) return true;
      if (v.description.toLowerCase().includes(needle)) return true;
      if (v.brand.toLowerCase().includes(needle)) return true;
      return false;
    });
  }, [allVariants, globalFilter, brand, channel]);

  const sortedVariants = useMemo(() => {
    const arr = [...filteredVariants];
    const mult = verkaufSort.dir === 'desc' ? -1 : 1;
    const num = (n: number) => (Number.isFinite(n) ? n : 0);
    arr.sort((a, b) => {
      let cmp = 0;
      // Delta-% across the full mode window (newest vs oldest). Matches
      // the chip + chart palette logic. oldest=0 sorts as +∞ growth so
      // "new movers" with no baseline land at the top in desc order.
      const deltaRatio = (r: VariantSalesRow) => {
        const cur = r.series[0] ?? 0;
        const old = r.series[r.series.length - 1] ?? 0;
        if (old <= 0) return cur > 0 ? 1e9 : 0;
        return (cur - old) / old;
      };
      // Auffüllen = maxStock − (verfügbar + pipeline). Desc default
      // surfaces the rows that need the largest replenishment first.
      const fbaDelta = (r: VariantSalesRow) => num(computeAuffuellen(r));
      // Order trigger rank: urgent (3) > ready (2) > wait (1) > ok (0).
      // Sort first by state-rank, then by qty so two READY rows still
      // order by absolute order size.
      const STATE_RANK: Record<OrderState, number> = { urgent: 3, ready: 2, wait: 1, ok: 0 };
      const orderScore = (r: VariantSalesRow) => {
        const t = computeOrderTrigger(r);
        return STATE_RANK[t.state] * 1e9 + t.qty;
      };
      switch (verkaufSort.key) {
        case 'asin':        cmp = a.asin.localeCompare(b.asin); break;
        case 'description': cmp = a.description.localeCompare(b.description); break;
        case 'heute':       cmp = num(a.heuteSales) - num(b.heuteSales); break;
        case 'fba':         cmp = fbaDelta(a) - fbaDelta(b); break;
        case 'order':       cmp = orderScore(a) - orderScore(b); break;
        case 'latest':      cmp = num(a.series[0]) - num(b.series[0]); break;
        case 'delta':       cmp = deltaRatio(a) - deltaRatio(b); break;
      }
      if (cmp !== 0) return cmp * mult;
      return a.sku.localeCompare(b.sku);
    });
    return arr;
  }, [filteredVariants, verkaufSort]);

  /* KPI summary for Verkäufe header — sums each period (week/month) of
     the active mode across filtered variants. Reacts to brand/channel/
     search filters so the KPI always reflects what the user sees. */
  const verkaufeKpi = useMemo(() => {
    const pointCount = MODE_META[salesMode].pointCount;
    const perPeriod = new Array<number>(pointCount).fill(0);
    for (const v of filteredVariants) {
      for (let i = 0; i < pointCount; i++) perPeriod[i] += v.series[i] || 0;
    }
    const total = perPeriod.reduce((s, x) => s + x, 0);
    return { perPeriod, total };
  }, [filteredVariants, salesMode]);

  // Count of rows currently actionable (URGENT + READY) — shown as a
  // badge on the toolbar button. Mode-independent: weeklyAnchor is.
  const bestellungActionableCount = useMemo(() => {
    let n = 0;
    for (const r of filteredVariants) {
      const t = computeOrderTrigger(r);
      if (t.state === 'urgent' || t.state === 'ready') n += 1;
    }
    return n;
  }, [filteredVariants]);

  // Bestellung plan — generated lazily only when the panel is open and
  // re-memoised when inputs change (filtered rows, dims).
  const bestellungPlan = useMemo(() => {
    if (!bestellungOpen) return null;
    return composeBestellung(filteredVariants, dimsBySku);
  }, [bestellungOpen, filteredVariants, dimsBySku]);

  const summary = data ?? { totalAsins: 0, totalBrands: 0, totalGrazStock: 0 };
  const filterActive = !!(globalFilter || brand || channel);

  const toggleExpand = (asin: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(asin)) next.delete(asin);
      else next.add(asin);
      return next;
    });
  };

  const allChannels: LynneChannel[] = ['PRIME', 'EV', 'EV-PRIME', 'OTHER'];

  return (
    <Page>
      <LynneStyles />

      <main
        data-screen="lynne-table"
        style={{
          width: '100%',
          padding: '40px 32px 140px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          fontFamily: T.font.ui,
        }}
      >
        {/* ── IDENTITY paper-island (Katalog only) ──────────────
            On Verkäufe view the entire identity card is hidden;
            only the TabBar remains, rendered naked below. */}
        {view === 'katalog' && (
          <div style={{ animation: 'lt-rise-local 480ms cubic-bezier(0.16,1,0.3,1) backwards' }}>
            <PaperCard>
              <WhitePanel padding="32px 36px 26px" style={{ background: 'transparent' }}>
                <Eyebrow>Katalog · Beta</Eyebrow>

                <h1 style={{
                  margin: '8px 0 6px',
                  fontSize: 'clamp(28px, 3.4vw, 38px)',
                  fontWeight: 600,
                  letterSpacing: '-0.025em',
                  lineHeight: 1.05,
                  color: T.text.primary,
                }}>
                  LYNNE Table
                </h1>

                <div style={{
                  display: 'flex',
                  gap: 10,
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  fontFamily: T.font.mono,
                  fontSize: 12,
                  color: T.text.subtle,
                  letterSpacing: '0.02em',
                }}>
                  <span>Produktkatalog · gruppiert nach ASIN</span>
                  <MetaDot />
                  <span>Quelle: Produktaufstellung KW14</span>
                  <MetaDot />
                  <span>Aktualisiert vom Importer</span>
                </div>

                <div style={{
                  marginTop: 22,
                  paddingTop: 18,
                  borderTop: `1px solid ${T.border.subtle}`,
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}>
                  <Metric value={formatNum(summary.totalAsins)} label="Artikel" />
                  <MetricSep />
                  <Metric value={formatNum(summary.totalBrands)} label="Marken" />
                  <MetricSep />
                  <Metric value={formatNum(summary.totalGrazStock)} label="Stk · Lager Graz" />
                </div>

                {/* Tab switcher — sits at the bottom of the identity card */}
                <div style={{ marginTop: 20 }}>
                  <TabBar value={view} onChange={setView} />
                </div>
              </WhitePanel>
            </PaperCard>
          </div>
        )}

        {/* On Verkäufe — TabBar row + full-width KPI hero card */}
        {view === 'verkaeufe' && (
          <div style={{
            animation: 'lt-rise-local 480ms cubic-bezier(0.16,1,0.3,1) backwards',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 12,
            padding: '8px 10px 0',
          }}>
            <TabBar value={view} onChange={setView} />
            <div style={{ alignSelf: 'stretch' }}>
              <VerkaufeKpiChart total={verkaufeKpi.total} perPeriod={verkaufeKpi.perPeriod} mode={salesMode} />
            </div>
          </div>
        )}

        {/* On Marktanalyse — just the TabBar, then the Marktanalyse screen
            renders its own header. No catalog identity card, no KPI hero,
            and the shared toolbar below is suppressed (it filters the
            local catalog, not Amazon results). */}
        {view === 'marktanalyse' && (
          <div style={{
            animation: 'lt-rise-local 480ms cubic-bezier(0.16,1,0.3,1) backwards',
            display: 'flex',
            alignItems: 'flex-start',
            padding: '8px 10px 0',
          }}>
            <TabBar value={view} onChange={setView} />
          </div>
        )}

        {/* ── TOOLBAR — catalog / Verkäufe filters (hidden on Marktanalyse) */}
        {view !== 'marktanalyse' && (
        <div style={{
          animation: 'lt-rise-local 480ms cubic-bezier(0.16,1,0.3,1) 80ms backwards',
        }}>
          <div style={{
            padding: '4px 10px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
          }}>
            <SearchPill
              value={globalFilter}
              onChange={setGlobalFilter}
              placeholder="ASIN · SKU · EAN · Beschreibung"
            />
            <FilterPill
              value={brand}
              onChange={setBrand}
              options={brands.map((b) => ({ value: b, label: b }))}
              placeholder="Alle Marken"
            />
            <FilterPill
              value={channel}
              onChange={setChannel}
              options={allChannels.map((c) => ({ value: c, label: c }))}
              placeholder="Alle Kanäle"
            />
            {view === 'verkaeufe' && (
              <ModePicker value={salesMode} onChange={setSalesMode} />
            )}
            {view === 'verkaeufe' && (
              <button
                type="button"
                className="bp-trigger"
                onClick={() => setBestellungOpen(true)}
                title="FBA-Bestellung automatisch zusammenstellen"
              >
                <Boxes size={13} strokeWidth={2.2} />
                <span>Bestellung</span>
                {bestellungActionableCount > 0 && (
                  <span className="bp-trigger-count">{bestellungActionableCount}</span>
                )}
              </button>
            )}
            <span style={{ flex: 1 }} />
            {view === 'katalog' && isAdmin && (
              <button
                type="button"
                onClick={() => setEditing({ mode: 'create' })}
                title="Neuen Artikel anlegen"
                style={{
                  all: 'unset',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '8px 14px',
                  background: 'var(--accent)',
                  color: '#FFFFFF',
                  borderRadius: 999,
                  fontFamily: T.font.ui,
                  fontSize: 12.5,
                  fontWeight: 600,
                  letterSpacing: '-0.005em',
                }}
              >
                <Plus size={13} strokeWidth={2.4} />
                <span>Artikel</span>
              </button>
            )}
            {view === 'katalog' && (
              <FieldsButton value={fields} onChange={setFields} />
            )}
            <IconButton onClick={() => refetch()} title="Neu laden">
              <RefreshCw size={14} strokeWidth={2} />
            </IconButton>
          </div>

          {filterActive && (
            <div style={{
              padding: '8px 14px 0',
              fontSize: 11,
              fontFamily: T.font.mono,
              color: T.text.faint,
              letterSpacing: '0.04em',
            }}>
              {view === 'katalog'
                ? (sorted.length === 0
                    ? `Keine Treffer für die aktuelle Filter-/Suchkombination`
                    : `${formatNum(sorted.length)} von ${formatNum(allItems.length)} Artikel`)
                : (sortedVariants.length === 0
                    ? `Keine Treffer für die aktuelle Filter-/Suchkombination`
                    : `${formatNum(sortedVariants.length)} von ${formatNum(allVariants.length)} SKUs`)}
            </div>
          )}
        </div>
        )}

        {view === 'katalog' && (
        <div style={{ display: 'contents' }}>

        {/* ── COLUMN HEADER — sticky, click-to-sort ───────────── */}
        {!isLoading && !isError && allItems.length > 0 && (
          <div style={{ animation: 'lt-rise-local 480ms cubic-bezier(0.16,1,0.3,1) 120ms backwards' }}>
            <ColumnHeader sort={sort} onSort={handleSort} />
          </div>
        )}

        {/* ── ARTICLE-CARD STACK — one container per ASIN ─────── */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          animation: 'lt-rise-local 480ms cubic-bezier(0.16,1,0.3,1) 160ms backwards',
        }}>
          {isLoading && <LoadingSkeleton />}
          {!isLoading && isError && <ErrorState onRetry={() => refetch()} />}
          {!isLoading && !isError && allItems.length === 0 && (
            <EmptyState
              message="Katalog noch nicht geladen"
              hint={
                <>
                  <div style={{ fontSize: 13, color: T.text.subtle }}>Aktuelle KW-Tabelle importieren:</div>
                  <code style={{
                    fontFamily: T.font.mono,
                    fontSize: 12,
                    background: T.bg.surface2,
                    color: T.text.secondary,
                    padding: '8px 14px',
                    borderRadius: 8,
                    letterSpacing: '0.02em',
                  }}>
                    python -m backend.import_lynne --source Produktaufstellung_KW14_-_Aktuel.xlsx
                  </code>
                </>
              }
            />
          )}
          {!isLoading && !isError && allItems.length > 0 && sorted.length === 0 && (
            <EmptyState message="Keine Treffer für die aktuelle Filter-/Suchkombination" />
          )}
          {!isLoading && !isError && sorted.map((g) => (
            <ArticleCard
              key={g.asin}
              group={g}
              isExpanded={expanded.has(g.asin)}
              onToggle={() => toggleExpand(g.asin)}
              channelFilter={channel}
              maxGrazStock={maxGrazStock}
              dim={dimsByAsin.get(g.asin) ?? null}
              fields={fields}
              onEdit={isAdmin ? () => setEditing({ mode: 'edit', asin: g.asin }) : null}
            />
          ))}
        </div>
        </div>
        )}

        {view === 'verkaeufe' && (
        <div style={{ display: 'contents' }}>
          {/* Column header (sticky, sortable) */}
          {!isLoading && !isError && allVariants.length > 0 && (
            <div style={{ animation: 'lt-rise-local 480ms cubic-bezier(0.16,1,0.3,1) 120ms backwards' }}>
              <VerkaeufeColumnHeader sort={verkaufSort} onSort={handleVerkaufeSort} mode={salesMode} />
            </div>
          )}

          {/* Variant card stack */}
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            animation: 'lt-rise-local 480ms cubic-bezier(0.16,1,0.3,1) 160ms backwards',
          }}>
            {isLoading && <LoadingSkeleton />}
            {!isLoading && isError && <ErrorState onRetry={() => refetch()} />}
            {!isLoading && !isError && allVariants.length === 0 && (
              <EmptyState message="Keine SKUs geladen" />
            )}
            {!isLoading && !isError && allVariants.length > 0 && sortedVariants.length === 0 && (
              <EmptyState message="Keine SKUs für die aktuelle Filter-/Suchkombination" />
            )}
            {!isLoading && !isError && sortedVariants.map((row) => (
              <VariantSalesCard
                key={`${row.asin}__${row.sku}`}
                row={row}
                dim={dimsBySku.get(row.sku) ?? null}
                mode={salesMode}
              />
            ))}
          </div>
        </div>
        )}

        {view === 'marktanalyse' && (
          <div style={{
            animation: 'lt-rise-local 480ms cubic-bezier(0.16,1,0.3,1) 120ms backwards',
          }}>
            <Marktanalyse />
          </div>
        )}
      </main>

      <BestellungPanel
        open={bestellungOpen}
        plan={bestellungPlan}
        onClose={() => setBestellungOpen(false)}
      />

      {editing && (
        <EditAsinDrawer
          mode={editing.mode}
          group={
            editing.mode === 'edit'
              ? allItems.find((g) => g.asin === editing.asin) ?? null
              : null
          }
          initialDim={
            editing.mode === 'edit'
              ? dimsByAsin.get(editing.asin) ?? null
              : null
          }
          onClose={() => setEditing(null)}
          onSaved={() => { void refetch(); }}
        />
      )}
    </Page>
  );
}
