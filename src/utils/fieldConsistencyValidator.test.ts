import { describe, it, expect } from 'vitest';
import {
  validateFieldConsistency,
  validateUseItemCodes,
} from './fieldConsistencyValidator';
import type { Parsed, ParsedItem, ParsedPallet } from '../types/api';

function item(fnsku: string, extras: Partial<ParsedItem> = {}): ParsedItem {
  return {
    sku: 'TEST-SKU',
    title: 'Test Title',
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
  return { format: 'standard', meta: {}, pallets, einzelneSkuItems: esku };
}

/* ─── validateFieldConsistency() ──────────────────────────────────── */

describe('validateFieldConsistency()', () => {
  it('empty input → empty result', () => {
    expect(validateFieldConsistency(null)).toEqual([]);
    expect(validateFieldConsistency(parsed([]))).toEqual([]);
  });

  it('clean Auftrag — same FNSKU paired with identical fields → no mismatches', () => {
    const p = parsed([
      pallet('P1-B1', [
        item('X001AAAAAA', { sku: 'A', asin: 'B07AAA', title: 'Roll 80mm' }),
        item('X001AAAAAA', { sku: 'A', asin: 'B07AAA', title: 'Roll 80mm' }),
      ]),
    ]);
    expect(validateFieldConsistency(p)).toEqual([]);
  });

  it('same FNSKU on two pallets with different ASIN → consistency mismatch on asin', () => {
    const p = parsed([
      pallet('P1-B1', [item('X001AAAAAA', { asin: 'B07ABCD123' })]),
      pallet('P2-B1', [item('X001AAAAAA', { asin: 'B07XYZQQQQ' })]),
    ]);
    const r = validateFieldConsistency(p);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      fnsku: 'X001AAAAAA',
      field: 'asin',
      occurrences: 2,
    });
    expect(r[0].values.sort()).toEqual(['B07ABCD123', 'B07XYZQQQQ']);
  });

  it('same FNSKU with different SKUs → mismatch on sku', () => {
    const p = parsed([
      pallet('P1-B1', [
        item('X001AAAAAA', { sku: 'AA-1111-2222' }),
        item('X001AAAAAA', { sku: 'BB-9999-0000' }),
      ]),
    ]);
    const r = validateFieldConsistency(p);
    expect(r.filter((m) => m.field === 'sku')).toHaveLength(1);
  });

  it('whitespace-only title diff → NO mismatch (normalisation absorbs it)', () => {
    const p = parsed([
      pallet('P1-B1', [
        item('X001AAAAAA', { title: 'Roll  80 mm Thermo' }),
        item('X001AAAAAA', { title: ' Roll 80 mm Thermo ' }),
      ]),
    ]);
    expect(validateFieldConsistency(p).filter((m) => m.field === 'title')).toEqual([]);
  });

  it('case-only title diff → NO mismatch', () => {
    const p = parsed([
      pallet('P1-B1', [
        item('X001AAAAAA', { title: 'Roll 80mm Thermo' }),
        item('X001AAAAAA', { title: 'ROLL 80MM THERMO' }),
      ]),
    ]);
    expect(validateFieldConsistency(p).filter((m) => m.field === 'title')).toEqual([]);
  });

  it('diacritic-only title diff (umlaut variant) → NO mismatch', () => {
    /* Grösse vs Grosse: NFKD decomposes ö → o + combining diaeresis,
       the diaeresis is then stripped. Both end up as "grosse". This
       is the canonical diacritic-stripping case the normaliser exists
       for. Note: ß vs ss is a *ligature* difference, not a diacritic,
       and is NOT normalised — those are intentionally treated as
       different strings. */
    const p = parsed([
      pallet('P1-B1', [
        item('X001AAAAAA', { title: 'Rolle Grösse 80' }),
        item('X001AAAAAA', { title: 'Rolle Grosse 80' }),
      ]),
    ]);
    expect(validateFieldConsistency(p).filter((m) => m.field === 'title')).toEqual([]);
  });

  it('substantive title diff (different product name) → mismatch on title', () => {
    const p = parsed([
      pallet('P1-B1', [
        item('X001AAAAAA', { title: 'Roll 80mm Thermo' }),
        item('X001AAAAAA', { title: 'Cleaning solvent 500ml' }),
      ]),
    ]);
    expect(validateFieldConsistency(p).filter((m) => m.field === 'title')).toHaveLength(1);
  });

  it('einzelneSkuItems participate in grouping with pallet items', () => {
    const p = parsed(
      [pallet('P1-B1', [item('X001AAAAAA', { asin: 'B07AAA' })])],
      [item('X001AAAAAA', { asin: 'B07ZZZ' })],
    );
    const r = validateFieldConsistency(p);
    expect(r.filter((m) => m.field === 'asin')).toHaveLength(1);
  });

  it('items with empty fnsku are silently skipped', () => {
    const p = parsed([
      pallet('P1-B1', [
        item('', { asin: 'B07AAA' }),
        item('', { asin: 'B07XXX' }),
      ]),
    ]);
    /* Two items, no FNSKU anchor → cannot establish "same product" */
    expect(validateFieldConsistency(p)).toEqual([]);
  });

  it('empty values are not treated as a distinct group value', () => {
    /* one item has useItem set, the other has null — that is not a
       "mismatch", just an information gap. */
    const p = parsed([
      pallet('P1-B1', [
        item('X001AAAAAA', { useItem: 'wird produziert' }),
        item('X001AAAAAA', { useItem: null }),
      ]),
    ]);
    expect(validateFieldConsistency(p).filter((m) => m.field === 'useItem')).toEqual([]);
  });
});

