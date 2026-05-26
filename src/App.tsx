/* Marathon root — wraps content in AppShell (with persistent sidebar)
   and routes between Workspace (Upload/Pruefen/Focus/Abschluss based on
   current Auftrag step), Historie, and Einstellungen. */

import { lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { AppStateProvider, useAppState } from './state';
import { AppShell } from './components/AppShell.jsx';
import DynamicIsland from './components/DynamicIsland.jsx';
import { useExperiment } from './utils/experiments';
import { CommandPalette } from './components/CommandPalette.jsx';
import { T } from './components/ui';
import { BetaDesignProvider } from './hooks/useBetaDesign';
import { FocusPresenceProvider } from './hooks/useFocusPresence';
import { ConfirmDialogProvider } from './components/ConfirmDialog';

/* Stale-deploy resilience for code-split chunks.
   When Railway redeploys, old chunk filenames are deleted. A tab
   that was open before the deploy holds a cached index.html that
   references the now-404 hashes — the next route navigation throws
   "Failed to fetch dynamically imported module". Wrap every lazy
   loader so a chunk-fetch failure triggers a one-shot hard reload
   (sessionStorage flag prevents reload loops on genuine network
   errors). Errors from inside the chunk module bubble normally to
   the error boundary. */
const RELOAD_FLAG = 'marathon.chunkReloadAt';
function isStaleChunkError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e || '');
  return /Failed to fetch dynamically imported module|Loading chunk|Loading CSS chunk|Importing a module script failed/i.test(msg);
}
function lazyWithReload<T extends ComponentType<any>>(loader: () => Promise<{ default: T }>) {
  return lazy<T>(async () => {
    try {
      return await loader();
    } catch (e) {
      if (isStaleChunkError(e)) {
        const last = Number(sessionStorage.getItem(RELOAD_FLAG) || '0');
        if (Date.now() - last > 30_000) {
          sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
          window.location.reload();
          // Return a stub so React doesn't hit the error boundary
          // while the navigation tears the page down.
          return { default: (() => null) as unknown as T };
        }
      }
      throw e;
    }
  });
}

/* Every screen is lazy-loaded so the initial bundle stays tiny and
   the warehouse worker only pays for the screen they're on. The
   Workspace flow (Upload → Pruefen → Focus → Abschluss) is the
   critical path, but each step is a separate concern + a heavy file
   (Focus alone is ~2k lines) — splitting them keeps the first paint
   fast and the chunks tree-shake independently. */
const UploadScreen         = lazyWithReload(() => import('./screens/Upload.jsx'));
const PruefenScreen        = lazyWithReload(() => import('./screens/Pruefen.jsx'));
const FocusScreen          = lazyWithReload(() => import('./screens/Focus.jsx'));
const AbschlussScreen      = lazyWithReload(() => import('./screens/Abschluss.jsx'));
const HistorieScreen       = lazyWithReload(() => import('./screens/Historie.jsx'));
const EinstellungenScreen  = lazyWithReload(() => import('./screens/Einstellungen.jsx'));
const AdminScreen          = lazyWithReload(() => import('./screens/Admin.jsx'));
const SucheScreen          = lazyWithReload(() => import('./screens/Suche.jsx'));
const LiveAktivitaetScreen = lazyWithReload(() => import('./screens/LiveAktivitaet.jsx'));
const BerichteScreen       = lazyWithReload(() => import('./screens/Berichte.jsx'));
const WarteschlangeScreen  = lazyWithReload(() => import('./screens/Warteschlange.jsx'));
const LynneTableScreen     = lazyWithReload(() => import('./screens/LynneTable.jsx'));

/* Legacy localStorage keys from the pre-backend era. Stale data left
   in old browsers; harmless but pollutes devtools. One-shot cleanup. */
const LEGACY_KEYS = [
  'marathon.queue.v1',
  'marathon.current.v1',
  'marathon.history.v1',
];

function ScreenFallback() {
  return (
    <div style={{
      minHeight: '60vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: T.text.faint,
      fontSize: 13,
      letterSpacing: 0.4,
    }}>
      Lädt…
    </div>
  );
}

