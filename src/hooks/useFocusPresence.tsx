/* Route-active flag for the multi-user Focus screen.
 *
 * Polling on ['auftraege'] is expensive (raw_text/parsed JSONB, GZip
 * still ~30 KB/round-trip on a busy Auftrag). We only need fresh data
 * while the worker is actually on the Focus screen — everywhere else
 * the cache stays cold.
 *
 * Pattern:
 *   - Provider at the App root holds the boolean.
 *   - `useDeclareFocusActive()` is called by the beta Focus screen on
 *     mount; flips the flag on then back off on unmount.
 *   - `useFocusActive()` is consumed by `useAppState()` to gate
 *     `refetchInterval` on the auftraege query.
 *
 * Classic Focus does NOT call useDeclareFocusActive — single-user mode
 * doesn't benefit from polling, so the flag stays false and the query
 * is invalidate-driven, same as before. */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';

interface Ctx {
  active: boolean;
  setActive: (v: boolean) => void;
}

const FocusPresenceCtx = createContext<Ctx | null>(null);

export function FocusPresenceProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  const value = useMemo(() => ({ active, setActive }), [active]);
  return (
    <FocusPresenceCtx.Provider value={value}>
      {children}
    </FocusPresenceCtx.Provider>
  );
}

/** Returns true when at least one screen has declared itself the
 *  "active focus" via useDeclareFocusActive(). Safe to call from
 *  outside the provider (returns false) so existing code paths in
 *  classic Focus that don't mount it still work. */
export function useFocusActive(): boolean {
  const ctx = useContext(FocusPresenceCtx);
  return ctx?.active ?? false;
}

/** Mount-side effect that flips the focus-active flag while the
 *  component is rendered. Call exactly once at the top of the beta
 *  Focus screen. */
export function useDeclareFocusActive(): void {
  const ctx = useContext(FocusPresenceCtx);
  const setActive = useCallback(
    (v: boolean) => ctx?.setActive(v),
    [ctx],
  );
  useEffect(() => {
    if (!ctx) return;
    setActive(true);
    return () => setActive(false);
  }, [ctx, setActive]);
}
