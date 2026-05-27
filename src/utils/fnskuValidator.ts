/* ─────────────────────────────────────────────────────────────────────────
   FNSKU cross-validator.

   Consumes the output of scanFnskuCodes() (independent regex scan over
   raw .docx text) and compares it against the FNSKU values that the
   main columnar parser extracted into parsed.pallets[].items[].fnsku
   (and parsed.einzelneSkuItems[]).

   The two parsers agree on a clean Lagerauftrag. Disagreements catch:
     - missingFromParser : scanner found an FNSKU the columnar parser
                           never produced (column drift, skipped row)
     - extraInParser     : columnar parser produced an FNSKU that does
                           not appear anywhere in the raw text
                           (hallucination / mismatched swap)
     - countMismatches   : same FNSKU but different occurrence counts
                           (multi-pack misparse)
     - positionMismatches: same set of FNSKUs but their order in raw
                           text does not match the order in the parsed
                           item stream (rows swapped)

   The report is purely informational ("warn"); it never blocks the
   workflow. UI surfaces the deltas; the worker decides.
   ───────────────────────────────────────────────────────────────────── */

import type { Parsed } from '../types/api';
import type { ScannedFnsku, ZonedScannedFnsku } from './fnskuScanner';
import {
  validateFieldConsistency,
  validateUseItemCodes,
} from './fieldConsistencyValidator';
import type {
  FieldConsistencyMismatch,
  UseItemMismatch,
} from './fieldConsistencyValidator';

export type { FieldConsistencyMismatch, UseItemMismatch } from './fieldConsistencyValidator';

export interface FnskuCountMismatch {
  fnsku: string;
  scan: number;
  parser: number;
}

export interface FnskuPositionMismatch {
  fnsku: string;
  scanIndex: number;
  parserIndex: number;
}

/** Per-palette delta: scan-side and parser-side counts of a specific
 *  FNSKU on a specific palette diverge. The palletId mirrors what the
 *  columnar parser stores in `parsed.pallets[].id` (e.g. "P1-B1"); the
 *  reserved value "EINZELNE" is used for the Einzelne-SKU tail block. */
export interface FnskuPalletCountMismatch {
  palletId: string;
  fnsku: string;
  scan: number;
  parser: number;
}

/** Reserved palletId used by the einzelne-SKU side of per-palette
 *  comparisons. Picked to avoid collision with real "Px-By" ids. */
export const EINZELNE_PALLET_KEY = 'EINZELNE';

export interface FnskuValidationReport {
  status: 'ok' | 'warn';
  summary: {
    scanCount: number;
    parserCount: number;
    /** FNSKUs filtered from `missingFromParser` because they look like
     *  header/template examples (only appear in the first 500 chars
     *  and only once). Surfaced for diagnostics, not as warnings. */
    headerCandidates: string[];
    /** Diagnostic: how many palette-keys were compared (union of scan
     *  and parser palette sets, including EINZELNE if present). */
    palletsCompared: number;
    /** Diagnostic: total items inspected for cross-field consistency. */
    itemsCompared: number;
  };
  missingFromParser: string[];
  extraInParser: string[];
  countMismatches: FnskuCountMismatch[];
  positionMismatches: FnskuPositionMismatch[];
  palletCountMismatches: FnskuPalletCountMismatch[];
  /** v3: FNSKU-anchored cross-field inconsistencies — same FNSKU paired
   *  with different ASIN/SKU/title/useItem across the Auftrag. */
  fieldConsistencyMismatches: FieldConsistencyMismatch[];
  /** v3: useItem field embeds an EAN or X-code that disagrees with the
   *  item's own ean / fnsku. */
  useItemMismatches: UseItemMismatch[];
}

/** Chars from the start of rawText considered "header zone". A scanned
 *  FNSKU that appears here once and never in the parser output is most
 *  likely an Amazon-template example, not a real item. */
const HEADER_ZONE_CHARS = 500;

/** Tolerance for position-rank comparison. The two streams will differ
 *  by small offsets even on clean docs (header lines, blank lines), so
 *  we only flag a position mismatch when the relative rank diverges by
 *  more than this. */
const POSITION_RANK_TOLERANCE = 1;

/* Backwards-compatible entry point used by callers that only have a
 * flat (non-zoned) scan. Per-palette diff is skipped in this mode —
 * the report will always have palletCountMismatches=[]. New callers
 * should prefer validateFnskuAgainstParserZoned(). */
