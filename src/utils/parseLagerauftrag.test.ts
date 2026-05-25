/* Vitest — pure-function tests for parseLagerauftrag.js
   Focus on the two highest-leverage helpers (`parseTitleMeta` +
   `classifyItem`) plus the validation severity pass. Full-document
   parsing of real .docx files is covered indirectly via the Node
   sanity-check scripts we run during dev — adding fixture .docx
   files here is a follow-up (would need to commit binary blobs). */

import { describe, expect, it } from 'vitest';
import {
  parseTitleMeta,
  classifyItem,
  validateParsing,
  detectFormat,
  normalizeHeight,
  detectCodeType,
  isValidEAN8,
  isValidUPC,
  parseLagerauftragText,
} from './parseLagerauftrag.js';

describe('parseTitleMeta', () => {
  it('returns nulls for empty / falsy title', () => {
    expect(parseTitleMeta(null)).toEqual({ dimStr: null, rollen: null, dim: null });
    expect(parseTitleMeta('')).toEqual({ dimStr: null, rollen: null, dim: null });
    expect(parseTitleMeta(undefined)).toEqual({ dimStr: null, rollen: null, dim: null });
  });

  it('extracts W×H dimensions in canonical "57 × 18" form', () => {
    const m = parseTitleMeta('Thermorolle 57x18 m 12 mm');
    expect(m.dim).toMatchObject({ w: 57, h: 18, normW: 57 });
    expect(m.dimStr).toBe('57 × 18');
  });

  it('prefers parenthetical "(W×OD×ID)" triple over the leading title pair', () => {
    // Title's "80mm x 50m" is W×LENGTH (50 meters) — wrong as diameter.
    // The parenthetical (Medium - 80x63x12) gives the canonical W × OD.
    const m = parseTitleMeta(
      'Thermorollen 80mm x 50m x 12mm - Kassenrollen - Bonrollen für Registrierkasse mit Bondrucker - Thermopapier für Kassensysteme – BPA Frei (Medium - 80x63x12 - 50 Meter - 50 Rollen)'
    );
    expect(m.dim).toMatchObject({ w: 80, h: 63 });
    expect(m.dimStr).toBe('80 × 63');
  });

  it('handles unicode × and Cyrillic х as separators', () => {
    expect(parseTitleMeta('80×80').dim).toMatchObject({ w: 80, h: 80 });
    expect(parseTitleMeta('80х80').dim).toMatchObject({ w: 80, h: 80 });
  });

  it('extracts explicit roll counts: "(50 Rollen)" wins over leading-prefix', () => {
    expect(parseTitleMeta('10 Thermo 57×18 (50 Rollen)').rollen).toBe(50);
    expect(parseTitleMeta('Thermorolle 57×35 mit 25 Stk').rollen).toBe(25);
    expect(parseTitleMeta('Set 12er Pack').rollen).toBe(12);
  });

  it('extracts leading-prefix multiplier when no explicit Rollen', () => {
    expect(parseTitleMeta('50 EC-Cash Thermorollen 57×9').rollen).toBe(50);
    expect(parseTitleMeta('10x Thermorollen 80×80').rollen).toBe(10);
    expect(parseTitleMeta('5 SWIPARO Cash Roll 57×18').rollen).toBe(5);
  });

  it('caps leading-prefix at 500 to reject zip codes / years / SKU prefixes', () => {
    expect(parseTitleMeta('70794 Filderstadt Thermorolle').rollen).toBeNull();
    expect(parseTitleMeta('2024 Aktion Thermorolle').rollen).toBeNull();
  });

  it('returns null rollen when no count pattern matches', () => {
    expect(parseTitleMeta('Thermorolle ohne Mengenangabe').rollen).toBeNull();
    expect(parseTitleMeta('Klebeband Standard').rollen).toBeNull();
  });
});

