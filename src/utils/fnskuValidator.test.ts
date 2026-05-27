import { describe, it, expect } from 'vitest';
import { scanFnskuCodes, scanFnskuCodesZoned } from './fnskuScanner';
import { validateFnskuAgainstParser, validateFnskuAgainstParserZoned, EINZELNE_PALLET_KEY } from './fnskuValidator';
import type { Parsed, ParsedItem, ParsedPallet } from '../types/api';

/* ─── Test helpers ─────────────────────────────────────────────── */

function item(fnsku: string, extras: Partial<ParsedItem> = {}): ParsedItem {
  return {
    sku: 'TEST-SKU',
    title: 'Test',
    asin: 'B07ABCD123',
    fnsku,
    ean: null,
    upc: null,
    condition: '',
    prep: '',
    prepType: null,
    labeler: '',
    units: 1,
    useItem: null,
    dimStr: null,
    rollen: null,
    dim: null,
    isThermo: false,
    isVeit: false,
    isHeipa: false,
    isTacho: false,
    isKlebeband: false,
    isProduktion: false,
    category: null,
    codeType: null,
    ...extras,
  };
}

function pallet(id: string, items: ParsedItem[]): ParsedPallet {
  return { id, items };
}

function parsed(pallets: ParsedPallet[], esku: ParsedItem[] = []): Parsed {
  return {
    format: 'standard',
    meta: {},
    pallets,
    einzelneSkuItems: esku,
  };
}

/* A realistic-ish raw text where the FNSKU sits in column 3 of each
   row. Prefix is sized to push the first data row past the
   HEADER_ZONE_CHARS=500 watermark so the header-filter does not
   accidentally swallow real "missing" items in these tests. */
const HEADER_PAD = 'Lagerauftrag fuer FBA Versand. '.repeat(20);

function buildRawText(rows: Array<{ sku: string; fnsku: string }>, prefix: string = HEADER_PAD + '\n'): string {
  return prefix + rows
    .map((r) => `${r.sku}\tTitle\tB07ABCD123\t${r.fnsku}\t9999999999999`)
    .join('\n');
}

/* ─── Tests ────────────────────────────────────────────────────── */

