/* Beta-design toggle — global, app-wide.
   Drives any component that wants to opt into the upcoming redesign.
   Persists in localStorage so the choice survives reloads. The provider
   is mounted at the App root; consumers read via `useBetaDesign()`.

   The design itself is intentionally empty for now — components should
   render their classic UI when `beta` is false (the default) and render
   the new design as the user defines it incrementally. */
import {
  createContext, useCallback, useContext, useEffect, useState, type ReactNode,
} from 'react';

const KEY = 'marathon.beta.design';

type Ctx = { beta: boolean; toggleBeta: () => void; setBeta: (v: boolean) => void };
const BetaCtx = createContext<Ctx | null>(null);

export function BetaDesignProvider({ children }: { children: ReactNode }) {
  const [beta, setBetaState] = useState<boolean>(() => {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
  });
  const setBeta = useCallback((v: boolean) => {
    setBetaState(v);
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* ignore */ }
  }, []);
  const toggleBeta = useCallback(() => {
    setBetaState((prev) => {
      const next = !prev;
      try { localStorage.setItem(KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  /* Reflect beta state on the documentElement so the Outfit font swap
     (driven by [data-beta="1"] in src/index.css) applies app-wide
     without each screen having to opt-in via JSX. */
  useEffect(() => {
    const root = document.documentElement;
    if (beta) root.setAttribute('data-beta', '1');
    else root.removeAttribute('data-beta');
  }, [beta]);

  return (
    <BetaCtx.Provider value={{ beta, toggleBeta, setBeta }}>
      {children}
    </BetaCtx.Provider>
  );
}

export function useBetaDesign(): Ctx {
  const ctx = useContext(BetaCtx);
  if (!ctx) throw new Error('useBetaDesign() must be used inside <BetaDesignProvider>');
  return ctx;
}
