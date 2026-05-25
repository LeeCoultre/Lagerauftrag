// @ts-nocheck — legacy pallet-optimizer component (pre-Marathon); not in active code path
/* PalletStackViz — minimal glass-morphism side view of one EUR pallet.
   Bottom = Level 1 (Thermorollen), Top = Level 6 (Tachorollen).

   Sizes:
     "row"     — 36×72 inline cell, no labels (used in pallet table)
     "card"    — full card with frame + KPI rail (expanded review view)
     "story"   — 100×200 ambient sidebar viz for Focus mode
                 (mini labels, no KPI rail, optional `pulseLevel` glow)
     "mini"    — 64×128 thumbnail for Übersicht tiles (no labels)
     "compact" — 22×30 micro icon
*/

import { useState, useId } from 'react';
import { LEVEL_META } from '@/utils/auftragHelpers.js';
import { T } from './ui.jsx';

const PALLET_VOL_M3   = 1.59;
const PALLET_WEIGHT_KG = 700;

export default function PalletStackViz({ palletState, size = 'row', onClick, pulseLevel = null, radius: radiusOverride = null }) {
  const isCard = size === 'card';
  const isCompact = size === 'compact';
  const isStory = size === 'story';
  const isMini = size === 'mini';
  const W = isCard ? 168 : isStory ? 100 : isMini ? 64 : isCompact ? 22 : 36;
  const H = isCard ? 320 : isStory ? 200 : isMini ? 128 : isCompact ? 30 : 72;

  if (!palletState) {
    return (
      <div style={{
        width: W, height: H,
        background: 'rgba(255,255,255,0.5)',
        border: `1px dashed ${T.border.strong}`,
        borderRadius: isCard ? 14 : 6,
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }} />
    );
  }

  // Compute volume per level (cm³)
  const volByLevel = {};
  for (let lvl = 1; lvl <= 7; lvl++) {
    const items = palletState.byLevel?.[lvl] || [];
    volByLevel[lvl] = items.reduce((s, x) => s + (x.volCm3 || 0), 0);
  }
  const palletVolCm3 = PALLET_VOL_M3 * 1e6;

  const levelHeights = {};
  let totalUsedHeight = 0;
  for (let lvl = 1; lvl <= 7; lvl++) {
    const h = Math.min(1, volByLevel[lvl] / palletVolCm3) * H;
    levelHeights[lvl] = h;
    totalUsedHeight += h;
  }
  totalUsedHeight = Math.min(H, totalUsedHeight);

  const overloadW = palletState.overloadFlags?.has?.('OVERLOAD-W');
  const overloadV = palletState.overloadFlags?.has?.('OVERLOAD-V');
  const overloadCap = palletState.overloadFlags?.has?.('OVERLOAD-CAP');
  // NO_VALID_PLACEMENT is intentionally NOT a "flagged" trigger here:
  // the carton was still placed (least-bad fallback), so the pallet
  // itself isn't broken. Red flag is reserved for truly lost ESKU
  // (distribution.unassigned), surfaced in the preflight panel.
  const flagged = overloadW || overloadV || overloadCap;

  if (!isCard) {
    return (
      <PalletFrame
        palletState={palletState}
        levelHeights={levelHeights}
        volByLevel={volByLevel}
        totalUsedHeight={totalUsedHeight}
        W={W} H={H}
        showLabels={isStory}
        flagged={flagged}
        onClick={onClick}
        pulseLevel={pulseLevel}
        compactLabels={isStory}
        radiusOverride={radiusOverride}
      />
    );
  }

  const fillPct = Math.min(100, (palletState.volCm3 / palletVolCm3) * 100);
  const wgtPct = Math.min(100, (palletState.weightKg / PALLET_WEIGHT_KG) * 100);
  const freeM3 = Math.max(0, PALLET_VOL_M3 - palletState.volCm3 / 1e6);
  const freeKg = Math.max(0, PALLET_WEIGHT_KG - palletState.weightKg);

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `${W}px 1fr`,
      gap: 22,
      alignItems: 'flex-start',
      width: '100%',
    }}>
      <PalletFrame
        palletState={palletState}
        levelHeights={levelHeights}
        volByLevel={volByLevel}
        totalUsedHeight={totalUsedHeight}
        W={W} H={H}
        showLabels
        flagged={flagged}
        onClick={onClick}
      />
      <KPIRail
        volCm3={palletState.volCm3}
        weightKg={palletState.weightKg}
        fillPct={fillPct}
        wgtPct={wgtPct}
        freeM3={freeM3}
        freeKg={freeKg}
        overloadV={overloadV}
        overloadW={overloadW}
        overloadCap={overloadCap}
        anyEsku={palletState.anyEsku}
      />
    </div>
  );
}