describe('validateFnskuAgainstParser()', () => {
  it('clean match → status=ok and empty deltas', () => {
    const rawText = buildRawText([
      { sku: 'SKU-1', fnsku: 'X001AAAAAA' },
      { sku: 'SKU-2', fnsku: 'X002BBBBBB' },
    ]);
    const scan = scanFnskuCodes(rawText);
    const p = parsed([pallet('P1', [item('X001AAAAAA'), item('X002BBBBBB')])]);

    const r = validateFnskuAgainstParser(scan, p);
    expect(r.status).toBe('ok');
    expect(r.missingFromParser).toEqual([]);
    expect(r.extraInParser).toEqual([]);
    expect(r.countMismatches).toEqual([]);
    expect(r.positionMismatches).toEqual([]);
    expect(r.summary.scanCount).toBe(2);
    expect(r.summary.parserCount).toBe(2);
  });

  it('parser skipped a row → missingFromParser surfaces it', () => {
    const rawText = buildRawText([
      { sku: 'SKU-1', fnsku: 'X001AAAAAA' },
      { sku: 'SKU-2', fnsku: 'X002BBBBBB' },
      { sku: 'SKU-3', fnsku: 'X003CCCCCC' },
    ]);
    const scan = scanFnskuCodes(rawText);
    /* parser only produced two items — missed the middle row */
    const p = parsed([pallet('P1', [item('X001AAAAAA'), item('X003CCCCCC')])]);

    const r = validateFnskuAgainstParser(scan, p);
    expect(r.status).toBe('warn');
    expect(r.missingFromParser).toEqual(['X002BBBBBB']);
    expect(r.extraInParser).toEqual([]);
  });

  it('parser hallucinated an FNSKU → extraInParser surfaces it', () => {
    const rawText = buildRawText([
      { sku: 'SKU-1', fnsku: 'X001AAAAAA' },
    ]);
    const scan = scanFnskuCodes(rawText);
    /* parser invented an extra item the scanner cannot see */
    const p = parsed([pallet('P1', [item('X001AAAAAA'), item('X099ZZZZZZ')])]);

    const r = validateFnskuAgainstParser(scan, p);
    expect(r.status).toBe('warn');
    expect(r.extraInParser).toEqual(['X099ZZZZZZ']);
    expect(r.missingFromParser).toEqual([]);
  });

  it('count mismatch on duplicate FNSKU (multi-pack misparse)', () => {
    const rawText = buildRawText([
      { sku: 'SKU-1', fnsku: 'X001AAAAAA' },
      { sku: 'SKU-2', fnsku: 'X001AAAAAA' },
      { sku: 'SKU-3', fnsku: 'X001AAAAAA' },
    ]);
    const scan = scanFnskuCodes(rawText);
    /* parser only captured one of the three duplicates */
    const p = parsed([pallet('P1', [item('X001AAAAAA')])]);

    const r = validateFnskuAgainstParser(scan, p);
    expect(r.status).toBe('warn');
    expect(r.countMismatches).toEqual([{ fnsku: 'X001AAAAAA', scan: 3, parser: 1 }]);
  });

  it('order swap → positionMismatches non-empty', () => {
    const rawText = buildRawText([
      { sku: 'SKU-A', fnsku: 'X001AAAAAA' },
      { sku: 'SKU-B', fnsku: 'X002BBBBBB' },
      { sku: 'SKU-C', fnsku: 'X003CCCCCC' },
      { sku: 'SKU-D', fnsku: 'X004DDDDDD' },
    ]);
    const scan = scanFnskuCodes(rawText);
    /* parser order: D, C, B, A — full reverse, every position outside tolerance */
    const p = parsed([pallet('P1', [
      item('X004DDDDDD'),
      item('X003CCCCCC'),
      item('X002BBBBBB'),
      item('X001AAAAAA'),
    ])]);

    const r = validateFnskuAgainstParser(scan, p);
    expect(r.status).toBe('warn');
    expect(r.positionMismatches.length).toBeGreaterThan(0);
  });

  it('within tolerance: ±1 rank shift does NOT trigger position mismatch', () => {
    /* Two adjacent items swapped — rank delta is exactly 1. Tolerance
       absorbs it so a clean parser is not pestered for header noise. */
    const rawText = buildRawText([
      { sku: 'SKU-A', fnsku: 'X001AAAAAA' },
      { sku: 'SKU-B', fnsku: 'X002BBBBBB' },
    ]);
    const scan = scanFnskuCodes(rawText);
    const p = parsed([pallet('P1', [item('X002BBBBBB'), item('X001AAAAAA')])]);

    const r = validateFnskuAgainstParser(scan, p);
    expect(r.positionMismatches).toEqual([]);
  });

  it('header-template FNSKU is filtered out of missingFromParser', () => {
    /* X009HEADER appears exactly once and in the first 500 chars — that
       matches the shape of an Amazon-template example. Should NOT raise
       a warning, just go into headerCandidates. The real data row uses
       HEADER_PAD to push itself past the header zone. */
    const rawText = 'Lagerauftrag-Vorlage Beispiel-Code: X009HEADER\n'
      + buildRawText([{ sku: 'SKU-1', fnsku: 'X001AAAAAA' }]);
    const scan = scanFnskuCodes(rawText);
    const p = parsed([pallet('P1', [item('X001AAAAAA')])]);

    const r = validateFnskuAgainstParser(scan, p);
    expect(r.missingFromParser).toEqual([]);
    expect(r.summary.headerCandidates).toEqual(['X009HEADER']);
    expect(r.status).toBe('ok');
  });

  it('einzelneSkuItems are included in the parser side of the comparison', () => {
    const rawText = buildRawText([
      { sku: 'ESKU-1', fnsku: 'X001AAAAAA' },
    ]);
    const scan = scanFnskuCodes(rawText);
    /* No regular pallet items, only einzelneSkuItems → should still match */
    const p = parsed([], [item('X001AAAAAA')]);

    const r = validateFnskuAgainstParser(scan, p);
    expect(r.status).toBe('ok');
    expect(r.summary.parserCount).toBe(1);
  });

  it('handles null parsed (defensive)', () => {
    const r = validateFnskuAgainstParser([], null);
    expect(r.status).toBe('ok');
    expect(r.summary.parserCount).toBe(0);
    expect(r.summary.scanCount).toBe(0);
  });

  it('ignores parser items whose fnsku is empty or wrongly-shaped', () => {
    const rawText = buildRawText([
      { sku: 'SKU-1', fnsku: 'X001AAAAAA' },
    ]);
    const scan = scanFnskuCodes(rawText);
    /* parser produced an item with an empty fnsku and one with a B0-shaped
       value — neither should show up as extraInParser. */
    const p = parsed([pallet('P1', [
      item('X001AAAAAA'),
      item(''),
      item('B07ABCD123'),
    ])]);

    const r = validateFnskuAgainstParser(scan, p);
    expect(r.status).toBe('ok');
    expect(r.extraInParser).toEqual([]);
  });

  it('v1 entry point reports empty palletCountMismatches even on a real mismatch (back-compat)', () => {
    /* The legacy validateFnskuAgainstParser() is preserved as a flat shim:
       it ignores zone info entirely so old callers don't suddenly get
       per-palette warnings they cannot interpret. */
    const rawText = [
      HEADER_PAD,
      'PALETTE 1 - P1-B1',
      'SKU-1\tTitle\tB07ABCD123\tX001AAAAAA\t9999999999999',
      'PALETTE 2 - P2-B1',
      'SKU-2\tTitle\tB07ABCD123\tX001AAAAAA\t9999999999999',
    ].join('\n');
    const flat = scanFnskuCodes(rawText);
    /* parser placed both on P1, P2 is empty — scan says one-per-palette */
    const p = parsed([
      pallet('P1-B1', [item('X001AAAAAA'), item('X001AAAAAA')]),
      pallet('P2-B1', []),
    ]);
    const r = validateFnskuAgainstParser(flat, p);
    expect(r.palletCountMismatches).toEqual([]);
    expect(r.summary.palletsCompared).toBe(0);
  });
});

