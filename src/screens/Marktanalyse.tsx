/* Marktanalyse — third tab in LYNNE Table.
 *
 * Free-form Amazon.de search powered by RainforestAPI (server-side
 * 24h cache, frontend `useMarketSearch` adds a 6h client cache on top).
 * UI shows a sticky header (search input + force-refresh) and a table
 * of {title, seller, price, rating, reviews, link}.
 *
 * Rendered only when LynneTable's view==='marktanalyse'. Inherits the
 * `data-screen="lynne-table"` parent so the `.lt-*` classes from
 * lynne-table.css apply unchanged. */

import { useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ExternalLink,
  Package,
  RefreshCw,
  Search,
  Star,
} from 'lucide-react';

import { T } from '@/components/ui';
import type { MarketProduct } from '@/types/api';
import { ApiError } from '@/marathonApi';
import { useMarketRefresh, useMarketSearch } from '@/hooks/useMarketSearch';


type SortKey = 'position' | 'price' | 'rating' | 'reviews';
type SortDir = 'asc' | 'desc';

const DEFAULT_QUERY = 'thermorollen';
const PRICE_FORMATTER = new Intl.NumberFormat('de-DE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 2,
});
const COMPACT_FORMATTER = new Intl.NumberFormat('de-DE', {
  notation: 'compact',
  maximumFractionDigits: 1,
});


function PaperCard({ children, flat = false, style }: { children?: React.ReactNode; flat?: boolean; style?: React.CSSProperties }) {
  return (
    <div style={{
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
    }}>{children}</div>
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


function StateCard({ kind, message, onRetry }: { kind: 'empty' | 'error' | 'loading'; message?: string; onRetry?: () => void }) {
  if (kind === 'loading') {
    return (
      <>
        {Array.from({ length: 6 }).map((_, i) => (
          <PaperCard key={i} flat style={{ gap: 0 }}>
            <WhitePanel padding="18px 22px">
              <div className="lt-skel-row" style={{ height: 56, borderBottom: 'none' }} />
            </WhitePanel>
          </PaperCard>
        ))}
      </>
    );
  }
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


function ProductRow({ product }: { product: MarketProduct }) {
  const muted = product.isSponsored === true;
  const price = product.priceCents != null
    ? PRICE_FORMATTER.format(product.priceCents / 100)
    : '—';
  const rating = product.rating != null ? product.rating.toFixed(1).replace('.', ',') : null;
  const reviews = product.reviewsCount != null
    ? COMPACT_FORMATTER.format(product.reviewsCount)
    : '—';
  const sellerOrBrand = product.seller || product.brand || '—';

  return (
    <PaperCard flat style={{ gap: 0, opacity: muted ? 0.72 : 1 }}>
      <WhitePanel padding="14px 22px">
        <div className="lt-grid lt-grid-marktanalyse">
          <div style={{
            fontFamily: T.font.mono, fontSize: 11, color: T.text.faint, fontVariantNumeric: 'tabular-nums',
          }}>
            #{product.position}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <div
              title={product.title}
              style={{
                fontSize: 13.5, fontWeight: 600, color: T.text.primary,
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.3,
              }}
            >
              {product.title}
            </div>
            <div style={{
              display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
              fontFamily: T.font.mono, fontSize: 10.5, color: T.text.faint,
            }}>
              {product.asin && <span>{product.asin}</span>}
              {product.isSponsored && (
                <span className="lt-pill" data-channel="OTHER" style={{ fontSize: 9 }}>Anzeige</span>
              )}
              {product.isPrime && (
                <span className="lt-pill" data-channel="PRIME" style={{ fontSize: 9 }}>Prime</span>
              )}
            </div>
          </div>

          <div style={{ fontSize: 12.5, color: T.text.primary, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sellerOrBrand}
          </div>

          <div className="lt-col-num" style={{
            fontSize: 13.5, fontWeight: 600, color: T.text.primary, fontVariantNumeric: 'tabular-nums',
          }}>
            {price}
          </div>

          <div className="lt-col-num" style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end',
            fontFamily: T.font.mono, fontSize: 12, color: T.text.primary,
          }}>
            {rating ? <><Star size={11} fill="#F59E0B" stroke="#F59E0B" /> {rating}</> : <span style={{ color: T.text.faint }}>—</span>}
          </div>

          <div className="lt-col-num" style={{
            fontFamily: T.font.mono, fontSize: 12, color: T.text.faint, fontVariantNumeric: 'tabular-nums',
          }}>
            {reviews}
          </div>

          <div style={{ justifySelf: 'end' }}>
            <a
              href={product.url}
              target="_blank"
              rel="noopener noreferrer"
              title="Auf Amazon.de öffnen"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 28, height: 28, borderRadius: 999,
                background: '#FFFFFF', border: `1px solid ${T.border.primary}`,
                color: T.text.primary, textDecoration: 'none',
              }}
            >
              <ExternalLink size={12} strokeWidth={1.8} />
            </a>
          </div>
        </div>
      </WhitePanel>
    </PaperCard>
  );
}