function LazyRoute({ children }: { children: ReactNode }) {
  return <Suspense fallback={<ScreenFallback />}>{children}</Suspense>;
}

export default function App() {
  useEffect(() => {
    LEGACY_KEYS.forEach((k) => localStorage.removeItem(k));
  }, []);
  // Experimental floating pill — opt-in via Einstellungen → Experimente.
  // Gated here so the component never even mounts (and never starts its
  // 1Hz tick / connection probe) until the user has explicitly enabled it.
  const [islandEnabled] = useExperiment('dynamicIsland');
  return (
    <BetaDesignProvider>
      <FocusPresenceProvider>
        <ConfirmDialogProvider>
          <AppStateProvider>
            <Router />
            {islandEnabled && <DynamicIsland />}
          </AppStateProvider>
        </ConfirmDialogProvider>
      </FocusPresenceProvider>
    </BetaDesignProvider>
  );
}

const ROUTE_KEY = 'marathon.route.v1';
const VALID_ROUTES = new Set([
  'workspace', 'warteschlange', 'suche', 'historie',
  'live', 'berichte', 'einstellungen', 'admin', 'lynne-table',
]);

function Router() {
  const [route, setRoute] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(ROUTE_KEY);
      if (saved && VALID_ROUTES.has(saved)) return saved;
    } catch { /* ignore */ }
    return 'workspace';
  });
  useEffect(() => {
    try { localStorage.setItem(ROUTE_KEY, route); } catch { /* ignore */ }
  }, [route]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sucheInitialQuery, setSucheInitialQuery] = useState('');

  /* Auto-redirect to Workspace when a new Auftrag becomes current was
     removed: `current` loads asynchronously via TanStack Query, so the
     effect always fired after data settles and overwrote the restored
     route from localStorage on every refresh.
     The action handlers that create a new current (Warteschlange start,
     Upload finish) already call `onRoute('workspace')` explicitly. */

  /* Global Cmd/Ctrl+K → Command Palette. Keep the listener on document
     so it fires regardless of which child has focus, except when typing
     in an input/textarea/contenteditable (those keep their own ⌘K). */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes('MAC');
      const meta  = isMac ? e.metaKey : e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') {
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName;
        const editable = t?.isContentEditable;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || editable) return;
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === 'Escape' && paletteOpen) {
        setPaletteOpen(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [paletteOpen]);

  return (
    <>
      <AppShell
        route={route}
        onRoute={setRoute}
        onOpenCommand={() => setPaletteOpen(true)}
      >
        {route === 'lynne-table'   && <LazyRoute><LynneTableScreen /></LazyRoute>}
        {route === 'workspace'     && <LazyRoute><Workspace onRoute={setRoute} /></LazyRoute>}
        {route === 'warteschlange' && <LazyRoute><WarteschlangeScreen onRoute={setRoute} /></LazyRoute>}
        {route === 'suche'         && <LazyRoute><SucheScreen initialQuery={sucheInitialQuery} /></LazyRoute>}
        {route === 'historie'      && <LazyRoute><HistorieScreen /></LazyRoute>}
        {route === 'live'          && <LazyRoute><LiveAktivitaetScreen /></LazyRoute>}
        {route === 'berichte'      && <LazyRoute><BerichteScreen /></LazyRoute>}
        {route === 'einstellungen' && <LazyRoute><EinstellungenScreen onRoute={setRoute} /></LazyRoute>}
        {route === 'admin'         && <LazyRoute><AdminScreen /></LazyRoute>}
      </AppShell>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onRoute={(r: string, opts?: { query?: string }) => {
          if (r === 'suche' && opts?.query) {
            setSucheInitialQuery(opts.query);
          }
          setRoute(r);
          setPaletteOpen(false);
        }}
      />
    </>
  );
}

function Workspace({ onRoute }: { onRoute: (r: string) => void }) {
  const { current } = useAppState();
  if (!current) return <UploadScreen onRoute={onRoute} />;
  switch (current.step) {
    case 'upload':    return <UploadScreen onRoute={onRoute} />;
    case 'pruefen':   return <PruefenScreen />;
    case 'focus':     return <FocusScreen />;
    case 'abschluss': return <AbschlussScreen />;
    default:          return <PruefenScreen />;
  }
}
