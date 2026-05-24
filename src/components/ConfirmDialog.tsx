/* ConfirmDialog — site-side replacement for window.confirm().
   Exposes a `useConfirm()` hook that returns a function
     confirm(opts) → Promise<boolean>
   which renders a single modal at the app root. Beta mode gets the
   paper-grey card + 2px white rim + halo grammar; classic mode keeps
   the standard surface + border vocabulary.

   Usage:
     const confirm = useConfirm();
     if (await confirm({ message: 'Auftrag verlassen?', danger: true })) ... */

import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode,
} from 'react';
import { useBetaDesign } from '@/hooks/useBetaDesign';
import { T } from './ui.jsx';

type Tone = 'danger' | 'primary' | 'neutral';

export interface ConfirmOptions {
  title?: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: Tone;
  /* Convenience flag — when true, tone defaults to 'danger' and the
     confirm button gets the destructive palette. */
  danger?: boolean;
}

type Resolver = (value: boolean) => void;

interface PendingConfirm extends ConfirmOptions {
  resolve: Resolver;
}

const ConfirmCtx = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  /* Ensures we never leak a resolver — every open() must resolve once
     when the dialog closes for any reason (confirm / cancel / Escape). */
  const resolveAndClose = (value: boolean) => {
    setPending((prev) => {
      if (prev) prev.resolve(value);
      return null;
    });
  };

  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => {
    setPending({ ...opts, resolve });
  }), []);

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {pending && (
        <ConfirmDialog
          opts={pending}
          onConfirm={() => resolveAndClose(true)}
          onCancel={() => resolveAndClose(false)}
        />
      )}
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) throw new Error('useConfirm() must be used inside <ConfirmDialogProvider>');
  return ctx;
}

/* ────────────────────────────────────────────────────────────────────── */

function ConfirmDialog({
  opts, onConfirm, onCancel,
}: {
  opts: ConfirmOptions;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { beta } = useBetaDesign();
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  const tone: Tone = opts.tone || (opts.danger ? 'danger' : 'primary');

  /* Focus primary action on mount so Enter immediately confirms. */
  useEffect(() => {
    const t = setTimeout(() => confirmBtnRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  /* Keyboard: Escape cancels, Enter confirms (when focus isn't on the
     cancel button — preserves the user's choice if they tabbed there). */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter') {
        const active = document.activeElement as HTMLElement | null;
        if (active?.dataset?.confirmRole === 'cancel') return;
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onConfirm, onCancel]);

  const title = opts.title || (opts.danger ? 'Wirklich fortfahren?' : 'Bestätigen');
  const confirmLabel = opts.confirmLabel || (opts.danger ? 'Ja, fortfahren' : 'Bestätigen');
  const cancelLabel = opts.cancelLabel || 'Abbrechen';

  /* Tone palette for the confirm button. */
  const toneBg = tone === 'danger' ? T.status.danger.main : 'var(--accent)';
  const toneText = '#FFFFFF';

  return (
    <div
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.42)',
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        cursor: 'pointer',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        animation: 'mp-cd-bg-in 200ms cubic-bezier(0.16, 1, 0.3, 1) both',
      }}
    >
      <style>{`
        @keyframes mp-cd-bg-in {
          0%   { opacity: 0; }
          100% { opacity: 1; }
        }
        @keyframes mp-cd-card-in {
          0%   { opacity: 0; transform: translateY(8px) scale(0.98); }
          100% { opacity: 1; transform: translateY(0)   scale(1); }
        }
      `}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={beta ? {
          maxWidth: 460,
          width: '100%',
          padding: 8,
          background: '#F4F5F7',
          border: '2px solid #FFFFFF',
          borderRadius: 28,
          boxShadow: '0 0 89.7px 0 rgba(0, 0, 0, 0.08)',
          cursor: 'default',
          animation: 'mp-cd-card-in 240ms cubic-bezier(0.16, 1, 0.3, 1) both',
          fontFamily: T.font.ui,
        } : {
          maxWidth: 460,
          width: '100%',
          background: T.bg.surface,
          border: `1px solid ${T.border.primary}`,
          borderRadius: 16,
          boxShadow: '0 18px 48px -20px rgba(15, 23, 42, 0.30)',
          cursor: 'default',
          animation: 'mp-cd-card-in 240ms cubic-bezier(0.16, 1, 0.3, 1) both',
          fontFamily: T.font.ui,
        }}
      >
        <div style={beta ? {
          background: '#FFFFFF',
          borderRadius: 22,
          padding: '24px 26px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        } : {
          padding: '22px 24px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}>
          {/* Eyebrow — mono caps, severity-tinted */}
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 10.5,
            fontWeight: 700,
            fontFamily: T.font.mono,
            color: tone === 'danger' ? T.status.danger.text : T.text.faint,
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
          }}>
            {tone === 'danger' ? (
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                <path d="M6 1.5L11 10H1z" stroke="currentColor" strokeWidth="1.6"
                      strokeLinejoin="round" />
                <path d="M6 5v2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <circle cx="6" cy="9" r="0.55" fill="currentColor" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.6" />
                <path d="M6 4v2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <circle cx="6" cy="8.4" r="0.55" fill="currentColor" />
              </svg>
            )}
            {tone === 'danger' ? 'Achtung' : 'Bestätigen'}
          </span>

          <h2
            id="confirm-title"
            style={{
              margin: 0,
              fontSize: 17,
              fontWeight: 600,
              color: T.text.primary,
              letterSpacing: '-0.012em',
              lineHeight: 1.3,
            }}
          >
            {opts.message || title}
          </h2>

          {opts.detail && (
            <p style={{
              margin: 0,
              fontSize: 13,
              color: T.text.subtle,
              lineHeight: 1.5,
              letterSpacing: '-0.005em',
            }}>
              {opts.detail}
            </p>
          )}

          <div style={{
            marginTop: 6,
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 8,
          }}>
            <button
              type="button"
              data-confirm-role="cancel"
              onClick={onCancel}
              style={{
                all: 'unset',
                cursor: 'pointer',
                padding: '10px 16px',
                fontSize: 13.5,
                fontWeight: 500,
                color: T.text.subtle,
                borderRadius: 999,
                letterSpacing: '-0.005em',
                transition: 'background 180ms ease, color 180ms ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = beta ? '#F4F5F7' : T.bg.surface2;
                e.currentTarget.style.color = T.text.primary;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = T.text.subtle;
              }}
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              ref={confirmBtnRef}
              data-confirm-role="confirm"
              onClick={onConfirm}
              style={{
                all: 'unset',
                cursor: 'pointer',
                padding: '10px 18px',
                background: toneBg,
                color: toneText,
                borderRadius: 999,
                fontSize: 13.5,
                fontWeight: 600,
                letterSpacing: '-0.005em',
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
              onFocus={(e) => {
                e.currentTarget.style.outline = `2px solid ${tone === 'danger' ? T.status.danger.main : T.accent.main}`;
                e.currentTarget.style.outlineOffset = '2px';
              }}
              onBlur={(e) => {
                e.currentTarget.style.outline = 'none';
              }}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
