/* Marktanalyse — third tab in LYNNE Table.
 *
 * Free-form Amazon.de search powered by RainforestAPI (server-side
 * 24h cache, frontend `useMarketSearch` adds a 6h client cache on top).
 *
 * Layout (top → bottom):
 *   1. Search header — input + Suchen + cache status + Neu-laden
 *   2. BrandStrip   — top-6 brands as horizontal bars (LYNNE always
 *                     surfaced and accent-highlighted), click → filter
 *   3. FilterBar    — min ★ segmented + Prime-toggle + hide-sponsored
 *   4. Column header + product rows (with thumbnails, vs-Median chip,
 *                                    rating bar, Top-Pick badge,
 *                                    LYNNE row highlighting)
 *
 * All filters / sorts are client-side: the backend returns the full
 * set in one payload (~16–70 products). The vs-Median chip references
 * the FULL-set median so the comparison stays stable as the user
 * toggles filters. Filtered count is shown beside the filter bar.
 *
 * Rendered only when LynneTable's view==='marktanalyse'. Inherits
 * the `data-screen="lynne-table"` parent so `.lt-*` classes apply. */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronRight,
  ExternalLink,
  Package,
  Pin,
  RefreshCw,
  Search,
  Sparkles,
  Star,
  X as XIcon,
} from 'lucide-react';

import { T } from '@/components/ui';
import type { LynneCatalog, MarketProduct } from '@/types/api';
import { ApiError, getLynneProducts } from '@/marathonApi';
import { useMarketRefresh, useMarketSearch } from '@/hooks/useMarketSearch';


type SortKey = 'position' | 'price' | 'rating' | 'reviews';
type SortDir = 'asc' | 'desc';

interface Stats {
  count: number;
  medianCents: number | null;
  minCents: number | null;
  maxCents: number | null;
  q25Cents: number | null;
  avgRating: number | null;
  primeCount: number;
  sponsoredCount: number;
}

interface BrandEntry {
  name: string;       // raw brand string, or '' for "(ohne Marke)"
  display: string;    // what to render
  count: number;
}

interface FilterState {
  minRating: number;       // 0 = off, else 3.0 / 3.5 / 4.0 / 4.5
  primeOnly: boolean;
  hideSponsored: boolean;
  brand: string | null;    // raw brand value; null = no brand filter
}

const DEFAULT_QUERY = 'thermorollen';

// LYNNE is the warehouse's own brand — we want to spot ourselves in any
// competitor search instantly. Match is case-insensitive across brand
// AND title, because Amazon often surfaces a LYNNE listing where our
// parser extracted a different first-word as brand (e.g. title starts
// with "Premium Thermorollen by LYNNE").
const LYNNE_BRAND_RE = /\blynne\b/i;

function isLynneProduct(p: { brand?: string | null; title?: string | null }): boolean {
  return LYNNE_BRAND_RE.test(p.brand || '') || LYNNE_BRAND_RE.test(p.title || '');
}

// Thermal-roll dimensions from an Amazon listing title.
// Primary: 3D — W × L × C   (e.g. "57mm x 18m x 12mm", "(80×80×12)")
// Secondary: 2D — W × L     (e.g. "57 mm × 50 m")
// Returns null if nothing parseable → product lands in "Ohne Format".
const FORMAT_3D_RE = /(\d{1,3})\s*(?:mm)?\s*[x×х]\s*(\d{1,3})\s*m?\s*[x×х]\s*(\d{1,3})\s*(?:mm)?/i;
const FORMAT_2D_RE = /(\d{1,3})\s*mm\s*[x×х]\s*(\d{1,3})\s*m\b/i;

function extractFormat(title: string): { key: string; label: string } | null {
  const m3 = title.match(FORMAT_3D_RE);
  if (m3) {
    const w = m3[1];
    const l = m3[2];
    const c = m3[3];
    return {
      key: `${w}x${l}x${c}`,
      label: `${w} × ${l} m × ${c} mm`,
    };
  }
  const m2 = title.match(FORMAT_2D_RE);
  if (m2) {
    const w = m2[1];
    const l = m2[2];
    return {
      key: `${w}x${l}`,
      label: `${w} mm × ${l} m`,
    };
  }
  return null;
}

// Median of a number array, or null if empty.
function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// Group filtered (non-LYNNE) products by their roll format.
interface FormatGroupData {
  key: string;
  label: string;
  products: MarketProduct[];
}

const NO_FORMAT_KEY = '__no_format__';

function groupProductsByFormat(products: MarketProduct[]): FormatGroupData[] {
  const groupMap = new Map<string, { label: string; products: MarketProduct[] }>();
  const noFormat: MarketProduct[] = [];

  for (const p of products) {
    const fmt = extractFormat(p.title);
    if (fmt == null) {
      noFormat.push(p);
      continue;
    }
    let bucket = groupMap.get(fmt.key);
    if (!bucket) {
      bucket = { label: fmt.label, products: [] };
      groupMap.set(fmt.key, bucket);
    }
    bucket.products.push(p);
  }

  const groups: FormatGroupData[] = Array.from(groupMap.entries())
    .map(([key, v]) => ({ key, label: v.label, products: v.products }))
    .sort((a, b) => b.products.length - a.products.length);

  // "Ohne Format" always lands at the bottom regardless of count.
  if (noFormat.length > 0) {
    groups.push({
      key: NO_FORMAT_KEY,
      label: 'Ohne erkennbares Format',
      products: noFormat,
    });
  }
  return groups;
}
const DEFAULT_FILTERS: FilterState = {
  minRating: 0,
  primeOnly: false,
  hideSponsored: false,
  brand: null,
};
const DEFAULT_SORT_KEY: SortKey = 'position';
const DEFAULT_SORT_DIR: SortDir = 'asc';

// Per-column natural direction — clicking a fresh column starts here.
const SORT_NATURAL_DIR: Record<SortKey, SortDir> = {
  position: 'asc',  // #1 → #N
  price: 'asc',     // cheapest first
  rating: 'desc',   // highest first
  reviews: 'desc',  // most reviewed first
};

