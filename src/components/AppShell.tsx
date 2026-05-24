/* ─────────────────────────────────────────────────────────────────────────
   AppShell — wraps content with the persistent left Sidebar.

   Also mounts <ActiveAuftragPill> — a floating bottom-right reminder
   that surfaces whenever there's an in-progress Auftrag AND the worker
   has navigated away from the Workspace route. One click returns them
   to the workflow screen they were on.

   Pill is suppressed on `warteschlange` (the queue UI itself shows the
   active Auftrag context — pill would be redundant) and on
   `workspace` (already there).
   ───────────────────────────────────────────────────────────────────────── */

import { Sidebar, SIDEBAR_WIDTH } from './Sidebar.jsx';
import { useAppState } from '@/state.jsx';
import { T } from './ui.jsx';
import { useBetaDesign } from '@/hooks/useBetaDesign';

const STEP_LABEL = {
  upload:    'Upload',
  pruefen:   'Prüfen',
  focus:     'Focus',
  abschluss: 'Abschluss',
};

/* Routes where the pill should NOT show. */
const PILL_SUPPRESSED = new Set(['workspace', 'warteschlange']);

export function AppShell({ route, onRoute, onOpenCommand, children }) {
  const { beta } = useBetaDesign();
  return (
    <div style={{
      display: 'flex',
      minHeight: '100vh',
      background: beta ? 'var(--bg-gradient)' : 'var(--bg)',
      alignItems: 'stretch',
    }}>
      <Sidebar route={route} onRoute={onRoute} onOpenCommand={onOpenCommand} />
      <div style={{
        flex: 1,
        minWidth: 0,
        position: 'relative',
        /* When the sidebar floats as a beta island it leaves the flex
           flow → reserve its width + 24px (12px island margin + 12px
           gap to content) on the left so content doesn't tuck under it. */
        marginLeft: beta ? 'calc(var(--sidebar-width) + 24px)' : 0,
      }}>
        {children}
      </div>
      <ActiveAuftragPill route={route} onRoute={onRoute} />
    </div>
  );
}

/* ── Floating reminder ── */
function ActiveAuftragPill({ route, onRoute }) {
  const { current } = useAppState();
  if (!current) return null;
  if (PILL_SUPPRESSED.has(route)) return null;

  const fba = current.fbaCode || current.fileName || '—';
  const stepLabel = (current.step ? STEP_LABEL[current.step] : null) || 'Workflow';
  const stepDestination = current.step === 'upload'
    ? 'Auftrag öffnen'
    : `Zurück zu ${stepLabel}`;

  /* Overall progress fraction. Falls back gracefully when parsed hasn't
     loaded yet (total=0 hides the fraction span). */
  const total = (current.parsed?.pallets || []).reduce(
    (s, p) => s + (p.items?.length || 0), 0,
  );
  const completed = Object.keys(current.completedKeys || {}).length;
  const pct = total > 0 ? Math.min(1, completed / total) : 0;

  return (
    <button
      type="button"
      onClick={() => onRoute('workspace')}
      onMouseDown={(e) => e.preventDefault()}
      title={`${stepDestination} — ${fba}`}
      aria-label={`${stepDestination}: ${fba}, ${stepLabel}, ${completed} von ${total}`}
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        zIndex: 100,
        padding: '10px 16px 12px',
        background: 'var(--bg-glass-strong)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        border: `1px solid ${T.border.primary}`,
        borderRadius: 999,
        boxShadow:
          '0 8px 24px -8px rgba(17, 24, 39, 0.15), 0 2px 6px rgba(17, 24, 39, 0.05)',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        fontFamily: T.font.ui,
        outline: 'none',
        transition: 'transform 200ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 200ms ease, border-color 200ms ease',
        animation: 'pill-rise 320ms cubic-bezier(0.16, 1, 0.3, 1) both',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-2px)';
        e.currentTarget.style.boxShadow =
          '0 12px 32px -8px rgba(17, 24, 39, 0.20), 0 4px 8px rgba(17, 24, 39, 0.06)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'none';
        e.currentTarget.style.boxShadow =
          '0 8px 24px -8px rgba(17, 24, 39, 0.15), 0 2px 6px rgba(17, 24, 39, 0.05)';
      }}
      onFocus={(e) => {
        e.currentTarget.style.boxShadow =
          `0 8px 24px -8px rgba(17, 24, 39, 0.15), 0 0 0 3px ${T.accent.main}33`;
      }}
      onBlur={(e) => {
        e.currentTarget.style.boxShadow =
          '0 8px 24px -8px rgba(17, 24, 39, 0.15), 0 2px 6px rgba(17, 24, 39, 0.05)';
      }}
    >
      {/* Pulsing accent dot */}
      <span className="mr-pulse" style={{
        width: 8, height: 8, borderRadius: '50%',
        background: T.accent.main,
        boxShadow: `0 0 0 3px ${T.accent.main}30`,
        flexShrink: 0,
      }} />

      {/* FBA code (mono) */}
      <span style={{
        fontSize: 12.5,
        fontWeight: 500,
        color: T.text.primary,
        fontFamily: T.font.mono,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '-0.005em',
        maxWidth: 160,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {fba}
      </span>

      <span style={{ width: 1, height: 14, background: T.border.primary, flexShrink: 0 }} />

      {/* Step pill */}
      <span style={{
        fontSize: 10.5,
        fontWeight: 600,
        fontFamily: T.font.mono,
        color: T.accent.text,
        textTransform: 'uppercase',
        letterSpacing: '0.10em',
      }}>
        {stepLabel}
      </span>

      {/* Progress fraction */}
      {total > 0 && (
        <span style={{
          fontSize: 11,
          fontFamily: T.font.mono,
          fontVariantNumeric: 'tabular-nums',
          color: T.text.subtle,
        }}>
          {completed}/{total}
        </span>
      )}

      {/* Arrow */}
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        color: T.text.subtle,
        marginLeft: 2,
      }} aria-hidden>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M3 7h8m0 0L7.5 3.5M11 7l-3.5 3.5" stroke="currentColor"
                strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </span>

      {/* Bottom hairline progress bar — sits in the bottom padding zone,
          flush with the rounded edge so it never overlaps the text row. */}
      {total > 0 && (
        <span aria-hidden style={{
          position: 'absolute',
          left: 18, right: 18, bottom: 4,
          height: 1.5,
          background: 'rgba(15,23,42,0.06)',
          borderRadius: 1,
          overflow: 'hidden',
          pointerEvents: 'none',
        }}>
          <span style={{
            display: 'block',
            width: `${pct * 100}%`,
            height: '100%',
            background: T.accent.main,
            transition: 'width 320ms cubic-bezier(0.16, 1, 0.3, 1)',
          }} />
        </span>
      )}

      {/* Local keyframes — scoped via unique name to avoid clashing with
          mr-rise's translateY (which leaves a residual 0 transform that
          conflicts with hover translateY(-2px)). */}
      <style>{`
        @keyframes pill-rise {
          0%   { opacity: 0; transform: translateY(8px); }
          100% { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </button>
  );
}

export { SIDEBAR_WIDTH };