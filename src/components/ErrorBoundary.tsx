/* ─────────────────────────────────────────────────────────────────────────
   ErrorBoundary — global last-line-of-defence wrapper that catches any
   uncaught render or lifecycle error in the React tree and renders a
   readable fallback UI instead of a blank #root.

   Without this, a single throw in any descendant (e.g. a parser edge
   case, a typo in a screen, a stale TanStack cache structure) crashes
   the whole app and the warehouse worker sees a white screen.

   The fallback UI:
     • States plainly that something broke (in German, like the rest)
     • Shows the error message (helpful for the user calling support)
     • Offers two actions: reload page, or copy-to-clipboard the error
       + stack trace for an email/Slack to admin
     • Caches a unique incident ID so logs / Sentry can be cross-
       referenced once observability is wired up

   Wrapping order in main.jsx:
       <ErrorBoundary>          ← outermost — catches Clerk/QueryClient init errors
         <ClerkProvider>
           <QueryClientProvider>
             <App />
           </QueryClientProvider>
         </ClerkProvider>
       </ErrorBoundary>

   Per-screen <ErrorBoundary>'s can be added later for finer recovery
   (e.g. so a Pruefen render crash doesn't blank the Sidebar+Topbar).
   ───────────────────────────────────────────────────────────────────────── */

import React, { Component, type ErrorInfo, type ReactNode } from 'react';

declare global {
  interface Window {
    Sentry?: { captureException?: (err: unknown, context?: unknown) => void };
  }
}

const STORAGE_KEY = 'marathon.lastIncident';

interface ErrorBoundaryProps { children?: ReactNode }
interface ErrorBoundaryState {
  error: Error | null;
  errorInfo: ErrorInfo | null;
  incidentId: string | null;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null, errorInfo: null, incidentId: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const incidentId = `INC-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
    this.setState({ errorInfo, incidentId });

    // Persist a tiny breadcrumb so a refresh doesn't lose all context
    // (we don't store the full stack — privacy / quota).
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        id: incidentId,
        at: new Date().toISOString(),
        msg: String(error?.message || error || '').slice(0, 240),
      }));
    } catch { /* quota / private mode — ignore */ }

    // Console log so devtools picks it up immediately. Sentry hook
    // (Tier 1.1) will replace this with proper capture once wired.
    console.error('[Marathon] Uncaught error', incidentId, error, errorInfo);

    if (typeof window !== 'undefined' && window.Sentry?.captureException) {
      try {
        window.Sentry.captureException(error, {
          tags: { incidentId },
          extra: { componentStack: errorInfo?.componentStack },
        });
      } catch { /* fail-quiet */ }
    }
  }

  handleReload = () => {
    window.location.reload();
  };

  handleCopy = async () => {
    const { error, errorInfo, incidentId } = this.state;
    const payload = [
      `Marathon · ${incidentId}`,
      `Time: ${new Date().toISOString()}`,
      `Build: 2.4.0`,
      `URL:  ${window.location.href}`,
      `User-Agent: ${navigator.userAgent}`,
      '',
      `Error: ${error?.message || error}`,
      '',
      `Stack:`,
      String(error?.stack || '(no stack)').split('\n').slice(0, 12).join('\n'),
      '',
      `Component stack:`,
      String(errorInfo?.componentStack || '').split('\n').slice(0, 16).join('\n'),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(payload);
      alert('In Zwischenablage kopiert. An Admin senden.');
    } catch {
      prompt('Manuell kopieren:', payload);
    }
  };

  render() {
    if (!this.state.error) return this.props.children;

    const { error, incidentId } = this.state;
    return (
      <div style={fallbackStyles.root}>
        <div style={fallbackStyles.panel}>
          <div style={fallbackStyles.iconWrap}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
              <path d="M12 8v5m0 3.5h.01M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"
                    stroke="#EF4444" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h1 style={fallbackStyles.title}>Etwas ist schiefgelaufen</h1>
          <p style={fallbackStyles.lead}>
            Marathon hat einen unerwarteten Fehler entdeckt und konnte die Seite
            nicht weiter rendern. Deine bisherige Arbeit ist auf dem Server
            gespeichert — ein Neuladen sollte reichen, um weiterzumachen.
          </p>

          <div style={fallbackStyles.errorBox}>
            <div style={fallbackStyles.errorBoxLabel}>Fehler</div>
            <div style={fallbackStyles.errorBoxMsg}>
              {String(error?.message || error)}
            </div>
            <div style={fallbackStyles.incident}>
              Vorfall-ID: <span style={{ fontFamily: 'JetBrains Mono, monospace' }}>{incidentId}</span>
            </div>
          </div>

          <div style={fallbackStyles.actions}>
            <button type="button" onClick={this.handleReload} style={fallbackStyles.btnPrimary}>
              Seite neu laden
            </button>
            <button type="button" onClick={this.handleCopy} style={fallbackStyles.btnGhost}>
              Fehler-Details kopieren
            </button>
          </div>
        </div>
      </div>
    );
  }
}

/* Inline styles — Marathon's design tokens aren't available here
   (ErrorBoundary catches errors that may include T being undefined),
   so we use literal hex/rgb values matching the brand. */
const fallbackStyles: Record<string, React.CSSProperties> = {
  root: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#F8FAFC',
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
    padding: 24,
  },
  panel: {
    width: '100%',
    maxWidth: 520,
    background: '#FFFFFF',
    border: '1px solid #E2E8F0',
    borderRadius: 14,
    padding: '32px 32px 28px',
    boxShadow: '0 12px 32px rgba(15, 23, 42, 0.08)',
  },
  iconWrap: {
    width: 64, height: 64,
    borderRadius: 16,
    background: '#FEF2F2',
    border: '1px solid #FECACA',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  title: {
    margin: 0,
    fontFamily: 'Montserrat, Inter, system-ui, sans-serif',
    fontSize: 24,
    fontWeight: 800,
    color: '#0F172A',
    letterSpacing: '-0.02em',
    marginBottom: 8,
  },
  lead: {
    margin: 0,
    fontSize: 14,
    lineHeight: 1.55,
    color: '#475569',
    marginBottom: 18,
  },
  errorBox: {
    background: '#F1F5F9',
    border: '1px solid #E2E8F0',
    borderRadius: 10,
    padding: '12px 14px',
    marginBottom: 18,
  },
  errorBoxLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: '#64748B',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  errorBoxMsg: {
    fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, monospace',
    fontSize: 12.5,
    color: '#0F172A',
    wordBreak: 'break-word',
    marginBottom: 8,
  },
  incident: {
    fontSize: 11.5,
    color: '#64748B',
  },
  actions: {
    display: 'flex',
    gap: 8,
  },
  btnPrimary: {
    flex: 1,
    height: 38,
    border: 0,
    borderRadius: 9,
    background: '#0F172A',
    color: '#FFFFFF',
    fontFamily: 'inherit',
    fontSize: 13.5,
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnGhost: {
    flex: 1,
    height: 38,
    background: '#FFFFFF',
    border: '1px solid #E2E8F0',
    borderRadius: 9,
    color: '#0F172A',
    fontFamily: 'inherit',
    fontSize: 13.5,
    fontWeight: 500,
    cursor: 'pointer',
  },
};