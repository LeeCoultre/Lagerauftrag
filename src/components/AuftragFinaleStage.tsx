/* AuftragFinaleStage — final transition card when the last article of
   the last pallet has been completed.

   Two variants, switched by `useBetaDesign`:

   • Classic (default): plain bordered card on a light dimmer, no
     glass / blur / aurora. Big checkmark, total stats, hard gate
     (Space/Enter or click).

   • Beta: paper-grey #F4F5F7 card with 2px white rim + soft halo,
     two nested white sub-panels (header · stats), accent-pill action
     button with translucent kbd. Same vocabulary as FlowHero /
     BetaIslandBar / PalletInterlude (beta variant).

   Reduce-motion: collapses to a quick opacity fade in both modes. */

import { useEffect } from 'react';
import { Button, T } from './ui.jsx';
import { useBetaDesign } from '@/hooks/useBetaDesign';

export default function AuftragFinaleStage({
  totals,
  reducedMotion = false,

  schnellmodus: _schnellmodus = false,
  onComplete,
}) {
  const { beta } = useBetaDesign();
  /* Hard gate: no auto-advance, no overlay-click dismiss. The worker
     must explicitly press Space/Enter or click the action button so
     they read the completion summary intentionally before the route
     change to Abschluss. */
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

  const m3   = ((totals?.volCm3 || 0) / 1e6).toFixed(2);
  const kg   = Math.round(totals?.weightKg || 0);
  const time = fmtLong(totals?.durationMs || 0);
  const fadeMs = reducedMotion ? 120 : 320;

  const stats = [
    { label: 'Paletten', value: totals?.palletCount ?? '—' },
    { label: 'Artikel',  value: totals?.itemCount   ?? '—' },
    { label: 'Gewicht',  value: `${kg} kg` },
    { label: 'Volumen',  value: `${m3} m³` },
    { label: 'Dauer',    value: time },
  ];

  if (beta) {
    return (
      <BetaFinale
        totals={totals}
        stats={stats}
        reducedMotion={reducedMotion}
        fadeMs={fadeMs}
        onComplete={onComplete}
      />
    );
  }

  return (
    <ClassicFinale
      totals={totals}
      stats={stats}
      reducedMotion={reducedMotion}
      fadeMs={fadeMs}
      onComplete={onComplete}
    />
  );
}

/* ══════════════════════════════════════════════════════════════════════
   CLASSIC — unchanged pre-beta layout.
   ══════════════════════════════════════════════════════════════════════ */
function ClassicFinale({ stats, reducedMotion, fadeMs, onComplete }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 900,
        background: 'rgba(17, 24, 39, 0.32)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
        animation: `finale-bg-in ${fadeMs}ms cubic-bezier(0.16, 1, 0.3, 1) both`,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 540,
          padding: '36px 40px',
          background: T.bg.surface,
          border: `1px solid ${T.border.primary}`,
          borderRadius: 20,
          boxShadow: 'none',
          fontFamily: T.font.ui,
          textAlign: 'center',
          cursor: 'default',
          animation: `finale-card-in ${fadeMs * 1.4}ms cubic-bezier(0.16, 1, 0.3, 1) both`,
        }}
      >
        <div
          className={reducedMotion ? '' : 'mr-finale-burst'}
          style={{
            width: 64, height: 64,
            borderRadius: '50%',
            background: T.status.success.bg,
            border: `1px solid ${T.status.success.border}`,
            color: T.status.success.text,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 20px',
          }}
        >
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
            <path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.4"
                  strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>

        <div style={{
          fontSize: 10.5,
          fontWeight: 600,
          fontFamily: T.font.mono,
          color: T.text.subtle,
          textTransform: 'uppercase',
          letterSpacing: '0.16em',
          marginBottom: 8,
        }}>
          Auftrag abgeschlossen
        </div>

        <h1 style={{
          fontSize: 'clamp(28px, 3.4vw, 38px)',
          fontWeight: 500,
          letterSpacing: '-0.025em',
          color: T.text.primary,
          margin: 0,
          lineHeight: 1.1,
        }}>
          Alles erledigt
        </h1>

        <div style={{
          marginTop: 24,
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
          gap: 16,
          paddingTop: 20,
          borderTop: `1px solid ${T.border.subtle}`,
        }}>
          {stats.map((s) => <Stat key={s.label} label={s.label} value={s.value} />)}
        </div>

        <div style={{
          marginTop: 24,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
        }}>
          <Button variant="primary" onClick={onComplete}
                  title="Zur Abschluss-Seite (Space)">
            Zu Abschluss
            <ClassicKbd>Space</ClassicKbd>
          </Button>
        </div>
      </div>

      <SharedKeyframes />
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   BETA — paper-grey card + nested white panels + accent pill button.
   Matches FlowHero / BetaIslandBar / PalletInterlude (beta) vocabulary.
   ══════════════════════════════════════════════════════════════════════ */