const PRICE_FORMATTER = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 2,
});
const COMPACT_FORMATTER = new Intl.NumberFormat('de-DE', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const PCT_FORMATTER = new Intl.NumberFormat('de-DE', {
  maximumFractionDigits: 0,
  signDisplay: 'always',
});


/* ─── Visual primitives duplicated from LynneTable.tsx (helpers there
   are not exported; ~40 LOC of duplication is cheaper than an export
   refactor across a 3800-line file). */

function PaperCard({
  children, flat = false, style, className, onMouseEnter, onMouseLeave,
}: {
  children?: React.ReactNode;
  flat?: boolean;
  style?: React.CSSProperties;
  className?: string;
  onMouseEnter?: React.MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLDivElement>;
}) {
  return (
    <div
      className={className}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
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
      }}
    >{children}</div>
  );
}

function WhitePanel({ children, padding, style }: { children?: React.ReactNode; padding?: string; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: '#FFFFFF',
      borderRadius: 24,
      padding: padding || '22px 26px',
      ...style,
    }}>{children}</div>
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
    }}>{children}</div>
  );
}

/* ─── Pure utilities ─── */

function formatRelative(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'gerade eben';
  if (mins < 60) return `vor ${mins} Min.`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `vor ${hours} Std.`;
  const days = Math.floor(hours / 24);
  return `vor ${days} Tag${days === 1 ? '' : 'en'}`;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function computeStats(products: MarketProduct[]): Stats {
  const count = products.length;
  const prices = products
    .map((p) => p.priceCents)
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b);
  const ratings = products
    .map((p) => p.rating)
    .filter((v): v is number => typeof v === 'number');
  const primeCount = products.filter((p) => p.isPrime === true).length;
  const sponsoredCount = products.filter((p) => p.isSponsored === true).length;
  const medianCents = percentile(prices, 0.5);
  const q25Cents = percentile(prices, 0.25);
  const minCents = prices[0] ?? null;
  const maxCents = prices[prices.length - 1] ?? null;
  const avgRating = ratings.length > 0
    ? ratings.reduce((a, b) => a + b, 0) / ratings.length
    : null;
  return {
    count,
    medianCents: medianCents != null ? Math.round(medianCents) : null,
    minCents,
    maxCents,
    q25Cents: q25Cents != null ? Math.round(q25Cents) : null,
    avgRating,
    primeCount,
    sponsoredCount,
  };
}

function computeBrands(products: MarketProduct[], topN = 6): BrandEntry[] {
  const counts = new Map<string, number>();
  for (const p of products) {
    const key = (p.brand || '').trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const entries: BrandEntry[] = Array.from(counts.entries())
    .map(([name, count]) => ({
      name,
      display: name || '(ohne Marke)',
      count,
    }))
    .sort((a, b) => b.count - a.count);
  const top = entries.slice(0, topN);
  // Always surface LYNNE even when it's outside the top-N — competitor
  // analysis is useless if we can't see ourselves.
  const lynneOutside = entries
    .slice(topN)
    .filter((e) => LYNNE_BRAND_RE.test(e.name));
  return [...top, ...lynneOutside];
}

function applyFilters(products: MarketProduct[], f: FilterState): MarketProduct[] {
  return products.filter((p) => {
    if (f.minRating > 0 && (p.rating == null || p.rating < f.minRating)) return false;
    if (f.primeOnly && p.isPrime !== true) return false;
    if (f.hideSponsored && p.isSponsored === true) return false;
    if (f.brand != null && (p.brand || '') !== f.brand) return false;
    return true;
  });
}

function sortProducts(products: MarketProduct[], key: SortKey, dir: SortDir): MarketProduct[] {
  const mult = dir === 'asc' ? 1 : -1;
  const fallback = Number.POSITIVE_INFINITY;
  const get = (p: MarketProduct): number => {
    switch (key) {
      case 'position': return p.position;
      case 'price': return p.priceCents ?? fallback;
      case 'rating': return p.rating != null ? -p.rating : fallback;
      case 'reviews': return p.reviewsCount != null ? -p.reviewsCount : fallback;
    }
  };
  return [...products].sort((a, b) => (get(a) - get(b)) * mult);
}

function isTopPick(p: MarketProduct, stats: Stats): boolean {
  if (p.rating == null || p.priceCents == null || p.reviewsCount == null) return false;
  if (stats.q25Cents == null) return false;
  return p.rating >= 4.2 && p.priceCents <= stats.q25Cents && p.reviewsCount >= 50;
}


/* ─── BrandStrip ─── */

function BrandStrip({
  brands, activeBrand, onPick,
}: { brands: BrandEntry[]; activeBrand: string | null; onPick: (name: string | null) => void }) {
  if (brands.length === 0) return null;
  const maxCount = Math.max(1, ...brands.map((b) => b.count));
  return (
    <PaperCard>
      <WhitePanel padding="16px 22px">
        <div style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          marginBottom: 10,
        }}>
          <Eyebrow>Top-Marken · klicken zum Filtern</Eyebrow>
          {activeBrand != null && (
            <button
              type="button"
              onClick={() => onPick(null)}
              style={{
                all: 'unset', cursor: 'pointer',
                fontSize: 11, fontWeight: 600,
                color: 'var(--accent, #FF5B1F)',
                fontFamily: T.font.ui,
              }}
            >
              Filter zurücksetzen
            </button>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {brands.map((b) => {
            const active = activeBrand === b.name;
            const pct = b.count / maxCount;
            const isUnknown = b.name === '';
            const isLynne = LYNNE_BRAND_RE.test(b.name);
            return (
              <button
                key={b.display}
                type="button"
                className="lt-mkt-brand-row"
                data-active={active || undefined}
                data-lynne={isLynne || undefined}
                onClick={() => onPick(active ? null : b.name)}
              >
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  fontSize: 12.5, fontWeight: isLynne ? 700 : 600,
                  color: isLynne ? 'var(--lynne-accent-dark, #6D28D9)'
                       : isUnknown ? T.text.faint
                       : T.text.primary,
                  fontStyle: isUnknown ? 'italic' : 'normal',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  textAlign: 'left',
                  letterSpacing: isLynne ? '0.02em' : undefined,
                }}>
                  {isLynne && <Star size={11} fill="currentColor" stroke="currentColor" />}
                  {b.display}
                  {isLynne && (
                    <span style={{
                      fontFamily: T.font.mono, fontSize: 9, fontWeight: 600,
                      color: 'var(--lynne-accent-dark, #6D28D9)',
                      letterSpacing: '0.08em', textTransform: 'uppercase',
                      opacity: 0.7,
                    }}>· eigene</span>
                  )}
                </span>
                <span className="lt-bar-track" style={{ width: '100%' }}>
                  <span
                    className="lt-bar-fill"
                    style={{
                      width: `${pct * 100}%`,
                      background: isLynne
                        ? 'var(--lynne-accent, #8B5CF6)'
                        : active
                          ? 'var(--accent, #FF5B1F)'
                          : undefined,
                    }}
                  />
                </span>
                <span style={{
                  fontFamily: T.font.mono, fontSize: 12, fontWeight: 600,
                  color: isLynne ? 'var(--lynne-accent-dark, #6D28D9)' : T.text.primary,
                  fontVariantNumeric: 'tabular-nums',
                  textAlign: 'right',
                }}>{b.count}</span>
              </button>
            );
          })}
        </div>
      </WhitePanel>
    </PaperCard>
  );
}


