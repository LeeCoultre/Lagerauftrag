import { describe, it, expect } from 'vitest';
import { scanFnskuCodes, scanFnskuCodesZoned, FNSKU_SCAN_RE } from './fnskuScanner';

describe('FNSKU_SCAN_RE', () => {
  it('matches a valid 10-char FNSKU', () => {
    expect('X001ABCDEF'.match(FNSKU_SCAN_RE)).toEqual(['X001ABCDEF']);
  });

  it('rejects an ASIN (B0 prefix)', () => {
    FNSKU_SCAN_RE.lastIndex = 0;
    expect(FNSKU_SCAN_RE.test('B07ABCD123')).toBe(false);
  });

  it('rejects a 9-char prefix-only run', () => {
    FNSKU_SCAN_RE.lastIndex = 0;
    expect(FNSKU_SCAN_RE.test('X00CTPXRB')).toBe(false);
  });

  it('rejects an 11-char run (no word boundary on right)', () => {
    FNSKU_SCAN_RE.lastIndex = 0;
    expect('X001ABCDEFG'.match(FNSKU_SCAN_RE)).toBe(null);
  });

  it('matches case-insensitively', () => {
    FNSKU_SCAN_RE.lastIndex = 0;
    const m = 'x001abcdef'.match(FNSKU_SCAN_RE);
    expect(m && m[0]).toBe('x001abcdef');
  });
});

describe('scanFnskuCodes()', () => {
  it('returns an empty array for empty input', () => {
    expect(scanFnskuCodes('')).toEqual([]);
  });

  it('finds all FNSKUs in a tab-separated row, uppercased', () => {
    const text = 'sku-1\ttitle\tB07ABCD123\tX001AAAAAA\t1234567890123';
    const r = scanFnskuCodes(text);
    expect(r).toHaveLength(1);
    expect(r[0].fnsku).toBe('X001AAAAAA');
    expect(r[0].position).toBe(text.indexOf('X001AAAAAA'));
    expect(r[0].line).toBe(1);
  });

  it('uppercases lowercased matches', () => {
    const r = scanFnskuCodes('row\tx002bbbbbb\tend');
    expect(r).toHaveLength(1);
    expect(r[0].fnsku).toBe('X002BBBBBB');
  });

  it('tracks line numbers across newlines', () => {
    const text = 'header\nfoo\tX001AAAAAA\nbar\tX002BBBBBB\n';
    const r = scanFnskuCodes(text);
    expect(r.map((x) => x.line)).toEqual([2, 3]);
  });

  it('preserves duplicate occurrences (does not de-dupe)', () => {
    const text = 'X001AAAAAA\nX001AAAAAA\nX001AAAAAA';
    const r = scanFnskuCodes(text);
    expect(r).toHaveLength(3);
    expect(r.every((x) => x.fnsku === 'X001AAAAAA')).toBe(true);
  });

  it('records positions in ascending order', () => {
    const text = 'X001BBBBBB\nX001AAAAAA';
    const r = scanFnskuCodes(text);
    expect(r[0].position).toBeLessThan(r[1].position);
  });

  it('captures a context window around the match', () => {
    const text = 'lead text before\tX001ABCDEF\ttail text after the code';
    const r = scanFnskuCodes(text);
    expect(r[0].context).toContain('X001ABCDEF');
  });

  it('does not pick up B0-prefixed ASINs', () => {
    expect(scanFnskuCodes('row\tB07ABCD123\tend')).toEqual([]);
  });

  it('does not pick up codes embedded inside longer alphanumeric runs', () => {
    /* AAAAX001ABCDEFZZZZ has no word boundary around X001ABCDEF */
    expect(scanFnskuCodes('AAAAX001ABCDEFZZZZ')).toEqual([]);
  });
});

describe('scanFnskuCodesZoned()', () => {
  it('classifies FNSKU before the first PALETTE marker as header', () => {
    const text = 'Beispiel X001AAAAAA\nPALETTE 1 - P1-B1\nrow X002BBBBBB';
    const r = scanFnskuCodesZoned(text);
    expect(r[0].zone).toEqual({ kind: 'header' });
    expect(r[1].zone).toEqual({ kind: 'pallet', palletId: 'P1-B1' });
  });

  it('classifies FNSKU between two PALETTE markers as belonging to the earlier pallet', () => {
    const text = [
      'PALETTE 1 - P1-B1',
      'row\tX001AAAAAA',
      'row\tX002BBBBBB',
      'PALETTE 2 - P2-B1',
      'row\tX003CCCCCC',
    ].join('\n');
    const r = scanFnskuCodesZoned(text);
    expect(r.map((x) => x.zone)).toEqual([
      { kind: 'pallet', palletId: 'P1-B1' },
      { kind: 'pallet', palletId: 'P1-B1' },
      { kind: 'pallet', palletId: 'P2-B1' },
    ]);
  });

  it('distributes across three pallets correctly', () => {
    const text = [
      'PALETTE 1 - P1-B1', 'X001AAAAAA',
      'PALETTE 2 - P2-B1', 'X002BBBBBB',
      'PALETTE 3 - P3-B1', 'X003CCCCCC',
    ].join('\n');
    const r = scanFnskuCodesZoned(text);
    expect(r.map((x) => (x.zone.kind === 'pallet' ? x.zone.palletId : x.zone.kind))).toEqual([
      'P1-B1', 'P2-B1', 'P3-B1',
    ]);
  });

  it('classifies FNSKU after ACHTUNG! Jeder Karton as einzelne', () => {
    const text = [
      'PALETTE 1 - P1-B1', 'X001AAAAAA',
      'ACHTUNG! Jeder Karton mit Einzelne SKU',
      'X002BBBBBB', 'X003CCCCCC',
    ].join('\n');
    const r = scanFnskuCodesZoned(text);
    expect(r[0].zone).toEqual({ kind: 'pallet', palletId: 'P1-B1' });
    expect(r[1].zone).toEqual({ kind: 'einzelne' });
    expect(r[2].zone).toEqual({ kind: 'einzelne' });
  });

  it('normalises dash variants in pallet ID to ASCII -', () => {
    /* en-dash (–), em-dash (—), minus sign (−) */
    const text = [
      'PALETTE 1 – P1–B1', 'X001AAAAAA',
      'PALETTE 2 — P2—B1', 'X002BBBBBB',
      'PALETTE 3 − P3−B1', 'X003CCCCCC',
    ].join('\n');
    const r = scanFnskuCodesZoned(text);
    expect(r.map((x) => (x.zone.kind === 'pallet' ? x.zone.palletId : x.zone.kind))).toEqual([
      'P1-B1', 'P2-B1', 'P3-B1',
    ]);
  });

  it('normalises whitespace around dashes in pallet ID', () => {
    const text = 'PALETTE 1 - P1 – B1\nX001AAAAAA';
    const r = scanFnskuCodesZoned(text);
    expect(r[0].zone).toEqual({ kind: 'pallet', palletId: 'P1-B1' });
  });

  it('handles raw text with no palette markers at all', () => {
    const text = 'Just a flat list\nX001AAAAAA\nX002BBBBBB';
    const r = scanFnskuCodesZoned(text);
    expect(r.map((x) => x.zone)).toEqual([{ kind: 'header' }, { kind: 'header' }]);
  });
});
