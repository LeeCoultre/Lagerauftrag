/* FBA-Bestellung-Generator — auto-composes a Lagerauftrag plan from
   the per-row "Bestellung" (URGENT/READY) signals on the Verkäufe tab.

   Algorithm (4 phases):
     A. Collect demand   — keep rows where computeOrderTrigger().state
                           is 'urgent' or 'ready' (qty > 0).
     B. Split            — for each demand row: qty = floor/perPallet
                           full single-SKU palettes + remainder → Einzelne pool.
     C. Bin-pack mixed   — greedy First-Fit by (level, brand) clusters,
                           respecting 700 kg / 1.59 m³ soft caps.
     D. Number + stats   — single-SKU palettes first (P1-B1…), then mixed.

   The generator deliberately produces its own slim `BestellungPalette`
   shape (rather than the full `palletState` used by PalletStackViz)
   because the input rows lack the rich item structure expected by the
   existing helpers. A follow-up can wire PalletStackViz once item-shape
   compatibility is bridged. */

import type { SkuDimensionLookup } from '@/types/api';
import {
  computeOrderTrigger,
  type OrderState,
  type VariantSalesRow,
} from '@/screens/LynneTable';

/* ─── Physical limits — kept in sync with auftragHelpers.ts ────────── */

const PALLET_VOL_M3              = 1.59;
const PALLET_VOL_CM3             = PALLET_VOL_M3 * 1e6;
const PALLET_WEIGHT_KG           = 700;
const PALLET_WEIGHT_OVERLOAD_KG  = PALLET_WEIGHT_KG + 5;
const DEFAULT_KG_PER_CARTON      = 0.55;
const PACK_COEFF                 = 1.125;
const FALLBACK_VOL_CM3           = 1500;          // ≈ 15×10×10 cm thermo carton

/* ─── Public types ─────────────────────────────────────────────────── */

export type BestellungPaletteType = 'single' | 'mixed';
export type BestellungOverloadFlag = 'OVERLOAD-W' | 'OVERLOAD-V';

export interface BestellungItem {
  row: VariantSalesRow;
  units: number;
  weightKg: number;
  volCm3: number;
  /** Per-unit weight used for this line (debugging / display). */
  unitWeightKg: number;
  unitVolCm3: number;
  isUrgent: boolean;
}

export interface BestellungPalette {
  id: string;                                 // "P1-B1"
  type: BestellungPaletteType;
  items: BestellungItem[];
  totalUnits: number;
  totalWeightKg: number;
  totalVolCm3: number;
  fillPctVol: number;                         // 0…1+ (1+ → OVERLOAD-V)
  fillPctWeight: number;
  overloadFlags: Set<BestellungOverloadFlag>;
  hasUrgent: boolean;
}

export interface BestellungStats {
  totalPalettes:    number;
  singlePalettes:   number;
  mixedPalettes:    number;
  totalUnits:       number;
  totalWeightKg:    number;
  totalVolM3:       number;
  urgentSkus:       number;
  readySkus:        number;
  skippedSkus:      number;
  unassignedItems:  number;                   // edge-case carton that didn't fit anywhere
  overloadPalettes: number;
}

export interface BestellungPlan {
  palettes: BestellungPalette[];
  einzelneRemainder: BestellungItem[];        // could not fit even on an empty mixed
  stats: BestellungStats;
}

/* ─── Per-unit dimensional helpers ─────────────────────────────────── */

function unitWeightKg(dim?: SkuDimensionLookup | null): number {
  if (dim?.weightKg && dim.weightKg > 0) return dim.weightKg;
  return DEFAULT_KG_PER_CARTON;
}

function unitVolCm3(dim?: SkuDimensionLookup | null): number {
  if (dim?.lengthCm && dim?.widthCm && dim?.heightCm) {
    return dim.lengthCm * dim.widthCm * dim.heightCm * PACK_COEFF;
  }
  return FALLBACK_VOL_CM3;
}

function resolveDim(
  row: VariantSalesRow,
  dimsBySku: Map<string, SkuDimensionLookup>,
): SkuDimensionLookup | undefined {
  return dimsBySku.get(row.sku) ?? (row.ean ? dimsBySku.get(row.ean) : undefined) ?? dimsBySku.get(row.asin);
}

/* ─── Palette factory + fit checks ─────────────────────────────────── */

function makeSinglePalette(id: string, item: BestellungItem): BestellungPalette {
  const overloadFlags = computeOverload(item.weightKg, item.volCm3);
  return {
    id,
    type:           'single',
    items:          [item],
    totalUnits:     item.units,
    totalWeightKg:  item.weightKg,
    totalVolCm3:    item.volCm3,
    fillPctVol:     item.volCm3 / PALLET_VOL_CM3,
    fillPctWeight:  item.weightKg / PALLET_WEIGHT_KG,
    overloadFlags,
    hasUrgent:      item.isUrgent,
  };
}

function makeMixedPalette(id: string): BestellungPalette {
  return {
    id,
    type:           'mixed',
    items:          [],
    totalUnits:     0,
    totalWeightKg:  0,
    totalVolCm3:    0,
    fillPctVol:     0,
    fillPctWeight:  0,
    overloadFlags:  new Set<BestellungOverloadFlag>(),
    hasUrgent:      false,
  };
}

function fits(p: BestellungPalette, item: BestellungItem): boolean {
  const newW = p.totalWeightKg + item.weightKg;
  const newV = p.totalVolCm3 + item.volCm3;
  return newW <= PALLET_WEIGHT_OVERLOAD_KG && newV <= PALLET_VOL_CM3;
}

