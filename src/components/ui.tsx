/* Marathon · Design System v3 — reusable atoms.
   Spec: DESIGN.md. */
/* eslint-disable react-refresh/only-export-components -- design tokens (T,
   STEPS) and component atoms ship from one module on purpose. */

import React, { useEffect, useState, type ReactNode, type CSSProperties, type ButtonHTMLAttributes } from 'react';
import { Wordmark } from './Logo.jsx';
import { useBetaDesign } from '@/hooks/useBetaDesign';

/* ─── Shared types ───────────────────────────────────────────────────── */
export interface Crumb {
  label: ReactNode;
  muted?: boolean;
  onClick?: () => void;
  title?: string;
}

export interface Step {
  n: number;
  id: string;
  label: string;
  sub?: string;
}

export type Tone = 'success' | 'warn' | 'danger' | 'accent' | 'neutral';

/* ─── Tokens ───────────────────────────────────────────────────────────
   ALL color tokens here resolve to CSS custom properties — defaults in
   src/index.css :root, dark-theme overrides in [data-theme="dark"].
   Toggle via src/utils/theme.ts. The category palette stays as flat
   hex literals: those colors are level identity (ESKU placement viz)
   and must keep the same hue across themes. */
export const T = {
  bg:     {
    page:     'var(--bg-page)',
    surface:  'var(--bg-surface)',
    surface2: 'var(--bg-surface-2)',
    surface3: 'var(--bg-surface-3)',
  },
  border: {
    primary: 'var(--border-primary)',
    subtle:  'var(--border-subtle)',
    strong:  'var(--border-strong)',
  },
  text:   {
    primary:   'var(--text-primary)',
    secondary: 'var(--text-secondary)',
    muted:     'var(--text-muted)',
    subtle:    'var(--text-subtle)',
    faint:     'var(--text-faint)',
  },

  accent: {
    main:   'var(--accent)',
    hover:  'var(--accent-hover)',
    text:   'var(--accent-text)',
    bg:     'var(--accent-bg)',
    border: 'var(--accent-border)',
  },

  status: {
    success: {
      main:   'var(--status-success-main)',
      bg:     'var(--status-success-bg)',
      text:   'var(--status-success-text)',
      border: 'var(--status-success-border)',
    },
    warn: {
      main:   'var(--status-warn-main)',
      bg:     'var(--status-warn-bg)',
      text:   'var(--status-warn-text)',
      border: 'var(--status-warn-border)',
    },
    danger: {
      main:   'var(--status-danger-main)',
      bg:     'var(--status-danger-bg)',
      text:   'var(--status-danger-text)',
      border: 'var(--status-danger-border)',
    },
  },

  category: {
    THERMO:     { color: '#3B82F6', bg: '#EFF6FF', text: '#1D4ED8' },
    PRODUKTION: { color: '#10B981', bg: '#ECFDF5', text: '#047857' },
    HEIPA:      { color: '#06B6D4', bg: '#ECFEFF', text: '#0E7490' },
    VEIT:       { color: '#A855F7', bg: '#FAF5FF', text: '#7E22CE' },
    TACHO:      { color: '#F97316', bg: '#FFF7ED', text: '#C2410C' },
    SONSTIGE:   { color: '#71717A', bg: '#FAFAFA', text: '#3F3F46' },
  },

  font: {
    ui:   'Inter, system-ui, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, monospace',
  },

  radius: { sm: 4, md: 8, lg: 14, full: 9999 },
  shadow: {
    card:   'var(--shadow-card)',
    raised: 'var(--shadow-raised)',
    cta:    '0 1px 2px rgba(79,70,229,0.2)',
    modal:  'var(--shadow-modal)',
  },
};

/* ─── Page shell ─────────────────────────────────────────────────────── */
/* Page-level wrapper — sets canvas bg, font and reset.
   In beta mode we go transparent so the AppShell gradient
   (--bg-gradient) shows through; classic mode keeps its solid
   --bg-page so nothing visually changes for non-beta users. */