export function validateFnskuAgainstParser(
  scanned: ScannedFnsku[],
  parsed: Parsed | null | undefined,
): FnskuValidationReport {
  /* Wrap each scan as a header-zoned record so the zoned validator
     treats it as "we don't know which palette" — all matches end up
     filtered for per-palette purposes, but the global checks still
     operate on the full scan set. */
  const zoned: ZonedScannedFnsku[] = scanned.map((s) => ({
    ...s,
    zone: { kind: 'header' as const },
  }));
  /* Run the same global checks the zoned validator does, but skip the
     per-palette pass entirely so the v1 contract is unchanged. */
  return computeReport(scanned, zoned, parsed, /* withPerPallet */ false);
}

export function validateFnskuAgainstParserZoned(
  zoned: ZonedScannedFnsku[],
  parsed: Parsed | null | undefined,
): FnskuValidationReport {
  return computeReport(zoned, zoned, parsed, /* withPerPallet */ true);
}

function computeReport(
  scanned: ScannedFnsku[],
  zoned: ZonedScannedFnsku[],
  parsed: Parsed | null | undefined,
  withPerPallet: boolean,
): FnskuValidationReport {
  const parserItems = collectParserFnskus(parsed);

  const scanCounts = countBy(scanned.map((s) => s.fnsku));
  const parserCounts = countBy(parserItems.map((p) => p.fnsku));

  const scanSet = new Set(scanCounts.keys());
  const parserSet = new Set(parserCounts.keys());

  const missingRaw = [...scanSet].filter((f) => !parserSet.has(f));
  const extraInParser = [...parserSet].filter((f) => !scanSet.has(f));

  /* Header-template filter: a missingFromParser entry that appears in
     the first HEADER_ZONE_CHARS of raw text AND has count===1 in the
     scan is treated as a template example, not a real miss. */
  const headerCandidates: string[] = [];
  const missingFromParser: string[] = [];
  for (const fnsku of missingRaw) {
    const occurrences = scanned.filter((s) => s.fnsku === fnsku);
    const isHeaderOnly = occurrences.length === 1
      && occurrences[0].position < HEADER_ZONE_CHARS;
    if (isHeaderOnly) headerCandidates.push(fnsku);
    else missingFromParser.push(fnsku);
  }

  /* Count mismatches: FNSKUs present in both sets but with different
     occurrence counts. */
  const countMismatches: FnskuCountMismatch[] = [];
  for (const fnsku of scanSet) {
    if (!parserSet.has(fnsku)) continue;
    const s = scanCounts.get(fnsku) ?? 0;
    const p = parserCounts.get(fnsku) ?? 0;
    if (s !== p) countMismatches.push({ fnsku, scan: s, parser: p });
  }

  /* Position rank comparison. Build two ordered lists keyed by FNSKU
     first-occurrence rank: rank 0 = the earliest, etc. Compare ranks
     only for FNSKUs in both sets. */
  const scanRanks = firstSeenRanks(scanned.map((s) => s.fnsku));
  const parserRanks = firstSeenRanks(parserItems.map((p) => p.fnsku));
  const positionMismatches: FnskuPositionMismatch[] = [];
  for (const fnsku of scanSet) {
    if (!parserSet.has(fnsku)) continue;
    const sRank = scanRanks.get(fnsku);
    const pRank = parserRanks.get(fnsku);
    if (sRank == null || pRank == null) continue;
    if (Math.abs(sRank - pRank) > POSITION_RANK_TOLERANCE) {
      positionMismatches.push({ fnsku, scanIndex: sRank, parserIndex: pRank });
    }
  }

  /* Per-palette comparison (v2) + cross-field consistency (v3). Both
     are only run for the zoned entry point — the legacy flat shim
     deliberately preserves v1 contract (no new warnings for callers
     that never asked for them). */
  let palletCountMismatches: FnskuPalletCountMismatch[] = [];
  let palletsCompared = 0;
  let fieldConsistencyMismatches: FieldConsistencyMismatch[] = [];
  let useItemMismatches: UseItemMismatch[] = [];
  let itemsCompared = 0;
  if (withPerPallet) {
    const scanByPallet = palletScanCounts(zoned);
    const parserByPallet = palletParserCounts(parsed);
    const palletKeys = new Set<string>([
      ...scanByPallet.keys(),
      ...parserByPallet.keys(),
    ]);
    palletsCompared = palletKeys.size;
    for (const palletId of palletKeys) {
      const sMap = scanByPallet.get(palletId) ?? new Map<string, number>();
      const pMap = parserByPallet.get(palletId) ?? new Map<string, number>();
      const fnskus = new Set<string>([...sMap.keys(), ...pMap.keys()]);
      for (const fnsku of fnskus) {
        const s = sMap.get(fnsku) ?? 0;
        const p = pMap.get(fnsku) ?? 0;
        if (s !== p) palletCountMismatches.push({ palletId, fnsku, scan: s, parser: p });
      }
    }
    /* Sort for stable UI output: palette first, then fnsku */
    palletCountMismatches = palletCountMismatches.sort((a, b) =>
      a.palletId.localeCompare(b.palletId) || a.fnsku.localeCompare(b.fnsku),
    );

    /* v3 — cross-field consistency. Same FNSKU across the Auftrag must
       have identical ASIN/SKU/title/useItem; useItem's embedded EAN or
       X-code must agree with the item's own ean/fnsku. */
    fieldConsistencyMismatches = validateFieldConsistency(parsed);
    useItemMismatches = validateUseItemCodes(parsed);
    itemsCompared = parserItems.length;
  }

  const hasIssue = missingFromParser.length > 0
    || extraInParser.length > 0
    || countMismatches.length > 0
    || positionMismatches.length > 0
    || palletCountMismatches.length > 0
    || fieldConsistencyMismatches.length > 0
    || useItemMismatches.length > 0;

  return {
    status: hasIssue ? 'warn' : 'ok',
    summary: {
      scanCount: scanned.length,
      parserCount: parserItems.length,
      headerCandidates,
      palletsCompared,
      itemsCompared,
    },
    missingFromParser,
    extraInParser,
    countMismatches,
    positionMismatches,
    palletCountMismatches,
    fieldConsistencyMismatches,
    useItemMismatches,
  };
}