/* ─── validateUseItemCodes() ──────────────────────────────────────── */

describe('validateUseItemCodes()', () => {
  it('empty input → empty result', () => {
    expect(validateUseItemCodes(null)).toEqual([]);
  });

  it('useItem with no extractable code → silent', () => {
    const p = parsed([pallet('P1-B1', [
      item('X001AAAAAA', { useItem: 'wird produziert' }),
    ])]);
    expect(validateUseItemCodes(p)).toEqual([]);
  });

  it('useItem extracts EAN that matches item.ean → no mismatch', () => {
    const p = parsed([pallet('P1-B1', [
      item('X001AAAAAA', { ean: '9120107187501', useItem: 'wird von 9120107187501 produziert' }),
    ])]);
    expect(validateUseItemCodes(p)).toEqual([]);
  });

  it('useItem extracts EAN that differs from item.ean → mismatch on ean', () => {
    const p = parsed([pallet('P1-B1', [
      item('X001AAAAAA', { ean: '9120107187501', useItem: 'wird von 1234567890128 produziert' }),
    ])]);
    const r = validateUseItemCodes(p);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      fnsku: 'X001AAAAAA',
      itemEan: '9120107187501',
      useItemExtractedCode: '1234567890128',
      expectedField: 'ean',
    });
  });

  it('useItem extracts X-code that matches item.fnsku → no mismatch', () => {
    const p = parsed([pallet('P1-B1', [
      item('X001AAAAAA', { useItem: 'Zu verwenden X001AAAAAA' }),
    ])]);
    expect(validateUseItemCodes(p)).toEqual([]);
  });

  it('useItem extracts X-code that differs from item.fnsku → mismatch on fnsku', () => {
    const p = parsed([pallet('P1-B1', [
      item('X001AAAAAA', { useItem: 'Zu verwenden X002BBBBBB' }),
    ])]);
    const r = validateUseItemCodes(p);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      fnsku: 'X001AAAAAA',
      useItemExtractedCode: 'X002BBBBBB',
      expectedField: 'fnsku',
    });
  });

  it('item.ean === null + useItem has EAN → skip (parent missing-code already warns)', () => {
    const p = parsed([pallet('P1-B1', [
      item('X001AAAAAA', { ean: null, useItem: 'wird von 9120107187501 produziert' }),
    ])]);
    expect(validateUseItemCodes(p)).toEqual([]);
  });

  it('EAN takes precedence over X-code in extraction order (matches auftragHelpers)', () => {
    /* Both a 13-digit run and an X-code appear; EAN regex runs first. */
    const p = parsed([pallet('P1-B1', [
      item('X001AAAAAA', { ean: '9120107187501', useItem: 'X002BBBBBB / 9120107187501' }),
    ])]);
    /* Since EAN matches first and item.ean agrees, no warning. */
    expect(validateUseItemCodes(p)).toEqual([]);
  });
});
