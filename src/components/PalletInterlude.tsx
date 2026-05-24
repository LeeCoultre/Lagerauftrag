// @ts-nocheck — legacy pallet-optimizer component (pre-Marathon); not in active code path
/* PalletInterlude — pallet-completion checkpoint.

   Two variants of the same layout, switched by the global beta-design
   flag (see `useBetaDesign`):

   • Classic (default): minimalist single-surface card, hairline
     divider between «Abgeschlossen» and «Nächste Palette», generic
     primary Button. Unchanged from the pre-beta design.

   • Beta: paper-grey #F4F5F7 card with a 2px white rim + soft halo,
     two nested WHITE sub-panels separating the sections, accent-tinted
     time pill, accent-pill action button. Matches the FlowHero /
     BetaIslandBar vocabulary.

   The gate is the same in both modes: Space / Enter confirms; overlay
   click does NOT dismiss. */

import { useEffect } from 'react';
import { Button, T } from './ui.jsx';
import { LEVEL_META, getDisplayLevel } from '@/utils/auftragHelpers.js';
import { useBetaDesign } from '@/hooks/useBetaDesign';

export default function PalletInterlude({
  pallet,            // { id, itemCount, weightKg, volCm3, durationMs }
  nextPallet,        // { id, items, ... }
  nextHints,         // [{ tone: 'danger'|'warn'|'info', label, detail? }]
  reducedMotion = false,
  onComplete,
}) {
  const { beta } = useBetaDesign();
  const hints = nextHints || [];

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        onComplete?.();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onComplete]);

  const time = fmtDuration(pallet?.durationMs || 0);
  const fadeMs = reducedMotion ? 100 : 280;

  if (beta) {
    return (
      <BetaInterlude
        pallet={pallet}
        nextPallet={nextPallet}
        hints={hints}
        time={time}
        fadeMs={fadeMs}
        onComplete={onComplete}
      />
    );
  }

  return (
    <ClassicInterlude
      pallet={pallet}
      nextPallet={nextPallet}
      hints={hints}
      time={time}
      fadeMs={fadeMs}
      onComplete={onComplete}
    />
  );
}

/* ══════════════════════════════════════════════════════════════════════
   CLASSIC variant — unchanged pre-beta layout.
   ══════════════════════════════════════════════════════════════════════ */
function ClassicInterlude({ pallet, nextPallet, hints, time, fadeMs, onComplete }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 800,
        background: 'rgba(17, 24, 39, 0.42)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
        animation: `interlude-bg-in ${fadeMs}ms cubic-bezier(0.16, 1, 0.3, 1) both`,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 480,
          background: T.bg.surface,
          border: `1px solid ${T.border.primary}`,
          borderRadius: 16,
          padding: '32px 36px 28px',
          fontFamily: T.font.ui,
          animation: `interlude-card-in ${fadeMs * 1.4}ms cubic-bezier(0.16, 1, 0.3, 1) both`,
        }}
      >
        <Eyebrow color={T.status.success.text} icon={<CheckIcon />}>
          Abgeschlossen
        </Eyebrow>
        <div style={{
          marginTop: 10,
          display: 'flex',
          alignItems: 'baseline',
          gap: 14,
          flexWrap: 'wrap',
        }}>
          <span style={{
            fontFamily: T.font.mono,
            fontSize: 'clamp(32px, 4.2vw, 44px)',
            fontWeight: 500,
            letterSpacing: '-0.025em',
            color: T.text.primary,
            lineHeight: 1,
          }}>
            {pallet?.id || '—'}
          </span>
          <span style={{
            fontFamily: T.font.mono,
            fontSize: 13,
            color: T.text.faint,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '0.02em',
          }}>
            {time}
          </span>
        </div>

        {nextPallet && <Hairline />}

        {nextPallet && (
          <>
            <Eyebrow>Nächste Palette</Eyebrow>
            <NextPalletPreview pallet={nextPallet} />
            {hints.length > 0 && <HintList hints={hints} />}
          </>
        )}

        <div style={{
          marginTop: 28,
          display: 'flex',
          justifyContent: 'flex-end',
        }}>
          <Button variant="primary" onClick={onComplete}
                  title="Nächste Palette starten (Space)">
            {nextPallet ? `${nextPallet.id} starten` : 'Weiter'}
            <ClassicKbd onPrimary>Space</ClassicKbd>
          </Button>
        </div>
      </div>

      <SharedKeyframes />
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   BETA variant — matches the new bottom-bar / hero-card vocabulary.
   ══════════════════════════════════════════════════════════════════════ */