/** Per-palette scan counts. Header-zoned hits are dropped entirely —
 *  they have no palette to compare against. */
function palletScanCounts(zoned: ZonedScannedFnsku[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const z of zoned) {
    let palletKey: string | null = null;
    if (z.zone.kind === 'pallet') palletKey = z.zone.palletId;
    else if (z.zone.kind === 'einzelne') palletKey = EINZELNE_PALLET_KEY;
    if (palletKey == null) continue;
    let inner = out.get(palletKey);
    if (!inner) {
      inner = new Map<string, number>();
      out.set(palletKey, inner);
    }
    inner.set(z.fnsku, (inner.get(z.fnsku) ?? 0) + 1);
  }
  return out;
}

function palletParserCounts(parsed: Parsed | null | undefined): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  if (!parsed) return out;
  const pallets = Array.isArray(parsed.pallets) ? parsed.pallets : [];
  for (const pal of pallets) {
    const palletId = String(pal?.id ?? '').toUpperCase();
    if (!palletId) continue;
    const inner = new Map<string, number>();
    const items = Array.isArray(pal?.items) ? pal.items : [];
    for (const it of items) {
      const v = normalize(it?.fnsku);
      if (!v) continue;
      inner.set(v, (inner.get(v) ?? 0) + 1);
    }
    if (inner.size > 0) out.set(palletId, inner);
  }
  const esku = Array.isArray(parsed.einzelneSkuItems) ? parsed.einzelneSkuItems : [];
  if (esku.length > 0) {
    const inner = new Map<string, number>();
    for (const it of esku) {
      const v = normalize(it?.fnsku);
      if (!v) continue;
      inner.set(v, (inner.get(v) ?? 0) + 1);
    }
    if (inner.size > 0) out.set(EINZELNE_PALLET_KEY, inner);
  }
  return out;
}

function collectParserFnskus(parsed: Parsed | null | undefined): Array<{ fnsku: string }> {
  if (!parsed) return [];
  const out: Array<{ fnsku: string }> = [];
  const pallets = Array.isArray(parsed.pallets) ? parsed.pallets : [];
  for (const pal of pallets) {
    const items = Array.isArray(pal?.items) ? pal.items : [];
    for (const it of items) {
      const v = normalize(it?.fnsku);
      if (v) out.push({ fnsku: v });
    }
  }
  const esku = Array.isArray(parsed.einzelneSkuItems) ? parsed.einzelneSkuItems : [];
  for (const it of esku) {
    const v = normalize(it?.fnsku);
    if (v) out.push({ fnsku: v });
  }
  return out;
}

function normalize(value: unknown): string {
  if (typeof value !== 'string') return '';
  const v = value.trim().toUpperCase();
  /* Only accept values that match the canonical FNSKU shape — if the
     parser stored "" or an ASIN-shaped value we treat it as "no fnsku"
     rather than as a hallucination. extraInParser should reflect real
     FNSKU-shaped strings the parser produced. */
  return /^X[0-9][A-Z0-9]{8}$/.test(v) ? v : '';
}

function countBy(values: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

function firstSeenRanks(values: string[]): Map<string, number> {
  const m = new Map<string, number>();
  let rank = 0;
  for (const v of values) {
    if (!m.has(v)) m.set(v, rank++);
  }
  return m;
}