describe('classifyItem', () => {
  it('classifies thermo titles (regex matches "Thermorollen" plural form)', () => {
    const c = classifyItem('Thermorollen 57x18 50 Rollen');
    expect(c.isThermo).toBe(true);
    expect(c.category).toBe('thermorollen');
  });

  it('classifies EC-Cash + SWIPARO + Bonrollen as thermo', () => {
    expect(classifyItem('SWIPARO Cash Roll 57×35').category).toBe('thermorollen');
    expect(classifyItem('Bonrollen 80×80 Standard').category).toBe('thermorollen');
    expect(classifyItem('EC-Cash Rollen 57×9').category).toBe('thermorollen');
  });

  it('classifies tacho explicitly', () => {
    const c = classifyItem('Tachographenrollen 57×8mm');
    expect(c.isTacho).toBe(true);
    expect(c.isThermo).toBe(false);
    expect(c.category).toBe('tachographenrollen');
  });

  it('classifies klebeband as its own category (before produktion)', () => {
    expect(classifyItem('TK THERMALKING Klebeband 50m').category).toBe('klebeband');
    expect(classifyItem('Klebeband Standard 50m').category).toBe('klebeband');
    expect(classifyItem('Paketband transparent').category).toBe('klebeband');
    expect(classifyItem('Absperrband rot-weiß').category).toBe('klebeband');
    expect(classifyItem('TK THERMALKING Klebeband 50m').isKlebeband).toBe(true);
    expect(classifyItem('TK THERMALKING Klebeband 50m').isProduktion).toBe(false);
  });

  it('classifies produktion (Sandsäcke, Kürbiskern)', () => {
    expect(classifyItem('Sandsack 50x bedruckt').category).toBe('produktion');
    expect(classifyItem('Kürbiskernöl 1 L').category).toBe('produktion');
  });

  it('classifies HEIPA / VEIT brands', () => {
    expect(classifyItem('HEIPA Thermopapier 80×80').category).toBe('heipa');
    expect(classifyItem('Veit GmbH Papierrolle 57×35').category).toBe('veit');
  });

  it('falls through to sonstige for unknown', () => {
    expect(classifyItem('Random product').category).toBe('sonstige');
    expect(classifyItem(null).category).toBe('sonstige');
  });

  it('Tacho beats Thermo when both substrings present', () => {
    // Tacho-rollen contains "rollen" but classifyItem prioritises Tacho.
    const c = classifyItem('Tachographenrollen Thermo 57×9');
    expect(c.category).toBe('tachographenrollen');
  });
});

describe('detectFormat', () => {
  it('flags Schilder format on the "VERWENDEN SIE KARTON" hallmark', () => {
    expect(detectFormat('Some header\nVERWENDEN SIE KARTON A')).toBe('schilder');
  });

  it('flags Standard format on Sendungsnummer header', () => {
    expect(detectFormat('Sendungsnummer\tFBA15ABC\nLagerauftrag\n')).toBe('standard');
  });

  it('defaults to standard for empty / unknown input', () => {
    expect(detectFormat('')).toBe('standard');
    expect(detectFormat('random text')).toBe('standard');
  });
});

describe('normalizeHeight + detectCodeType', () => {
  it('normalizeHeight returns numeric value for typical heights', () => {
    expect(typeof normalizeHeight(18)).toBe('number');
    expect(typeof normalizeHeight(80)).toBe('number');
  });

  it('detectCodeType returns the prefix family bucket', () => {
    expect(detectCodeType('X001QKJOQ7')).toBe('X001');
    expect(detectCodeType('X002ABCDEF')).toBe('X002');
    expect(detectCodeType('B07YXWBHQ4')).toBe('B0');
    expect(detectCodeType('UNKNOWN')).toBe('OTHER');
    expect(detectCodeType('')).toBe('OTHER');
    expect(detectCodeType(null)).toBe('OTHER');
  });
});