/* ─── The frame: glass surface with soft layers ─────────────────────── */
function PalletFrame({
  palletState, levelHeights, volByLevel, totalUsedHeight,
  W, H, showLabels, flagged, onClick,
  pulseLevel = null, compactLabels = false, radiusOverride = null,
}) {
  const [hover, setHover] = useState(null);
  const patternId = useId().replace(/:/g, '');

  const radius = radiusOverride != null ? radiusOverride : (showLabels ? 14 : 6);
  // Stack bottom-up
  let yCursor = H;
  const layers = [];
  for (let lvl = 1; lvl <= 7; lvl++) {
    const h = levelHeights[lvl];
    if (h <= 0) continue;
    yCursor -= h;
    layers.push({ lvl, y: yCursor, h });
  }

  return (
    <div
      onClick={onClick}
      style={{
        position: 'relative',
        width: W,
        height: H,
        cursor: onClick ? 'pointer' : 'default',
        borderRadius: radius,
        background: T.bg.surface,
        border: `1px solid ${flagged ? T.status.danger.border : T.border.primary}`,
        boxShadow: flagged
          ? `0 4px 16px ${T.status.danger.bg}`
          : T.shadow.card,
        overflow: 'hidden',
        transition: 'box-shadow 220ms ease',
      }}
    >
      <svg
        width={W}
        height={H}
        style={{ display: 'block', overflow: 'visible' }}
      >
        <defs>
          {/* Subtle dot grid for empty space — "breathing room" feel */}
          <pattern id={`empty-${patternId}`} patternUnits="userSpaceOnUse"
                   width="10" height="10">
            <circle cx="2" cy="2" r="0.7" fill="rgba(15,23,42,0.06)" />
          </pattern>
          {/* Soft vertical gradient per level */}
          {Object.entries(LEVEL_META).map(([lvl, meta]) => (
            <linearGradient key={lvl} id={`lvl-${lvl}-${patternId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={meta.color} stopOpacity="0.92" />
              <stop offset="100%" stopColor={meta.color} stopOpacity="0.78" />
            </linearGradient>
          ))}
          {/* Clip path for rounded corners on the contents */}
          <clipPath id={`clip-${patternId}`}>
            <rect x={0} y={0} width={W} height={H} rx={radius} ry={radius} />
          </clipPath>
        </defs>

        <g clipPath={`url(#clip-${patternId})`}>

          {/* Filled layers */}
          {layers.map(({ lvl, y, h }) => {
            const isHover = hover === lvl;
            const isPulse = pulseLevel === lvl;
            const items = palletState.byLevel?.[lvl] || [];
            const eskuCount = items.filter((x) => x.source === 'esku').length;
            const lvlPct = (volByLevel[lvl] / (PALLET_VOL_M3 * 1e6)) * 100;

            return (
              <g
                key={lvl}
                onMouseEnter={() => setHover(lvl)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: 'default' }}
              >
                <rect
                  x={0}
                  y={y}
                  width={W}
                  height={h}
                  fill={`url(#lvl-${lvl}-${patternId})`}
                  opacity={isHover ? 1 : 0.96}
                  style={{
                    transition: 'opacity 180ms ease',
                    animation: 'pviz-rise 700ms cubic-bezier(0.16, 1, 0.3, 1) both',
                    transformOrigin: '0 100%',
                  }}
                />
                {/* Pulse overlay for the current artikel's level */}
                {isPulse && (
                  <rect
                    x={0}
                    y={y}
                    width={W}
                    height={h}
                    fill="#FFFFFF"
                    style={{
                      animation: 'pviz-pulse 2.4s ease-in-out infinite',
                      mixBlendMode: 'overlay',
                      pointerEvents: 'none',
                    }}
                  />
                )}
                {/* Top edge highlight — light line for "depth" */}
                <line
                  x1={0} x2={W}
                  y1={y + 0.5} y2={y + 0.5}
                  stroke="#FFFFFF"
                  strokeOpacity="0.45"
                  strokeWidth="1"
                />
                {showLabels && h >= (compactLabels ? 14 : 22) && (
                  <>
                    <text
                      x={compactLabels ? 8 : 12}
                      y={y + h / 2 + 4}
                      fontSize={compactLabels ? 9.5 : 11}
                      fontFamily={T.font.ui}
                      fill="#FFFFFF"
                      fontWeight={600}
                      style={{ letterSpacing: '0.02em' }}
                    >
                      L{lvl}
                    </text>
                    {!compactLabels && (
                      <text
                        x={W - 12}
                        y={y + h / 2 + 4}
                        fontSize={10.5}
                        fontFamily={T.font.ui}
                        fill="#FFFFFF"
                        fillOpacity="0.85"
                        fontWeight={500}
                        textAnchor="end"
                      >
                        {Math.round(lvlPct)}%
                      </text>
                    )}
                  </>
                )}
                {eskuCount > 0 && showLabels && h >= 16 && (
                  <circle cx={W - 10} cy={y + 8} r="2.5" fill="#FFFFFF" />
                )}
              </g>
            );
          })}

          {/* Subtle current-load line marker */}
          {totalUsedHeight > 0 && totalUsedHeight < H && showLabels && (
            <line
              x1={0} x2={W}
              y1={H - totalUsedHeight} y2={H - totalUsedHeight}
              stroke="rgba(15,23,42,0.18)"
              strokeWidth="0.75"
              strokeDasharray="3 3"
            />
          )}
        </g>
      </svg>

      {hover && showLabels && (
        <Tooltip
          level={hover}
          volCm3={volByLevel[hover]}
          items={palletState.byLevel?.[hover] || []}
          x={W + 10}
          y={layers.find((l) => l.lvl === hover)?.y ?? 0}
        />
      )}

      <style>{`
        @keyframes pviz-rise {
          from { transform: scaleY(0); }
          to   { transform: scaleY(1); }
        }
        @keyframes pviz-pulse {
          0%, 100% { opacity: 0; }
          50%      { opacity: 0.32; }
        }
        @media (prefers-reduced-motion: reduce) {
          @keyframes pviz-pulse { 0%, 100% { opacity: 0.18; } 50% { opacity: 0.18; } }
        }
      `}</style>
    </div>
  );
}

/* ─── KPI rail: numbers + soft progress + free-space ─────────────────── */
function KPIRail({
  volCm3, weightKg, fillPct, wgtPct, freeM3, freeKg,
  overloadV, overloadW, overloadCap, anyEsku,
}) {
  const volTone = overloadV ? 'danger' : fillPct >= 90 ? 'warn' : 'normal';
  const wgtTone = overloadW ? 'danger' : wgtPct >= 90 ? 'warn' : 'normal';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <KPI
        label="Volumen"
        bigValue={(volCm3 / 1e6).toFixed(2)}
        unit="m³"
        denominator="/ 1.59"
        pct={fillPct}
        tone={volTone}
      />
      <KPI
        label="Gewicht"
        bigValue={Math.round(weightKg)}
        unit="kg"
        denominator="/ 700"
        pct={wgtPct}
        tone={wgtTone}
      />
      <FreeBlock m3={freeM3} kg={freeKg} overloadV={overloadV} overloadW={overloadW} />
      {(anyEsku || overloadCap) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {anyEsku && <Pill tone="accent">+ ESKU verteilt</Pill>}
          {overloadCap && <Pill tone="danger">Kapazität überlastet</Pill>}
        </div>
      )}
    </div>
  );
}

function KPI({ label, bigValue, unit, denominator, pct, tone }) {
  const trackColor = tone === 'danger' ? T.status.danger.main
    : tone === 'warn' ? T.status.warn.main
    : T.text.primary;
  const valueColor = tone === 'danger' ? T.status.danger.text : T.text.primary;
  return (
    <div>
      <div style={{
        fontSize: 12,
        color: T.text.subtle,
        fontWeight: 500,
        marginBottom: 6,
        letterSpacing: '0.005em',
      }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 8 }}>
        <span style={{
          fontFamily: 'Montserrat, Inter, system-ui, sans-serif',
          fontSize: 28,
          fontWeight: 700,
          letterSpacing: '-0.025em',
          color: valueColor,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1,
        }}>
          {bigValue}
        </span>
        <span style={{
          fontSize: 12,
          color: T.text.faint,
          fontWeight: 500,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {denominator} {unit}
        </span>
      </div>
      <div style={{
        position: 'relative',
        height: 4,
        borderRadius: 999,
        background: 'rgba(15,23,42,0.06)',
        overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute',
          top: 0, left: 0,
          height: '100%',
          width: `${Math.min(100, pct)}%`,
          borderRadius: 999,
          background: trackColor,
          transition: 'width 700ms cubic-bezier(0.16, 1, 0.3, 1)',
        }} />
      </div>
      <div style={{
        marginTop: 4,
        fontSize: 11.5,
        fontWeight: 500,
        color: tone === 'danger' ? T.status.danger.text : T.text.subtle,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {tone === 'danger' ? `${Math.round(pct)}% · überladen` : `${Math.round(pct)}% belegt`}
      </div>
    </div>
  );
}

function FreeBlock({ m3, kg, overloadV, overloadW }) {
  return (
    <div style={{
      paddingTop: 12,
      borderTop: `1px solid rgba(15,23,42,0.06)`,
    }}>
      <div style={{
        fontSize: 12,
        color: T.text.subtle,
        fontWeight: 500,
        marginBottom: 6,
      }}>
        Frei
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'baseline' }}>
        <span style={{
          fontFamily: 'Montserrat, Inter, system-ui, sans-serif',
          fontSize: 18,
          fontWeight: 700,
          letterSpacing: '-0.02em',
          color: overloadV ? T.status.danger.text : T.text.primary,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {overloadV ? '–' : m3.toFixed(2)}
          <span style={{ fontSize: 11, color: T.text.faint, fontWeight: 500, marginLeft: 4 }}>m³</span>
        </span>
        <span style={{
          fontFamily: 'Montserrat, Inter, system-ui, sans-serif',
          fontSize: 18,
          fontWeight: 700,
          letterSpacing: '-0.02em',
          color: overloadW ? T.status.danger.text : T.text.primary,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {overloadW ? '–' : Math.round(kg)}
          <span style={{ fontSize: 11, color: T.text.faint, fontWeight: 500, marginLeft: 4 }}>kg</span>
        </span>
      </div>
    </div>
  );
}

function Pill({ tone, children }) {
  const palette =
    tone === 'danger' ? { bg: 'rgba(239,68,68,0.10)',  color: T.status.danger.text }
    : tone === 'warn' ? { bg: 'rgba(245,158,11,0.10)', color: T.status.warn.text }
    : { bg: T.accent.bg, color: T.accent.text };
  return (
    <div style={{
      padding: '5px 10px',
      background: palette.bg,
      color: palette.color,
      fontSize: 11.5,
      fontWeight: 600,
      borderRadius: 999,
      display: 'inline-flex',
      width: 'fit-content',
    }}>
      {children}
    </div>
  );
}

function Tooltip({ level, volCm3, items, x, y }) {
  const meta = LEVEL_META[level];
  const cartonCount = items.reduce((s, x) => s + (x.cartons || 0), 0);
  const weightKg = items.reduce((s, x) => s + (x.weightKg || 0), 0);
  const eskuCount = items.filter((x) => x.source === 'esku').length;
  return (
    <div style={{
      position: 'absolute',
      left: x, top: y,
      zIndex: 50,
      background: 'rgba(15,23,42,0.92)',
      backdropFilter: 'blur(8px)',
      WebkitBackdropFilter: 'blur(8px)',
      color: '#FFFFFF',
      padding: '10px 12px',
      fontSize: 11.5,
      fontFamily: T.font.ui,
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      borderRadius: 10,
      boxShadow: '0 6px 24px rgba(15,23,42,0.25)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{
          width: 8, height: 8, borderRadius: 999,
          background: meta.color,
        }} />
        <strong style={{ fontSize: 12 }}>L{level} · {meta.shortName}</strong>
      </div>
      <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: 11 }}>
        {cartonCount} {cartonCount === 1 ? 'Karton' : 'Kartons'}
        {' · '}{weightKg.toFixed(1)} kg
        {' · '}{(volCm3 / 1e6).toFixed(3)} m³
      </div>
      {eskuCount > 0 && (
        <div style={{
          color: '#FF8A4D',
          fontSize: 11, marginTop: 3,
          fontWeight: 600,
        }}>
          + {eskuCount} ESKU
        </div>
      )}
    </div>
  );
}