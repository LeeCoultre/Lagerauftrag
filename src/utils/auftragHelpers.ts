/* ─────────────────────────────────────────────────────────────────────────
   auftragHelpers — pure helpers that map parsed-Lagerauftrag data into
   shapes the screens consume. Keeps screens dumb.

   v2 — SOP v1.1 implementation:
     • 6-level physical hierarchy (Thermorollen → ÖKO → Klebeband →
       Produktion → Kernöl → Tachorollen) replaces the old `category`.
     • Hard constraints H1-H4 (level order) + H7 (Single-SKU pallets
       excluded via pallet.hasFourSideWarning).
     • Soft 700 kg / 1.59 m³ limits → OVERLOAD-W / OVERLOAD-V flags
       (do NOT block placement; bridge gets escalated in UI).
     • Sweet-Spot 85% scoring is preserved as the geometric tie-breaker
       on top of useItem/format/brand/FNSKU/level bonuses.
     • Real dim/weight from sku_dimensions table when available, fallback
       to the heuristics below.
   ───────────────────────────────────────────────────────────────────────── */

import { parseTitleMeta } from './parseLagerauftrag.js';

/* ─── Level (1-6) — physical stacking order ──────────────────────────────
   1 = bottom, 6 = top. A carton at level X may not sit BELOW a carton
   of level Y < X — that's the load-bearing rule the warehouse enforces.

   Detection is by SKU title regex (SOP Appendix A.6). Order matters:
   higher levels are checked first because their patterns are more
   specific (e.g. "Tacho" beats "Thermorollen" default).
   ───────────────────────────────────────────────────────────────────────── */

export function getLevel(item) {
  const t = (item.title || '').toLowerCase();
  if (/\btacho/.test(t)) return 7;                                  // Tachorollen
  if (/(kürbis|kernöl)/.test(t)) return 6;                          // Kernöl
  // Klebeband (incl. paketband / packband / absperrband / fragile /
  // bruchgefahr) — adhesive tapes and fragile-marker SKUs always sit
  // BELOW Produktion in the stack, so they must be classified BEFORE
  // the L5 regex below. Otherwise a title like "TK THERMALKING Klebeband"
  // would get absorbed into L5 via the brand prefix and lose its own
  // level. (Exception: ESKU Klebeband can land on Produktion pallets —
  // enforced in violatesLevelOrder, not here.)
  if (/(klebeband|paketband|packband|absperrband|fragile|bruchgefahr)/.test(t)) return 4;
  // Produktion: explicit phrasing OR known TK-THERMALKING product line
  // OR any of the bulk-packaging keywords (big bags, sandbags, fillers).
  if (/(wird (von .* )?produziert|tk\s+thermalking|big\s*bag|silosack|sandsack|sandsäcke|sandsaecke|säcke|bauschutt|holzsack|holzwolle|füllmaterial)/.test(t)) return 5;
  // L3 ÖKO Thermorollen — ONLY explicit "öko" branding. `phenolfrei`
  // is a paper spec (BPA-free analog) that regular L1 thermorolls also
  // carry, so matching it would false-positive thermal rolls like
  // "EC Thermorollen ... phenolfrei 52g/m²" into L3. Genuine ÖKO
  // articles always carry the "öko" word in their title — that's the
  // only reliable signal.
  if (/öko/.test(t)) return 3;
  // L2 Veit — own bucket for the VEIT brand thermal rolls so they
  // stand apart from generic L1 Thermorollen. Detection logic is the
  // same `\bveit\b` regex `classifyItem` uses; placed AFTER the öko
  // check so a "VEIT öko …" title still resolves to L3 ÖKO the way it
  // did before this split.
  if (/\bveit\b/.test(t)) return 2;
  return 1;                                                          // Thermorollen (default)
}

export const LEVEL_META = {
  1: { name: 'Thermorollen',   shortName: 'THERMO',     color: '#3B82F6', bg: '#EFF6FF', text: '#1D4ED8' },
  2: { name: 'Veit',           shortName: 'VEIT',       color: '#EC4899', bg: '#FDF2F8', text: '#BE185D' },
  3: { name: 'ÖKO Thermo',     shortName: 'ÖKO',        color: '#06B6D4', bg: '#ECFEFF', text: '#0E7490' },
  4: { name: 'Klebeband',      shortName: 'KLEBE',      color: '#A855F7', bg: '#FAF5FF', text: '#7E22CE' },
  5: { name: 'Produktion',     shortName: 'PRODUKTION', color: '#10B981', bg: '#ECFDF5', text: '#047857' },
  6: { name: 'Kernöl',         shortName: 'KERNÖL',     color: '#F59E0B', bg: '#FFFBEB', text: '#B45309' },
  7: { name: 'Tachorollen',    shortName: 'TACHO',      color: '#F97316', bg: '#FFF7ED', text: '#C2410C' },
};

/* Compat shim: legacy parsed Aufträge (Historie) only have `category`.
   Map it to the closest level for display purposes. */
const CATEGORY_TO_LEVEL = {
  thermorollen: 1,
  heipa: 1,
  veit: 2,
  klebeband: 4,
  produktion: 5,
  tachographenrollen: 7,
  sonstige: 1,
};

/* Compact title for UI rendering — drops marketing/spec noise tokens
   and surfaces the size hint (litres, kg, ml, grams) at the end so it
   survives column-width ellipsis. Original `it.title` is preserved for
   tooltips, parsing, and matching. */