function BetaInterlude({ pallet, nextPallet, hints, time, fadeMs, onComplete }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 800,
        background: 'rgba(15, 23, 42, 0.32)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
        animation: `interlude-bg-in ${fadeMs}ms cubic-bezier(0.16, 1, 0.3, 1) both`,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 520,
          padding: 8,
          background: '#F4F5F7',
          border: '2px solid #FFFFFF',
          borderRadius: 32,
          boxShadow: '0 0 89.7px 0 rgba(0, 0, 0, 0.05)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          fontFamily: T.font.ui,
          animation: `interlude-card-in ${fadeMs * 1.4}ms cubic-bezier(0.16, 1, 0.3, 1) both`,
        }}
      >
        <BetaPanel>
          <Eyebrow color={T.status.success.text} icon={<CheckIcon />}>
            Abgeschlossen
          </Eyebrow>
          <div style={{
            marginTop: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}>
            <span style={{
              fontFamily: T.font.mono,
              fontSize: 'clamp(34px, 4.4vw, 48px)',
              fontWeight: 600,
              letterSpacing: '-0.025em',
              color: T.text.primary,
              lineHeight: 1,
            }}>
              {pallet?.id || '—'}
            </span>
            <span title={`Dauer · ${time}`} style={{
              fontFamily: T.font.mono,
              fontSize: 13,
              fontWeight: 700,
              color: 'var(--accent)',
              letterSpacing: '0.02em',
              fontVariantNumeric: 'tabular-nums',
              flexShrink: 0,
            }}>
              {time}
            </span>
          </div>
        </BetaPanel>

        {nextPallet && (
          <BetaPanel>
            <Eyebrow>Nächste Palette</Eyebrow>
            <NextPalletPreview pallet={nextPallet} />
            {hints.length > 0 && <HintList hints={hints} />}
          </BetaPanel>
        )}

        <div style={{
          padding: '4px 8px 8px',
          display: 'flex',
          justifyContent: 'flex-end',
        }}>
          <button
            type="button"
            onClick={onComplete}
            title="Nächste Palette starten (Space)"
            style={{
              all: 'unset',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 12,
              padding: '12px 22px',
              background: 'var(--accent)',
              color: '#FFFFFF',
              borderRadius: 999,
              fontFamily: T.font.ui,
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: '-0.005em',
              cursor: 'pointer',
              transition: 'transform 200ms cubic-bezier(0.16, 1, 0.3, 1), filter 200ms ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-1px)';
              e.currentTarget.style.filter = 'brightness(1.05)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'none';
              e.currentTarget.style.filter = 'none';
            }}
          >
            {nextPallet ? `${nextPallet.id} starten` : 'Weiter'}
            <BetaKbd>Space</BetaKbd>
          </button>
        </div>
      </div>

      <SharedKeyframes />
    </div>
  );
}

function BetaPanel({ children }) {
  return (
    <div style={{
      background: '#FFFFFF',
      borderRadius: 24,
      padding: '22px 26px',
    }}>
      {children}
    </div>
  );
}