export function Page({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  const { beta } = useBetaDesign();
  return (
    <div style={{
      background: beta ? 'transparent' : T.bg.page,
      minHeight: '100vh',
      fontFamily: T.font.ui,
      color: T.text.primary,
      ...style,
    }}>
      {children}
    </div>
  );
}

/* ─── Topbar ─────────────────────────────────────────────────────────── */
/* Sticky breadcrumb topbar.
   crumbs: [{ label, muted?, onClick?, title? }, ...]
   If a crumb has onClick → renders as clickable Crumb (hover lift,
   accent on hover). The last crumb stays passive even if onClick set. */
export function Topbar({ crumbs = [], center, right }: { crumbs?: Crumb[]; center?: ReactNode; right?: ReactNode }) {
  return (
    <header style={{
      position: 'sticky',
      top: 0,
      zIndex: 10,
      height: 60,
      padding: '0 40px',
      background: 'var(--bg-glass-medium)',
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      borderBottom: `1px solid ${T.border.primary}`,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    }}>
      {crumbs.map((c, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Crumb crumb={c} isLast={i === crumbs.length - 1} />
          {i < crumbs.length - 1 && <Sep />}
        </span>
      ))}
      <span style={{ flex: 1 }} />
      {center && (
        <span style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          display: 'inline-flex',
          alignItems: 'center',
          pointerEvents: 'auto',
        }}>
          {center}
        </span>
      )}
      {right}
    </header>
  );
}

function Crumb({ crumb, isLast }: { crumb: Crumb; isLast: boolean }) {
  const [hover, setHover] = useState(false);
  const interactive = !!crumb.onClick && !isLast;
  const baseColor = isLast
    ? T.text.primary
    : crumb.muted ? T.text.subtle : T.text.primary;
  const color = interactive && hover ? T.accent.text : baseColor;

  if (interactive) {
    return (
      <button
        type="button"
        onClick={crumb.onClick}
        onMouseDown={(e) => e.preventDefault()}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={crumb.title || `Zu ${crumb.label}`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '6px 10px',
          margin: '0 -10px',
          fontSize: 14.5,
          fontWeight: 500,
          fontFamily: 'inherit',
          color,
          background: hover ? T.accent.bg : 'transparent',
          border: 'none',
          borderRadius: T.radius.sm,
          cursor: 'pointer',
          transition: 'color 160ms ease, background 160ms ease',
        }}
      >
        {crumb.label}
      </button>
    );
  }

  return (
    <span style={{
      fontSize: 14.5,
      color: baseColor,
      fontWeight: isLast ? 600 : 500,
    }}>
      {crumb.label}
    </span>
  );
}

export function Sep() {
  return <span style={{ color: T.border.strong, fontSize: 13, margin: '0 5px' }}>/</span>;
}

/* ─── Stepper (Live Progress Line) ───────────────────────────────────────
   Single continuous line through all 4 circles (background grey + accent
   fill that animates to the current step). Three circle states:
     done    — accent-filled circle with check (fade-in), label primary
     current — accent-filled circle with number + breathing pulse halo
     todo    — outline circle with number, faded label

   Mount-time stagger: circles fade-scale-in 60ms apart, then the
   accent fill-line slides to its position. Designed to feel alive on
   navigation, not just static.
──────────────────────────────────────────────────────────────────────── */
export const STEPS = [
  { n: 1, id: 'upload',    label: 'Upload',      sub: 'Datei laden' },
  { n: 2, id: 'pruefen',   label: 'Prüfen',      sub: 'Daten kontrollieren' },
  { n: 3, id: 'focus',     label: 'Focus-Modus', sub: 'Paletten bearbeiten' },
  { n: 4, id: 'abschluss', label: 'Abschluss',   sub: 'Zeit speichern' },
];

