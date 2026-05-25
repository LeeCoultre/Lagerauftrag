// @ts-nocheck — legacy pallet-optimizer component (pre-Marathon); not in active code path
/* PalletStoryCard — 3-zone redesign.

   Zones:
     1. Stack-hero (left rail, 100×200)
     2. Identity + headline + items (right column)
     3. Capacity-line (one mono row at bottom)

   Removed vs. previous version:
     • Decorative giant "01" watermark, accent halo, floating fill-badge
     • Subtitle line + narrative paragraph (duplicated headline)
     • Separate Levels-Verteilung section (bar + chip-row — both gone)
     • Per-item level text chip (color dot now carries the tooltip)
     • Footer 4-stat grid + Formate counter
     • All eyebrow labels and 3 dividers (now just 1)

   Tone is signalled by a single colored dot leading the headline.
*/

import { useRef, useState } from 'react';
import {
  formatItemTitle, getDisplayLevel, LEVEL_META, eskuOverrideKey, largeBaseRank, sortItemsForPallet,
} from '@/utils/auftragHelpers.js';
import PalletStackViz from './PalletStackViz.jsx';
import EskuMovePopover from './EskuMovePopover.jsx';
import { T } from './ui.jsx';

const TOP_ITEMS_VISIBLE = 5;
const PALLET_VOL_M3 = 1.59;
const PALLET_WEIGHT_KG = 700;