function BetaKbd({ children }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 30, height: 20,
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

/* ══════════════════════════════════════════════════════════════════════
   SHARED atoms — used by both variants.
   ══════════════════════════════════════════════════════════════════════ */

function Hairline() {
  return (
    <div style={{
      height: 1,
      background: T.border.subtle,
      margin: '24px 0',
    }} />
  );
}

function Eyebrow({ children, color, icon }) {
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 10.5,
      fontWeight: 600,
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

function NextPalletPreview({ pallet }) {
  const items = pallet?.items || [];
  const total = items.length;
  return (
    <div style={{
      marginTop: 10,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 12,
        fontFamily: T.font.mono,
      }}>
        <span style={{
          fontSize: 'clamp(22px, 2.6vw, 28px)',
          fontWeight: 500,
          color: T.text.primary,
          letterSpacing: '-0.018em',
          lineHeight: 1,
        }}>
          {pallet?.id}
        </span>
        <span style={{
          fontSize: 12.5,
          color: T.text.faint,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '0.02em',
        }}>
          {total} Artikel
        </span>
      </div>

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
        marginTop: 4,
      }}>
        {items.map((it, j) => {
          const lvl = it.level || getDisplayLevel(it) || 1;
          const meta = LEVEL_META[lvl] || LEVEL_META[1];
          return (
            <span
              key={j}
              aria-hidden
              style={{
                width: 22,
                height: 3,
                borderRadius: 2,
                background: meta.color,
                opacity: 0.8,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function HintList({ hints }) {
  return (
    <ul style={{
      margin: '14px 0 0 0',
      padding: 0,
      listStyle: 'none',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    }}>
      {hints.map((h, i) => (
        <HintLine key={i} tone={h.tone} label={h.label} detail={h.detail} />
      ))}
    </ul>
  );
}

function HintLine({ tone, label, detail }) {
  const palette = tone === 'danger'
    ? { dot: T.status.danger.main, text: T.status.danger.text }
    : tone === 'warn'
    ? { dot: T.status.warn.main,   text: T.status.warn.text }
    : { dot: T.accent.main,        text: T.text.primary };
  return (
    <li style={{
      display: 'grid',
      gridTemplateColumns: 'auto auto 1fr',
      alignItems: 'center',
      gap: 10,
      fontSize: 13,
      lineHeight: 1.4,
    }}>
      <span aria-hidden style={{
        width: 7, height: 7,
        borderRadius: '50%',
        background: palette.dot,
        flexShrink: 0,
      }} />
      <span style={{
        color: palette.text,
        fontWeight: 600,
        letterSpacing: '-0.005em',
        whiteSpace: 'nowrap',
      }}>
        {label}
      </span>
      {detail && (
        <span style={{
          color: T.text.faint,
          fontFamily: T.font.mono,
          fontSize: 11.5,
          fontVariantNumeric: 'tabular-nums',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          · {detail}
        </span>
      )}
    </li>
  );
}

function ClassicKbd({ children, onPrimary }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 22, height: 18,
      padding: '0 6px',
      fontSize: 10.5, fontFamily: T.font.mono, fontWeight: 600,
      color: onPrimary ? '#fff' : T.text.secondary,
      background: onPrimary ? 'var(--bg-glass-on-accent)' : T.bg.surface3,
      border: `1px solid ${onPrimary ? 'var(--bg-glass-on-accent-border)' : T.border.primary}`,
      borderRadius: 3,
      lineHeight: 1,
      letterSpacing: '0.04em',
    }}>{children}</span>
  );
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <path d="M2.5 6.5l2 2 5-5.5" stroke="currentColor" strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function SharedKeyframes() {
  return (
    <style>{`
      @keyframes interlude-bg-in {
        from { opacity: 0; }
        to   { opacity: 1; }
      }
      @keyframes interlude-card-in {
        from { opacity: 0; transform: translateY(14px) scale(0.98); }
        to   { opacity: 1; transform: translateY(0)    scale(1); }
      }
    `}</style>
  );
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm === 0 ? `${h}h` : `${h}h ${mm}m`;
}

/* Legacy export kept as a no-op — Focus.tsx still imports `resetSkipCount`. */
/* eslint-disable react-refresh/only-export-components -- legacy no-op export */
export function resetSkipCount() { /* deprecated */ }