/* StepperBar — workflow tabs.

   Pass `onNavigate(stepId)` to make tabs clickable. By default ANY step
   that is not the current one is navigable (parent screen owns the
   workflow rules); to override, pass `canNavigate(stepId) → boolean`.

   When `onNavigate` is provided, also installs Alt+1..4 shortcuts at
   document level so the worker can jump tabs without leaving the
   keyboard. The shortcut handler is auto-cleaned on unmount. */
export function StepperBar({ active, steps = STEPS, onNavigate, canNavigate }: { active: string; steps?: Step[]; onNavigate?: (id: string) => void; canNavigate?: (id: string) => boolean }) {
  // Alt+1..4 keyboard navigation — only when onNavigate is wired.
  useEffect(() => {
    if (!onNavigate) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      const t = e.target as (HTMLElement | null);
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA') return;
      if (t?.isContentEditable) return;
      const idx = parseInt(e.key, 10) - 1;
      if (Number.isNaN(idx) || idx < 0 || idx >= steps.length) return;
      const target = steps[idx];
      if (!target || target.id === active) return;
      const allowed = canNavigate ? canNavigate(target.id) : true;
      if (!allowed) return;
      e.preventDefault();
      onNavigate(target.id);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, steps, onNavigate, canNavigate]);

  return (
    <div style={{
      padding: '18px 32px 20px',
      background: 'transparent',
      borderBottom: `1px solid ${T.border.primary}`,
    }}>
      <StepperKeyframes />
      <Stepper
        active={active}
        steps={steps}
        onNavigate={onNavigate}
        canNavigate={canNavigate}
      />
    </div>
  );
}

/* Local keyframes scoped to this component family. Re-mounted with
   StepperBar; keys are namespaced (mp-stp-*) so they can't clash. */
function StepperKeyframes() {
  return (
    <style>{`
      @keyframes mp-stp-pop {
        0%   { opacity: 0; transform: scale(0.85); }
        100% { opacity: 1; transform: scale(1); }
      }
      @keyframes mp-stp-pulse {
        0%   { box-shadow: 0 0 0 0   var(--accent, #FF5B1F); opacity: 0.55; }
        70%  { box-shadow: 0 0 0 9px transparent; opacity: 0; }
        100% { box-shadow: 0 0 0 0   transparent; opacity: 0; }
      }
      @keyframes mp-stp-check {
        0%   { opacity: 0; transform: scale(0.6); }
        60%  { opacity: 1; transform: scale(1.1); }
        100% { opacity: 1; transform: scale(1); }
      }
    `}</style>
  );
}