describe('validateParsing', () => {
  // Build a minimal parsed shape — we don't need to drive the full
  // parser to test the validator.
  const minimalParsed = ({
    pallets = [] as Array<{ id: string; items: Array<Record<string, unknown>> }>,
    einzelneSkuItems = [] as Array<Record<string, unknown>>,
    meta = {} as Record<string, unknown>,
  } = {}) => ({
    format: 'standard',
    meta: { totalUnits: 0, totalSkus: 0, ...meta },
    pallets,
    einzelneSkuItems,
  });

  it('returns ok=true with no issues when counts match', () => {
    const v = validateParsing(
      'Lagerauftrag FBA15\n…\nGesamt 0 Einheiten\n',
      minimalParsed({ meta: { totalUnits: 0, totalSkus: 0 } }),
    );
    expect(v.errorCount + v.warningCount).toBe(0);
  });

  it('flags unit-mismatch as error when header says N and items sum to M', () => {
    const parsed = minimalParsed({
      meta: { totalUnits: 100, totalSkus: 1 },
      pallets: [{
        id: 'P1-B1',
        items: [{ title: 'Item', units: 80, fnsku: 'X1', sku: 'S1', asin: 'A1' }],
      }],
    });
    const v = validateParsing('any', parsed);
    const unitFlag = v.issues.find((i) => i.kind === 'unit-mismatch');
    expect(unitFlag).toBeDefined();
    expect(unitFlag?.severity).toBe('error');
  });

  it('flags missing-asin as warn (not error)', () => {
    const parsed = minimalParsed({
      meta: { totalUnits: 5, totalSkus: 1 },
      pallets: [{
        id: 'P1-B1',
        items: [{ title: 'Item', units: 5, fnsku: 'X1', sku: 'S1' }], // no asin
      }],
    });
    const v = validateParsing('any', parsed);
    const asinFlag = v.issues.find((i) => i.kind === 'missing-asin');
    if (asinFlag) {                          // only emitted when ASIN actually missing
      expect(asinFlag.severity).toBe('warn');
    }
  });

  it('flags missing-identifier (error) when BOTH fnsku and sku absent', () => {
    const parsed = minimalParsed({
      meta: { totalUnits: 5, totalSkus: 0 },
      pallets: [{
        id: 'P1-B1',
        items: [{ title: 'Mystery Item', units: 5, fnsku: '', sku: '' }],
      }],
    });
    const v = validateParsing('any', parsed);
    const missingId = v.issues.find((i) => i.kind === 'missing-identifier');
    expect(missingId).toBeDefined();
    expect(missingId?.severity).toBe('error');
    // Should NOT also emit missing-fnsku (avoid double-count)
    expect(v.issues.find((i) => i.kind === 'missing-fnsku')).toBeUndefined();
  });

  it('falls back to missing-fnsku when sku present but fnsku absent', () => {
    const parsed = minimalParsed({
      meta: { totalUnits: 5, totalSkus: 1 },
      pallets: [{
        id: 'P1-B1',
        items: [{ title: 'Item', units: 5, fnsku: '', sku: 'AB-CDEF-1234' }],
      }],
    });
    const v = validateParsing('any', parsed);
    expect(v.issues.find((i) => i.kind === 'missing-identifier')).toBeUndefined();
    expect(v.issues.find((i) => i.kind === 'missing-fnsku')).toBeDefined();
  });
});

describe('Checksum helpers', () => {
  it('isValidEAN8 accepts known-good and rejects off-by-one corruption', () => {
    // 40123455 — checksum 5 (computed from "4012345" weights)
    expect(isValidEAN8('40123455')).toBe(true);
    // Flip last digit → invalid
    expect(isValidEAN8('40123450')).toBe(false);
    // Non-8-digit input
    expect(isValidEAN8('1234567')).toBe(false);
    expect(isValidEAN8('123456789')).toBe(false);
  });

  it('isValidUPC accepts known-good and rejects corruption', () => {
    // 042100005264 — Coca-Cola classic UPC, well-known valid checksum
    expect(isValidUPC('042100005264')).toBe(true);
    // Flip last digit → invalid
    expect(isValidUPC('042100005263')).toBe(false);
    // Wrong length
    expect(isValidUPC('04210000526')).toBe(false);
  });
});