export default function Marktanalyse() {
  const [draft, setDraft] = useState(DEFAULT_QUERY);
  const [submittedQuery, setSubmittedQuery] = useState(DEFAULT_QUERY);
  const [sortKey, setSortKey] = useState<SortKey>('position');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const search = useMarketSearch(submittedQuery, true);
  const refresh = useMarketRefresh();

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'position' ? 'asc' : 'desc');
    }
  };

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = draft.trim();
    if (!q) return;
    setSubmittedQuery(q);
    setSortKey('position');
    setSortDir('asc');
  };

  const handleForceRefresh = () => {
    if (refresh.isPending) return;
    refresh.mutate(submittedQuery);
  };

  const data = search.data;
  const products = data ? sortProducts(data.products, sortKey, sortDir) : [];

  const apiError = search.error instanceof ApiError ? search.error : null;
  const errorMessage = apiError?.status === 503
    ? 'Daten-Provider ist gerade nicht erreichbar.'
    : apiError?.message ?? search.error?.message ?? '';

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

            {data && (
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: 10,
                fontFamily: T.font.mono, fontSize: 11, color: T.text.faint,
              }}>
                <span>
                  {data.fromCache ? 'Cache' : 'Live'} · {data.resultCount} Treffer · {formatRelative(data.fetchedAt)}
                </span>
                <button
                  type="button"
                  onClick={handleForceRefresh}
                  disabled={refresh.isPending}
                  title="Live-Anfrage an RainforestAPI (verbraucht 1 Credit)"
                  style={{
                    all: 'unset', cursor: refresh.isPending ? 'progress' : 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    padding: '6px 12px', background: '#FFFFFF',
                    border: `1px solid ${T.border.primary}`, borderRadius: 999,
                    fontSize: 11.5, fontWeight: 600, color: T.text.primary,
                  }}
                >
                  <RefreshCw size={11} strokeWidth={2} /> Neu laden
                </button>
              </div>
            )}
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

      {/* Column header */}
      {data && products.length > 0 && (
        <PaperCard flat style={{ gap: 0 }}>
          <WhitePanel padding="10px 22px">
            <div className="lt-grid lt-grid-marktanalyse lt-colhead">
              <ColumnHeader label="#" sortKey="position" currentKey={sortKey} dir={sortDir} onSort={handleSort} />
              <ColumnHeader label="Titel" sortKey={null} currentKey={sortKey} dir={sortDir} onSort={handleSort} />
              <ColumnHeader label="Verkäufer / Marke" sortKey={null} currentKey={sortKey} dir={sortDir} onSort={handleSort} />
              <ColumnHeader label="Preis" sortKey="price" currentKey={sortKey} dir={sortDir} onSort={handleSort} numeric />
              <ColumnHeader label="Bewertung" sortKey="rating" currentKey={sortKey} dir={sortDir} onSort={handleSort} numeric />
              <ColumnHeader label="Rezensionen" sortKey="reviews" currentKey={sortKey} dir={sortDir} onSort={handleSort} numeric />
              <ColumnHeader label="" sortKey={null} currentKey={sortKey} dir={sortDir} onSort={handleSort} />
            </div>
          </WhitePanel>
        </PaperCard>
      )}

      {/* States */}
      {search.isLoading && <StateCard kind="loading" />}
      {!search.isLoading && search.isError && (
        <StateCard
          kind="error"
          message={errorMessage || 'Suche fehlgeschlagen'}
          onRetry={() => search.refetch()}
        />
      )}
      {!search.isLoading && !search.isError && data && products.length === 0 && (
        <StateCard kind="empty" message={`Keine Treffer für „${submittedQuery}"`} />
      )}

      {/* Rows */}
      {!search.isLoading && !search.isError && products.map((p) => (
        <ProductRow key={p.id} product={p} />
      ))}
    </div>
  );
}