export function Stepper({ active, steps = STEPS, onNavigate, canNavigate }: { active: string; steps?: Step[]; onNavigate?: (id: string) => void; canNavigate?: (id: string) => boolean }) {
  const activeIdx = steps.findIndex((s) => s.id === active);
  const n = steps.length;

  /* Continuous progress line geometry — circle centers sit at
     (i + 0.5) / n of the row width. The line stretches from the
     first to the last center; the fill width is proportional to
     activeIdx. */
  const trackLeftPct = 50 / n;                    // left of background
  const trackWidthPct = ((n - 1) / n) * 100;      // background full width
  const fillWidthPct = (activeIdx / n) * 100;     // accent fill width

  return (
    <div style={{
      maxWidth: 1080,
      margin: '0 auto',
      position: 'relative',
    }}>
      {/* Background track (full grey hairline through all circles) */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: `${trackLeftPct}%`,
          width: `${trackWidthPct}%`,
          top: 16,                                /* half of 32px circle */
          height: 1,
          background: T.border.primary,
          zIndex: 0,
        }}
      />
      {/* Done fill — green track between completed steps. Width is the
          fraction of done segments (activeIdx / n). */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: `${trackLeftPct}%`,
          width: `${fillWidthPct}%`,
          top: 16,
          height: 1,
          background: T.status.success.main,
          zIndex: 1,
          transition: 'width 480ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      />

      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${n}, 1fr)`,
        alignItems: 'flex-start',
        position: 'relative',
        zIndex: 2,
      }}>
        {steps.map((s, i) => {
          const state = i < activeIdx ? 'done' : i === activeIdx ? 'current' : 'todo';
          const isCurrent = state === 'current';
          /* Clickable when onNavigate is wired and either canNavigate
             allows it OR (default) it's any non-current step. */
          let clickable = false;
          if (onNavigate && !isCurrent) {
            clickable = canNavigate ? !!canNavigate(s.id) : true;
          }
          const isBlocked = onNavigate && !isCurrent && !clickable;
          return (
            <StepCell
              key={s.id}
              step={s}
              state={state}
              mountDelayMs={i * 60}
              clickable={clickable}
              isBlocked={isBlocked}
              shortcut={i + 1}
              onClick={clickable && onNavigate ? () => onNavigate(s.id) : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}

interface StepCellProps {
  step: Step;
  state: 'done' | 'current' | 'todo';
  mountDelayMs?: number;
  clickable?: boolean;
  isBlocked?: boolean;
  shortcut?: number | null;
  onClick?: () => void;
}

function StepCell({
  step, state, mountDelayMs = 0,
  clickable = false, isBlocked = false, shortcut = null, onClick,
}: StepCellProps) {
  const isDone = state === 'done';
  const isCurrent = state === 'current';
  const [hover, setHover] = useState(false);

  /* Color semantics:
       done     → success green (completed stage)
       current  → accent orange (active stage, eye-magnet)
       todo     → surface + faint text (idle)
     The fill line between circles uses the same green so the done
     segment of the workflow reads as one unified completed track. */
  const stateColor = isDone
    ? T.status.success.main
    : isCurrent
    ? T.accent.main
    : null;
  const circleBg = stateColor || T.bg.surface;
  const circleColor = stateColor ? '#fff' : T.text.faint;
  const circleBorder = stateColor || T.border.strong;

  const labelColor = (isCurrent || isDone) ? T.text.primary : T.text.faint;
  const labelWeight = isCurrent ? 600 : 500;
  const subColor = (isCurrent || isDone) ? T.text.subtle : T.text.faint;

  const Wrapper = (clickable ? 'button' : 'div') as React.ElementType;
  const wrapperProps: Record<string, unknown> = clickable ? {
    type: 'button',
    onClick,
    onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    title: `Zu ${step.label}` + (shortcut ? ` (Alt+${shortcut})` : ''),
  } : {
    title: isCurrent
      ? `Aktueller Schritt: ${step.label}`
      : isBlocked ? `${step.label} — noch nicht verfügbar`
      : step.label,
  };

  return (
    <Wrapper
      {...wrapperProps}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        position: 'relative',
        animation: `mp-stp-pop 320ms cubic-bezier(0.16, 1, 0.3, 1) ${mountDelayMs}ms backwards`,
        background: 'transparent',
        border: 'none',
        padding: 0,
        cursor: clickable ? 'pointer' : isBlocked ? 'not-allowed' : 'default',
        opacity: isBlocked ? 0.55 : 1,
        fontFamily: 'inherit',
        textAlign: 'center',
      }}>
      {/* Circle row — must be first child so its center sits at top: 16px,
          which is exactly where the progress line is drawn. */}
      <div style={{
        position: 'relative',
        width: 32,
        height: 32,
        flexShrink: 0,
      }}>
        {isCurrent && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              animation: 'mp-stp-pulse 2.4s ease-out infinite',
              pointerEvents: 'none',
            }}
          />
        )}
        <span style={{
          position: 'relative',
          zIndex: 2,
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: circleBg,
          color: circleColor,
          border: `1px solid ${clickable && hover ? T.accent.hover : circleBorder}`,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 14,
          fontWeight: 600,
          fontFamily: T.font.ui,
          fontVariantNumeric: 'tabular-nums',
          transition: 'all 240ms cubic-bezier(0.16, 1, 0.3, 1)',
          boxShadow: isCurrent
            ? `0 0 0 5px ${T.accent.bg}`
            : (clickable && hover) ? `0 0 0 5px ${T.accent.bg}` : 'none',
          transform: clickable && hover ? 'translateY(-2px) scale(1.04)' : 'none',
        }}>
          {isDone ? (
            <svg
              key="check"
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              style={{ animation: 'mp-stp-check 280ms cubic-bezier(0.16, 1, 0.3, 1)' }}
            >
              <path d="M3 7l3 3 5-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : step.n}
        </span>
      </div>

      {/* Label + sub stacked under circle, centered. Live-region for
          screen readers can be added later if needed. */}
      <div style={{
        textAlign: 'center',
        lineHeight: 1.2,
      }}>
        <div style={{
          fontSize: 14,
          fontWeight: labelWeight,
          color: labelColor,
          letterSpacing: '-0.005em',
          transition: 'color 240ms',
        }}>
          {step.label}
        </div>
        <div style={{
          marginTop: 4,
          fontSize: 12,
          color: subColor,
          fontWeight: 400,
          lineHeight: 1.3,
          transition: 'color 240ms',
        }}>
          {step.sub}
        </div>
      </div>
    </Wrapper>
  );
}

/* ─── StudioFrame ────────────────────────────────────────────────────────
   Premium "studio" wrapper for hero blocks.

   Combines three signals that say «this is the centerpiece of the
   screen»:
     • Mono-eyebrow row above (label + optional status, accent dot)
     • Hairline L-marks at the four corners — Linear/Raycast vibe
     • Long premium drop-shadow when idle (single-source-of-truth so
       Upload + Pruefen HeroFBA + Focus ArticleHeroCard look identical)

   Children render INSIDE the frame and SHOULD NOT carry their own
   border / shadow / borderRadius — StudioFrame supplies them. Use
   `padding` prop to control inner space. */
interface StudioFrameProps {
  children?: ReactNode;
  label?: ReactNode;
  status?: ReactNode;
  accent?: boolean;
  padding?: string | number;
  bare?: boolean;
  gap?: number;
  zen?: boolean;
  style?: CSSProperties;
  contentStyle?: CSSProperties;
}

export function StudioFrame({
  children, label, status, accent = true,
  padding = '32px 36px', bare = false, gap = 14,
  zen = false,
  style, contentStyle,
}: StudioFrameProps) {
  const accentColor = accent ? T.accent.main : T.text.faint;
  const eyebrow = (label || status) ? (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: bare ? gap : 14,
      padding: '0 4px',
      gap: 12,
      opacity: zen ? 0 : 1,
      transition: 'opacity 240ms cubic-bezier(0.16, 1, 0.3, 1)',
      pointerEvents: zen ? 'none' : 'auto',
    }}>
      {label && (
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 10.5,
          fontFamily: T.font.mono,
          fontWeight: 600,
          color: T.text.subtle,
          textTransform: 'uppercase',
          letterSpacing: '0.14em',
        }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: accentColor }} />
          {label}
        </span>
      )}
      {status && (
        <span style={{
          fontSize: 10.5,
          fontFamily: T.font.mono,
          fontWeight: 500,
          color: T.text.faint,
          letterSpacing: '0.10em',
          textTransform: 'uppercase',
        }}>
          {status}
        </span>
      )}
    </div>
  ) : null;

  return (
    <div style={{
      position: 'relative',
      /* Outer breathing room — keeps siblings from crowding the studio. */
      margin: '12px 0',
      ...style,
    }}>
      {/* OUTER MAT — invisible 16px buffer, hosts the corner-marks so
          they sit a clear margin away from the card edge. The result
          is a self-contained «island» easily distinguished from any
          neighbouring section. The eyebrow lives INSIDE the mat so
          it's visually framed by the corner-marks. */}
      <div style={{
        position: 'relative',
        padding: 16,
      }}>
        <span style={{
          position: 'absolute',
          inset: 0,
          opacity: zen ? 0 : 1,
          transition: 'opacity 240ms cubic-bezier(0.16, 1, 0.3, 1)',
          pointerEvents: 'none',
        }}>
          <CornerMarks long />
        </span>
        {eyebrow}
        {bare ? (
          /* Bare mode — render children directly. Used when wrapping
             multiple already-styled cards (each child supplies its own
             chrome, so an inner box would double up). */
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap,
            ...contentStyle,
          }}>
            {children}
          </div>
        ) : (
          <div style={{
            position: 'relative',
            padding,
            background: T.bg.surface,
            border: `1px solid ${T.border.primary}`,
            borderRadius: 18,
            boxShadow: 'none',
            ...contentStyle,
          }}>
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

/* Hairline L-marks at the four corners of a studio surface. Pure
   decoration — gives the wrapped element a «framed» feel. Pointer
   events off so clicks pass through. The `long` variant uses bigger
   arms and is anchored at offset 0 (used by StudioFrame's outer mat). */
export function CornerMarks({ stroke, long }: { stroke?: string; long?: boolean }) {
  const arm = long ? 20 : 14;
  const offset = long ? 0 : -10;
  const color = stroke || T.border.strong;
  const common: React.CSSProperties = { position: 'absolute', width: arm, height: arm, pointerEvents: 'none' };
  return (
    <>
      <span style={{ ...common, top: offset, left: offset, borderTop: `1px solid ${color}`, borderLeft: `1px solid ${color}`, borderTopLeftRadius: 4 }} />
      <span style={{ ...common, top: offset, right: offset, borderTop: `1px solid ${color}`, borderRight: `1px solid ${color}`, borderTopRightRadius: 4 }} />
      <span style={{ ...common, bottom: offset, left: offset, borderBottom: `1px solid ${color}`, borderLeft: `1px solid ${color}`, borderBottomLeftRadius: 4 }} />
      <span style={{ ...common, bottom: offset, right: offset, borderBottom: `1px solid ${color}`, borderRight: `1px solid ${color}`, borderBottomRightRadius: 4 }} />
    </>
  );
}

/* ─── Card ───────────────────────────────────────────────────────────── */
export function Card({ children, style, padding }: { children?: ReactNode; style?: CSSProperties; padding?: string | number }) {
  return (
    <div style={{
      background: T.bg.surface,
      border: `1px solid ${T.border.primary}`,
      borderRadius: T.radius.lg,
      boxShadow: T.shadow.card,
      ...(padding != null ? { padding } : {}),
      ...style,
    }}>
      {children}
    </div>
  );
}

/* ─── Section header ─────────────────────────────────────────────────── */
export function SectionHeader({ title, sub, right }: { title?: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div style={{
      marginBottom: 14,
      display: 'flex',
      alignItems: 'flex-start',
      gap: 16,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h2 style={{
          fontSize: 18,
          fontWeight: 600,
          color: T.text.primary,
          margin: 0,
          letterSpacing: '-0.01em',
        }}>
          {title}
        </h2>
        {sub && (
          <p style={{
            fontSize: 13.5,
            color: T.text.subtle,
            margin: '4px 0 0',
            lineHeight: 1.5,
          }}>
            {sub}
          </p>
        )}
      </div>
      {right}
    </div>
  );
}

/* ─── Eyebrow (mini label above H1) ────────────────────────────────────── */
export function Eyebrow({ children }: { children?: ReactNode }) {
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 12,
      fontWeight: 500,
      color: T.text.subtle,
      marginBottom: 12,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: T.accent.main }} />
      {children}
    </div>
  );
}

/* ─── H1 / Lead ──────────────────────────────────────────────────────── */
export function PageH1({ children }: { children?: ReactNode }) {
  return (
    <h1 style={{
      fontFamily: T.font.ui,
      fontSize: 'clamp(28px, 3.6vw, 40px)',
      fontWeight: 600,
      letterSpacing: '-0.02em',
      lineHeight: 1.15,
      color: T.text.primary,
      margin: 0,
    }}>
      {children}
    </h1>
  );
}

export function Lead({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return (
    <p style={{
      marginTop: 12,
      fontSize: 15,
      lineHeight: 1.55,
      color: T.text.muted,
      maxWidth: 640,
      margin: '12px 0 0',
      ...style,
    }}>
      {children}
    </p>
  );
}

/* ─── Label (uppercase mini-meta) ────────────────────────────────────── */
export function Label({ children }: { children?: ReactNode }) {
  return (
    <span style={{
      fontSize: 11.5,
      fontWeight: 500,
      color: T.text.subtle,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
    }}>
      {children}
    </span>
  );
}

/* ─── Meta (label + value pair) ──────────────────────────────────────── */
export function Meta({ label, value, mono }: { label?: ReactNode; value?: ReactNode; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 11.5, color: T.text.subtle, fontWeight: 500, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{
        fontFamily: mono ? T.font.mono : 'inherit',
        fontSize: 14,
        fontWeight: 500,
        color: T.text.primary,
      }}>
        {value}
      </div>
    </div>
  );
}

/* ─── Badge / Pill ───────────────────────────────────────────────────── */
export function Badge({ children, tone, color, bg, text }: { children?: ReactNode; tone?: Tone; color?: string; bg?: string; text?: string }) {
  let styles: { background?: string; color?: string; borderColor?: string };
  if (color) {
    styles = { background: bg, color: text, borderColor: color + '40' };
  } else {
    const tones: Record<Tone, { background: string; color: string; borderColor: string }> = {
      success: { background: T.status.success.bg, color: T.status.success.text, borderColor: T.status.success.border },
      warn:    { background: T.status.warn.bg,    color: T.status.warn.text,    borderColor: T.status.warn.border },
      danger:  { background: T.status.danger.bg,  color: T.status.danger.text,  borderColor: T.status.danger.border },
      accent:  { background: T.accent.bg,         color: T.accent.text,         borderColor: T.accent.border },
      neutral: { background: T.bg.surface3,       color: T.text.secondary,      borderColor: T.border.primary },
    };
    styles = (tone && tones[tone]) || { background: T.bg.surface3, color: T.text.secondary, borderColor: T.border.primary };
  }
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '2px 8px',
      borderRadius: T.radius.full,
      border: `1px solid ${styles.borderColor}`,
      background: styles.background,
      color: styles.color,
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.02em',
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

/* ─── Buttons ────────────────────────────────────────────────────────── */
const baseBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  height: 44,
  padding: '0 22px',
  borderRadius: T.radius.md,
  fontSize: 15,
  fontWeight: 500,
  fontFamily: T.font.ui,
  cursor: 'pointer',
  transition: 'background 150ms, border-color 150ms, color 150ms',
  whiteSpace: 'nowrap',
};

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle';
  size?: 'sm' | 'md' | 'lg';
  children?: ReactNode;
  style?: CSSProperties;
}

export function Button({ variant = 'primary', size = 'md', children, style, disabled, ...rest }: ButtonProps) {
  const sizeStyle: CSSProperties = size === 'sm'
    ? { height: 36, padding: '0 14px', fontSize: 13.5 }
    : size === 'lg'
    ? { height: 48, padding: '0 26px', fontSize: 16 }
    : {};

  let variantStyle: CSSProperties = {};
  if (variant === 'primary') {
    variantStyle = {
      background: T.accent.main,
      color: '#fff',
      border: 0,
      boxShadow: T.shadow.cta,
    };
  } else if (variant === 'ghost') {
    variantStyle = {
      background: T.bg.surface,
      color: T.text.secondary,
      border: `1px solid ${T.border.strong}`,
    };
  } else if (variant === 'danger') {
    variantStyle = {
      background: T.bg.surface,
      color: T.status.danger.text,
      border: `1px solid ${T.status.danger.border}`,
    };
  } else if (variant === 'subtle') {
    variantStyle = {
      background: 'transparent',
      color: T.text.subtle,
      border: 0,
      padding: '0 8px',
      fontSize: 13,
    };
  }

  const onMouseEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (variant === 'primary') e.currentTarget.style.background = T.accent.hover;
    else if (variant === 'ghost') {
      e.currentTarget.style.background = T.bg.surface2;
      e.currentTarget.style.borderColor = T.text.faint;
    }
    else if (variant === 'danger') e.currentTarget.style.background = T.status.danger.bg;
    else if (variant === 'subtle') e.currentTarget.style.color = T.text.secondary;
  };
  const onMouseLeave = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (variant === 'primary') e.currentTarget.style.background = T.accent.main;
    else if (variant === 'ghost') {
      e.currentTarget.style.background = T.bg.surface;
      e.currentTarget.style.borderColor = T.border.strong;
    }
    else if (variant === 'danger') e.currentTarget.style.background = T.bg.surface;
    else if (variant === 'subtle') e.currentTarget.style.color = T.text.subtle;
  };

  return (
    <button
      {...rest}
      disabled={disabled}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        ...baseBtn,
        ...variantStyle,
        ...sizeStyle,
        ...(disabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/* ─── KPI card ───────────────────────────────────────────────────────── */
export function Kpi({ label, value, sub, tone }: { label?: ReactNode; value?: ReactNode; sub?: ReactNode; tone?: 'accent' | 'danger' | 'warn' | 'success' }) {
  const valueColor = tone === 'accent'  ? T.accent.main
    : tone === 'danger'  ? T.status.danger.main
    : tone === 'warn'    ? T.status.warn.main
    : tone === 'success' ? T.status.success.main
    : T.text.primary;
  return (
    <div style={{
      padding: '18px 20px',
      background: T.bg.surface,
      border: `1px solid ${T.border.primary}`,
      borderRadius: T.radius.lg,
      boxShadow: T.shadow.card,
    }}>
      <div style={{ fontSize: 12, color: T.text.subtle, fontWeight: 500, marginBottom: 8 }}>
        {label}
      </div>
      <div style={{
        fontSize: 32,
        fontWeight: 600,
        letterSpacing: '-0.025em',
        color: valueColor,
        lineHeight: 1,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 12, color: T.text.subtle, marginTop: 6 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

/* ─── Validation banner ──────────────────────────────────────────────── */
export function ValidationBanner({ tone = 'success', title, sub, action }: { tone?: 'success' | 'warn' | 'danger'; title?: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  const palette = T.status[tone] || T.status.success;
  const icon = tone === 'success' ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M5 12.5l5 5 9-11" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ) : tone === 'warn' ? (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M12 8v5m0 3.5h.01M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7v6m0 3.5h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: '14px 20px',
      background: palette.bg,
      border: `1px solid ${palette.border}`,
      borderRadius: T.radius.lg,
    }}>
      <span style={{
        width: 32, height: 32,
        borderRadius: '50%',
        background: palette.main,
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}>
        {icon}
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: palette.text }}>
          {title}
        </div>
        {sub && (
          <div style={{ fontSize: 12.5, color: palette.text, opacity: 0.85, marginTop: 1 }}>
            {sub}
          </div>
        )}
      </div>
      {action}
    </div>
  );
}

/* ─── Empty state ────────────────────────────────────────────────────── */
export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title?: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div style={{
      padding: '64px 32px',
      background: T.bg.page,
      border: `1px dashed ${T.border.strong}`,
      borderRadius: T.radius.lg,
      textAlign: 'center',
    }}>
      {icon && (
        <div style={{ display: 'inline-flex', color: T.text.faint, marginBottom: 16 }}>
          {icon}
        </div>
      )}
      {title && (
        <h3 style={{
          fontSize: 18,
          fontWeight: 600,
          color: T.text.primary,
          margin: 0,
          letterSpacing: '-0.01em',
        }}>
          {title}
        </h3>
      )}
      {description && (
        <p style={{
          fontSize: 14,
          color: T.text.subtle,
          maxWidth: 420,
          margin: '8px auto 24px',
          lineHeight: 1.55,
        }}>
          {description}
        </p>
      )}
      {action}
    </div>
  );
}

/* ─── Wordmark re-export ─────────────────────────────────────────────── */
export { Wordmark };