export default function PalletStoryCard({
  pallet, story, items, eskuAssigned, palletState,
  allPallets, palletStates, eskuDist, eskuOverrides, onMoveEsku,
  bare = false,
}) {
  const [showAllItems, setShowAllItems] = useState(false);
  const [hover, setHover] = useState(false);

  const accentMeta = LEVEL_META[pallet.level] || LEVEL_META[1];

  /* Mirror Focus item ordering:
     • Large-base ESKU (80×80 → rank 2, 58×64 / 57×63 → rank 1) lays the
       physical base BEFORE Mixed.
     • Non-base ESKU (rank 0) gets merged with Mixed and re-sorted by
       level via sortItemsForPallet — so an L1 ESKU 80×63 lands in the
       L1 group with Mixed L1, not dumped after L5+. */
  const base80    = eskuAssigned.filter((it) => largeBaseRank(it) === 2);
  const baseOther = eskuAssigned.filter((it) => largeBaseRank(it) === 1);
  const restEsku  = eskuAssigned.filter((it) => largeBaseRank(it) === 0);
  const combined  = sortItemsForPallet([...items, ...restEsku]);
  const ranked = [
    ...base80.map((it) => ({ source: 'esku', item: it })),
    ...baseOther.map((it) => ({ source: 'esku', item: it })),
    ...combined.map((it) => ({ source: it.isEinzelneSku ? 'esku' : 'mixed', item: it })),
  ];
  const visibleItems = showAllItems ? ranked : ranked.slice(0, TOP_ITEMS_VISIBLE);
  const hiddenCount = ranked.length - visibleItems.length;

  const cap = story.capacity;
  const fillPct = cap.fillPct ?? cap.volumePct;
  const fillValue = Math.round(fillPct * 100);
  const overWeight = cap.weightPct > 1;
  const overVolume = cap.volumePct > 1;
  const overFill = fillPct > 1;

  const toneColor = mapToneColor(story.tone);

  return (
    <article
      id={`pallet-row-${pallet.id}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={bare ? {
        position: 'relative',
        padding: 0,
        background: 'transparent',
        border: 0,
        borderRadius: 0,
        scrollMarginTop: 120,
        display: 'grid',
        gridTemplateColumns: '100px 1fr',
        gap: 24,
        boxShadow: 'none',
        transition: 'none',
      } : {
        position: 'relative',
        padding: 24,
        background: T.bg.surface,
        border: `1px solid ${T.border.primary}`,
        borderRadius: 18,
        scrollMarginTop: 80,
        display: 'grid',
        gridTemplateColumns: '100px 1fr',
        gap: 24,
        transform: hover ? 'translateY(-1px)' : 'translateY(0)',
        boxShadow: hover
          ? '0 18px 36px -22px rgba(17,24,39,0.11)'
          : '0 8px 24px -20px rgba(17,24,39,0.05)',
        transition: 'transform 220ms cubic-bezier(0.16,1,0.3,1), box-shadow 220ms cubic-bezier(0.16,1,0.3,1)',
      }}
    >
      {/* ─── ZONE 1 — Stack hero ─────────────────────────────── */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 10,
      }}>
        <PalletStackViz palletState={palletState} size="story" />
        <span style={{
          fontFamily: T.font.mono,
          fontSize: 12,
          fontWeight: 600,
          color: T.text.primary,
          letterSpacing: '-0.005em',
        }}>
          {pallet.id}
        </span>
      </div>

      {/* ─── ZONE 2 — Identity + items ───────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Chip row */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}>
          <LevelChip meta={accentMeta} level={pallet.level} />
          {eskuAssigned.length > 0 && <EskuChip count={eskuAssigned.length} />}
        </div>

        {/* Headline (with leading tone-dot) */}
        <h3 style={{
          margin: '12px 0 0',
          fontSize: 20,
          fontWeight: 500,
          color: T.text.primary,
          letterSpacing: '-0.02em',
          lineHeight: 1.2,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          minWidth: 0,
        }}>
          <span style={{
            width: 8, height: 8,
            borderRadius: '50%',
            background: toneColor,
            flexShrink: 0,
            boxShadow: `0 0 0 3px ${toneColor}22`,
          }} />
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {story.headline}
          </span>
        </h3>

        {/* Items */}
        <div style={{ marginTop: 16 }}>
          {visibleItems.map((row, i) => (
            <ItemRow
              key={`${row.source}-${i}`}
              row={row}
              isLast={i === visibleItems.length - 1}
              currentPalletId={pallet.id}
              allPallets={allPallets}
              palletStates={palletStates}
              eskuDist={eskuDist}
              eskuOverrides={eskuOverrides}
              onMoveEsku={onMoveEsku}
            />
          ))}

          {(hiddenCount > 0 || (showAllItems && ranked.length > TOP_ITEMS_VISIBLE)) && (
            <button
              type="button"
              onClick={() => setShowAllItems((v) => !v)}
              style={{
                marginTop: 8,
                padding: '4px 2px',
                fontSize: 11.5,
                fontWeight: 500,
                color: T.text.subtle,
                background: 'transparent',
                border: 0,
                cursor: 'pointer',
                fontFamily: T.font.ui,
                letterSpacing: '-0.005em',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = T.text.primary; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = T.text.subtle; }}
            >
              {showAllItems ? '— weniger' : `+${hiddenCount} weitere`}
            </button>
          )}
        </div>

        {/* Single divider */}
        <div style={{
          height: 1,
          background: T.border.primary,
          margin: '16px 0',
        }} />

        {/* ─── ZONE 3 — Capacity line ─────────────────────────── */}
        <CapacityLine
          cap={cap}
          fillValue={fillValue}
          overWeight={overWeight}
          overVolume={overVolume}
          overFill={overFill}
        />
      </div>
    </article>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Small atoms — chips, capacity line.
   ════════════════════════════════════════════════════════════════════════ */
function mapToneColor(tone) {
  if (tone === 'warn' || tone === 'special') return T.status.warn.main;
  if (tone === 'danger') return T.status.danger.main;
  if (tone === 'accent') return T.accent.main;
  if (tone === 'cool')   return '#3B82F6';
  return T.status.success.main;
}

function LevelChip({ meta, level }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 7,
      padding: '3px 9px',
      background: meta.bg,
      border: `1px solid ${meta.color}30`,
      borderRadius: 999,
      fontSize: 11,
      fontFamily: T.font.mono,
      fontWeight: 700,
      color: meta.text,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
    }}>
      <span style={{ width: 7, height: 7, background: meta.color, borderRadius: 2 }} />
      L{level} {meta.shortName}
    </span>
  );
}

function EskuChip({ count }) {
  return (
    <span style={{
      fontSize: 11,
      color: T.accent.text,
      fontWeight: 700,
      fontFamily: T.font.mono,
      padding: '3px 9px',
      background: T.accent.bg,
      border: `1px solid ${T.accent.border}`,
      borderRadius: 999,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
    }}>
      +{count} ESKU
    </span>
  );
}

function CapacityLine({ cap, fillValue, overWeight, overVolume, overFill }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'baseline',
      gap: 14,
      flexWrap: 'wrap',
      fontFamily: T.font.mono,
      fontVariantNumeric: 'tabular-nums',
      fontSize: 12.5,
      letterSpacing: '-0.005em',
    }}>
      <CapPart
        value={`${cap.volumeM3.toFixed(2)} / ${PALLET_VOL_M3.toFixed(2)}`}
        unit="m³"
        hot={overVolume}
      />
      <Sep />
      <CapPart
        value={`${Math.round(cap.weightKg)} / ${PALLET_WEIGHT_KG}`}
        unit="kg"
        hot={overWeight}
      />
      <Sep />
      <CapPart
        value={`${fillValue}%`}
        unit="Auslastung"
        unitLow
        hot={overFill}
      />
    </div>
  );
}

function Sep() {
  return <span style={{ color: T.border.strong }}>·</span>;
}

function CapPart({ value, unit, hot, unitLow }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'baseline',
      gap: 5,
    }}>
      <span style={{
        color: hot ? T.status.danger.text : T.text.primary,
        fontWeight: 600,
      }}>
        {value}
      </span>
      <span style={{
        fontSize: unitLow ? 10 : 11,
        color: hot ? T.status.danger.text : T.text.faint,
        textTransform: unitLow ? 'uppercase' : 'none',
        letterSpacing: unitLow ? '0.08em' : 'normal',
        fontWeight: unitLow ? 600 : 500,
      }}>
        {unit}
      </span>
    </span>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   ItemRow — collapsed by default. Click row → toggle full detail panel
   (mirrors Focus.PalletListOverlay's ArticleDetailPanel: title + every
   code we have + meta chips). ESKU move stays on the row.
   ════════════════════════════════════════════════════════════════════════ */
function ItemRow({
  row, isLast,
  currentPalletId, allPallets, palletStates, eskuDist, eskuOverrides, onMoveEsku,
}) {
  const it = row.item;
  const lvl = getDisplayLevel(it);
  const meta = LEVEL_META[lvl] || LEVEL_META[1];
  const isEsku = row.source === 'esku';
  const cartonsHere = it.placementMeta?.cartonsHere;
  const qty = isEsku
    ? (cartonsHere ?? it.einzelneSku?.cartonsCount ?? 1)
    : (it.units || 0);
  const qtyUnit = isEsku ? 'Krt' : 'Stk';
  const title = formatItemTitle(it.title);
  const [hover, setHover] = useState(false);
  const [popOpen, setPopOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const triggerRef = useRef(null);

  const canMove = isEsku && typeof onMoveEsku === 'function' && allPallets?.length > 1;
  const itemKey = isEsku ? eskuOverrideKey(it) : '';
  const isOverridden = isEsku && !!(eskuOverrides && itemKey && eskuOverrides[itemKey]);

  return (
    <div style={{
      borderBottom: !isLast ? `1px solid ${T.border.subtle}` : 'none',
      margin: '0 -8px',
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
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={isEsku && isOverridden ? `${it.title}\n· Manuell verschoben` : it.title}
        style={{
          position: 'relative',
          display: 'grid',
          gridTemplateColumns: '8px 1fr auto auto',
          alignItems: 'center',
          gap: 12,
          padding: '8px',
          background: expanded
            ? (isEsku ? T.accent.bg : T.bg.surface2)
            : hover ? (isEsku ? T.accent.bg : T.bg.surface2) : 'transparent',
          borderRadius: 4,
          cursor: 'pointer',
          transition: 'background 140ms',
        }}
      >
        <span style={{
          width: 8, height: 8,
          borderRadius: 2,
          background: meta.color,
          flexShrink: 0,
        }} />

        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minWidth: 0,
        }}>
          {isEsku && (
            <span style={{
              flexShrink: 0,
              padding: '1px 5px',
              fontSize: 9,
              fontWeight: 800,
              letterSpacing: '0.1em',
              fontFamily: T.font.mono,
              color: T.accent.text,
              background: T.bg.surface,
              border: `1px solid ${T.accent.border}`,
              borderRadius: 3,
              textTransform: 'uppercase',
            }}>
              ESKU{isOverridden ? '·↪' : ''}
            </span>
          )}
          <span style={{
            fontSize: 13,
            fontWeight: isEsku ? 600 : 500,
            color: T.text.primary,
            letterSpacing: '-0.005em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}>
            {title}
          </span>
        </div>

        <div style={{
          textAlign: 'right',
          fontFamily: T.font.mono,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}>
          <span style={{
            fontSize: 14,
            fontWeight: 600,
            color: T.text.primary,
            letterSpacing: '-0.01em',
          }}>
            {qty.toLocaleString('de-DE')}
          </span>
          <span style={{
            marginLeft: 4,
            fontSize: 10,
            color: T.text.faint,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            fontWeight: 600,
          }}>
            {qtyUnit}
          </span>
        </div>

        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}>
          {canMove && (
            <>
              <button
                ref={triggerRef}
                type="button"
                onClick={(e) => { e.stopPropagation(); setPopOpen((v) => !v); }}
                title="ESKU auf andere Palette verschieben"
                style={{
                  width: 22, height: 22,
                  padding: 0,
                  fontSize: 12,
                  fontFamily: T.font.mono,
                  fontWeight: 700,
                  color: isOverridden ? T.accent.text : T.text.subtle,
                  background: isOverridden ? T.accent.bg : 'transparent',
                  border: `1px solid ${isOverridden ? T.accent.border : T.border.primary}`,
                  borderRadius: 999,
                  cursor: 'pointer',
                  opacity: hover || isOverridden || popOpen ? 1 : 0,
                  transition: 'opacity 140ms, background 140ms',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                ↪
              </button>
              <EskuMovePopover
                open={popOpen}
                anchorEl={triggerRef.current}
                pallets={allPallets}
                palletStates={palletStates}
                byPalletId={eskuDist}
                currentPalletId={currentPalletId}
                isOverridden={isOverridden}
                onPick={(targetId) => onMoveEsku(itemKey, targetId)}
                onClose={() => setPopOpen(false)}
              />
            </>
          )}
          <span
            aria-hidden
            style={{
              width: 16, height: 16,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: T.text.faint,
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 180ms cubic-bezier(0.16,1,0.3,1)',
              opacity: hover || expanded ? 1 : 0.55,
            }}
          >
            <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
              <path d="M2 1l4 3.5-4 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </div>
      </div>

      {expanded && <ItemDetailPanel item={it} level={lvl} levelMeta={meta} isEsku={isEsku} />}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   ItemDetailPanel — full read-only article info, mirrors the panel in
   Focus.PalletListOverlay. Title + every code we have + meta chips.
   ════════════════════════════════════════════════════════════════════════ */
function ItemDetailPanel({ item, level, levelMeta, isEsku }) {
  const codes: Array<[string, string | null | undefined]> = [
    ['FNSKU',    item.fnsku],
    ['SKU',      item.sku],
    ['EAN',      item.ean],
    ['ASIN',     item.asin],
    ['Use-Item', item.useItem],
  ];
  const visibleCodes = codes.filter(([, v]) => v);
  const flags = (item.placementMeta?.flags || []) as unknown[];
  const lst = deriveLstLabel(item.title || '');
  const eskuCartons = isEsku
    ? (item.placementMeta?.cartonsHere ?? item.einzelneSku?.cartonsCount ?? null)
    : null;
  const eskuPacksPerCarton = isEsku ? (item.einzelneSku?.packsPerCarton ?? null) : null;

  return (
    <div style={{
      padding: '12px 16px 14px 28px',
      background: T.bg.surface2,
      borderTop: `1px dashed ${T.border.subtle}`,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      animation: 'mp-prf-rise 220ms cubic-bezier(0.16,1,0.3,1)',
    }}>
      <DetailField label="Titel" value={item.title || '—'} multiline />

      {visibleCodes.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '8px 18px',
        }}>
          {visibleCodes.map(([k, v]) => (
            <DetailField key={k} label={k} value={String(v)} mono />
          ))}
        </div>
      )}

      {item.dimStr && (
        <DetailField label="Maße" value={item.dimStr} mono />
      )}

      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '6px 8px',
        alignItems: 'center',
      }}>
        <PillChip>
          <span style={{ width: 6, height: 6, background: levelMeta.color, borderRadius: 2, marginRight: 5 }} />
          L{level} {levelMeta.name}
        </PillChip>
        {item.units != null && !isEsku && (
          <PillChip>× {item.units.toLocaleString('de-DE')} Stück</PillChip>
        )}
        {isEsku && eskuCartons != null && (
          <PillChip accent>⬢ ESKU · {eskuCartons} Karton{eskuCartons === 1 ? '' : 's'}</PillChip>
        )}
        {isEsku && eskuPacksPerCarton != null && (
          <PillChip>{eskuPacksPerCarton} Einh./Karton</PillChip>
        )}
        {lst && <PillChip>{lst}</PillChip>}
        {flags.map((f, k) => (
          <PillChip key={k} warn>{String(f)}</PillChip>
        ))}
      </div>
    </div>
  );
}

function DetailField({ label, value, mono, multiline }) {
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

function PillChip({ children, accent, warn }) {
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

/* Local mirror of focusItemView's LST detection — no need to import the
   whole helper just for one boolean. */
function deriveLstLabel(title) {
  if (!title) return null;
  const t = title;
  if (/\bmit\s+lst\b/i.test(t)) return 'mit LST';
  if (/\bohne\s+lst\b/i.test(t)) return 'ohne LST';
  if (/\bohne\s+(?:sepa[-\s]*)?lastschrift(?:text)?\b/i.test(t)) return 'ohne LST';
  if (/\b(?:sepa[-\s]*)?lastschrift(?:text)?\b/i.test(t)) return 'mit LST';
  if (/\bsepa[-\s]*druck\b/i.test(t)) return 'mit LST';
  return null;
}
