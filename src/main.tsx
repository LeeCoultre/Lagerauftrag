import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as Sentry from '@sentry/react'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { applyAccent, getStoredAccent } from './utils/accent.js'
import { applyTheme, getStoredTheme } from './utils/theme'
import { clerkAppearance } from './utils/clerkAppearance'

/* Sentry — only initialised when a DSN is configured (VITE_SENTRY_DSN).
   Locally we leave it off so dev console stays quiet; on Railway prod
   the env var is set and ErrorBoundary's window.Sentry hook starts
   flowing. The freeze-week test surface is the most important time
   to capture runtime errors, so this lights up immediately on deploy.
   Sample rate is 1.0 (every error) — five users, low traffic, no quota
   pressure. Performance/replay are off (tracesSampleRate=0) until we
   have a reason to enable them. */
const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: import.meta.env.MODE,
    release: 'marathon@2.4.0',
    tracesSampleRate: 0,
    sendDefaultPii: false,
  })
  // ErrorBoundary already calls window.Sentry?.captureException — wire
  // the SDK into that hook so the existing fallback UI participates.
  ;(window as unknown as { Sentry?: typeof Sentry }).Sentry = Sentry
}

/* Apply the user's saved accent + theme before React mounts so the first
   paint already has the right palette (no flash of default orange / no
   flash of light-mode when the user set dark). */
applyAccent(getStoredAccent())
applyTheme(getStoredTheme())

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY
if (!CLERK_KEY) {
  throw new Error('VITE_CLERK_PUBLISHABLE_KEY is not set. See .env.example.')
}

/* Beta-design opt-in: read synchronously here (same key as
   useBetaDesign.tsx) so the QueryClient defaults can pick the safer
   set without waiting for React to mount. Classic defaults are
   preserved byte-identical when beta is off. */
const isBetaDesign = (() => {
  try { return localStorage.getItem('marathon.beta.design') === '1'; }
  catch { return false; }
})()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: isBetaDesign
      ? {
          /* Beta: kill global auto-refetch. Queries that need polling
             (auftraege in Focus, useApiHealth, useMyShift, etc.) opt
             in explicitly. Eliminates the "UI teleport" caused by
             background refetches overwriting optimistic patches. */
          refetchInterval: false,
          refetchOnWindowFocus: false,
          staleTime: 30_000,
          retry: 1,
        }
      : {
          // Auftraege list refetches every 5s so other users' actions show up.
          refetchInterval: 5000,
          refetchOnWindowFocus: true,
          staleTime: 2000,
          retry: 1,
        },
  },
})

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- index.html guarantees #root
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* ErrorBoundary wraps everything — even ClerkProvider init can throw
        (e.g. on a malformed publishable key) so the fallback UI must
        sit one level above it. */}
    <ErrorBoundary>
      <ClerkProvider publishableKey={CLERK_KEY} appearance={clerkAppearance}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </ClerkProvider>
    </ErrorBoundary>
  </StrictMode>,
)