/* ─── FilterBar ─── */

const RATING_OPTIONS = [3.0, 3.5, 4.0, 4.5];

function FilterBar({
  filters, onChange, totalCount, filteredCount, onReset,
}: {
  filters: FilterState;
  onChange: (next: FilterState) => void;
  totalCount: number;
  filteredCount: number;
  onReset: () => void;
}) {
  const anyActive = filters.minRating > 0 || filters.primeOnly || filters.hideSponsored || filters.brand != null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: '6px 10px',
    }}>
      <span style={{
        fontFamily: T.font.mono, fontSize: 10.5, fontWeight: 700,
        color: T.text.faint, letterSpacing: '0.16em', textTransform: 'uppercase',
        marginRight: 6,
      }}>Filter</span>

      {/* Rating segmented */}
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span style={{ fontSize: 11, color: T.text.faint, marginRight: 2 }}>★ ab</span>
        {RATING_OPTIONS.map((v) => (
          <button
            key={v}
            type="button"
            className="lt-mkt-pill"
            data-active={filters.minRating === v || undefined}
            onClick={() => onChange({ ...filters, minRating: filters.minRating === v ? 0 : v })}
          >
            {v.toFixed(1).replace('.', ',')}
          </button>
        ))}
      </div>

      <span style={{ width: 1, height: 16, background: T.border.primary, margin: '0 6px' }} />

      <button
        type="button"
        className="lt-mkt-pill"
        data-active={filters.primeOnly || undefined}
        onClick={() => onChange({ ...filters, primeOnly: !filters.primeOnly })}
      >
        Nur Prime
      </button>

      <button
        type="button"
        className="lt-mkt-pill"
        data-active={filters.hideSponsored || undefined}
        onClick={() => onChange({ ...filters, hideSponsored: !filters.hideSponsored })}
      >
        Anzeigen ausblenden
      </button>

      {filters.brand != null && (
        <button
          type="button"
          className="lt-mkt-pill"
          data-active
          onClick={() => onChange({ ...filters, brand: null })}
          title="Marken-Filter entfernen"
        >
          Marke: {filters.brand || '(ohne)'} <XIcon size={11} strokeWidth={2.2} />
        </button>
      )}

      <span style={{ flex: 1 }} />

      <span style={{
        fontFamily: T.font.mono, fontSize: 11, color: T.text.faint,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {filteredCount} / {totalCount} angezeigt
      </span>

      {anyActive && (
        <button
          type="button"
          onClick={onReset}
          style={{
            all: 'unset', cursor: 'pointer',
            fontSize: 11, fontWeight: 600,
            color: 'var(--accent, #FF5B1F)',
            fontFamily: T.font.ui,
            marginLeft: 4,
          }}
        >
          Zurücksetzen
        </button>
      )}
    </div>
  );
}


/* ─── ColumnHeader (sortable) ─── */

function ColumnHeader({
  label, sortKey, currentKey, dir, onSort, numeric = false,
}: {
  label: string;
  sortKey: SortKey | null;
  currentKey: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  numeric?: boolean;
}) {
  if (sortKey === null) {
    return (
      <span className="lt-colhead-static" style={{ justifySelf: numeric ? 'end' : 'start' }}>
        {label}
      </span>
    );
  }
  const active = currentKey === sortKey;
  const Icon = !active ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={`lt-colhead-cell${active ? ' lt-colhead-active' : ''}${numeric ? ' lt-colhead-num' : ''}`}
    >
      {numeric ? <><Icon size={10} strokeWidth={2} /> {label}</> : <>{label} <Icon size={10} strokeWidth={2} /></>}
    </button>
  );
}


/* ─── Per-row visual primitives ─── */

function hashHue(s: string): number {
  // Cheap deterministic string → 0..359 hue.
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 360;
}

function ProductImage({ url, title, brand }: { url?: string | null; title: string; brand?: string | null }) {
  const [errored, setErrored] = useState(false);
  const seed = (brand || title || '?').trim();
  const initial = (seed.charAt(0) || '?').toUpperCase();
  if (!url || errored) {
    const hue = hashHue(seed.toLowerCase());
    return (
      <div
        className="lt-mkt-img-fallback"
        aria-label={title}
        style={{
          background: `hsl(${hue}deg 70% 92%)`,
          color: `hsl(${hue}deg 55% 32%)`,
        }}
      >{initial}</div>
    );
  }
  return (
    <img
      src={url}
      alt={title}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setErrored(true)}
      className="lt-mkt-img"
    />
  );
}

function RatingBar({ rating }: { rating: number | null | undefined }) {
  if (rating == null) {
    return <span style={{ color: T.text.faint, fontSize: 11 }}>—</span>;
  }
  const filled = Math.max(0, Math.min(5, rating));
  const W = 60;
  const H = 6;
  const gap = 1.5;
  const segW = (W - gap * 4) / 5;
  const text = rating.toFixed(1).replace('.', ',');
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      justifyContent: 'flex-end',
    }}>
      <span style={{
        fontFamily: T.font.mono, fontSize: 11.5, color: T.text.primary,
        fontVariantNumeric: 'tabular-nums',
      }}>{text}</span>
      <svg width={W} height={H} aria-hidden style={{ display: 'block' }}>
        {[0, 1, 2, 3, 4].map((i) => {
          const x = i * (segW + gap);
          const frac = Math.max(0, Math.min(1, filled - i));
          return (
            <g key={i}>
              <rect x={x} y={0} width={segW} height={H} rx={1} fill={T.border.subtle ?? 'rgba(15,23,42,0.08)'} />
              {frac > 0 && (
                <rect x={x} y={0} width={segW * frac} height={H} rx={1} fill="#F59E0B" />
              )}
            </g>
          );
        })}
      </svg>
    </span>
  );
}

