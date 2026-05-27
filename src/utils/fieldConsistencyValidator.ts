/* ─────────────────────────────────────────────────────────────────────────
   Cross-field consistency validator (v3).

   v1 (fnskuScanner) and v2 (per-pallet) check that the parser's FNSKU
   stream matches the raw text. They are blind to the *other* fields:
   if the columnar parser correctly identifies an FNSKU but pairs it
   with the wrong ASIN / SKU / title (say a manual edit slid one cell
   to the right), neither v1 nor v2 will flag it.

   This module catches that. The contract is simple:

     For all items sharing the same FNSKU in a single Lagerauftrag,
     the ASIN, SKU, title and useItem MUST be identical (modulo
     cosmetic normalisation for the text fields).

   FNSKU is Amazon's unique product identifier — the same FNSKU on
   palette 1 and palette 3 must describe the same product, full stop.

   Additionally, the "Zu verwendender Artikel" (useItem) field often
   embeds an EAN or X-code. If we can extract one, it should agree
   with the item's own EAN or FNSKU. A divergence usually means the
   warehouse picked the wrong cardboard to seed the operation.

   Internal-only: no lookups against lynne_products or sku_dimensions.
   ───────────────────────────────────────────────────────────────────── */

import type { Parsed, ParsedItem } from '../types/api';

export type FieldConsistencyField = 'asin' | 'sku' | 'title' | 'useItem';

export interface FieldConsistencyMismatch {
  fnsku: string;                  // anchor: all items with this FNSKU disagree
  field: FieldConsistencyField;
  values: string[];               // unique observed values, in first-seen order
  occurrences: number;            // total items grouped under this FNSKU
}

export type UseItemExpectedField = 'fnsku' | 'ean';

export interface UseItemMismatch {
  fnsku: string;
  itemEan: string | null;
  useItemRaw: string;
  useItemExtractedCode: string;
  expectedField: UseItemExpectedField;
}

/* ─── Public API ───────────────────────────────────────────────────── */

export function validateFieldConsistency(
  parsed: Parsed | null | undefined,
): FieldConsistencyMismatch[] {
  const items = collectItems(parsed);
  if (items.length === 0) return [];

  /* Group by FNSKU. Items without a usable FNSKU are silently skipped
     here — `validateParsing` already flags those with missing-fnsku /
     missing-identifier errors. */
  const groups = new Map<string, ParsedItem[]>();
  for (const it of items) {
    const key = normalizeFnsku(it.fnsku);
    if (!key) continue;
    const bucket = groups.get(key);
    if (bucket) bucket.push(it);
    else groups.set(key, [it]);
  }

  const out: FieldConsistencyMismatch[] = [];
  for (const [fnsku, group] of groups) {
    if (group.length < 2) continue;
    pushIfDivergent(out, fnsku, group, 'asin',    (it) => stringValue(it.asin));
    pushIfDivergent(out, fnsku, group, 'sku',     (it) => stringValue(it.sku));
    pushIfDivergent(out, fnsku, group, 'title',   (it) => normalizeText(stringValue(it.title)));
    pushIfDivergent(out, fnsku, group, 'useItem', (it) => normalizeText(stringValue(it.useItem)));
  }
  return out;
}

export function validateUseItemCodes(
  parsed: Parsed | null | undefined,
): UseItemMismatch[] {
  const items = collectItems(parsed);
  const out: UseItemMismatch[] = [];
  for (const it of items) {
    const useItemRaw = stringValue(it.useItem);
    if (!useItemRaw) continue;
    const extracted = extractCode(useItemRaw);
    if (extracted.kind === 'none') continue;

    if (extracted.kind === 'fnsku') {
      const itemFnsku = normalizeFnsku(it.fnsku);
      if (!itemFnsku) continue;
      if (extracted.value !== itemFnsku) {
        out.push({
          fnsku: itemFnsku,
          itemEan: it.ean ?? null,
          useItemRaw,
          useItemExtractedCode: extracted.value,
          expectedField: 'fnsku',
        });
      }
    } else {
      /* extracted.kind === 'ean' */
      const itemEan = it.ean ? String(it.ean).trim() : null;
      if (!itemEan) continue;          // parser already missing-code-warns
      if (extracted.value !== itemEan) {
        out.push({
          fnsku: normalizeFnsku(it.fnsku) || stringValue(it.fnsku),
          itemEan,
          useItemRaw,
          useItemExtractedCode: extracted.value,
          expectedField: 'ean',
        });
      }
    }
  }
  return out;
}

/* ─── Helpers ──────────────────────────────────────────────────────── */

function collectItems(parsed: Parsed | null | undefined): ParsedItem[] {
  if (!parsed) return [];
  const out: ParsedItem[] = [];
  const pallets = Array.isArray(parsed.pallets) ? parsed.pallets : [];
  for (const pal of pallets) {
    const items = Array.isArray(pal?.items) ? pal.items : [];
    for (const it of items) if (it) out.push(it);
  }
  const esku = Array.isArray(parsed.einzelneSkuItems) ? parsed.einzelneSkuItems : [];
  for (const it of esku) if (it) out.push(it);
  return out;
}

function stringValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return String(v);
}

function normalizeFnsku(v: unknown): string {
  const s = stringValue(v).trim().toUpperCase();
  return /^X[0-9][A-Z0-9]{8}$/.test(s) ? s : '';
}

/** Normalisation for free-form text fields (title, useItem wrapper).
 *  Strips diacritics, collapses whitespace, lowercases. Cosmetic
 *  differences in input should not fire a warning. */
function normalizeText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function pushIfDivergent(
  out: FieldConsistencyMismatch[],
  fnsku: string,
  group: ParsedItem[],
  field: FieldConsistencyField,
  read: (it: ParsedItem) => string,
): void {
  const values: string[] = [];
  for (const it of group) {
    const v = read(it);
    if (!v) continue;                  // empty values do not contribute
    if (!values.includes(v)) values.push(v);
  }
  if (values.length > 1) {
    out.push({ fnsku, field, values, occurrences: group.length });
  }
}

type ExtractedCode =
  | { kind: 'ean'; value: string }
  | { kind: 'fnsku'; value: string }
  | { kind: 'none' };

/** Mirrored from auftragHelpers.extractUseItemId, but returns a typed
 *  discriminated union so the caller knows which item field to compare
 *  against. Loose patterns on purpose — same heuristics the parser
 *  already uses for display purposes. */
function extractCode(text: string): ExtractedCode {
  const ean = text.match(/\b\d{12,14}\b/);
  if (ean) return { kind: 'ean', value: ean[0] };
  const x = text.match(/\bX[0-9A-Z]{8,10}\b/i);
  if (x) return { kind: 'fnsku', value: x[0].toUpperCase() };
  return { kind: 'none' };
}
