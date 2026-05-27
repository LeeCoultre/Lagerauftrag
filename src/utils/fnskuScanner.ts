/* ─────────────────────────────────────────────────────────────────────────
   Independent FNSKU scanner — cross-check for parseLagerauftrag.

   The main parser is columnar: it splits each Lagerauftrag row on tabs
   and picks parts[3] as the FNSKU. If columns drift (a stray tab, a
   nonstandard template, mammoth-quirk), the columnar logic can pick
   the wrong value or skip a row entirely.

   This scanner is INTENTIONALLY structure-agnostic. It runs a single
   strict FNSKU regex over the raw .docx text and records every
   occurrence with its char offset. The validator then compares this
   flat list against parsed.pallets[].items[].fnsku to surface deltas.

   Keep this file free of imports from parseLagerauftrag so the two
   parsers cannot share bugs.
   ───────────────────────────────────────────────────────────────────── */

export interface ScannedFnsku {
  /** Uppercased, exactly 10 chars: X + digit + 8 alphanumerics. */
  fnsku: string;
  /** Char offset in the rawText. */
  position: number;
  /** 1-based line number where the match starts. */
  line: number;
  /** ±30 chars window around the match, with the match itself in the middle. */
  context: string;
}

/** Strict 10-char FNSKU pattern. Word boundaries prevent matching inside
 *  longer alphanumeric runs (e.g. embedded in a SKU). The /g flag is
 *  required for matchAll(); /i lets us catch lowercased typos in the
 *  source doc and we uppercase before returning. */
export const FNSKU_SCAN_RE = /\bX[0-9][A-Z0-9]{8}\b/gi;

export function scanFnskuCodes(rawText: string): ScannedFnsku[] {
  if (!rawText) return [];
  const out: ScannedFnsku[] = [];
  for (const match of rawText.matchAll(FNSKU_SCAN_RE)) {
    const value = (match[0] || '').toUpperCase();
    const position = match.index ?? 0;
    out.push({
      fnsku: value,
      position,
      line: lineOf(rawText, position),
      context: contextOf(rawText, position, value.length),
    });
  }
  return out;
}

function lineOf(text: string, pos: number): number {
  let n = 1;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++;
  }
  return n;
}

function contextOf(text: string, pos: number, len: number): string {
  const start = Math.max(0, pos - 30);
  const end = Math.min(text.length, pos + len + 30);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

/* ─── Zoned scan (v2) ────────────────────────────────────────────────
   Per-pallet cross-check: partition each found FNSKU into a zone based
   on its char position in the raw text. Zones are detected with this
   file's own palette-marker regex — INTENTIONALLY not imported from
   parseLagerauftrag, so a bug in the parser's palette detection does
   not silently propagate into the validator.

   Dash variants in palette IDs (ASCII hyphen, en-dash, em-dash, minus
   sign) are normalised to ASCII "-" so the resulting palletId matches
   what the columnar parser stores in parsed.pallets[].id.
   ─────────────────────────────────────────────────────────────────── */

export type FnskuZoneId =
  | { kind: 'header' }
  | { kind: 'pallet'; palletId: string }
  | { kind: 'einzelne' };

export interface ZonedScannedFnsku extends ScannedFnsku {
  zone: FnskuZoneId;
}

/** Matches the FBA palette header line. Two groups: palette number,
 *  raw palette id ("P1-B1" with any dash variant or whitespace). */
export const PALETTE_HEADER_SCAN_RE =
  /PALETTE\s+(\d+)\s*[-–—−]\s*(P\d+\s*[-–—−]\s*B\d+)/gi;

/** Marker that opens the "Einzelne SKU" tail-block. Anything after it
 *  belongs to einzelneSkuItems, not to the last palette. */
export const EINZELNE_BLOCK_START_RE = /ACHTUNG!\s*Jeder\s+Karton/i;

interface PalletBoundary {
  position: number;
  palletId: string;
}

function normalizeZonedPalletId(rawId: string): string {
  return rawId.replace(/\s*[-–—−]\s*/g, '-').toUpperCase();
}

function findPalletBoundaries(rawText: string): PalletBoundary[] {
  const out: PalletBoundary[] = [];
  for (const m of rawText.matchAll(PALETTE_HEADER_SCAN_RE)) {
    if (m.index == null) continue;
    out.push({
      position: m.index,
      palletId: normalizeZonedPalletId(m[2] || ''),
    });
  }
  return out;
}

function findEinzelneStart(rawText: string): number | null {
  const m = rawText.match(EINZELNE_BLOCK_START_RE);
  return m && m.index != null ? m.index : null;
}

function zoneAt(
  position: number,
  boundaries: PalletBoundary[],
  einzelneStart: number | null,
): FnskuZoneId {
  if (einzelneStart != null && position >= einzelneStart) {
    return { kind: 'einzelne' };
  }
  if (boundaries.length === 0 || position < boundaries[0].position) {
    return { kind: 'header' };
  }
  /* Linear scan is fine — palette counts are tiny (≤ ~30 even on big
     Aufträgen). Keep the simple form. */
  let owner = boundaries[0];
  for (const b of boundaries) {
    if (b.position <= position) owner = b;
    else break;
  }
  return { kind: 'pallet', palletId: owner.palletId };
}

export function scanFnskuCodesZoned(rawText: string): ZonedScannedFnsku[] {
  if (!rawText) return [];
  const boundaries = findPalletBoundaries(rawText);
  const einzelneStart = findEinzelneStart(rawText);
  const flat = scanFnskuCodes(rawText);
  return flat.map((s) => ({
    ...s,
    zone: zoneAt(s.position, boundaries, einzelneStart),
  }));
}