function VsMedianChip({ priceCents, medianCents }: { priceCents: number | null | undefined; medianCents: number | null }) {
  if (priceCents == null || medianCents == null || medianCents === 0) {
    return <span style={{ color: T.text.faint, fontSize: 11 }}>—</span>;
  }
  const pct = ((priceCents - medianCents) / medianCents) * 100;
  if (Math.abs(pct) <= 2) {
    return <span className="lt-wow-chip lt-wow-chip-flat" title="Auf Median-Niveau">Median</span>;
  }
  const cls = pct < 0 ? 'lt-wow-chip-up' : 'lt-wow-chip-flat';
  // "up" tone here means "below median = cheaper = good buy" (green).
  // "+X%" above median → neutral gray, not red — pricier isn't necessarily worse.
  const text = `${PCT_FORMATTER.format(Math.round(pct))} %`;
  return (
    <span
      className={`lt-wow-chip ${cls}`}
      title={`Preis vs Median (${PRICE_FORMATTER.format(medianCents / 100)})`}
    >
      {text}
    </span>
  );
}


/* ─── ProductRow ─── */

function ProductRow({
  product, medianCents, isTop, isLynne,
}: { product: MarketProduct; medianCents: number | null; isTop: boolean; isLynne: boolean }) {
  const muted = product.isSponsored === true && !isLynne;
  const price = product.priceCents != null
    ? PRICE_FORMATTER.format(product.priceCents / 100)
    : '—';
  const reviews = product.reviewsCount != null
    ? COMPACT_FORMATTER.format(product.reviewsCount)
    : '—';
  const brand = product.brand || '—';

  // Whole card is a link — clicking anywhere opens the Amazon listing
  // in a new tab. Native <a> gives mid-click → new tab, Cmd/Ctrl-click,
  // right-click context menu, keyboard activation. Inner ↗ icon stays
  // as a visual cue (no nested anchor — would be invalid HTML).
  return (
    <a
      href={product.url}
      target="_blank"
      rel="noopener noreferrer"
      title="Auf Amazon.de öffnen"
      className={isLynne ? 'lt-mkt-row-lynne' : undefined}
      style={{
        display: 'block',
        background: '#FFFFFF',
        borderRadius: 18,
        padding: '12px 22px',
        opacity: muted ? 0.78 : 1,
        transition: 'transform 160ms cubic-bezier(0.16,1,0.3,1), box-shadow 160ms ease',
        cursor: 'pointer',
        textDecoration: 'none',
        color: 'inherit',
      }}
      onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => {
        e.currentTarget.style.transform = 'translateY(-1px)';
        e.currentTarget.style.boxShadow = '0 6px 24px rgba(15, 23, 42, 0.06)';
      }}
      onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
        <div className="lt-grid lt-grid-marktanalyse">
          {/* # */}
          <div style={{
            fontFamily: T.font.mono, fontSize: 11, color: T.text.faint,
            fontVariantNumeric: 'tabular-nums',
          }}>#{product.position}</div>

          {/* Image */}
          <ProductImage url={product.imageUrl} title={product.title} brand={product.brand} />

          {/* Title + ASIN + pills */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <div
              title={product.title}
              style={{
                fontSize: 13.5, fontWeight: 600, color: T.text.primary,
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.3,
              }}
            >{product.title}</div>
            <div style={{
              display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
              fontFamily: T.font.mono, fontSize: 10.5, color: T.text.faint,
            }}>
              {isLynne && (
                <span
                  className="lt-pill"
                  data-channel="LYNNE"
                  title="LYNNE — eigene Marke (im Verkauf bei uns)"
                  style={{ fontSize: 9, gap: 3 }}
                >
                  <Star size={9} fill="#FFFFFF" stroke="#FFFFFF" /> LYNNE
                </span>
              )}
              {product.asin && <span title={`ASIN ${product.asin}`}>{product.asin}</span>}
              {product.isSponsored && (
                <span
                  className="lt-pill"
                  data-channel="OTHER"
                  title="Gesponserte Platzierung — Verkäufer hat für die Position bezahlt"
                  style={{ fontSize: 9 }}
                >Anzeige</span>
              )}
              {product.isPrime && (
                <span
                  className="lt-pill"
                  data-channel="PRIME"
                  title="Amazon Prime — schneller Versand, Mitgliedschaft erforderlich"
                  style={{ fontSize: 9 }}
                >Prime</span>
              )}
              {isTop && (
                <span
                  className="lt-pill"
                  data-channel="TOP"
                  title="Top Preis/Leistung: ≥4,2★, im günstigsten Viertel der Preisspanne, ≥50 Rezensionen"
                  style={{ fontSize: 9, gap: 3 }}
                >
                  <Sparkles size={9} strokeWidth={2} /> Top P/L
                </span>
              )}
            </div>
          </div>

          {/* Brand */}
          <div style={{ minWidth: 0 }}>
            {isLynne ? (
              <span className="lt-mkt-brand-lynne" title="LYNNE — eigene Marke">
                <Star size={11} fill="currentColor" stroke="currentColor" />
                {brand !== '—' ? brand : 'LYNNE'}
              </span>
            ) : (
              <span style={{
                fontSize: 12.5,
                fontWeight: brand === '—' ? 400 : 600,
                color: brand === '—' ? T.text.faint : T.text.primary,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                display: 'inline-block', maxWidth: '100%',
              }}>{brand}</span>
            )}
          </div>

          {/* Price */}
          <div className="lt-col-num" style={{
            fontSize: 13.5, fontWeight: 600, color: T.text.primary, fontVariantNumeric: 'tabular-nums',
          }}>{price}</div>

          {/* vs Median */}
          <div className="lt-col-num" style={{ justifySelf: 'end' }}>
            <VsMedianChip priceCents={product.priceCents} medianCents={medianCents} />
          </div>

          {/* Rating */}
          <div className="lt-col-num">
            <RatingBar rating={product.rating} />
          </div>

          {/* Reviews */}
          <div className="lt-col-num" style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end',
            fontFamily: T.font.mono, fontSize: 12, color: T.text.faint, fontVariantNumeric: 'tabular-nums',
          }}>
            {product.reviewsCount != null && <Star size={10} fill={T.text.faint as string} stroke={T.text.faint as string} />}
            {reviews}
          </div>

          {/* Link indicator — visual only; the whole card is clickable.
              Nested <a> would be invalid HTML. */}
          <div style={{ justifySelf: 'end' }} aria-hidden>
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 28, height: 28, borderRadius: 999,
                background: '#FFFFFF', border: `1px solid ${T.border.primary}`,
                color: T.text.primary,
              }}
            >
              <ExternalLink size={12} strokeWidth={1.8} />
            </span>
          </div>
        </div>
    </a>
  );
}