/* ─── v2: per-palette counts ────────────────────────────────────── */

describe('validateFnskuAgainstParserZoned()', () => {
  it('per-pallet match: same FNSKU counts on the same pallet → ok', () => {
    const rawText = [
      HEADER_PAD,
      'PALETTE 1 - P1-B1',
      'SKU-1\tTitle\tB07ABCD123\tX001AAAAAA\t9999999999999',
      'SKU-1\tTitle\tB07ABCD123\tX001AAAAAA\t9999999999999',
      'SKU-1\tTitle\tB07ABCD123\tX001AAAAAA\t9999999999999',
    ].join('\n');
    const zoned = scanFnskuCodesZoned(rawText);
    const p = parsed([pallet('P1-B1', [
      item('X001AAAAAA'),
      item('X001AAAAAA'),
      item('X001AAAAAA'),
    ])]);

    const r = validateFnskuAgainstParserZoned(zoned, p);
    expect(r.status).toBe('ok');
    expect(r.palletCountMismatches).toEqual([]);
    expect(r.summary.palletsCompared).toBe(1);
  });

  it('per-pallet mismatch surfaces deltas even when global counts agree', () => {
    /* Classic worst case: scanner sees X001 × 3 on P1, × 2 on P2 (5
       total). Parser put all 5 onto P1, P2 ended up empty. Global
       count is 5 == 5 → v1 would say OK. Per-pallet exposes it. */
    const rawText = [
      HEADER_PAD,
      'PALETTE 1 - P1-B1',
      ...Array(3).fill('SKU-X\tTitle\tB07ABCD123\tX001AAAAAA\t9999999999999'),
      'PALETTE 2 - P2-B1',
      ...Array(2).fill('SKU-X\tTitle\tB07ABCD123\tX001AAAAAA\t9999999999999'),
    ].join('\n');
    const zoned = scanFnskuCodesZoned(rawText);
    const p = parsed([
      pallet('P1-B1', Array(5).fill(0).map(() => item('X001AAAAAA'))),
      pallet('P2-B1', []),
    ]);

    const r = validateFnskuAgainstParserZoned(zoned, p);
    expect(r.status).toBe('warn');
    expect(r.countMismatches).toEqual([]); // global agrees
    expect(r.palletCountMismatches).toEqual([
      { palletId: 'P1-B1', fnsku: 'X001AAAAAA', scan: 3, parser: 5 },
      { palletId: 'P2-B1', fnsku: 'X001AAAAAA', scan: 2, parser: 0 },
    ]);
  });

  it('einzelne-SKU partition is compared against parsed.einzelneSkuItems', () => {
    const rawText = [
      HEADER_PAD,
      'PALETTE 1 - P1-B1',
      'SKU-1\tTitle\tB07ABCD123\tX001AAAAAA\t9999999999999',
      'ACHTUNG! Jeder Karton mit Einzelne SKU',
      'SKU-X\tTitle\tB07ABCD123\tX002BBBBBB\t9999999999999',
    ].join('\n');
    const zoned = scanFnskuCodesZoned(rawText);
    /* parser misplaced X002 onto P1 instead of recognising the
       einzelne section */
    const p = parsed(
      [pallet('P1-B1', [item('X001AAAAAA'), item('X002BBBBBB')])],
      [],
    );
    const r = validateFnskuAgainstParserZoned(zoned, p);
    expect(r.status).toBe('warn');
    expect(r.palletCountMismatches).toEqual([
      { palletId: 'EINZELNE', fnsku: 'X002BBBBBB', scan: 1, parser: 0 },
      { palletId: 'P1-B1', fnsku: 'X002BBBBBB', scan: 0, parser: 1 },
    ]);
  });

  it('einzelne match: scanner & parser agree on the einzelne block', () => {
    const rawText = [
      HEADER_PAD,
      'PALETTE 1 - P1-B1',
      'SKU-1\tTitle\tB07ABCD123\tX001AAAAAA\t9999999999999',
      'ACHTUNG! Jeder Karton mit Einzelne SKU',
      'SKU-X\tTitle\tB07ABCD123\tX002BBBBBB\t9999999999999',
    ].join('\n');
    const zoned = scanFnskuCodesZoned(rawText);
    const p = parsed(
      [pallet('P1-B1', [item('X001AAAAAA')])],
      [item('X002BBBBBB')],
    );
    const r = validateFnskuAgainstParserZoned(zoned, p);
    expect(r.status).toBe('ok');
    expect(r.palletCountMismatches).toEqual([]);
    /* P1 + einzelne both compared */
    expect(r.summary.palletsCompared).toBe(2);
    expect(EINZELNE_PALLET_KEY).toBe('EINZELNE');
  });

  it('header-zone FNSKU does not produce per-palette warnings', () => {
    /* X009HEADER appears only in the header zone (no real pallet
       binding). Should not pollute per-palette comparison. */
    const rawText = [
      'Beispiel X009HEADER\n',
      HEADER_PAD,
      'PALETTE 1 - P1-B1',
      'SKU-1\tTitle\tB07ABCD123\tX001AAAAAA\t9999999999999',
    ].join('\n');
    const zoned = scanFnskuCodesZoned(rawText);
    const p = parsed([pallet('P1-B1', [item('X001AAAAAA')])]);
    const r = validateFnskuAgainstParserZoned(zoned, p);
    expect(r.palletCountMismatches).toEqual([]);
    expect(r.status).toBe('ok');
    expect(r.summary.headerCandidates).toEqual(['X009HEADER']);
  });
});