function BetaFinale({ stats, reducedMotion, fadeMs, onComplete }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 900,
        background: 'rgba(15, 23, 42, 0.32)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
        animation: `finale-bg-in ${fadeMs}ms cubic-bezier(0.16, 1, 0.3, 1) both`,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 560,
          padding: 8,
          background: '#F4F5F7',
          border: '2px solid #FFFFFF',
          borderRadius: 32,
          boxShadow: '0 0 89.7px 0 rgba(0, 0, 0, 0.05)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          fontFamily: T.font.ui,
          cursor: 'default',
          animation: `finale-card-in ${fadeMs * 1.4}ms cubic-bezier(0.16, 1, 0.3, 1) both`,
        }}
      >
        {/* Header panel — checkmark + eyebrow + title */}
        <div style={{
          background: '#FFFFFF',
          borderRadius: 24,
          padding: '28px 26px 24px',
          textAlign: 'center',
        }}>
          <div
            className={reducedMotion ? '' : 'mr-finale-burst'}
            style={{
              width: 72, height: 72,
              borderRadius: '50%',
              background: T.status.success.bg,
              color: T.status.success.text,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 18px',
            }}
          >
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
              <path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" strokeWidth="2.4"
                    strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>

          <div style={{
            fontSize: 10.5,
            fontWeight: 700,
            fontFamily: T.font.mono,
            color: T.text.subtle,
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
            marginBottom: 10,
          }}>
            Auftrag abgeschlossen
          </div>

          <h1 style={{
            fontSize: 'clamp(30px, 3.6vw, 42px)',
            fontWeight: 600,
            letterSpacing: '-0.025em',
            color: T.text.primary,
            margin: 0,
            lineHeight: 1.05,
          }}>
            Alles erledigt
          </h1>
        </div>

        {/* Stats panel */}
        <div style={{
          background: '#FFFFFF',
          borderRadius: 24,
          padding: '22px 26px',
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
          gap: 16,
        }}>
          {stats.map((s) => <Stat key={s.label} label={s.label} value={s.value} />)}
        </div>

        {/* Action — accent pill right-aligned */}
        <div style={{
          padding: '4px 8px 8px',
          display: 'flex',
          justifyContent: 'flex-end',
        }}>
          <button
            type="button"
            onClick={onComplete}
            title="Zur Abschluss-Seite (Space)"
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
            Zu Abschluss
            <BetaKbd>Space</BetaKbd>
          </button>
        </div>
      </div>

      <SharedKeyframes />
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   SHARED atoms.
   ══════════════════════════════════════════════════════════════════════ */

function Stat({ label, value }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{
        fontSize: 10.5,
        color: T.text.subtle,
        fontWeight: 600,
        fontFamily: T.font.mono,
        textTransform: 'uppercase',
        letterSpacing: '0.10em',
        marginBottom: 6,
      }}>
        {label}
      </div>
      <div style={{
        fontFamily: T.font.ui,
        fontSize: 18,
        fontWeight: 600,
        letterSpacing: '-0.018em',
        color: T.text.primary,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </div>
    </div>
  );
}

function ClassicKbd({ children }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 22, height: 18,
      padding: '0 6px',
      fontSize: 10.5, fontFamily: T.font.mono,
      color: T.text.secondary,
      background: T.bg.surface3,
      border: `1px solid ${T.border.primary}`,
      borderRadius: 3,
      lineHeight: 1,
    }}>{children}</span>
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

function SharedKeyframes() {
  return (
    <style>{`
      @keyframes finale-bg-in {
        from { opacity: 0; }
        to   { opacity: 1; }
      }
      @keyframes finale-card-in {
        from { opacity: 0; transform: translateY(14px); }
        to   { opacity: 1; transform: translateY(0); }
      }
    `}</style>
  );
}

function fmtLong(ms) {
  if (!ms || ms < 0) return '0:00';
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