/* ─── GroupColumnHeader — sortable column header row, rendered inside
   each format / LYNNE container. Same grid template as rows.        */

function GroupColumnHeader({
  sortKey, sortDir, onSort,
}: {
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  return (
    <div style={{
      background: 'rgba(15, 23, 42, 0.02)',
      borderRadius: 14,
      padding: '8px 22px',
    }}>
      <div className="lt-grid lt-grid-marktanalyse lt-colhead">
        <ColumnHeader label="#" sortKey="position" currentKey={sortKey} dir={sortDir} onSort={onSort} />
        <span className="lt-colhead-static" aria-label="Bild" />
        <ColumnHeader label="Titel" sortKey={null} currentKey={sortKey} dir={sortDir} onSort={onSort} />
        <ColumnHeader label="Marke" sortKey={null} currentKey={sortKey} dir={sortDir} onSort={onSort} />
        <ColumnHeader label="Preis" sortKey="price" currentKey={sortKey} dir={sortDir} onSort={onSort} numeric />
        <ColumnHeader label="vs Median" sortKey={null} currentKey={sortKey} dir={sortDir} onSort={onSort} numeric />
        <ColumnHeader label="Bewertung" sortKey="rating" currentKey={sortKey} dir={sortDir} onSort={onSort} numeric />
        <ColumnHeader label="Rezensionen" sortKey="reviews" currentKey={sortKey} dir={sortDir} onSort={onSort} numeric />
        <ColumnHeader label="" sortKey={null} currentKey={sortKey} dir={sortDir} onSort={onSort} />
      </div>
    </div>
  );
}


/* ─── FormatGroup — collapsible container per roll format (57×18×12, ...)
   Header shows format label + count + median + ⌀ rating.            */

function FormatGroup({
  label, products, expanded, onToggle, medianCents, topPickSet, sortKey, sortDir, onSort,
}: {
  label: string;
  products: MarketProduct[];
  expanded: boolean;
  onToggle: () => void;
  medianCents: number | null;
  topPickSet: Set<string>;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  // Mini-stats for the header — computed locally so each group shows
  // its OWN median, not the market-wide median (which is `medianCents`
  // used downstream by VsMedianChip).
  const groupStats = useMemo(() => {
    const prices = products
      .map((p) => p.priceCents)
      .filter((v): v is number => typeof v === 'number');
    const ratings = products
      .map((p) => p.rating)
      .filter((v): v is number => typeof v === 'number');
    return {
      median: medianOf(prices),
      avgRating: ratings.length > 0
        ? ratings.reduce((a, b) => a + b, 0) / ratings.length
        : null,
    };
  }, [products]);

  const fmtPrice = (cents: number | null) =>
    cents != null ? PRICE_FORMATTER.format(cents / 100) : '—';
  const avgR = groupStats.avgRating != null
    ? `${groupStats.avgRating.toFixed(1).replace('.', ',')}★`
    : '—';

  return (
    <PaperCard>
      <button
        type="button"
        className="lt-mkt-group-header"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <ChevronRight
          className="lt-mkt-chevron"
          data-expanded={expanded || undefined}
          size={16}
          strokeWidth={2.2}
        />
        <span style={{
          fontSize: 15, fontWeight: 600, color: T.text.primary,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '-0.012em',
        }}>{label}</span>
        <span style={{ flex: 1 }} />
        <span style={{
          fontFamily: T.font.mono, fontSize: 11, color: T.text.faint,
          letterSpacing: '0.04em',
        }}>
          {products.length} Treffer
          {groupStats.median != null && <> · Median {fmtPrice(groupStats.median)}</>}
          {groupStats.avgRating != null && <> · ⌀ {avgR}</>}
        </span>
      </button>

      {expanded && (
        <>
          <GroupColumnHeader sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
          {products.map((p) => (
            <ProductRow
              key={p.id}
              product={p}
              medianCents={medianCents}
              isTop={topPickSet.has(p.id)}
              isLynne={false}
            />
          ))}
        </>
      )}
    </PaperCard>
  );
}


/* ─── LynneContainer — pinned own-brand container.
   Accent border + gradient bg, 4 mini-metrics (Produkte / Marktanteil
   / Median ⭐ / vs Markt), collapsible (default expanded).           */

function LynneContainer({
  products, marketMedianCents, totalCount, topPickSet,
  expanded, onToggle, sortKey, sortDir, onSort,
}: {
  products: MarketProduct[];
  marketMedianCents: number | null;
  totalCount: number;
  topPickSet: Set<string>;
  expanded: boolean;
  onToggle: () => void;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const lynneStats = useMemo(() => {
    const prices = products
      .map((p) => p.priceCents)
      .filter((v): v is number => typeof v === 'number');
    return { median: medianOf(prices) };
  }, [products]);

  const fmtPrice = (cents: number | null) =>
    cents != null ? PRICE_FORMATTER.format(cents / 100) : '—';
  const sharePct = totalCount > 0
    ? Math.round((products.length / totalCount) * 100)
    : 0;
  const vsMarktPct = (lynneStats.median != null && marketMedianCents != null && marketMedianCents > 0)
    ? Math.round(((lynneStats.median - marketMedianCents) / marketMedianCents) * 100)
    : null;
  const vsMarktColor: string = vsMarktPct == null
    ? (T.text.faint as string)
    : vsMarktPct < 0
      ? '#047857'
      : (T.text.subtle as string);

  return (
    <PaperCard className="lt-mkt-lynne-container">
      <button
        type="button"
        className="lt-mkt-group-header"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <ChevronRight
          className="lt-mkt-chevron"
          data-expanded={expanded || undefined}
          size={16}
          strokeWidth={2.2}
          style={{ color: 'var(--lynne-accent, #8B5CF6)' }}
        />
        <Pin size={14} strokeWidth={2} style={{
          color: 'var(--lynne-accent, #8B5CF6)', flexShrink: 0,
        }} />
        <Star size={15} fill="var(--lynne-accent, #8B5CF6)" stroke="var(--lynne-accent, #8B5CF6)" />
        <span style={{
          fontSize: 16, fontWeight: 700,
          color: 'var(--lynne-accent-dark, #6D28D9)',
          letterSpacing: '0.06em',
        }}>LYNNE</span>
        <span style={{
          fontFamily: T.font.mono, fontSize: 10, fontWeight: 600,
          color: T.text.faint, letterSpacing: '0.16em',
          textTransform: 'uppercase',
        }}>· Eigene Marke · klar erkennbar</span>

        <span style={{ flex: 1 }} />

        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 16,
          fontFamily: T.font.mono,
        }}>
          <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
            <span style={{
              fontSize: 18, fontWeight: 700,
              color: 'var(--lynne-accent-dark, #6D28D9)',
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '-0.018em',
            }}>{products.length}</span>
            <span style={{ fontSize: 9.5, color: T.text.faint, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Produkte
            </span>
          </span>

          <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
            <span style={{
              fontSize: 18, fontWeight: 700,
              color: T.text.primary,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '-0.018em',
            }}>{sharePct}%</span>
            <span style={{ fontSize: 9.5, color: T.text.faint, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Marktanteil
            </span>
          </span>

          <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
            <span style={{
              fontSize: 18, fontWeight: 700,
              color: T.text.primary,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '-0.018em',
            }}>{fmtPrice(lynneStats.median)}</span>
            <span style={{ fontSize: 9.5, color: T.text.faint, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Median
            </span>
          </span>

          {vsMarktPct != null && (
            <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
              <span style={{
                fontSize: 18, fontWeight: 700,
                color: vsMarktColor,
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: '-0.018em',
              }}>{vsMarktPct >= 0 ? '+' : ''}{vsMarktPct}%</span>
              <span style={{ fontSize: 9.5, color: T.text.faint, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                vs Markt
              </span>
            </span>
          )}
        </div>
      </button>

      {expanded && (
        <>
          <GroupColumnHeader sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
          {products.map((p) => (
            <ProductRow
              key={p.id}
              product={p}
              medianCents={marketMedianCents}
              isTop={topPickSet.has(p.id)}
              isLynne={true}
            />
          ))}
        </>
      )}
    </PaperCard>
  );
}


/* ─── State cards ─── */

function LoadingLayout() {
  // Mocks the visible Marktanalyse layout so the page doesn't pop when
  // results arrive — brand strip + 6 rows of skeleton.
  return (
    <>
      {/* BrandStrip skeleton */}
      <PaperCard>
        <WhitePanel padding="16px 22px">
          <div className="lt-skel-row" style={{ width: 180, height: 10, borderRadius: 4, borderBottom: 'none', marginBottom: 10 }} />
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 10px' }}>
              <div className="lt-skel-row" style={{ width: 130, height: 12, borderRadius: 4, borderBottom: 'none' }} />
              <div className="lt-skel-row" style={{ flex: 1, height: 6, borderRadius: 999, borderBottom: 'none' }} />
              <div className="lt-skel-row" style={{ width: 20, height: 12, borderRadius: 4, borderBottom: 'none' }} />
            </div>
          ))}
        </WhitePanel>
      </PaperCard>

      {/* Row skeletons */}
      {Array.from({ length: 6 }).map((_, i) => (
        <PaperCard key={i} flat style={{ gap: 0 }}>
          <WhitePanel padding="14px 22px">
            <div className="lt-skel-row" style={{ height: 48, borderBottom: 'none' }} />
          </WhitePanel>
        </PaperCard>
      ))}
    </>
  );
}

function StateCard({ kind, message, onRetry }: { kind: 'empty' | 'error' | 'loading'; message?: string; onRetry?: () => void }) {
  if (kind === 'loading') return <LoadingLayout />;
  const Icon = kind === 'error' ? AlertTriangle : Package;
  const bg = kind === 'error' ? T.status.danger.bg : T.bg.surface2;
  const fg = kind === 'error' ? T.status.danger.text : T.text.faint;
  return (
    <PaperCard>
      <WhitePanel padding="48px 28px">
        <div style={{
          textAlign: 'center', display: 'flex', flexDirection: 'column',
          alignItems: 'center', gap: 12,
        }}>
          <div style={{
            display: 'inline-flex', width: 46, height: 46,
            alignItems: 'center', justifyContent: 'center',
            borderRadius: 999, background: bg, color: fg,
          }}>
            <Icon size={20} strokeWidth={1.6} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, color: T.text.primary }}>
            {message ?? (kind === 'error' ? 'Suche fehlgeschlagen' : 'Keine Ergebnisse')}
          </div>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              style={{
                all: 'unset', cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 7,
                padding: '8px 16px', background: '#FFFFFF',
                border: `1px solid ${T.border.primary}`, borderRadius: 999,
                fontFamily: T.font.ui, fontSize: 12.5, fontWeight: 600,
                color: T.text.primary,
              }}
            >
              <RefreshCw size={13} strokeWidth={2} /> Erneut versuchen
            </button>
          )}
        </div>
      </WhitePanel>
    </PaperCard>
  );
}


/* ─── Main ─── */

export default function Marktanalyse() {
  const [draft, setDraft] = useState(DEFAULT_QUERY);
  const [submittedQuery, setSubmittedQuery] = useState(DEFAULT_QUERY);
  const [sortKey, setSortKey] = useState<SortKey>('position');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  // Explicit-fetch mode: nothing fires on mount. Both "Suchen" and
  // "Neu laden" buttons flip this to true, which enables the underlying
  // useQuery. Until then the page sits in an idle hero state.
  const [hasFetched, setHasFetched] = useState(false);
  // Expand state persists across queries via localStorage. We track
  // only deviations from the defaults so format keys from old searches
  // don't accumulate noise:
  //   - lynneExpanded:   default FALSE (LYNNE container collapsed)
  //   - collapsedFormats: Set of format keys the user has explicitly
  //                       collapsed (default: all format groups expanded)
  const [lynneExpanded, setLynneExpanded] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('marathon.market.lynneExpanded.v1');
      if (saved != null) return saved === 'true';
    } catch { /* ignore */ }
    return false;
  });
  const [collapsedFormats, setCollapsedFormats] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('marathon.market.collapsedFormats.v1');
      if (saved) {
        const arr = JSON.parse(saved) as unknown;
        if (Array.isArray(arr)) return new Set(arr.filter((v): v is string => typeof v === 'string'));
      }
    } catch { /* ignore */ }
    return new Set();
  });
  useEffect(() => {
    try { localStorage.setItem('marathon.market.lynneExpanded.v1', String(lynneExpanded)); } catch { /* ignore */ }
  }, [lynneExpanded]);
  useEffect(() => {
    try {
      localStorage.setItem(
        'marathon.market.collapsedFormats.v1',
        JSON.stringify(Array.from(collapsedFormats)),
      );
    } catch { /* ignore */ }
  }, [collapsedFormats]);

  const search = useMarketSearch(submittedQuery, hasFetched);
  const refresh = useMarketRefresh();

  // Own product catalog (lynne_products table) — used to identify
  // products in any Amazon search that ARE actually ours, regardless
  // of the brand name Amazon shows. Cross-reference is by ASIN. Cache
  // 30 min on the client (catalog doesn't change between Marathon
  // imports). Shares queryKey with LynneTable's Katalog tab — no
  // duplicate API call.
  const ownCatalog = useQuery<LynneCatalog>({
    queryKey: ['lynne-products'],
    queryFn: getLynneProducts,
    staleTime: 30 * 60_000,
    retry: 1,
  });
  const ownAsins = useMemo(() => {
    const set = new Set<string>();
    for (const g of ownCatalog.data?.items ?? []) {
      if (g.asin) set.add(g.asin);
    }
    return set;
  }, [ownCatalog.data]);

  // Reset filters + sort when the search query changes. Expand state
  // (lynneExpanded, collapsedFormats) intentionally persists across
  // queries — it's a user preference, not result-set-specific.
  useEffect(() => {
    setFilters(DEFAULT_FILTERS);
    setSortKey('position');
    setSortDir('asc');
  }, [submittedQuery]);

  const data = search.data;
  const allProducts = data?.products ?? [];

  // KPIs / brands / histogram are computed from the FULL set so the
  // Median reference stays stable as the user toggles filters.
  const stats = useMemo(() => computeStats(allProducts), [allProducts]);
  const brands = useMemo(() => computeBrands(allProducts), [allProducts]);
  const topPickSet = useMemo(() => {
    const ids = new Set<string>();
    for (const p of allProducts) {
      if (isTopPick(p, stats)) ids.add(p.id);
    }
    return ids;
  }, [allProducts, stats]);
  // Cross-reference Amazon results with our own catalog (lynne_products)
  // by ASIN. This catches all our brands (LYNNE, TK THERMALKING, SWIPARO,
  // Veit GmbH, WARMWALD, ...) even when the Amazon brand label differs
  // from how we store it. Fallback: still flag products whose brand or
  // title literally contains "LYNNE" — covers ASINs that aren't in our
  // catalog yet.
  const lynneSet = useMemo(() => {
    const ids = new Set<string>();
    for (const p of allProducts) {
      if (p.asin && ownAsins.has(p.asin)) {
        ids.add(p.id);
        continue;
      }
      if (isLynneProduct(p)) ids.add(p.id);
    }
    return ids;
  }, [allProducts, ownAsins]);

  // filtered → split LYNNE vs format-bucketed non-LYNNE → sorted
  const filtered = useMemo(() => applyFilters(allProducts, filters), [allProducts, filters]);

  const { lynneFiltered, formatGroups } = useMemo(() => {
    const lynneOnly: MarketProduct[] = [];
    const others: MarketProduct[] = [];
    for (const p of filtered) {
      if (lynneSet.has(p.id)) lynneOnly.push(p);
      else others.push(p);
    }
    return {
      lynneFiltered: lynneOnly,
      formatGroups: groupProductsByFormat(others),
    };
  }, [filtered, lynneSet]);

  const sortedLynne = useMemo(
    () => sortProducts(lynneFiltered, sortKey, sortDir),
    [lynneFiltered, sortKey, sortDir],
  );
  const sortedGroups = useMemo(
    () => formatGroups.map((g) => ({
      ...g,
      products: sortProducts(g.products, sortKey, sortDir),
    })),
    [formatGroups, sortKey, sortDir],
  );

  // (No auto-expand effect — all format groups are expanded by default,
  // user explicitly collapses what they don't want via the chevron.)

  // 3-cycle sort matching VerkaeufeColumnHeader semantics:
  //   click new column      → natural direction
  //   click same (natural)  → reverse
  //   click same (reverse)  → reset to default (#asc)
  const handleSort = (key: SortKey) => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir(SORT_NATURAL_DIR[key]);
      return;
    }
    const natural = SORT_NATURAL_DIR[key];
    if (sortDir === natural) {
      setSortDir(natural === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(DEFAULT_SORT_KEY);
      setSortDir(DEFAULT_SORT_DIR);
    }
  };

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = draft.trim();
    if (!q) return;
    setSubmittedQuery(q);
    setHasFetched(true);
  };

  const handleForceRefresh = () => {
    if (refresh.isPending) return;
    const q = draft.trim() || submittedQuery;
    // If the draft has changed since the last Suchen, treat Neu laden as
    // "fetch this draft now" — keeps behavior intuitive when the user
    // wants to skip the Suchen step entirely.
    if (q !== submittedQuery) setSubmittedQuery(q);
    setHasFetched(true);
    refresh.mutate(q);
  };

  const apiError = search.error instanceof ApiError ? search.error : null;
  const errorMessage = apiError?.status === 503
    ? 'Daten-Provider ist gerade nicht erreichbar.'
    : apiError?.message ?? search.error?.message ?? '';

  const showRichLayer = !search.isLoading && !search.isError && allProducts.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Header — search input + provider status */}
      <PaperCard>
        <WhitePanel padding="20px 24px">
          <form
            onSubmit={handleSubmit}
            style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}
          >
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 16px',
              background: T.bg.surface2 ?? '#F4F5F7', borderRadius: 999,
              minWidth: 320, flex: 1, maxWidth: 520,
            }}>
              <Search size={14} color={T.text.faint} strokeWidth={1.8} />
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Auf Amazon.de suchen — z. B. „thermorollen"
                spellCheck={false}
                autoComplete="off"
                style={{
                  all: 'unset', flex: 1, fontFamily: T.font.ui,
                  fontSize: 13.5, color: T.text.primary, minWidth: 0,
                }}
              />
            </div>
            <button
              type="submit"
              disabled={!draft.trim() || search.isFetching}
              style={{
                all: 'unset', cursor: search.isFetching ? 'progress' : 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 7,
                padding: '10px 18px', background: T.text.primary, color: '#FFFFFF',
                borderRadius: 999, fontFamily: T.font.ui, fontSize: 12.5, fontWeight: 600,
                opacity: !draft.trim() ? 0.4 : 1,
              }}
            >
              <Search size={13} strokeWidth={2.2} /> Suchen
            </button>

            <div style={{ flex: 1 }} />

            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 10,
              fontFamily: T.font.mono, fontSize: 11, color: T.text.faint,
            }}>
              {data && (
                <span>
                  {data.fromCache ? 'Cache' : 'Live'} · {data.resultCount} Treffer · {formatRelative(data.fetchedAt)}
                </span>
              )}
              <button
                type="button"
                onClick={handleForceRefresh}
                disabled={refresh.isPending || !(draft.trim() || submittedQuery)}
                title={
                  hasFetched
                    ? 'Live-Anfrage an RainforestAPI (verbraucht 1 Credit)'
                    : 'Daten live von Amazon laden (verbraucht 1 API-Credit)'
                }
                style={{
                  all: 'unset',
                  cursor: refresh.isPending ? 'progress' : 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '6px 12px',
                  background: '#FFFFFF',
                  border: `1px solid ${T.border.primary}`, borderRadius: 999,
                  fontSize: 11.5, fontWeight: 600, color: T.text.primary,
                }}
              >
                <RefreshCw size={11} strokeWidth={2} /> Neu laden
              </button>
            </div>
          </form>

          {refresh.error && (
            <div style={{
              marginTop: 10, padding: '8px 14px',
              background: T.status.danger.bg, color: T.status.danger.text,
              borderRadius: 12, fontSize: 12,
            }}>
              {refresh.error instanceof ApiError && refresh.error.status === 429
                ? 'Bitte warte eine Minute zwischen Live-Anfragen.'
                : refresh.error.message}
            </div>
          )}
        </WhitePanel>
      </PaperCard>

      {/* Rich layer: brand strip + filter bar — only when we actually
          have a result set. (KPI/SummaryStrip removed per request.) */}
      {showRichLayer && brands.length > 1 && (
        <BrandStrip
          brands={brands}
          activeBrand={filters.brand}
          onPick={(name) => setFilters({ ...filters, brand: name })}
        />
      )}

      {showRichLayer && (
        <FilterBar
          filters={filters}
          onChange={setFilters}
          totalCount={allProducts.length}
          filteredCount={filtered.length}
          onReset={() => setFilters(DEFAULT_FILTERS)}
        />
      )}

      {/* (Outer column header removed — each FormatGroup / LynneContainer
          renders its own column header inside when expanded.) */}

      {/* Idle state — no fetch has been triggered yet (page mount).
          Replaces the auto-fetch behavior with explicit user action. */}
      {!hasFetched && (
        <PaperCard>
          <WhitePanel padding="56px 28px">
            <div style={{
              textAlign: 'center', display: 'flex', flexDirection: 'column',
              alignItems: 'center', gap: 14, maxWidth: 460, margin: '0 auto',
            }}>
              <div style={{
                display: 'inline-flex', width: 52, height: 52,
                alignItems: 'center', justifyContent: 'center',
                borderRadius: 999, background: T.bg.surface2, color: T.text.faint,
              }}>
                <Search size={22} strokeWidth={1.6} />
              </div>
              <div style={{
                fontSize: 17, fontWeight: 600, color: T.text.primary,
                letterSpacing: '-0.012em',
              }}>
                Bereit für die Marktanalyse
              </div>
              <div style={{
                fontSize: 12.5, color: T.text.subtle, lineHeight: 1.5,
              }}>
                Standardsuche „{draft || submittedQuery}". Klick <strong>Neu laden</strong>{' '}
                oben rechts, um Live-Daten von Amazon.de abzurufen,{' '}
                oder ändere den Suchbegriff und drücke <strong>Suchen</strong>.
              </div>
              <button
                type="button"
                onClick={handleForceRefresh}
                disabled={refresh.isPending}
                style={{
                  all: 'unset', cursor: refresh.isPending ? 'progress' : 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  padding: '10px 18px',
                  background: 'var(--accent, #FF5B1F)', color: '#FFFFFF',
                  borderRadius: 999,
                  fontFamily: T.font.ui, fontSize: 12.5, fontWeight: 600,
                  marginTop: 4,
                }}
              >
                <RefreshCw size={13} strokeWidth={2.2} /> Live abrufen
              </button>
              <div style={{
                fontFamily: T.font.mono, fontSize: 10, color: T.text.faint,
                letterSpacing: '0.08em', textTransform: 'uppercase', marginTop: 2,
              }}>
                Verbraucht 1 API-Credit · Cache 24 Std.
              </div>
            </div>
          </WhitePanel>
        </PaperCard>
      )}

      {/* States — only when a fetch has actually been requested */}
      {hasFetched && search.isLoading && <StateCard kind="loading" />}
      {hasFetched && !search.isLoading && search.isError && (
        <StateCard
          kind="error"
          message={errorMessage || 'Suche fehlgeschlagen'}
          onRetry={() => search.refetch()}
        />
      )}
      {hasFetched && !search.isLoading && !search.isError && data && allProducts.length === 0 && (
        <StateCard kind="empty" message={`Keine Treffer für „${submittedQuery}"`} />
      )}
      {showRichLayer && filtered.length === 0 && (
        <StateCard
          kind="empty"
          message="Keine Treffer für aktive Filter"
          onRetry={() => setFilters(DEFAULT_FILTERS)}
        />
      )}

      {/* LYNNE pinned container — own brand, accent border, default expanded */}
      {showRichLayer && sortedLynne.length > 0 && (
        <LynneContainer
          products={sortedLynne}
          marketMedianCents={stats.medianCents}
          totalCount={allProducts.length}
          topPickSet={topPickSet}
          expanded={lynneExpanded}
          onToggle={() => setLynneExpanded((v) => !v)}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={handleSort}
        />
      )}

      {/* Format-grouped competitor containers — ALL expanded by default,
          user explicitly collapses what they don't need. Collapsed set
          persists across queries via localStorage. */}
      {showRichLayer && sortedGroups
        .filter((g) => g.products.length > 0)
        .map((g) => (
          <FormatGroup
            key={g.key}
            label={g.label}
            products={g.products}
            expanded={!collapsedFormats.has(g.key)}
            onToggle={() => setCollapsedFormats((prev) => {
              const next = new Set(prev);
              if (next.has(g.key)) next.delete(g.key);     // expand
              else next.add(g.key);                         // collapse
              return next;
            })}
            medianCents={stats.medianCents}
            topPickSet={topPickSet}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
          />
        ))}
    </div>
  );
}
