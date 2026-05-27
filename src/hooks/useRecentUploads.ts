/* Last N successfully-parsed uploads, persisted in localStorage.

   Each entry:
     { id, fileName, fbaCode, palletCount, articleCount, ts }

   • `id` is the auftrag UUID, so clicks can navigate to its detail.
   • `ts` lets us format "vor X min" relative to now.

   Capped at MAX (default 5) — older entries fall off the tail. We
   de-dupe by id: re-uploading the same auftrag bumps it to the top
   instead of creating a second row.

   No auto-cleanup of completed/deleted Aufträge — the recent list is
   purely a UX shortcut, dead links just open a 404 detail. We could
   prune via /api/auftraege?ids=... but it's not worth the complexity
   for a list of 5. */

import { useCallback, useEffect, useState } from 'react';

export const RECENT_UPLOADS_KEY = 'marathon.recent_uploads.v1';
export const RECENT_UPLOADS_EVENT = 'marathon:recent_uploads_changed';
const KEY = RECENT_UPLOADS_KEY;
const MAX = 5;

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(items) {
  try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* ignore */ }
}

export function useRecentUploads() {
  const [items, setItems] = useState(read);

  /* Keep multiple tabs/sessions in sync — storage event fires when
     another window writes the same key. Also listen to an in-window
     custom event so that non-hook helpers (e.g. state.tsx's leaveMut
     cleanup) can mutate the list and have all live hooks re-read. */
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setItems(read());
    };
    const onCustom = () => setItems(read());
    window.addEventListener('storage', onStorage);
    window.addEventListener(RECENT_UPLOADS_EVENT, onCustom);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(RECENT_UPLOADS_EVENT, onCustom);
    };
  }, []);

  const broadcast = () => {
    try { window.dispatchEvent(new Event(RECENT_UPLOADS_EVENT)); }
    catch { /* SSR or restricted env — silent */ }
  };

  const add = useCallback((entry) => {
    if (!entry?.id) return;
    setItems((prev) => {
      const next = [
        { ...entry, ts: entry.ts ?? Date.now() },
        ...prev.filter((e) => e.id !== entry.id),
      ].slice(0, MAX);
      write(next);
      broadcast();
      return next;
    });
  }, []);

  const remove = useCallback((id) => {
    setItems((prev) => {
      const next = prev.filter((e) => e.id !== id);
      write(next);
      broadcast();
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    write([]);
    setItems([]);
    broadcast();
  }, []);

  return { items, add, remove, clear };
}

/* Imperative helper for non-React code (e.g. state.tsx's leaveMut cleanup).
   Removes the entry by auftrag id, persists, and notifies every live
   `useRecentUploads` hook in the same window via the custom event. */
export function removeFromRecentUploads(id: string): void {
  if (!id || typeof window === 'undefined') return;
  try {
    const list = read();
    const next = list.filter((e: { id?: string }) => e?.id !== id);
    if (next.length === list.length) return;
    write(next);
    window.dispatchEvent(new Event(RECENT_UPLOADS_EVENT));
  } catch { /* ignore */ }
}