export function formatItemTitle(title) {
  if (!title) return '—';
  let size: string | null = null;
  const sz = title.match(/\((\d+(?:[.,]\d+)?)\s*(ml|l|kg|g)\)/i);
  if (sz) {
    const num = parseFloat(sz[1].replace(',', '.'));
    const unit = sz[2].toLowerCase();
    size = unit === 'l'  ? `${num} L`
         : unit === 'kg' ? `${num} kg`
         : `${num} ${unit}`;
  }
  const core = title
    .replace(/\s+(g\.g\.A\.?|100\s*%|vegan|kaltgepresst|gepresst)\b.*$/i, '')
    .replace(/\s*\(\d+(?:[.,]\d+)?\s*(ml|l|kg|g)\)/gi, '')
    .replace(/\s*[-–]\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return size ? `${core} ${size}` : core;
}

export function getDisplayLevel(item) {
  if (item?.level) return item.level;
  // Live items always have a title — go through SOP v1.1 title regex.
  // The legacy `category` field (set by parseLagerauftrag.classifyItem)
  // lumps Klebeband, Kürbiskernöl etc. into 'produktion' which would
  // collapse multiple SOP levels (3, 4, 5) into a single L4 — wrong.
  // Fall back to category mapping ONLY when the item has no title
  // (legacy Historie summary rows).
  if (item?.title) return getLevel(item);
  if (item?.category) return CATEGORY_TO_LEVEL[item.category] ?? 1;
  return 1;
}

/* ─── Pallet ordering ─────────────────────────────────────────────────────
   Operations rule:
     1. Pallets WITHOUT Tachorollen (level 7) come first
     2. Inside each group, fewest articles first (easy → hard)
     3. Single-SKU pallets (hasFourSideWarning) sharing the same useItem
        cluster together — the worker handles all variants of the same
        parent product back-to-back instead of jumping between SKUs.
     4. Tachorollen-pallets always last
   Stable sort preserves original order for equal-rank pallets.
   ───────────────────────────────────────────────────────────────────────── */
function palletHasLevel(p, level) {
  return (p.items || []).some((it) => getDisplayLevel(it) === level);
}

/* Cluster identifier for a Single-SKU pallet — uniquely identifies the
   product stencilled on the 4-Seiten-Warnung label so split palets of
   the same SKU cluster together. Returns null for Mixed pallets, and
   null when nothing identifies the product.

   Priority chain (most specific → most universal):
     1. useItem ("Zu verwendender Artikel" — parent EAN / X-code).
     2. EAN of the article itself.
     3. FNSKU (Amazon label-level; usually same across split palets of
        the same SKU).
     4. SKU (seller-listing identifier).
   The chain protects against parser variants: some Single-SKU palets
   carry "Zu verwendender Artikel:" lines, others ship without them. */
export function singleSkuClusterKey(p) {
  if (!p?.hasFourSideWarning) return null;
  const first = (p.items || [])[0];
  if (!first) return null;
  const fromUseItem = extractUseItemId(first.useItem);
  if (fromUseItem) return `use:${fromUseItem}`;
  if (first.ean)   return `ean:${String(first.ean)}`;
  if (first.fnsku) return `fnsku:${String(first.fnsku).toUpperCase()}`;
  if (first.sku)   return `sku:${String(first.sku).toUpperCase()}`;
  return null;
}

export function sortPallets(pallets) {
  const list = (pallets || []).map((p, i) => ({ p, i }));

  // First-appearance index per useItem → cluster anchor. Pallets with
  // the same useItem land at the same anchor, so they stay adjacent
  // even when the original order had non-clusterable pallets in
  // between. Mixed (non-single-SKU) pallets keep their own index as
  // anchor, so they retain their relative position.
  const clusterAnchor = new Map<string, number>();
  for (const { p, i } of list) {
    const k = singleSkuClusterKey(p);
    if (k && !clusterAnchor.has(k)) clusterAnchor.set(k, i);
  }
  const anchorOf = (entry) => {
    const k = singleSkuClusterKey(entry.p);
    return k ? clusterAnchor.get(k)! : entry.i;
  };

  return list
    .sort((a, b) => {
      const at = palletHasLevel(a.p, 7) ? 1 : 0;
      const bt = palletHasLevel(b.p, 7) ? 1 : 0;
      if (at !== bt) return at - bt;
      const al = a.p.items?.length || 0;
      const bl = b.p.items?.length || 0;
      if (al !== bl) return al - bl;
      const aa = anchorOf(a);
      const bb = anchorOf(b);
      if (aa !== bb) return aa - bb;
      return a.i - b.i;
    })
    .map((x) => x.p);
}

/* ─── Pallet stats / heuristics ─────────────────────────────────────────── */

const PALLET_VOL_M3   = 1.59;                 // SOP soft limit
export const PALLET_VOL_CM3  = PALLET_VOL_M3 * 1e6;
const PALLET_WEIGHT_KG = 700;                  // SOP soft limit
const TARA_KG         = 0.4;                   // Karton tara (corrugated + tape)
const PACK_COEFF      = 1.125;                 // Packing slack inside the carton
const SWEET_SPOT_PCT  = 0.85;                  // Sweet-spot fill target
const DEFAULT_KG_PER_CARTON = 0.55;            // fallback when no dimensions row

// L7 Tachorollen scale physically linearly in `rollen`: Swip 6 = 2 × Swip 3
// taped together, Swip 12 = 4×, etc. Amazon assigns ONE EAN (9120107187501)
// to the whole family, so any sku_dimensions row keyed by that EAN
// mis-sizes 14 of 15 variants. Solution: bypass dim lookup for Mixed L7
// items and price each Einheit as `rollen × per-roll constants`. Constants
// derived from Swip 3 (densest pack, least cardboard overhead):
//   165 cm³ / 3 rolls = 55 cm³/roll;  0.09 kg / 3 = 0.030 kg/roll.
const TACHO_VOL_PER_ROLL_CM3 = 55;
const TACHO_KG_PER_ROLL      = 0.031;

/* ── Volume / weight model ─────────────────────────────────────────────
   Two physically distinct paths:

   Mixed-Box item (Phase 1, isEinzelneSku=false):
     `units` raw Einheiten go into ONE outer cardboard box (P1-Bx).
     Total volume = units × per-Einheit-volume (no Tara, no PACK_COEFF
     per Einheit — slack and outer box weight live at the pallet level).
     Per-Einheit weight = dimensions.weightKg (same).

   ESKU item (Phase 2, isEinzelneSku=true):
     `cartonsCount` independent FBA cartons. Each carton holds
     `packsPerCarton` Einheiten and has its own slack (×1.125) + Tara
     (0.4 kg). Total volume = cartonsCount × per-carton-volume.

   Heuristics below are reverse-engineered fallbacks used ONLY when
   `item.dimensions` is missing. They produce "reasonable" totals for
   warehouse-typical items: thermorolls ≈ a few cm³ each Einheit; ESKU
   carton ≈ a few thousand cm³.
   ───────────────────────────────────────────────────────────────────── */

/* Per-ESKU-carton heuristic. Used only as ESKU fallback when dimensions
   missing. Returns approximate volume of ONE carton holding the item's
   `packsPerCarton` Einheiten.

   ESKU pattern is "(N × M Rollen)" — the carton holds N consumer-style
   inner packs, each with M rolls. So volume ≈ M_rolls × per-roll-box ×
   N × packing-slack. We recompute the per-roll bounding-box volume
   from dim when present (same physical reality as the Mixed heuristic),
   and only fall back to coarse buckets when no dim is available. */
/* Thermo-roll family — physical packaging is the same cylinder-in-box
   shape across L1 Thermorollen, L2 Veit, and L3 ÖKO Thermo. Heuristics
   share the same roll bounding-box formula for all three. */
const THERMO_FAMILY = new Set([1, 2, 3]);

function eskuCartonHeuristicCm3(it) {
  const lvl = getDisplayLevel(it);
  const N = it.einzelneSku?.packsPerCarton ?? 10;
  if (THERMO_FAMILY.has(lvl)) {
    const wCm = (it.dim?.w ?? 57) / 10;
    const dCm = (it.dim?.normH ?? it.dim?.h ?? 35) / 10;
    const perRollBox = Math.max(20, wCm * dCm * dCm);
    const rollsPerInner = it.rollen || 5;
    return perRollBox * rollsPerInner * N * ROLL_PACK_INV;
  }
  if (lvl === 7) return 1500 * N;             // Tachorollen carton scaled by inner packs
  if (lvl === 6) return 1100 * N;             // Kernöl bottle ≈1.1L outer
  if (lvl === 5) return 1800 * N;             // Produktion
  if (lvl === 4) return 350  * N;             // Klebeband
  return 800 * N;
}

/* Sniff "500 g" / "1 Kg" / "1.5 kg" hints from item title and convert
   to kg. Returns null if nothing recognised. Lets Füllmaterial-type
   items get a sensible per-Einheit weight without dim data. */
function weightFromTitle(title) {
  if (!title) return null;
  const t = title.toLowerCase();
  // kg pattern first (more specific)
  const kg = t.match(/(\d+(?:[.,]\d+)?)\s*k\s*g\b/);
  if (kg) return parseFloat(kg[1].replace(',', '.'));
  const g = t.match(/(\d+(?:[.,]\d+)?)\s*g\b/);
  if (g) return parseFloat(g[1].replace(',', '.')) / 1000;
  return null;
}

/* Per-Einheit heuristic for Mixed items. Much smaller than the ESKU
   per-carton heuristic — one Einheit, not one carton. For thermal
   rolls with `rollen` count, scales by roll count (a 40-roll Einheit
   is bulkier than a 5-roll one).

   `item.dim.w` / `.h` are stored in MILLIMETERS by parseLagerauftrag.
   For thermal rolls the title "57mm × 35mm × 12mm" yields dim.w=57
   (axial width) and dim.h=35 (outer diameter). Some titles use roll
   LENGTH instead of diameter ("57mm × 14m × 12mm"); parseLagerauftrag
   maps those via the heights table to dim.normH (e.g. 14m → 35mm), so
   we always prefer normH and only fall back to raw h.
   ───────────────────────────────────────────────────────────────────
   PHYSICAL MODEL
   ──────────────
   A thermal roll is a cylinder with axial width W and outer diameter D.
   Its bounding box (the cube it occupies on a pallet) is W × D × D.
   N rolls packed into the consumer Einheit-Karton don't tessellate
   perfectly — square-grid cylinder packing leaves ~21% void; add
   ~5% slack for the outer cardboard. Combined factor ≈ 1.30.

   The previous formula (wCm × hCm × 1.0) was a flat cross-section
   times a 1 cm rim — that's ~3.5× too small for a 35 mm-diameter
   roll. With 350 Einheiten of 50-roll boxes, the under-estimate
   showed a near-full pallet as ~22% filled. */
const ROLL_PACK_INV = 1.30;       // cylinder→carton packing slack
const PROD_PACK_INV = 1.10;       // produktion outer-carton slack
const KLEBE_PACK_INV = 1.10;      // Klebeband outer-carton slack
const TACHO_PACK_INV = 1.20;      // small spool packing

function mixedItemHeuristicCm3(it) {
  const lvl = getDisplayLevel(it);
  if (THERMO_FAMILY.has(lvl)) {
    const wCm = (it.dim?.w ?? 57) / 10;
    const dCm = (it.dim?.normH ?? it.dim?.h ?? 35) / 10;
    const perRollBox = Math.max(20, wCm * dCm * dCm);          // floor 20 cm³
    return perRollBox * Math.max(1, it.rollen || 1) * ROLL_PACK_INV;
  }
  if (lvl === 7) {
    // Tachorolle: small spool ~57×15×15 mm bounding-box → ~13 cm³ each
    const wCm = (it.dim?.w ?? 57) / 10;
    const dCm = (it.dim?.normH ?? it.dim?.h ?? 15) / 10;
    const perRollBox = Math.max(8, wCm * dCm * dCm);
    return perRollBox * Math.max(1, it.rollen || 1) * TACHO_PACK_INV;
  }
  if (lvl === 6) return 1000;                                    // 1L bottle + slack
  if (lvl === 5) return 350 * Math.max(1, it.rollen || 1) * PROD_PACK_INV;
  if (lvl === 4) return 80  * Math.max(1, it.rollen || 1) * KLEBE_PACK_INV;
  return 250;
}

/* Per-Einheit weight heuristic for Mixed items. Prefers explicit kg/g
   in the title; falls back to level-based rule scaled by `rollen`. */
function mixedItemHeuristicKg(it) {
  const fromTitle = weightFromTitle(it.title);
  if (fromTitle != null) return fromTitle;
  const lvl = getDisplayLevel(it);
  const r = Math.max(1, it.rollen || 1);
  if (THERMO_FAMILY.has(lvl)) return 0.05 * r;   // 50g per roll (Thermo / Veit / ÖKO)
  if (lvl === 7) return 0.02 * r;                // 20g per Tachorolle
  if (lvl === 6) return 0.45;                    // Kernöl bottle
  if (lvl === 5) return 0.5 * r;                 // Produktion / Sandsäcke
  if (lvl === 4) return 0.08 * r;                // Klebeband
  return 0.10;
}

/* How many "parent Einheiten" of physical content live in ONE ESKU
   carton — used to scale weight/volume.

   When dim is matched via the ESKU's OWN identifier (fnsku/sku/ean/
   asin), the dim row's per-Einheit values describe ONE ESKU Einheit.
   So a carton holds `packsPerCarton` of those, and the multiplier is
   `packsPerCarton`.

   When dim is matched via `useItem` (the parent product's EAN — the
   typical case for Lagerauftrag-derived ESKU), the dim row describes
   the PARENT's per-Einheit. ESKU notation `(N × M)` is the parent's
   Einheit re-packed: e.g. parent "(50 Rollen)" ↔ ESKU "(10 × 5
   Rollen)" — same 50 rolls, just split into smaller packs. So 1
   ESKU carton ≈ 1 parent Einheit physically, multiplier 1.

   Without dim, we rely on heuristics elsewhere. */
function eskuCartonRatio(it) {
  if (!it.dimensions) return it.einzelneSku?.packsPerCarton ?? 1;
  if (it.dimensionsMatch === 'use_item') return 1;
  return it.einzelneSku?.packsPerCarton ?? 1;
}

/* TOTAL volume of an item across all of its Einheiten / cartons. */
export function itemTotalVolumeCm3(it) {
  if (it.isEinzelneSku) {
    const cartons = it.einzelneSku?.cartonsCount ?? Math.max(1, Math.ceil((it.units || 0) / (it.einzelneSku?.packsPerCarton || 1)));
    if (it.dimensions) {
      const ratio = eskuCartonRatio(it);
      const perCarton = it.dimensions.lengthCm * it.dimensions.widthCm * it.dimensions.heightCm * ratio * PACK_COEFF;
      return cartons * perCarton;
    }
    return cartons * eskuCartonHeuristicCm3(it);
  }
  // Mixed: just sum per-Einheit volume (no per-Einheit Tara/PACK_COEFF)
  const u = it.units || 0;
  // L7 Tachorollen — Einheit scales linearly in `rollen` (Swip 6 = 2× Swip 3
  // taped, Swip 12 = 4×, etc.) and all variants share one Stamm-EAN. Per-roll
  // constants are accurate to within ~5%; dim lookup against the shared EAN
  // would mis-size every variant except the one the row was keyed for.
  if (getDisplayLevel(it) === 7) {
    return u * Math.max(1, it.rollen || 1) * TACHO_VOL_PER_ROLL_CM3;
  }
  if (it.dimensions) {
    return u * it.dimensions.lengthCm * it.dimensions.widthCm * it.dimensions.heightCm;
  }
  return u * mixedItemHeuristicCm3(it);
}

/* TOTAL weight of an item. Mixed: units × per-Einheit. ESKU: per-carton
   weight (Einheiten + Tara) × carton count. */
export function itemTotalWeightKg(it) {
  if (it.isEinzelneSku) {
    const cartons = it.einzelneSku?.cartonsCount ?? Math.max(1, Math.ceil((it.units || 0) / (it.einzelneSku?.packsPerCarton || 1)));
    if (it.dimensions) {
      const ratio = eskuCartonRatio(it);
      return cartons * (it.dimensions.weightKg * ratio + TARA_KG);
    }
    return cartons * DEFAULT_KG_PER_CARTON;
  }
  const u = it.units || 0;
  // L7 Tachorollen — same per-roll model as itemTotalVolumeCm3.
  if (getDisplayLevel(it) === 7) {
    return u * Math.max(1, it.rollen || 1) * TACHO_KG_PER_ROLL;
  }
  if (it.dimensions) return u * it.dimensions.weightKg;
  return u * mixedItemHeuristicKg(it);
}

/* Number of physical cartons added to the pallet by this item.
   For Mixed: 0 separate cartons — the Einheiten share the outer P1-Bx box.
   For ESKU: cartonsCount independent FBA cartons. */
function itemCartonCount(it) {
  if (it.isEinzelneSku) {
    return it.einzelneSku?.cartonsCount ?? Math.max(1, Math.ceil((it.units || 0) / (it.einzelneSku?.packsPerCarton || 1)));
  }
  return 0;
}

/* Per-carton volume / weight — used by the ESKU placement loop only.
   Mixed items don't pass through here (their volume is summed at the
   pallet level via itemTotalVolumeCm3).

   Heuristic fallback (no dim row in DB) scales per-Einheit values by
   `packsPerCarton`, so heavier categories like Klebeband-x36 or
   Kürbiskernöl produce realistic per-carton weight rather than a flat
   0.55 kg. The flat default was wrong by 10× for L4/L5 ESKU. */
function eskuCartonVolumeCm3(it) {
  if (it.dimensions) {
    const ratio = eskuCartonRatio(it);
    return it.dimensions.lengthCm * it.dimensions.widthCm * it.dimensions.heightCm * ratio * PACK_COEFF;
  }
  return eskuCartonHeuristicCm3(it);
}

function eskuCartonWeightKg(it) {
  if (it.dimensions) {
    const ratio = eskuCartonRatio(it);
    return it.dimensions.weightKg * ratio + TARA_KG;
  }
  // Per-Einheit weight × packsPerCarton + Tara — so Klebeband-x36
  // (~0.5kg/Einh × 36) yields 18kg per carton instead of 0.55kg.
  const perEinheit = mixedItemHeuristicKg(it);
  const n = it.einzelneSku?.packsPerCarton ?? 1;
  return perEinheit * n + TARA_KG;
}

/* "Work units" for visual prominence on a pallet — number of Einheiten
   for Mixed items (lots of small things), carton count for ESKU. */
function itemWorkUnits(it) {
  if (it.isEinzelneSku) {
    return it.einzelneSku?.cartonsCount ?? 1;
  }
  return Math.max(1, it.units || 0);
}

/* ─── Within-pallet picking order ────────────────────────────────────────
   Order items so the warehouse worker handles them in a sensible
   physical sequence inside one pallet:

     1. Heavy/bulky first (higher total volume → forms the load base)
     2. Within similar volume, more units first (knock out big batches)
     3. Cluster carton-format-matching items adjacent (pulls items with
        the same outer carton size next to each other → fewer context
        switches at the picking station).

   Format clustering uses a sizeBucket from real `dimensions` when
   available (rounded to nearest litre), else falls back to the
   `rollen + dim` signature. Without sku_dimensions data, clustering
   is best-effort for non-roll items.
   ───────────────────────────────────────────────────────────────────── */

/* SOP picking order — drives both Pruefen rendering and Focus workflow.
   The worker stacks the pallet bottom-up, so the order they tackle
   items determines what physically lands first on the base.

   Rule (set 2026-05-03 / refined 2026-05-04 / 2026-05-06):
     1. Group items by physical level (1..6).
     2. Levels 5 (Kürbiskernöl) and 6 (Tachorollen) are the fragile cap
        of the pallet — they ALWAYS come last. Inside that tail, L5
        before L6 (Tacho is the absolute top of the stack).
     3. All other groups (L1..L4) are ordered by ascending level —
        L1 Thermorollen first because they're the heaviest/bulkiest
        rolls and form the physical base of the stack; L4 Produktion
        (Füllmaterial / Sandsäcke / etc.) sits above them, light filler
        material that would crush under L1. Within the same level,
        total units DESC clears the bigger batch first.
     4. Within each level group, items are clustered by W×H format —
        SAME dimensions stay adjacent regardless of rollen-per-Einheit
        count (so a 57×18 with 75 rolls and a 57×18 with 15 rolls land
        next to each other, not interleaved with 57×14 between them).
     5. Order clusters by sum-volume DESC (10% threshold dampens noise),
        ties broken by sum-units DESC then anchor origIdx.
     6. Within a cluster: volume DESC, then units DESC, then origIdx.
     7. ESKU items get unique cluster keys (FNSKU/SKU based) so they
        DO NOT cluster — each ESKU keeps its own placement narrative.

   Works for both Mixed (Phase 1) and ESKU (Phase 2). */
const VOL_TIE_BREAK_THRESHOLD = 0.10;

/* Cluster key — items with the same physical Rolle format group
   together so the worker stacks like-with-like.

   Resolution order:
     1. ESKU → unique key (rule 7, never cluster).
     2. **L1/L2 Thermorollen + useItem present** → `useitem:<EAN>`.
        Variants of the same parent product (same "Zu verwendender
        Artikel" EAN) must always be picked together — regardless of
        rolle size or LST variant. So 4017279107701-57×14 and
        4017279107701-57×35 cluster, while 9120107187419-57×35 stays
        in its own bucket. (User rule 2026-05-13, supersedes the
        2026-05-07 rolle-only rule for thermorollen.)
     3. **Rolle format from title** when extractable — covers L3
        Klebeband and any L1/L2 items without a parseable useItem.
        Same format-signature clusters regardless of own EAN.
     4. Fall back to `dim:WxH|use:EAN/X-code` for items without a
        recognisable rolle pattern (L4 Produktion, generic Sandsäcke,
        etc.). useItem keeps the V5/EZ EAN-cross-reference behaviour
        for those non-rolle SKUs. */
function formatClusterKey(it, level) {
  if (it.isEinzelneSku) {
    return `esku:${it.fnsku || it.sku || it.title || ''}`;
  }
  if (THERMO_FAMILY.has(level)) {
    const useId = extractUseItemId(it.useItem);
    if (useId) return `useitem:${useId}`;
  }
  const rolle = extractRolleFormat(it.title);
  if (rolle) return `rolle:${rolle}`;
  const w = it.dim?.normW ?? it.dim?.w ?? 'x';
  const h = it.dim?.normH ?? it.dim?.h ?? 'x';
  const use = extractUseItemId(it.useItem)
    ?? (it.ean ? String(it.ean) : null)
    ?? 'x';
  return `dim:${w}x${h}|use:${use}`;
}

/* Extract a canonical rolle-format signature from the title.

   Patterns recognised (most specific first):
     • "57mm x 18m x 12mm"  →  "57x18m-12"   (width × length-meters × thickness)
     • "57x18x12 mm"        →  "57x18m-12"   (no spaces variant)
     • "58/64/12"           →  "58/64/12"    (slash-format, e.g. Tacho diameter spec)

   Carton-only specs like "(57x40x12)" without rolle units do NOT match —
   those are carton dimensions and would falsely merge different rolle
   families that happen to ship in similar boxes. */
export function extractRolleFormat(title) {
  if (!title) return null;
  const t = String(title);
  /* "57mm x 18m x 12mm" or "57 mm × 18 m × 12 mm" — middle token has 'm'
     unit (meters, length of rolle), outer tokens have 'mm' (rolle width
     and thickness). The 'm' alone (not 'mm') is the disambiguator. */
  const a = t.match(/(\d{2,3})\s*mm\s*[x×]\s*(\d{1,3})\s*m\s*[x×]\s*(\d{1,3})\s*mm/i);
  if (a) return `${a[1]}x${a[2]}m-${a[3]}`;
  /* Slash-format e.g. "58/64/12" appearing as a standalone token (Tacho
     inner/outer/thickness convention). */
  const b = t.match(/(?:^|\s)(\d{2,3})\/(\d{2,3})\/(\d{1,3})(?=\s|$|[-,])/);
  if (b) return `${b[1]}/${b[2]}/${b[3]}`;
  return null;
}

/* Veit (L2) is normally picked RIGHT AFTER L1 Thermorollen so its rolls
   sit on the Thermo base. But a heavy Veit batch (50-roll packs ≥ 120
   Einheiten, or 20-roll packs ≥ 400 Einheiten) is bulky/dense enough to
   form the physical base itself — then Veit moves BEFORE L1.

   "Heavy" check is per-item: any single Veit row hitting either
   threshold flips the whole L2 group to the base position. */
function isHeavyVeitGroup(group) {
  return group.some((e) => {
    const rolls = e.item.rollen ?? 0;
    const units = e.units || 0;
    if (rolls === 50 && units >= 120) return true;
    if (rolls === 20 && units >= 400) return true;
    return false;
  });
}

/* Detects "large base layer" thermal roll formats — the wide/heavy
   variants the warehouse stacks at the very bottom of a pallet before
   anything else. Matched by title (cheap, robust to missing dimensions
   from sku_dimensions). When this returns true on an ESKU item, Focus
   prepends it to the pallet's item list so the worker sees it first
   and physically lays it as the base.

   Within the base group there is a strict sub-order: 80mm variants
   always come first (heaviest / widest footprint), then the 57×63
   and 58×64 variants follow. See `largeBaseRank()` for the priority. */
export function isLargeBaseFormat(it) {
  return largeBaseRank(it) > 0;
}

/* Sub-priority inside the "large base layer" group:
     2 = 80mm width variants (top priority — placed first)
     1 = 57mm × 63m/mm  or  58 × 64  (placed after 80mm, before Mixed)
     0 = not a base-layer format
*/
export function largeBaseRank(it) {
  const title = it?.title || '';
  if (!title) return 0;
  // 80mm width × anything — highest priority base layer
  if (/\b80\s*mm\s*[x×*]/i.test(title)) return 2;
  // 58 × 64 (Heipa square variant)
  if (/\b58\s*[x×*]\s*64\b/i.test(title)) return 1;
  // 57mm × 63 (mm or m) — Thermalking tall
  if (/\b57\s*mm\s*[x×*]\s*63\s*m/i.test(title)) return 1;
  return 0;
}

export function sortItemsForPallet(items) {
  if (!items?.length) return items || [];
  const FINAL_LEVELS = new Set([6, 7]);

  const enriched = items.map((it, i) => {
    const level = getDisplayLevel(it);
    return {
      item: it,
      origIdx: i,
      level,
      units: it.isEinzelneSku
        ? (it.einzelneSku?.cartonsCount ?? it.placementMeta?.cartonsHere ?? 1)
        : (it.units || 0),
      totalVol: itemTotalVolumeCm3(it),
      fmtKey: formatClusterKey(it, level),
    };
  });

  const groups = new Map();
  for (const e of enriched) {
    if (!groups.has(e.level)) groups.set(e.level, []);
    groups.get(e.level).push(e);
  }

  // Veit (L2) pick-order override: default position is right after L1
  // by ascending order. A heavy Veit batch jumps BEFORE L1 (pickKey 0.5).
  // Other levels keep their natural numeric order.
  const veitGroup = groups.get(2) || [];
  const veitKey = veitGroup.length > 0 && isHeavyVeitGroup(veitGroup) ? 0.5 : 2;
  const pickKey = (lvl) => (lvl === 2 ? veitKey : lvl);

  const orderedGroups = [...groups.entries()]
    .sort(([la, ga], [lb, gb]) => {
      const finalA = FINAL_LEVELS.has(la);
      const finalB = FINAL_LEVELS.has(lb);
      if (finalA !== finalB) return finalA ? 1 : -1;          // non-final first
      if (finalA && finalB) return la - lb;                   // L5 then L6
      // Both non-final: ascending pickKey so L1 forms the physical base
      // (with Veit slotted right after — or before, for heavy batches).
      const ka = pickKey(la);
      const kb = pickKey(lb);
      if (ka !== kb) return ka - kb;
      const sumA = ga.reduce((s, e) => s + e.units, 0);
      const sumB = gb.reduce((s, e) => s + e.units, 0);
      return sumB - sumA;
    })
    .map(([, g]) => g);

  // Within each level: cluster by W×H, order clusters by sum-volume,
  // then sort items inside each cluster.
  for (const g of orderedGroups) {
    if (!g.length) continue;
    const groupLevel = g[0].level;

    /* L7 (Tachorollen) — pack-size dominates ordering. The warehouse
       always stacks the biggest pack first (60 → 15 → 6 → 3 Rollen),
       regardless of total batch units. We bucket by `rollen` and order
       buckets by rollen DESC, falling back to volume/units within the
       same pack-size group. No W×H clustering — Tacho dims are usually
       expressed as "57/8" (slashes) which the dim regex doesn't catch
       anyway, so all Tacho items would otherwise land in one mega-bucket. */
    if (groupLevel === 7) {
      const buckets = new Map();
      for (const e of g) {
        const r = e.item.rollen ?? 0;
        const key = `r:${r}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(e);
      }
      for (const bucket of buckets.values()) {
        bucket.sort((a, b) => {
          if (a.units    !== b.units)    return b.units    - a.units;
          if (a.totalVol !== b.totalVol) return b.totalVol - a.totalVol;
          return a.origIdx - b.origIdx;
        });
      }
      const orderedBuckets = [...buckets.entries()]
        .sort(([ka, ba], [kb, bb]) => {
          const ra = parseInt(ka.slice(2), 10) || 0;
          const rb = parseInt(kb.slice(2), 10) || 0;
          if (ra !== rb) return rb - ra;                  // rollen DESC
          return ba[0].origIdx - bb[0].origIdx;
        })
        .map(([, b]) => b);
      g.length = 0;
      for (const bucket of orderedBuckets) g.push(...bucket);
      continue;
    }

    const buckets = new Map();
    for (const e of g) {
      if (!buckets.has(e.fmtKey)) buckets.set(e.fmtKey, []);
      buckets.get(e.fmtKey).push(e);
    }

    // Within each bucket: volume DESC, units DESC, origIdx (stable).
    for (const bucket of buckets.values()) {
      bucket.sort((a, b) => {
        if (a.totalVol !== b.totalVol) return b.totalVol - a.totalVol;
        if (a.units    !== b.units)    return b.units    - a.units;
        return a.origIdx - b.origIdx;
      });
    }

    // Order buckets: sum-volume DESC (10% threshold), sum-units DESC,
    // anchor origIdx for stability.
    const orderedBuckets = [...buckets.values()].sort((bA, bB) => {
      const volA = bA.reduce((s, e) => s + e.totalVol, 0);
      const volB = bB.reduce((s, e) => s + e.totalVol, 0);
      const vMax = Math.max(volA, volB);
      if (vMax > 0 && Math.abs(volA - volB) / vMax > VOL_TIE_BREAK_THRESHOLD) {
        return volB - volA;
      }
      const unA = bA.reduce((s, e) => s + e.units, 0);
      const unB = bB.reduce((s, e) => s + e.units, 0);
      if (unA !== unB) return unB - unA;
      return bA[0].origIdx - bB[0].origIdx;
    });

    // Flatten back into the level group, preserving cluster adjacency.
    g.length = 0;
    for (const bucket of orderedBuckets) g.push(...bucket);
  }

  return orderedGroups.flatMap((g) => g.map((e) => e.item));
}

/* ─── Per-pallet primary level for badge color ────────────────────────── */
export function primaryLevel(items) {
  // Pick the dominant level by total volume (heavier physical presence)
  if (!items?.length) return 1;
  const vols: Record<string, number> = {};
  for (const it of items) {
    const lvl = getDisplayLevel(it);
    vols[lvl] = (vols[lvl] || 0) + itemTotalVolumeCm3(it);
  }
  const sorted = (Object.entries(vols) as Array<[string, number]>).sort((a, b) => b[1] - a[1]);
  return parseInt(sorted[0][0], 10);
}

/* ─── Einzelne-SKU distribution (V3 — water-fill) ────────────────────────
   SOP v1.1 — Phase 2 placement after Mixed-Boxes are fixed by Auftrag plan.

   Placement rule (2026-05-21 rewrite): ESKU groups go onto the pallet
   with the LOWEST current volume among eligible pallets. The natural
   emergent behaviour balances pallets — once the chosen pallet's volume
   exceeds the next-lowest, the next-lowest becomes the new target for
   subsequent groups. No artificial caps; no scoring tie-breakers steer
   the choice (they only annotate placementMeta for UI transparency).

   Hard constraints (block placement):
     H1-H4: violatesLevelOrder — a level-X carton cannot sit on a pallet
            whose existing items have any level Y > X (with relaxations
            for L7 Tacho, L4-on-L5 Klebeband, and pallets < 70% full).
     H7:    pallet.hasFourSideWarning → Single-SKU pallet, excluded.

   Soft (annotated, never block):
     OVERLOAD-W — pallet weight + carton.weight > 700 kg
     OVERLOAD-V — pallet volume + carton.volume > 1.59 m³
     OVERLOAD-CAP — capacity fraction (cartons / palletLoadMax) > 1.0

   NO_VALID_PLACEMENT: if no pallet passes H1+H7, the carton is assigned
   to the "least bad" pallet (min absolute violations) and flagged for
   manual escalation in the UI — never blocks the workflow.

   Returns:
     {
       byPalletId:   { [palletId]: ESKU items[] (with .placementMeta) },
       unassigned:   ESKU items[] (kept for backward compat, always [] in V2),
       reasons:      { [itemKey]: { source, breakdown, overload, ... } },
       palletStates: { [palletId]: { byLevel, weightKg, volumeCm3,
                                     overloadFlags, fillPct, anyEsku } },
       overloadCount:    int  — total OVERLOAD-W + OVERLOAD-V flags
       noValidCount:     int  — total NO_VALID_PLACEMENT flags
     }
   ───────────────────────────────────────────────────────────────────────── */

export function distributeEinzelneSku(pallets, einzelneSkuItems) {
  const byPalletId = Object.fromEntries((pallets || []).map((p) => [p.id, []]));
  const unassigned = [];
  const reasons = {};
  const palletStates = {};
  let noValidCount = 0;

  if (!pallets?.length) {
    return { byPalletId, unassigned, reasons, palletStates,
             overloadCount: 0, overloadedPalletCount: 0, noValidCount };
  }

  // Initialize pallet states from Phase 1 (Mixed)
  const states = pallets.map(buildPalletState);
  for (const ps of states) palletStates[ps.pallet.id] = ps;

  if (einzelneSkuItems?.length) {
    // Phase 2: enrich + sort ESKU
    const entries = einzelneSkuItems.map(enrichEsku);

    // Group by FNSKU (atomic unit — SOP "ACHTUNG! Jeder Karton ...
    // Kartonnummer": one shipment of N cartons on ONE pallet).
    const groups = new Map();
    for (const e of entries) {
      const key = e.item.fnsku || e.item.sku || e.item.title;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    // Sort: level ASC (lower levels placed first — they're the base of
    // the stack), then total group volume DESC (largest groups placed
    // first so the smaller groups can fine-tune balance afterwards).
    const orderedGroups = Array.from(groups.values()).sort((a, b) => {
      const la = a[0].level, lb = b[0].level;
      if (la !== lb) return la - lb;
      const volA = a.reduce((s, e) => s + e.volCm3 * Math.max(1, e.cartons || 1), 0);
      const volB = b.reduce((s, e) => s + e.volCm3 * Math.max(1, e.cartons || 1), 0);
      return volB - volA;
    });

    for (const group of orderedGroups) {
      for (const e of group) {
        // ATOMIC PLACEMENT — whole FNSKU group lands on the lowest-volume
        // eligible pallet. After this insertion, ps.volCm3 grows; the
        // next group naturally targets whichever pallet is now lowest
        // (water-fill / level-pour). NO_VALID_PLACEMENT fallback only
        // fires when no pallet passes H1-H4 + H7.
        const totalCartons = Math.max(1, e.cartons || 1);
        const result = pickPalletBalanced(e, states, totalCartons);
        const target = result.target;
        for (let i = 0; i < totalCartons; i++) target.add(e);
        const pid = target.pallet.id;
        if (result.flags.includes('NO_VALID_PLACEMENT')) noValidCount += 1;

        byPalletId[pid].push({
          ...e.item,
          placementMeta: {
            score: result.score,
            breakdown: result.breakdown,
            overload: result.overload,
            flags: [...(result.flags || [])],
            cartonsHere: totalCartons,
            cartonsTotalGroup: totalCartons,
          },
        });
        reasons[e.key] = {
          source: result.flags.includes('NO_VALID_PLACEMENT')
            ? 'no_valid_placement'
            : 'assigned',
          breakdown: result.breakdown,
          overload: result.overload,
          flags: result.flags,
          palletId: pid,
          splits: null,
        };
      }
    }
  }

  // Final fillPct per pallet
  for (const ps of states) ps.fillPct = ps.volCm3 / PALLET_VOL_CM3;

  // OVERLOAD counts — derive from final pallet states. One pallet that
  // breaches both weight + volume counts as 2 overload incidents but
  // only 1 affected pallet. Avoids double-counting per ESKU placement
  // (the previous bug where each ESKU added to an already-overloaded
  // pallet bumped the counter again).
  let overloadCount = 0;
  let overloadedPalletCount = 0;
  for (const ps of states) {
    if (ps.overloadFlags.size > 0) overloadedPalletCount += 1;
    overloadCount += ps.overloadFlags.size;
  }

  return { byPalletId, unassigned, reasons, palletStates,
           overloadCount, overloadedPalletCount, noValidCount };
}

/* ─── ESKU key (stable identifier for manual overrides) ──────────────────
   Same key used by distributeEinzelneSku to group atomically (line ~781).
   Moving an ESKU by key means moving the WHOLE group — matches the
   "atomic placement" SOP: all cartons of one FNSKU live on one pallet. */
export function eskuOverrideKey(it) {
  return it?.fnsku || it?.sku || it?.title || '';
}

/* ─── applyEskuOverrides ─────────────────────────────────────────────────
   Re-routes ESKU items between pallets based on a manual overrides map
   `{ [eskuKey]: targetPalletId }`. Returns the SAME shape as
   distributeEinzelneSku so callers can swap in-place.

   - Unknown keys / unknown targets are ignored (override skipped).
   - H7 hasFourSideWarning pallets are blocked targets (single-SKU
     rule is absolute — see CLAUDE.md memory `marathon_four_side_warning`).
   - The move IS allowed to violate H1-H4 / OVERLOAD-W/-V (worker knows
     better in some cases); we annotate placementMeta.manualOverride
     and re-derive palletStates so OVERLOAD flags stay accurate.

   Identity: ESKU items with the same fnsku/sku/title share one key
   (they're already placed atomically by distributeEinzelneSku). Moving
   the key moves all cartons of that group together — matches SOP. */
export function applyEskuOverrides(distribution, overrides, enrichedPallets) {
  if (!distribution || !overrides) return distribution;
  const overrideEntries = (Object.entries(overrides) as Array<[string, string]>)
    .filter(([, v]) => v != null && v !== '');
  if (overrideEntries.length === 0) return distribution;

  const palletById = new Map<string, any>((enrichedPallets || []).map((p) => [p.id, p]));
  const validTargets = new Set<string>(Object.keys(distribution.byPalletId || {}));

  // Build key → list of placed items (with their auto-assigned pid)
  const placedByKey = new Map<string, Array<{ item: any; autoPid: string }>>();
  const byPidEntries = Object.entries(distribution.byPalletId || {}) as Array<[string, any[]]>;
  for (const [pid, items] of byPidEntries) {
    for (const it of items) {
      const k = eskuOverrideKey(it);
      if (!placedByKey.has(k)) placedByKey.set(k, []);
      placedByKey.get(k)!.push({ item: it, autoPid: pid });
    }
  }

  // Resolve final target pid per key (drop invalid overrides)
  const finalTargetByKey = new Map<string, string>();
  let anyApplied = false;
  for (const [key, targetPid] of overrideEntries) {
    if (!placedByKey.has(key)) continue;
    if (!validTargets.has(targetPid)) continue;
    if (palletById.get(targetPid)?.hasFourSideWarning) continue;   // H7 absolute
    const entries = placedByKey.get(key)!;
    if (entries.every((e) => e.autoPid === targetPid)) continue;   // no-op
    finalTargetByKey.set(key, targetPid);
    anyApplied = true;
  }
  if (!anyApplied) return distribution;

  // Build new byPalletId
  const newByPalletId = {};
  for (const pid of validTargets) newByPalletId[pid] = [];
  const newReasons = { ...(distribution.reasons || {}) };

  for (const [key, entries] of placedByKey.entries()) {
    const target = finalTargetByKey.get(key);
    for (const { item, autoPid } of entries) {
      if (target && target !== autoPid) {
        const moved = {
          ...item,
          placementMeta: {
            ...(item.placementMeta || {}),
            manualOverride: true,
            autoTarget: autoPid,
            flags: [...((item.placementMeta?.flags) || []), 'MANUAL-MOVE'],
          },
        };
        newByPalletId[target].push(moved);
        if (newReasons[key]) {
          newReasons[key] = {
            ...newReasons[key],
            source: 'manual_override',
            palletId: target,
            autoTarget: autoPid,
            flags: [...(newReasons[key].flags || []), 'MANUAL-MOVE'],
          };
        }
      } else {
        newByPalletId[autoPid].push(item);
      }
    }
  }

  // Recompute palletStates: rebuild Mixed baseline, then re-add the
  // (possibly re-routed) ESKU items per pallet. We DO NOT block on
  // H1-H4 or H7 here — placement is now manual — but overload flags
  // and capacityFraction get a fresh, accurate read.
  const newPalletStates = {};
  let overloadCount = 0;
  let overloadedPalletCount = 0;
  for (const p of enrichedPallets || []) {
    const ps = buildPalletState(p);
    for (const eskuItem of newByPalletId[p.id] || []) {
      const enriched = enrichEsku(eskuItem);
      ps.add(enriched);
    }
    ps.fillPct = ps.volCm3 / PALLET_VOL_CM3;
    newPalletStates[p.id] = ps;
    if (ps.overloadFlags.size > 0) overloadedPalletCount += 1;
    overloadCount += ps.overloadFlags.size;
  }

  return {
    ...distribution,
    byPalletId: newByPalletId,
    palletStates: newPalletStates,
    reasons: newReasons,
    overloadCount,
    overloadedPalletCount,
  };
}

/* `formatKey` for capacity tracking. Same physical product (one
   sku_dimensions row) → one key; identifies items that share a
   `pallet_load_max` value. Falls back to a synthetic key from L×B×H
   when DB id is missing so heuristic items still group. */
function formatKey(it) {
  if (it?.dimensions?.id) return `id:${it.dimensions.id}`;
  if (it?.dimensions) {
    const d = it.dimensions;
    return `dim:${d.lengthCm}x${d.widthCm}x${d.heightCm}`;
  }
  return null;     // unknown — capacity check skipped for this item
}

function buildPalletState(p) {
  let volCm3 = 0;
  let weightKg = 0;
  const formats = new Set();
  const levels = new Set();
  const brands = new Set();
  const useItemIds = new Set();
  const fnskus = new Set();
  const byLevel = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
  // Capacity tracking — { formatKey: cartons }, plus per-key max
  const formatCounts = {};
  const formatMax = {};

  for (const it of p.items || []) {
    const vol = itemTotalVolumeCm3(it);
    const wgt = itemTotalWeightKg(it);
    volCm3 += vol;
    weightKg += wgt;
    formats.add(formatSig(it));
    const lvl = getDisplayLevel(it);
    levels.add(lvl);
    byLevel[lvl].push({
      item: it,
      source: 'mixed',
      count: itemWorkUnits(it),
      volCm3: vol,
      weightKg: wgt,
    });
    const b = detectBrand(it.title);
    if (b !== 'GENERIC') brands.add(b);
    palletItemTokens(it).forEach((t) => useItemIds.add(t));
    if (it.fnsku) fnskus.add(it.fnsku);
    // Capacity contribution. Mixed cartons = units (1 Einheit ≈ 1 carton
    // for thermal-roll-style items). Skip if no pallet_load_max for the
    // format — falls back to volume soft limit elsewhere.
    const fk = formatKey(it);
    const max = it.dimensions?.palletLoadMax;
    if (fk && max) {
      const cartons = it.isEinzelneSku
        ? (it.einzelneSku?.cartonsCount ?? 1)
        : (it.units || 0);
      formatCounts[fk] = (formatCounts[fk] || 0) + cartons;
      formatMax[fk] = max;
    }
  }

  // Detect Phase-1 overloads up-front
  const overloadFlags = new Set();
  if (weightKg > PALLET_WEIGHT_KG) overloadFlags.add('OVERLOAD-W');
  if (volCm3   > PALLET_VOL_CM3)   overloadFlags.add('OVERLOAD-V');

  // Capacity-fraction overload — sum of (count/max) across formats.
  // > 1.0 means the pallet is physically over-stuffed by carton count
  // (factoring stack height + footprint voids), even if volume in m³
  // looks fine.
  function capacityFraction() {
    let f = 0;
    for (const k of Object.keys(formatCounts)) {
      f += formatCounts[k] / formatMax[k];
    }
    return f;
  }
  if (capacityFraction() > 1.0) overloadFlags.add('OVERLOAD-CAP');

  return {
    pallet: p,
    volCm3, weightKg,
    formats, levels, brands, useItemIds, fnskus,
    formatCounts, formatMax,
    byLevel,
    overloadFlags,
    fillPct: volCm3 / PALLET_VOL_CM3,
    capacityFraction,
    anyEsku: false,
    eligible: p.hasFourSideWarning !== true,    // H7

    add(e) {
      const newVol = this.volCm3 + e.volCm3;
      const newWgt = this.weightKg + e.weightKg;
      if (newWgt > PALLET_WEIGHT_KG) this.overloadFlags.add('OVERLOAD-W');
      if (newVol > PALLET_VOL_CM3)   this.overloadFlags.add('OVERLOAD-V');
      this.volCm3 = newVol;
      this.weightKg = newWgt;
      this.formats.add(e.formatSig);
      this.levels.add(e.level);
      if (e.brand !== 'GENERIC') this.brands.add(e.brand);
      if (e.useItemId) this.useItemIds.add(e.useItemId);
      if (e.item.fnsku) this.fnskus.add(e.item.fnsku);
      // Capacity: one ESKU carton = +1 of this format's count
      if (e.formatKey && e.palletLoadMax) {
        this.formatCounts[e.formatKey] = (this.formatCounts[e.formatKey] || 0) + 1;
        this.formatMax[e.formatKey] = e.palletLoadMax;
        if (this.capacityFraction() > 1.0) this.overloadFlags.add('OVERLOAD-CAP');
      }
      this.byLevel[e.level].push({
        item: e.item,
        source: 'esku',
        count: 1,
        volCm3: e.volCm3,
        weightKg: e.weightKg,
      });
      this.anyEsku = true;
      this.fillPct = this.volCm3 / PALLET_VOL_CM3;
    },
  };
}

function enrichEsku(item) {
  const cartons = itemCartonCount(item);
  // Per-ESKU-carton volume / weight — placement loop adds one carton at a time.
  return {
    item,
    key:           item.fnsku || item.sku || item.title,
    cartons,
    volCm3:        eskuCartonVolumeCm3(item),
    weightKg:      eskuCartonWeightKg(item),
    formatSig:     formatSig(item),
    level:         getLevel(item),
    brand:         detectBrand(item.title),
    useItemId:     extractUseItemId(item.useItem),
    formatKey:     formatKey(item),
    palletLoadMax: item.dimensions?.palletLoadMax ?? null,
  };
}

/* H1-H4: a carton at level X may not sit BELOW any existing item of level Y > X.
   The pallet's level stack is monotonic from bottom (1) up to top (7).

   Relaxations (in evaluation order):
   - L7 Tachorollen NEVER blocks — Tacho spools physically occupy a corner
     of the pallet (~2% volume), not a full stack layer, so ESKU can sit
     BESIDE them. Always applies.
   - L4 Klebeband-ESKU may sit on L5 Produktion (Mixed-Box workflow rule;
     ESKU is allowed to co-locate).
   - L6 Kernöl ALWAYS blocks — fragile glass bottles must be on top, items
     below them risk breakage if the pallet shifts. No threshold applies.
   - All other Y > X violations relax when the pallet is < 70% full:
     ESKU can occupy free corners beside higher-level items rather than
     being strictly stacked under them. SOP 2026-05-15 part 2. */
const LEVEL_ORDER_RELAX_THRESHOLD = 0.70;

function violatesLevelOrder(carton, ps) {
  const fillPct = ps.volCm3 / PALLET_VOL_CM3;
  for (const existingLevel of ps.levels) {
    if (existingLevel > carton.level) {
      if (existingLevel === 7) continue;
      if (carton.level === 4 && existingLevel === 5) continue;
      if (existingLevel === 6) return true;                    // Kernöl: hard
      if (fillPct < LEVEL_ORDER_RELAX_THRESHOLD) continue;
      return true;
    }
  }
  return false;
}

function passesHardConstraints(carton, ps) {
  if (!ps.eligible) return false;                   // H7
  if (violatesLevelOrder(carton, ps)) return false; // H1-H4
  return true;
}

function scorePallet(carton, ps) {
  const breakdown: Record<string, boolean | number> = {
    useItemMatch: false, formatMatch: false, brandMatch: false,
    fnskuMatch: false, levelMatch: false,
    monoLevelConflict: false, multiLevelMismatch: false,
    fillScore: 0,
    overloadPenalty: 0,
  };
  let score = 0;

  if (carton.useItemId && ps.useItemIds.has(carton.useItemId)) {
    score += 50000;
    breakdown.useItemMatch = true;
  }
  if (ps.formats.has(carton.formatSig)) {
    score += 10000;
    breakdown.formatMatch = true;
  }
  if (carton.brand !== 'GENERIC' && ps.brands.has(carton.brand)) {
    score += 3000;
    breakdown.brandMatch = true;
  }
  if (carton.item.fnsku && ps.fnskus.has(carton.item.fnsku)) {
    score += 1000;
    breakdown.fnskuMatch = true;
  }
  if (ps.levels.has(carton.level)) {
    score += 500;
    breakdown.levelMatch = true;
  } else if (ps.levels.size === 1) {
    score -= 10000;
    breakdown.monoLevelConflict = true;
  } else if (ps.levels.size > 1) {
    score -= 200;
    breakdown.multiLevelMismatch = true;
  }

  // Sweet-spot 85% — tightness bonus relative to current free space
  const fillAfter = (ps.volCm3 + carton.volCm3) / PALLET_VOL_CM3;
  breakdown.fillScore = Math.round(
    (1 - Math.min(1, Math.abs(SWEET_SPOT_PCT - fillAfter))) * 100
  );
  score += breakdown.fillScore;

  // Empty-pallet preference — load-balancing across pallets of the same
  // level. Strong enough to override brand+fnsku+level (3000+1000+500 =
  // 4500) so a half-empty pallet wins over a near-full pallet of the
  // same brand. Does NOT unseat format-match (10000) unless the pallet
  // is more than half empty (>50% free) — the SOP explicitly prefers
  // format affinity until the load gap becomes large enough that
  // splitting the format becomes the right call.
  const fillBefore = ps.volCm3 / PALLET_VOL_CM3;
  if (fillBefore < 0.5) {
    score += 10000;
    breakdown.emptyPalletBonus = 10000;
  } else if (fillBefore < 0.75) {
    score += 5000;
    breakdown.emptyPalletBonus = 5000;
  }

  // ── Capacity fraction (Pallet load) — strongest signal when known.
  // Empirical max-cartons-per-pallet captures stack height + edge voids
  // that volume m³ alone misses. If THIS placement would push the
  // pallet past 1.0 (= physical full), penalise massively so the
  // distributor splits the group across multiple pallets instead of
  // overstuffing one. Pre-existing over-1.0 keeps its small base
  // penalty (so we don't pile MORE on a known-bad pallet) while still
  // letting useItem-Match win as a tie-breaker if no clean option
  // exists.
  let pen = 0;
  const currentFrac = ps.capacityFraction();
  if (carton.formatKey && carton.palletLoadMax) {
    const wouldFrac = currentFrac + (1 / carton.palletLoadMax);
    breakdown.capacityFraction = wouldFrac;
    if (wouldFrac > 1.0) {
      pen += currentFrac <= 1.0 ? 100000 : 30000;
      breakdown.capacityOverflow = true;
    } else if (wouldFrac > 0.95) {
      score += 200;
      breakdown.nearCapacity = true;
    }
  } else if (currentFrac >= 1.0) {
    // Carton has no known max, but the pallet's other formats have
    // already filled it to physical capacity. Stacking more on top
    // would still overstuff — soft-penalise so a less-full pallet
    // wins. Doesn't apply when pallet has zero capacity-tracked items
    // (then we have no signal and fall through to volume/weight).
    pen += 30000;
    breakdown.palletAtCapacity = true;
  }

  // Volume / weight soft-limit penalty — same logic, lighter weight
  // (capacity fraction above is stricter). Only kicks in for items
  // without pallet_load_max data. Penalty applies on EVERY carton that
  // would land on an over-limit pallet, not just the first one to push
  // it over — otherwise subsequent cartons of the same group keep piling
  // onto the already-overloaded pallet without scoring impact.
  if (!carton.palletLoadMax) {
    if ((ps.weightKg + carton.weightKg) > PALLET_WEIGHT_KG) pen += 50000;
    if ((ps.volCm3   + carton.volCm3)   > PALLET_VOL_CM3)   pen += 50000;
  }

  if (pen > 0) {
    score -= pen;
    breakdown.overloadPenalty = pen;
  }

  return { score, breakdown };
}

/* ─── Water-fill placement (V3, 2026-05-21) ────────────────────────────
   Pure level-pour: the ESKU group goes to the eligible pallet with the
   LOWEST current volume. After each placement that pallet rises; the
   next group naturally targets whichever pallet is now lowest. This
   produces an even fill across all eligible pallets without artificial
   caps, format-match priority, or scoring tie-breakers steering the
   placement.

   `scorePallet` is still called — but only to populate the breakdown
   shown in placementMeta (Pruefen popover / Focus tooltips). It does
   NOT influence which pallet wins; only ps.volCm3 does.

   Ties (two eligible pallets at exactly the same volume): break by
   scorePallet so the more "compatible" pallet wins among equals. In
   practice this only matters at the very first placement (two empty
   pallets); afterwards volumes diverge by the carton volume itself.

   Returns { target, score, breakdown, overload, flags }. Always returns
   a target — falls back to least-bad NO_VALID_PLACEMENT if every pallet
   fails hard constraints. */
function pickPalletBalanced(carton, states, totalCartons) {
  const eligible = states.filter((ps) => passesHardConstraints(carton, ps));

  if (eligible.length > 0) {
    let best: typeof eligible[number] = eligible[0];
    let bestVol = best.volCm3;
    let bestScore = scorePallet(carton, best).score;

    for (let i = 1; i < eligible.length; i++) {
      const ps = eligible[i];
      const vol = ps.volCm3;
      if (vol < bestVol) {
        best = ps;
        bestVol = vol;
        bestScore = scorePallet(carton, ps).score;
      } else if (vol === bestVol) {
        const s = scorePallet(carton, ps).score;
        if (s > bestScore) {
          best = ps;
          bestScore = s;
        }
      }
    }

    const { score, breakdown } = scorePallet(carton, best);
    const overload = predictOverloadGroup(carton, best, totalCartons);
    return {
      target: best,
      score,
      breakdown: { ...breakdown, balanceMode: true },
      overload,
      flags: [...overload],
    };
  }

  // No pallet passes hard constraints — NO_VALID_PLACEMENT on the
  // least-bad pallet (H7 worst, then level-order violation, then
  // fill-pct tie-break). UI surfaces this for manual escalation.
  let best = states[0];
  let leastViolations = Infinity;
  for (const ps of states) {
    let v = 0;
    if (!ps.eligible) v += 100;
    if (violatesLevelOrder(carton, ps)) v += 10;
    v += ps.volCm3 / PALLET_VOL_CM3;
    if (v < leastViolations) {
      leastViolations = v;
      best = ps;
    }
  }
  const overload = predictOverloadGroup(carton, best, totalCartons);
  return {
    target: best,
    score: -Infinity,
    breakdown: { fillScore: 0 },
    overload,
    flags: ['NO_VALID_PLACEMENT', ...overload],
  };
}

function predictOverloadGroup(carton, ps, totalCartons) {
  const flags: string[] = [];
  const w = ps.weightKg + carton.weightKg * totalCartons;
  const v = ps.volCm3   + carton.volCm3   * totalCartons;
  if (w > PALLET_WEIGHT_KG) flags.push('OVERLOAD-W');
  if (v > PALLET_VOL_CM3)   flags.push('OVERLOAD-V');
  if (carton.formatKey && carton.palletLoadMax) {
    const wouldFrac = ps.capacityFraction() + (totalCartons / carton.palletLoadMax);
    if (wouldFrac > 1.0) flags.push('OVERLOAD-CAP');
  }
  return flags;
}

function pickPallet(carton, states) {
  const eligible = states.filter((ps) => passesHardConstraints(carton, ps));

  if (eligible.length > 0) {
    // Hard guardrail: prefer pallets that won't overflow weight/volume
    // after this carton lands. Only fall back to overflow-allowed
    // candidates when EVERY eligible pallet would overflow (genuine
    // density problem — too many cartons for the pallet count). Without
    // this filter the scoring fight (brand-match vs sweet-spot) could
    // still send cartons onto an already-overloaded pallet.
    const wouldNotOverflow = eligible.filter((ps) =>
      (ps.weightKg + carton.weightKg) <= PALLET_WEIGHT_KG &&
      (ps.volCm3   + carton.volCm3)   <= PALLET_VOL_CM3
    );
    const candidates = wouldNotOverflow.length > 0 ? wouldNotOverflow : eligible;

    // Score every eligible pallet, then pick best with FREE-VOLUME tie-break.
    // Without the tie-break the first pallet in iteration order won the
    // toss whenever scores matched, leading to lopsided placements.
    let best: typeof eligible[number] | null = null;
    let bestScore = -Infinity;
    let bestFree = -Infinity;
    let bestBreakdown: Record<string, boolean | number> | null = null;
    for (const ps of candidates) {
      const { score, breakdown } = scorePallet(carton, ps);
      const free = PALLET_VOL_CM3 - ps.volCm3;
      if (score > bestScore || (score === bestScore && free > bestFree)) {
        bestScore = score;
        bestFree = free;
        best = ps;
        bestBreakdown = breakdown;
      }
    }
    const overload = predictOverload(carton, best);
    const flags = [...overload];
    return {
      target: best,
      score: bestScore,
      breakdown: bestBreakdown,
      overload,
      flags,
    };
  }

  // No pallet passes hard — pick least-bad and flag NO_VALID_PLACEMENT
  let best = states[0];
  let leastViolations = Infinity;
  for (const ps of states) {
    let v = 0;
    if (!ps.eligible) v += 100;            // Single-SKU pallet — strongest no
    if (violatesLevelOrder(carton, ps)) v += 10;
    // Tie-break by remaining capacity
    v += ps.volCm3 / PALLET_VOL_CM3;
    if (v < leastViolations) {
      leastViolations = v;
      best = ps;
    }
  }
  const overload = predictOverload(carton, best);
  return {
    target: best,
    score: -Infinity,
    breakdown: { fillScore: 0 },
    overload,
    flags: ['NO_VALID_PLACEMENT', ...overload],
  };
}

function predictOverload(carton, ps) {
  const flags: string[] = [];
  if (ps.weightKg + carton.weightKg > PALLET_WEIGHT_KG) flags.push('OVERLOAD-W');
  if (ps.volCm3 + carton.volCm3 > PALLET_VOL_CM3) flags.push('OVERLOAD-V');
  // Capacity fraction — empirical max cartons of THIS format on THIS
  // pallet (factoring stack height + footprint voids). Only flagged
  // when the carton's format has a known pallet_load_max.
  if (carton.formatKey && carton.palletLoadMax) {
    const wouldFrac = ps.capacityFraction() + (1 / carton.palletLoadMax);
    if (wouldFrac > 1.0) flags.push('OVERLOAD-CAP');
  }
  return flags;
}

/* ─── enrichItemDims — async batch lookup, called from state.jsx ───────
   The Lagerauftrag .docx item carries the FNSKU directly, but the
   underlying physical-product key (the EAN of the SKU it represents) is
   only available in the "Zu verwendender Artikel" line — i.e. the
   `useItem` field, e.g. "wird von 9120107187709 produziert". Without
   probing useItem we'd miss most matches, because admin xlsx imports
   are usually keyed by EAN, not FNSKU. */
export async function enrichItemDims(items, lookupFn) {
  if (!items?.length || !lookupFn) return items;
  const keys = new Set();
  for (const it of items) {
    if (it.fnsku) keys.add(it.fnsku);
    if (it.sku)   keys.add(it.sku);
    if (it.ean)   keys.add(it.ean);
    if (it.asin)  keys.add(it.asin);          // many production items live under ASIN only
    const useId = extractUseItemId(it.useItem);
    if (useId) keys.add(useId);
  }
  if (keys.size === 0) return items;
  let res;
  try {
    res = await lookupFn([...keys]);
  } catch {
    return items;                              // graceful: fall back to heuristics
  }
  const lookups = res?.lookups || {};
  return items.map((it) => {
    const useId = extractUseItemId(it.useItem);
    let dim: unknown = null, source: string | null = null;
    if (lookups[it.fnsku])      { dim = lookups[it.fnsku]; source = 'fnsku'; }
    else if (lookups[it.sku])   { dim = lookups[it.sku];   source = 'sku'; }
    else if (lookups[it.ean])   { dim = lookups[it.ean];   source = 'ean'; }
    else if (lookups[it.asin])  { dim = lookups[it.asin];  source = 'asin'; }
    else if (useId && lookups[useId]) { dim = lookups[useId]; source = 'use_item'; }
    return dim
      ? { ...it, dimensions: dim, dimensionsMatch: source, hasDimensions: true }
      : it;
  });
}

/* ─── Identity / matching helpers ────────────────────────────────────────── */
export function formatSig(it) {
  const r = it.rollen ?? 'x';
  const w = it.dim?.normW ?? it.dim?.w ?? 'x';
  const h = it.dim?.normH ?? it.dim?.h ?? 'x';
  return `${r}-${w}x${h}`;
}

export function detectBrand(title) {
  const t = (title || '').toUpperCase();
  if (/SWIPARO/.test(t))       return 'SWIPARO';
  if (/ECO\s*ROOLLS/.test(t))  return 'ECO_ROOLLS';
  if (/THERMALKING/.test(t))   return 'THERMALKING';
  if (/\bVEIT\b/.test(t))      return 'VEIT';
  if (/\bHEIPA\b/.test(t))     return 'HEIPA';
  return 'GENERIC';
}

function extractUseItemId(s) {
  if (!s) return null;
  const ean = String(s).match(/\b\d{12,14}\b/);
  if (ean) return ean[0];
  const xcode = String(s).match(/\bX[0-9A-Z]{8,10}\b/i);
  if (xcode) return xcode[0].toUpperCase();
  return null;
}

function palletItemTokens(it) {
  const out = new Set();
  const useId = extractUseItemId(it.useItem);
  if (useId) out.add(useId);
  if (it.ean)   out.add(String(it.ean));
  if (it.fnsku) out.add(String(it.fnsku).toUpperCase());
  return out;
}

/* ─── Build view-shape for Pruefen ────────────────────────────────────── */
export function pruefenView(parsed) {
  if (!parsed) return null;
  const pallets = parsed.pallets || [];
  const meta    = parsed.meta || {};

  let cartons = 0, units = 0, articles = 0, weightKg = 0, volumeCm3 = 0;
  const palletViews = pallets.map((p) => {
    let pCartons = 0, pVol = 0, pWeight = 0, pUnits = 0;
    const formats = new Set();
    p.items.forEach((it) => {
      // ESKU adds physical cartons; Mixed shares the outer P1-Bx box (0)
      pCartons += itemCartonCount(it);
      pVol += itemTotalVolumeCm3(it);
      pWeight += itemTotalWeightKg(it);
      pUnits += it.units || 0;
      if (it.dimStr) formats.add(it.dimStr);
    });
    // Outer Mixed-Box itself contributes one carton + Tara
    if (p.items?.length) { pCartons += 1; pWeight += TARA_KG; }
    cartons += pCartons; volumeCm3 += pVol; weightKg += pWeight;
    articles += p.items.length; units += pUnits;
    const lvl = primaryLevel(p.items);
    return {
      id: p.id,
      level: lvl,
      articles: p.items.length,
      units: pUnits,
      fillPct: pVol / PALLET_VOL_CM3,
      formats: Array.from(formats),
      isSingleSku: p.hasFourSideWarning === true,
    };
  });

  const overallFill = pallets.length > 0
    ? volumeCm3 / (pallets.length * PALLET_VOL_CM3)
    : 0;

  return {
    fba: meta.sendungsnummer || meta.fbaCode || '—',
    destination: meta.destination || '—',
    format: parsed.format === 'schilder' ? 'SCHILDER' : 'STANDARD',
    createdDate: meta.createdDate || '',
    createdTime: meta.createdTime || '',
    stats: {
      palletCount: pallets.length,
      articles,
      cartons,
      weightKg: Math.round(weightKg),
      units,
      fillPct: overallFill,
      durationSec: estimateOrderSeconds(pallets),
    },
    pallets: palletViews,
  };
}

/* ─── Order time estimate ─────────────────────────────────────────────── */
const T_PER_ARTICLE = 11;
const T_PER_ARTICLE_TACHO = 21;
const T_PALLET_BASE = 6 * 60;
const T_BETWEEN_PALLETS = 9 * 60;

function isTachoForTiming(it) {
  if (getDisplayLevel(it) !== 7) return false;
  const w = it.dim?.w, h = it.dim?.h;
  if (w === 57 && (h === 15 || h === 6)) return true;
  if (it.rollen === 60) return true;
  return false;
}
export function estimateOrderSeconds(pallets) {
  if (!pallets?.length) return 0;
  let s = 0;
  pallets.forEach((p) => {
    s += T_PALLET_BASE;
    p.items.forEach((it) => { s += isTachoForTiming(it) ? T_PER_ARTICLE_TACHO : T_PER_ARTICLE; });
  });
  s += Math.max(0, pallets.length - 1) * T_BETWEEN_PALLETS;
  return s;
}

/* ─── Build view-shape for Focus ──────────────────────────────────────── */
export function focusItemView(item) {
  const { rollen } = parseTitleMeta(item.title || '');
  /* LST detection — Lieferanten use both the abbreviation (mit/ohne LST)
     and the full word "Lastschrifttext" (sometimes prefixed "SEPA-").
     Also "SEPA-Druck" appears in some Veit titles. The presence-only
     hits (Lastschrift / SEPA-Druck mention without ohne-prefix) imply
     "mit LST" since these phrases describe an included feature. */
  const t = item.title || '';
  const lstFullPos = /\b(?:sepa[-\s]*)?lastschrift(?:text)?\b/i;
  const sepaDruck = /\bsepa[-\s]*druck\b/i;
  const ohneFull = /\bohne\s+(?:sepa[-\s]*)?lastschrift(?:text)?\b/i;
  const lst =
    /\bmit\s+lst\b/i.test(t) ? 'mit LST' :
    /\bohne\s+lst\b/i.test(t) ? 'ohne LST' :
    ohneFull.test(t) ? 'ohne LST' :
    (lstFullPos.test(t) || sepaDruck.test(t)) ? 'mit LST' :
    null;

  // Produktion-Fallback: "(50)" trailing oder "50x ..." leading
  let perCarton = item.rollen || rollen || null;
  const lvl = getDisplayLevel(item);
  if (!perCarton && lvl === 5) {
    perCarton = extractProduktionPerCarton(item.title || '');
  }
  const perCartonUnit = lvl === 5 ? 'Stück' : 'Rollen';

  // ESKU items carry their own carton metadata (cartonsCount =
  // number of FBA-labelled cartons) plus distributor-attached
  // placement flags (OVERLOAD, NO_VALID_PLACEMENT). These show up
  // in Focus so the worker knows it's a separate Phase-2 item with
  // independent FBA Box ID labels.
  const isEsku = item.isEinzelneSku === true;
  const eskuCartons = isEsku
    ? (item.einzelneSku?.cartonsCount ?? Math.max(1, Math.ceil((item.units || 0) / (item.einzelneSku?.packsPerCarton || 1))))
    : null;
  const eskuPacksPerCarton = isEsku ? (item.einzelneSku?.packsPerCarton ?? null) : null;
  const placementFlags = item.placementMeta?.flags || [];

  // Display keeps the original useItem text (incl. wrappers like
  // "wird von X001BVO9LV produziert"), but clipboard gets only the
  // bare code so the worker doesn't paste prose into the scanner.
  const useItemRaw  = item.useItem || '';
  const useItemCode = extractUseItemId(useItemRaw) || useItemRaw;

  /* Artikel-Code priority:
       • ESKU rows always lead with the merchant SKU (e.g. LQ-R9N2-YLD0).
         The SKU is what the worker reads off the FBA box label and what
         downstream systems index, so it must be the scan target whenever
         present. FNSKU rides under it as a secondary line for cross-check.
       • Mixed rows keep FNSKU dominant (legacy behaviour the rest of the
         warehouse flow relies on).
     Both branches fall back to whatever non-empty code we have so the
     hero never renders a bare '—'. */
  const primaryCode = isEsku
    ? (item.sku   || item.fnsku || '—')
    : (item.fnsku || item.sku   || '—');
  const secondaryCode = isEsku
    ? (item.sku && item.fnsku && item.fnsku !== item.sku ? item.fnsku : null)
    : null;

  return {
    code:           primaryCode,
    secondaryCode,
    useItem:        useItemRaw,
    useItemCode,
    units:          item.units || 0,
    name:           shortArticleName(item),
    dim:            item.dimStr,
    rollen:         perCarton,
    rollenUnit:     perCartonUnit,
    level:          lvl,
    levelMeta:      LEVEL_META[lvl],
    lst,
    isEsku,
    eskuCartons,
    eskuPacksPerCarton,
    placementFlags,
  };
}

export function extractProduktionPerCarton(title) {
  // "(50)" am Ende — Stück pro Karton
  const trail = title.match(/\((\d+)\)\s*$/);
  if (trail) return parseInt(trail[1], 10);
  // "TK THERMALKING 50x Sandsäcke ..." — Prefix-Multiplikator
  const lead = title.match(/^(?:[A-ZÄÖÜ]{2,}\s+)+(\d+)\s*x\s+/i);
  if (lead) return parseInt(lead[1], 10);
  return null;
}

/* Extract a clean size hint ("500 g" / "1 Kg" / "1 L" / "250 ml") from
   a Produktion title. Picks the FIRST numeric+unit pair so SKUs like
   "Füllmaterial für Pakete - 500 g Holzwolle ... (500 g Holzwolle)"
   yield "500 g" rather than colliding with later occurrences. Returns
   null if no size token is present. */
function extractL5SizeHint(title) {
  if (!title) return null;
  const m = title.match(/\b(\d+(?:[.,]\d+)?)\s*(kg|g|l|ml)\b/i);
  if (!m) return null;
  const num = m[1];
  const unit = m[2].toLowerCase();
  const pretty = unit === 'kg' ? 'Kg' : unit === 'l' ? 'L' : unit;
  return `${num} ${pretty}`;
}

function shortArticleName(item) {
  const title = item.title || '';
  const { dimStr } = parseTitleMeta(title);
  const lvl = getDisplayLevel(item);

  const lower = title.toLowerCase();
  const isThermo = THERMO_FAMILY.has(lvl) || /thermo|bonroll|kassenroll/i.test(lower);
  if (isThermo) {
    if (dimStr) return `Thermorolle ${dimStr}`;
    // Thermopapier-Notation: "12mm ø, 57mm breit"
    const diameter = title.match(/(\d+)\s*mm\s*ø/i);
    const width    = title.match(/(\d+)\s*mm\s+(?:breit|wide|width|breite)\b/i);
    if (diameter && width) return `Thermopapier, ${diameter[1]}mm ø, ${width[1]}mm`;
    if (diameter)          return `Thermopapier, ${diameter[1]}mm ø`;
    if (width)             return `Thermopapier, ${width[1]}mm breit`;
  }

  if (lvl === 7) {
    // Tacho-Notationen: "57-8mm", "57/8 mm", "57/28/7"
    const m = title.match(/(\d+)\s*[-/×x]\s*(\d+)(?:\s*[-/×x]\s*(\d+))?/i);
    if (m) {
      const dims = [m[1], m[2], m[3]].filter(Boolean).join('/');
      return `Tachographenrollen ${dims}mm`;
    }
    return 'Tachographenrollen';
  }

  if (lvl === 5) {
    // Big Bag SKUs: anchor the name on "Big Bag" itself — drop any
    // leading brand prefix (e.g. "TK THERMALKING") and any trailing
    // size suffix ("1000 Kg", "500 L", …). The per-Einheit "Stück"
    // line and the carton tile already carry the pack info; keeping
    // them in the headline duplicates the same kg figure across every
    // Big Bag variant in the auftrag.
    if (/\bbig\s*bag\b/i.test(title)) {
      const m = title.match(/\bbig\s*bag\b(.*)$/i);
      const tail = (m ? m[1] : '')
        .replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|g|l|ml)\b/gi, '')
        .split(/[,(–—-]/)[0]
        .replace(/\s+/g, ' ')
        .replace(/[\s,;–—-]+$/, '')
        .trim();
      return tail ? `Big Bag ${tail}` : 'Big Bag';
    }
    let s = title
      .replace(/^TK\s+\w+\s+/i, '')
      .replace(/^\d+\s*x\s+/i, '')
      .replace(/\b(für|zum|leer|mit|ohne)\s+.*/i, '')
      .split(/[,(–—-]/)[0]
      .trim();
    if (!s) s = title.split(/[,(]/)[0].trim();
    // Surface the size hint (e.g. "500 g", "1 Kg", "1 L") so visually
    // identical L5 names like "Füllmaterial" are still distinguishable
    // between pack sizes. Read from the original title because the strip
    // above usually drops the "für …" tail that carries the gram count.
    const size = extractL5SizeHint(title);
    if (s.length > 50) s = s.slice(0, 47) + '…';
    if (size && !new RegExp(`\\b${size.replace(/\s+/g, '\\s+')}\\b`, 'i').test(s)) {
      s = `${s} ${size}`;
    }
    return s;
  }

  if (lvl === 6) {
    // Kernöl: drop "g.g.A. 100% vegan und kaltgepresst" noise and
    // surface the litre/ml hint at the end (parser keeps the full title
    // for matching, this is just for rendering).
    return formatItemTitle(title);
  }

  if (title.length > 50) return title.slice(0, 47) + '…';
  return title;
}

/* ─── Level aggregation across pallets (for Abschluss) ────────────────── */
export function levelDistribution(pallets) {
  const totals: Record<string, number> = {};
  let grand = 0;
  pallets.forEach((p) => {
    p.items.forEach((it) => {
      const lvl = getDisplayLevel(it);
      totals[lvl] = (totals[lvl] || 0) + (it.units || 0);
      grand += it.units || 0;
    });
  });
  return (Object.entries(totals) as Array<[string, number]>)
    .sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10))
    .map(([level, units]) => ({
      level: parseInt(level, 10),
      meta: LEVEL_META[parseInt(level, 10)] || LEVEL_META[1],
      units,
      pct: grand ? units / grand : 0,
    }));
}

/* ─── Pallet timings (from current.palletTimings) ─────────────────────── */
export function palletTimingRows(pallets, palletTimings) {
  return pallets.map((p) => {
    const t = palletTimings?.[p.id] || {};
    const dur = t.startedAt && t.finishedAt
      ? Math.round((t.finishedAt - t.startedAt) / 1000)
      : 0;
    return {
      id: p.id,
      level: primaryLevel(p.items),
      articles: p.items.length,
      durSec: dur,
    };
  });
}