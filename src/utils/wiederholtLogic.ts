/* ─────────────────────────────────────────────────────────────────────────
   WIEDERHOLT — repeat detection (full-screen overlay trigger).

   SHOW    if useItem code appears on the NEXT pallet AND that occurrence
           has quantity ≥ 30
   DON'T   if NEXT article in the SAME pallet has same code (continuous
           within one pallet — the worker just keeps scanning)

   Cross-pallet repeats are NOT suppressed. When two consecutive pallets
   hold the same article (especially single-article 4-Seiten-Warnung
   pallets that look visually identical), the worker often takes the
   first pallet back by mistake after finishing it. Wiederholt is the
   warning that prevents that confusion — even if it's "continuous", the
   pallet boundary is real and the worker needs to see it.
   ───────────────────────────────────────────────────────────────────────── */

const QTY_THRESHOLD = 30;

export function detectWiederholt(pallets, palletIdx, itemIdx) {
  const pallet = pallets?.[palletIdx];
  if (!pallet) return null;
  const item = pallet.items?.[itemIdx];
  if (!item) return null;
  const code = item.useItem || item.fnsku;
  if (!code) return null;

  // Suppression: next article WITHIN the same pallet has same code
  // (worker just keeps scanning — no need to surface an overlay).
  const nextInPallet = pallet.items?.[itemIdx + 1];
  if (nextInPallet && (nextInPallet.useItem || nextInPallet.fnsku) === code) {
    return null;
  }

  // Look at NEXT pallet for hit with qty > 30
  const np = pallets?.[palletIdx + 1];
  if (!np) return null;
  const hit = np.items.find((it) => {
    const c = it.useItem || it.fnsku;
    return c === code && (it.units || 0) >= QTY_THRESHOLD;
  });
  if (!hit) return null;

  return {
    code,
    units: hit.units,
    palletId: np.id,
    name: hit.title,
  };
}