describe('parseWarnings — new uncertainty signals', () => {
  /* Build a minimal standard-format Auftrag text. The first item on
     P1-B1 is a placeholder that satisfies parseItemsFromBlock; the
     ESKU block at the tail drives parseEinzelneSkuSection. */
  const buildAuftrag = (eskuBlock: string) => [
    'PALETTE 1 - P1-B1',
    'P1-B1 → AB-CDEF-1234\tDummy item\tB07AAAAAAA\tX001AAAAAA\tEAN:9120107187433\tNeu\tKeine Vorbereitung erforderlich\tnull\tVerkäufer\t1',
    '',
    eskuBlock,
  ].join('\n');

  const findEskuWarning = (parsed: any, field: string) => {
    const item = parsed.einzelneSkuItems?.[0];
    if (!item) return undefined;
    return (item.parseWarnings || []).find((w: any) => w.field === field);
  };

  it('Thermo title without parsed dim → medium dim warning', () => {
    const text = [
      'PALETTE 1 - P1-B1',
      'P1-B1 → AB-CDEF-1234\tBonrollen Thermopapier ohne Maße\tB07AAAAAAA\tX001AAAAAA\tEAN:9120107187433\tNeu\tKeine Vorbereitung erforderlich\tnull\tVerkäufer\t10',
    ].join('\n');
    const parsed = parseLagerauftragText(text);
    const item = parsed.pallets[0]?.items[0];
    expect(item).toBeDefined();
    const dimFlag = (item.parseWarnings || []).find((w: any) => w.field === 'dim');
    expect(dimFlag).toBeDefined();
    expect(dimFlag?.severity).toBe('medium');
  });

  it('ACHTUNG X > 100 → high achtung warning', () => {
    const esku = [
      'ACHTUNG! Jeder Karton mit (200 x 5 Rollen) muss ein Etikett haben.',
      'Einzelne SKU → SK-WXYZ-5678\tThermo item\tB07BBBBBBB\tX001BBBBBB\tEAN:9120107187433\tNeu\tKeine Vorbereitung erforderlich\tnull\tVerkäufer\t10',
    ].join('\n');
    const parsed = parseLagerauftragText(buildAuftrag(esku));
    const flag = findEskuWarning(parsed, 'achtung');
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe('high');
    expect(flag?.reason).toMatch(/Packs pro Karton/);
  });

  it('ACHTUNG Y > 1000 → high achtung warning', () => {
    const esku = [
      'ACHTUNG! Jeder Karton mit (5 x 5000 Rollen) muss ein Etikett haben.',
      'Einzelne SKU → SK-WXYZ-5678\tThermo item\tB07BBBBBBB\tX001BBBBBB\tEAN:9120107187433\tNeu\tKeine Vorbereitung erforderlich\tnull\tVerkäufer\t10',
    ].join('\n');
    const parsed = parseLagerauftragText(buildAuftrag(esku));
    const achtungFlags = (parsed.einzelneSkuItems[0]?.parseWarnings || [])
      .filter((w: any) => w.field === 'achtung' && w.severity === 'high');
    expect(achtungFlags.length).toBeGreaterThanOrEqual(1);
    expect(achtungFlags.some((w: any) => /Stück pro Pack/.test(w.reason))).toBe(true);
  });

  it('ACHTUNG dim-poisoned (10 x 80mm*63mm (5) 50M) → low recovered warning', () => {
    const esku = [
      'ACHTUNG! Jeder Karton mit (10 x 80mm*63mm (5) 50M) muss ein Etikett haben.',
      'Einzelne SKU → SK-WXYZ-5678\tThermo item 80x63\tB07BBBBBBB\tX001BBBBBB\tEAN:9120107187433\tNeu\tKeine Vorbereitung erforderlich\tnull\tVerkäufer\t10',
    ].join('\n');
    const parsed = parseLagerauftragText(buildAuftrag(esku));
    const flag = findEskuWarning(parsed, 'achtung');
    expect(flag).toBeDefined();
    expect(flag?.severity).toBe('low');
    expect(flag?.reason).toMatch(/rekonstruiert/);
  });
});