function addToMixed(p: BestellungPalette, item: BestellungItem): void {
  p.items.push(item);
  p.totalUnits     += item.units;
  p.totalWeightKg  += item.weightKg;
  p.totalVolCm3    += item.volCm3;
  p.fillPctVol      = p.totalVolCm3 / PALLET_VOL_CM3;
  p.fillPctWeight   = p.totalWeightKg / PALLET_WEIGHT_KG;
  p.overloadFlags   = computeOverload(p.totalWeightKg, p.totalVolCm3);
  if (item.isUrgent) p.hasUrgent = true;
}

function computeOverload(weightKg: number, volCm3: number): Set<BestellungOverloadFlag> {
  const flags = new Set<BestellungOverloadFlag>();
  if (weightKg > PALLET_WEIGHT_OVERLOAD_KG) flags.add('OVERLOAD-W');
  if (volCm3   > PALLET_VOL_CM3)            flags.add('OVERLOAD-V');
  return flags;
}

/* ─── composeBestellung — main entry point ─────────────────────────── */

export function composeBestellung(
  rows: VariantSalesRow[],
  dimsBySku: Map<string, SkuDimensionLookup>,
): BestellungPlan {
  /* Phase A — demand collection */
  type Demand = {
    row: VariantSalesRow;
    qty: number;
    perPallet: number;
    state: OrderState;
    unitWeight: number;
    unitVol: number;
  };

  const demands: Demand[] = [];
  let urgentCount = 0;
  let readyCount  = 0;

  for (const row of rows) {
    const trigger = computeOrderTrigger(row);
    if (trigger.state !== 'urgent' && trigger.state !== 'ready') continue;
    if (trigger.qty <= 0) continue;
    const dim = resolveDim(row, dimsBySku);
    demands.push({
      row,
      qty:        trigger.qty,
      perPallet:  Math.max(1, row.perPallet || 1),
      state:      trigger.state,
      unitWeight: unitWeightKg(dim),
      unitVol:    unitVolCm3(dim),
    });
    if (trigger.state === 'urgent') urgentCount += 1;
    else                            readyCount  += 1;
  }

  const skippedSkus = rows.length - demands.length;

  /* Phase B — single-SKU palettes + Einzelne pool */
  const palettes: BestellungPalette[] = [];
  const einzelnePool: BestellungItem[] = [];
  let palletIdx = 1;

  // Urgent SKUs ship first → their single-SKU palettes get the lowest
  // P1-B numbers, which surfaces critical ones at the top of the panel.
  demands.sort((a, b) => {
    if (a.state !== b.state) return a.state === 'urgent' ? -1 : 1;
    return b.qty - a.qty;
  });

  for (const d of demands) {
    const fullPallets = Math.floor(d.qty / d.perPallet);
    const remainder   = d.qty - fullPallets * d.perPallet;
    const isUrgent    = d.state === 'urgent';

    for (let i = 0; i < fullPallets; i++) {
      const item: BestellungItem = {
        row:           d.row,
        units:         d.perPallet,
        unitWeightKg:  d.unitWeight,
        unitVolCm3:    d.unitVol,
        weightKg:      d.perPallet * d.unitWeight,
        volCm3:        d.perPallet * d.unitVol,
        isUrgent,
      };
      palettes.push(makeSinglePalette(`P1-B${palletIdx++}`, item));
    }
    if (remainder > 0) {
      einzelnePool.push({
        row:           d.row,
        units:         remainder,
        unitWeightKg:  d.unitWeight,
        unitVolCm3:    d.unitVol,
        weightKg:      remainder * d.unitWeight,
        volCm3:        remainder * d.unitVol,
        isUrgent,
      });
    }
  }

  /* Phase C — bin-pack Einzelne into mixed palettes.
     Sort by (brand asc, vol desc) so similar items cluster and the
     biggest cartons land first (FFD heuristic). */
  einzelnePool.sort((a, b) => {
    const ba = a.row.brand || '';
    const bb = b.row.brand || '';
    if (ba !== bb) return ba.localeCompare(bb);
    return b.volCm3 - a.volCm3;
  });

  const einzelneRemainder: BestellungItem[] = [];
  let currentMixed: BestellungPalette | null = null;

  for (const item of einzelnePool) {
    if (!currentMixed || !fits(currentMixed, item)) {
      if (currentMixed && currentMixed.items.length > 0) palettes.push(currentMixed);
      currentMixed = makeMixedPalette(`P1-B${palletIdx++}`);
      if (!fits(currentMixed, item)) {
        // Item too large for any pallet — record as unassigned (edge case).
        einzelneRemainder.push(item);
        // Discard the opened mixed palette since nothing went onto it.
        palletIdx -= 1;
        currentMixed = null;
        continue;
      }
    }
    addToMixed(currentMixed, item);
  }
  if (currentMixed && currentMixed.items.length > 0) palettes.push(currentMixed);

  /* Phase D — stats */
  const single  = palettes.filter((p) => p.type === 'single').length;
  const mixed   = palettes.length - single;
  const totalU  = palettes.reduce((s, p) => s + p.totalUnits,    0);
  const totalW  = palettes.reduce((s, p) => s + p.totalWeightKg, 0);
  const totalV  = palettes.reduce((s, p) => s + p.totalVolCm3,   0);
  const overloads = palettes.filter((p) => p.overloadFlags.size > 0).length;

  return {
    palettes,
    einzelneRemainder,
    stats: {
      totalPalettes:    palettes.length,
      singlePalettes:   single,
      mixedPalettes:    mixed,
      totalUnits:       totalU,
      totalWeightKg:    totalW,
      totalVolM3:       totalV / 1e6,
      urgentSkus:       urgentCount,
      readySkus:        readyCount,
      skippedSkus,
      unassignedItems:  einzelneRemainder.length,
      overloadPalettes: overloads,
    },
  };
}
