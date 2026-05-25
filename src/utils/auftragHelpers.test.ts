/* Vitest — auftragHelpers.js critical-path tests.

   Covers:
     • getDisplayLevel — title regex priority over legacy `category`
     • formatItemTitle — Kürbiskernöl noise stripping + size suffix
     • sortItemsForPallet — W×H clustering rule (added 2026-05-06)
     • distributeEinzelneSku — H1-H4 level order + H7 4-Seiten-Warnung
     • itemTotalVolumeCm3 / itemTotalWeightKg — heuristic fallbacks

   Tests use minimal synthetic items — no real .docx, no DB. */

import { describe, expect, it } from 'vitest';
import {
  getLevel,
  getDisplayLevel,
  formatItemTitle,
  focusItemView,
  sortItemsForPallet,
  sortPallets,
  distributeEinzelneSku,
  applyEskuOverrides,
  eskuOverrideKey,
  primaryLevel,
  itemTotalVolumeCm3,
  itemTotalWeightKg,
  extractRolleFormat,
  LEVEL_META,
} from './auftragHelpers.js';

/* ─── Helpers to build minimal items ───────────────────────────────── */
function mkMixed({ title, units = 10, dim = null, rollen = null, fnsku = 'X-FAKE' }: { title: string; units?: number; dim?: unknown; rollen?: unknown; fnsku?: string }): Record<string, unknown> {
  return {
    title,
    units,
    fnsku,
    sku: 'sku-' + fnsku,
    dim,
    rollen,
    isEinzelneSku: false,
  };
}
function mkEsku({ title, cartons = 5, packsPerCarton = 10, fnsku = 'X-ESKU' }: { title: string; cartons?: number; packsPerCarton?: number; fnsku?: string }): Record<string, unknown> {
  return {
    title,
    fnsku,
    sku: 'sku-' + fnsku,
    isEinzelneSku: true,
    units: cartons * packsPerCarton,
    einzelneSku: { cartonsCount: cartons, packsPerCarton },
  };
}

/* ════════════════════════════════════════════════════════════════════ */
describe('getLevel / getDisplayLevel', () => {
  it('Tachorollen → L7 (highest priority — beats Thermorollen pattern)', () => {
    expect(getLevel({ title: 'Tachographenrollen 57×8mm' })).toBe(7);
    expect(getLevel({ title: 'Tachorolle 57/8' })).toBe(7);
  });

  it('Kürbiskernöl → L6 (fragile cap, just below Tacho)', () => {
    expect(getLevel({ title: 'Steirisches Gourmet Kürbiskernöl 1L' })).toBe(6);
    expect(getLevel({ title: 'Kernöl Premium' })).toBe(6);
  });

  it('Sandsäcke / TK THERMALKING (non-Klebeband) → L5 Produktion', () => {
    expect(getLevel({ title: 'TK THERMALKING Big Bag 500L' })).toBe(5);
    expect(getLevel({ title: '50x Sandsäcke leer' })).toBe(5);
  });

  it('Klebeband / paketband / packband / absperrband / fragile → L4 (before Produktion)', () => {
    expect(getLevel({ title: 'Klebeband Standard 50m' })).toBe(4);
    expect(getLevel({ title: 'Fragile Aufkleber' })).toBe(4);
    // TK THERMALKING branding does NOT pull a Klebeband item into L5 —
    // Klebeband is checked first because it always stacks below Produktion.
    expect(getLevel({ title: 'TK THERMALKING Klebeband 50m' })).toBe(4);
    expect(getLevel({ title: 'Paketband transparent 50mm × 66m' })).toBe(4);
    expect(getLevel({ title: 'Packband braun' })).toBe(4);
    expect(getLevel({ title: 'Absperrband rot-weiß' })).toBe(4);
  });

  it('only the "öko" word triggers L3 — phenolfrei alone is L1', () => {
    // Genuine ÖKO branding wins L3.
    expect(getLevel({ title: 'ÖKO Thermorollen phenolfrei' })).toBe(3);
    expect(getLevel({ title: 'THERMALKING - ÖKO - Thermorollen 80mm' })).toBe(3);
    // Phenolfrei alone is a paper spec, not an ÖKO product.
    expect(getLevel({ title: 'Phenolfrei BPA-frei Thermorolle' })).toBe(1);
    expect(getLevel({
      title: 'EC Thermorollen mit SEPA-Lastschrifttext 57mm x 14m x 12mm phenolfrei 52g/m² (50)',
    })).toBe(1);
  });

  it('ECO ROOLLS brand alone is L1, not L3', () => {
    // Brand prefix "ECO ROOLLS" (registered trademark) used to false-
    // positive into L3. The vendor's catalog is mostly regular thermal
    // paper — only the explicit "öko" word marks an actual L3 product.
    expect(getLevel({
      title: 'ECO ROOLLS® EC Cash Rollen Thermopapier 57mm x 35mm x 12mm - Kassenrollen',
    })).toBe(1);
    expect(getLevel({ title: 'ECO ROOLLS 57×40' })).toBe(1);
    // ECO ROOLLS that ARE explicitly öko still hit L3:
    expect(getLevel({ title: 'ECO ROOLLS öko 80×80' })).toBe(3);
  });

  it('VEIT brand → L2 (own bucket, sits right after L1 Thermo in the pick order)', () => {
    expect(getLevel({ title: 'Veit GmbH Papierrolle 57×35' })).toBe(2);
    expect(getLevel({ title: 'VEIT Thermorollen 80×80' })).toBe(2);
    // Word-boundary: "Veitsbach" shouldn't match.
    expect(getLevel({ title: 'Veitsbach Thermo 57×40' })).toBe(1);
  });

  it('VEIT + öko stays L3 — öko precedence preserved', () => {
    // VEIT öko historically resolved to ÖKO (the dedicated thermal-roll
    // sub-bucket); the L2 Veit branch must not override that.
    expect(getLevel({ title: 'VEIT öko Thermorolle 57×40' })).toBe(3);
  });

  it('default falls through to L1 Thermorollen', () => {
    expect(getLevel({ title: 'Standard Thermorolle 57×18' })).toBe(1);
    expect(getLevel({ title: 'Random product' })).toBe(1);
  });

  it('getDisplayLevel: title regex wins over legacy category field', () => {
    // Legacy parser tagged Kernöl as 'produktion' (=L5) but the live
    // title-based check should give L6.
    const item = { title: 'Kürbiskernöl 1 L', category: 'produktion' };
    expect(getDisplayLevel(item)).toBe(6);
  });

  it('getDisplayLevel: pre-computed item.level always wins', () => {
    expect(getDisplayLevel({ level: 7, title: 'whatever' })).toBe(7);
  });

  it('LEVEL_META has 7 entries with shortName + color, L2=VEIT', () => {
    for (let lvl = 1; lvl <= 7; lvl++) {
      expect(LEVEL_META[lvl]).toMatchObject({
        shortName: expect.any(String),
        color: expect.stringMatching(/^#[0-9A-F]{6}$/i),
      });
    }
    expect(LEVEL_META[2].shortName).toBe('VEIT');
    expect(LEVEL_META[7].shortName).toBe('TACHO');
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('formatItemTitle', () => {
  it('strips g.g.A. + 100% vegan + kaltgepresst noise on Kernöl titles', () => {
    const out = formatItemTitle('Steirisches Gourmet Kürbiskernöl g.g.A. 100% vegan kaltgepresst (1 l)');
    expect(out).not.toMatch(/g\.g\.A/);
    expect(out).not.toMatch(/100\s*%/);
    expect(out).not.toMatch(/vegan/i);
    expect(out).not.toMatch(/kaltgepresst/i);
  });

  it('surfaces (N l) / (N kg) suffix at end of cleaned title', () => {
    expect(formatItemTitle('Steirisches Kürbiskernöl (1 l)')).toMatch(/1 L$/);
    expect(formatItemTitle('Big Bag (10 kg)')).toMatch(/10 kg$/);
  });

  it('handles missing / empty input', () => {
    expect(formatItemTitle('')).toBe('—');
    expect(formatItemTitle(null)).toBe('—');
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('focusItemView — L5 size hint preserves variant distinction', () => {
  /* Convention (2026-05-24): L5 size hint moved OUT of the name and INTO
     the perCarton headline (item.rollen + item.rollenUnit). The Focus
     hero renders it as "1 Kg" / "500 g" above a clean "Füllmaterial"
     title — same visual distinction, less duplication, mirrors the
     thermo "50 Rollen" split. */
  it('surfaces "1 Kg" in perCarton (rollen + Kg unit) on a Füllmaterial', () => {
    const view = focusItemView({
      title:
        'Füllmaterial für Pakete - 1 Kg Holzwolle für Geschenkkorb - naturbelassenes Ostergras - Deko Stroh - perfekt als Füllung für Verpackungen - Premium Qualität (1 Kg Holzwolle)',
      units: 50,
    });
    expect(view.name).toMatch(/Füllmaterial/);
    expect(String(view.rollen)).toBe('1');
    expect(view.rollenUnit).toBe('Kg');
  });

  it('surfaces "500 g" in perCarton for the small variant', () => {
    const view = focusItemView({
      title:
        'Füllmaterial für Pakete - 500 g Holzwolle für Geschenkkorb - naturbelassenes Ostergras - Deko Stroh - perfekt als Füllung für Verpackungen - Premium Qualität (500 g Holzwolle)',
      units: 40,
    });
    expect(String(view.rollen)).toBe('500');
    expect(view.rollenUnit).toBe('g');
  });

  it('strips the size hint from the name to avoid duplication with perCarton', () => {
    const view = focusItemView({
      title: 'Sandsack 50 Kg',
      units: 20,
    });
    // Name should be just "Sandsack" — size lives in perCarton now.
    expect(view.name).not.toMatch(/50\s*Kg/i);
    expect(view.name).toMatch(/Sandsack/);
  });

  it('Big Bag: strips "1000 Kg" suffix from the headline', () => {
    const view = focusItemView({ title: 'Big Bag 1000 Kg', units: 4 });
    expect(view.name).toBe('Big Bag');
  });

  it('Big Bag: strips brand prefix AND size — TK THERMALKING Big Bag → Big Bag', () => {
    const view = focusItemView({ title: 'TK THERMALKING Big Bag 1000 Kg', units: 4 });
    expect(view.name).toBe('Big Bag');
  });

  it('Big Bag: keeps variant descriptor AFTER "Big Bag", strips size', () => {
    const view = focusItemView({ title: 'Big Bag XL 500 Kg schwarz', units: 4 });
    expect(view.name).toBe('Big Bag XL schwarz');
  });

  it('Big Bag: strips size even with parenthetical pack count', () => {
    const view = focusItemView({ title: 'Big Bag 1000 Kg (4 Stück)', units: 4 });
    expect(view.name).toBe('Big Bag');
  });

  it('Big Bag: bare title returns "Big Bag" unchanged', () => {
    const view = focusItemView({ title: 'TK THERMALKING Big Bag', units: 4 });
    expect(view.name).toBe('Big Bag');
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('focusItemView — useItem display vs copy-code split', () => {
  it('keeps full "wird von X001BVO9LV produziert" for display, exposes bare code for clipboard', () => {
    const view = focusItemView({
      title: 'Füllmaterial für Pakete - 500 g Holzwolle',
      useItem: 'wird von X001BVO9LV produziert',
    });
    expect(view.useItem).toBe('wird von X001BVO9LV produziert');
    expect(view.useItemCode).toBe('X001BVO9LV');
  });

  it('bare X-code: display and copy match', () => {
    const view = focusItemView({
      title: 'Füllmaterial 1 Kg',
      useItem: 'X001BVO9LV',
    });
    expect(view.useItem).toBe('X001BVO9LV');
    expect(view.useItemCode).toBe('X001BVO9LV');
  });

  it('EAN wrapper: display keeps prefix, copy gets just the digits', () => {
    const view = focusItemView({
      title: 'Sandsack 50 Kg',
      useItem: 'EAN: 9120107182162 (Bestand)',
    });
    expect(view.useItem).toBe('EAN: 9120107182162 (Bestand)');
    expect(view.useItemCode).toBe('9120107182162');
  });

  it('falls back to the original string when no code can be extracted', () => {
    const view = focusItemView({
      title: 'Random',
      useItem: 'VF-Z4DN-RFTL',
    });
    expect(view.useItem).toBe('VF-Z4DN-RFTL');
    expect(view.useItemCode).toBe('VF-Z4DN-RFTL');
  });

  it('returns empty strings when useItem is missing', () => {
    const view = focusItemView({ title: 'Random' });
    expect(view.useItem).toBe('');
    expect(view.useItemCode).toBe('');
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('sortItemsForPallet — W×H cluster rule (2026-05-06)', () => {
  it('clusters identical W×H even with different rollen counts', () => {
    // FBA15LL4PK53 P1-B3 case: 57×18 (75 rolls) + 57×14 + 57×18 (15 rolls) + 57×9
    // Expected: 57×18 cluster stays adjacent (75 rolls then 15 rolls),
    // then 57×14, then 57×9.
    const items = [
      mkMixed({ title: 'Thermorollen 57×9',  units: 20, dim: { w: 57, h: 9 },  rollen: 50, fnsku: 'F1' }),
      mkMixed({ title: 'Thermorollen 57×14', units: 70, dim: { w: 57, h: 14 }, rollen: 50, fnsku: 'F2' }),
      mkMixed({ title: 'Thermorollen 57×18', units: 15, dim: { w: 57, h: 18 }, rollen: 50, fnsku: 'F3' }),
      mkMixed({ title: 'Thermorollen 57×18', units: 75, dim: { w: 57, h: 18 }, rollen: 50, fnsku: 'F4' }),
    ];
    const sorted = sortItemsForPallet(items);
    const keys = sorted.map((it) => `${it.dim.w}×${it.dim.h} ·${it.units}`);
    // 57×18 (75) anchor → 57×18 (15) clustered after → 57×14 → 57×9
    expect(keys[0]).toBe('57×18 ·75');
    expect(keys[1]).toBe('57×18 ·15');
    expect(keys[2]).toBe('57×14 ·70');
    expect(keys[3]).toBe('57×9 ·20');
  });

  it('puts L6 (Kernöl) and L7 (Tacho) at end, L6 before L7', () => {
    const items = [
      mkMixed({ title: 'Tachographenrollen 57×8', units: 20, dim: { w: 57, h: 8 }, rollen: 50, fnsku: 'T1' }),
      mkMixed({ title: 'Kürbiskernöl 1L',         units: 10, fnsku: 'K1' }),
      mkMixed({ title: 'Thermorollen 57×18',      units: 30, dim: { w: 57, h: 18 }, rollen: 50, fnsku: 'F1' }),
    ];
    const sorted = sortItemsForPallet(items);
    expect(getDisplayLevel(sorted[0])).toBe(1);   // L1 first
    expect(getDisplayLevel(sorted[1])).toBe(6);   // Kernöl
    expect(getDisplayLevel(sorted[2])).toBe(7);   // Tacho last
  });

  it('returns empty array for empty input', () => {
    expect(sortItemsForPallet([])).toEqual([]);
    expect(sortItemsForPallet(null)).toEqual([]);
    expect(sortItemsForPallet(undefined)).toEqual([]);
  });

  it('preserves single-item input', () => {
    const item = mkMixed({ title: 'Thermo 57×18', units: 10, dim: { w: 57, h: 18 } });
    expect(sortItemsForPallet([item])).toEqual([item]);
  });

  it('ESKU items get unique cluster keys — do NOT cluster with each other', () => {
    // Two ESKU items with same W×H but different fnsku should stay
    // separate (the sort still orders them, just doesn't merge).
    const a = mkEsku({ title: 'ESKU A 57×18', cartons: 5, fnsku: 'EA' });
    const b = mkEsku({ title: 'ESKU B 57×18', cartons: 3, fnsku: 'EB' });
    a.dim = { w: 57, h: 18 };
    b.dim = { w: 57, h: 18 };
    const sorted = sortItemsForPallet([a, b]);
    expect(sorted.length).toBe(2);    // both present
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('sortItemsForPallet — Veit (L2) pick-order rule', () => {
  it('default: L2 Veit sits RIGHT AFTER L1 (before L3/L4/L5)', () => {
    const items = [
      mkMixed({ title: 'Klebeband 50m',           units: 10, fnsku: 'KB' }),         // L4
      mkMixed({ title: 'Sandsack 50x',            units: 5,  fnsku: 'PR' }),         // L5
      mkMixed({ title: 'Veit Thermo 57×40',       units: 30, dim: { w: 57, h: 40 }, rollen: 50, fnsku: 'V1' }), // L2 (small)
      mkMixed({ title: 'Thermorollen 57×18',      units: 40, dim: { w: 57, h: 18 }, rollen: 50, fnsku: 'T1' }), // L1
      mkMixed({ title: 'ÖKO Thermo 80×80',        units: 20, dim: { w: 80, h: 80 }, fnsku: 'O1' }),             // L3
    ];
    const sorted = sortItemsForPallet(items);
    const levels = sorted.map(getDisplayLevel);
    expect(levels).toEqual([1, 2, 3, 4, 5]);
  });

  it('heavy Veit (50 rollen × 120 units) — L2 jumps to BASE position before L1', () => {
    const items = [
      mkMixed({ title: 'Thermorollen 57×18', units: 40,  dim: { w: 57, h: 18 }, rollen: 50, fnsku: 'T1' }),
      mkMixed({ title: 'Veit Thermo 57×40',  units: 120, dim: { w: 57, h: 40 }, rollen: 50, fnsku: 'V1' }),
      mkMixed({ title: 'Klebeband 50m',      units: 10,  fnsku: 'KB' }),
    ];
    const sorted = sortItemsForPallet(items);
    expect(getDisplayLevel(sorted[0])).toBe(2);   // Veit forms the base
    expect(getDisplayLevel(sorted[1])).toBe(1);
    expect(getDisplayLevel(sorted[2])).toBe(4);
  });

  it('heavy Veit (20 rollen × 400 units) also flips to base', () => {
    const items = [
      mkMixed({ title: 'Thermorollen 57×18', units: 40,  dim: { w: 57, h: 18 }, rollen: 50, fnsku: 'T1' }),
      mkMixed({ title: 'Veit Mini 80×80',    units: 400, dim: { w: 80, h: 80 }, rollen: 20, fnsku: 'V2' }),
    ];
    const sorted = sortItemsForPallet(items);
    expect(getDisplayLevel(sorted[0])).toBe(2);
    expect(getDisplayLevel(sorted[1])).toBe(1);
  });

  it('Veit just BELOW the threshold stays in default position (after L1)', () => {
    const items = [
      mkMixed({ title: 'Thermorollen 57×18', units: 40,  dim: { w: 57, h: 18 }, rollen: 50, fnsku: 'T1' }),
      mkMixed({ title: 'Veit Thermo 57×40',  units: 119, dim: { w: 57, h: 40 }, rollen: 50, fnsku: 'V1' }),
      mkMixed({ title: 'Veit Mini 80×80',    units: 399, dim: { w: 80, h: 80 }, rollen: 20, fnsku: 'V2' }),
    ];
    const sorted = sortItemsForPallet(items);
    expect(getDisplayLevel(sorted[0])).toBe(1);
    expect(getDisplayLevel(sorted[1])).toBe(2);   // Veit V1
    expect(getDisplayLevel(sorted[2])).toBe(2);   // Veit V2
  });

  it('non-50/20 rollen counts are NEVER heavy — Veit stays after L1', () => {
    const items = [
      mkMixed({ title: 'Thermorollen 57×18', units: 40,   dim: { w: 57, h: 18 }, rollen: 50, fnsku: 'T1' }),
      mkMixed({ title: 'Veit 30-Rollen',     units: 9999, dim: { w: 57, h: 40 }, rollen: 30, fnsku: 'V1' }),
    ];
    const sorted = sortItemsForPallet(items);
    expect(getDisplayLevel(sorted[0])).toBe(1);
    expect(getDisplayLevel(sorted[1])).toBe(2);
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('extractRolleFormat', () => {
  it('captures "57mm x 18m x 12mm" as canonical 57x18m-12 signature', () => {
    expect(extractRolleFormat('Ec-Cash Thermorollen 57mm x 18m x 12mm')).toBe('57x18m-12');
    expect(extractRolleFormat('57mm × 14m × 12mm')).toBe('57x14m-12');
  });
  it('treats LST-variants as same format', () => {
    const a = '50 EC-Cash Thermorollen im Karton 57mm x 18m x 12mm mit Lastschrifttext ELV';
    const b = 'Ec-Cash Thermorollen 57mm x 18m x 12mm (57x40x12) (50 Rollen)';
    expect(extractRolleFormat(a)).toBe(extractRolleFormat(b));
  });
  it('catches slash-format "58/64/12"', () => {
    expect(extractRolleFormat('Thermorolle 58/64/12 - 50 Meter Lauflänge')).toBe('58/64/12');
  });
  it('returns null for carton-only specs (no rolle units)', () => {
    expect(extractRolleFormat('(57x40x12) Karton')).toBeNull();
    expect(extractRolleFormat('Thermorollen ohne Mass')).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('sortItemsForPallet — useItem clustering for Thermorollen (2026-05-13)', () => {
  /* User rule 2026-05-13: for L1/L2 Thermorollen, items sharing the
     same `useItem` (parent product EAN from "Zu verwendender Artikel")
     must ALWAYS cluster together — even when rolle formats differ.
     Supersedes the 2026-05-07 rolle-format-only rule. */
  it('clusters same useItem across different rolle formats (L1)', () => {
    /* User's reported case: two SKUs share useItem 4017279107701 but
       have different formats (57×14 and 57×35). Currently sorted with
       a 9120107187419-57×35 item between them — they must instead
       group together. */
    const items = [
      mkMixed({ title: 'Thermorolle 57 × 14 50 Rollen',
                units: 50, dim: { w: 57, h: 14 }, rollen: 50, fnsku: 'F-A1' }),
      mkMixed({ title: 'Thermorolle 57 × 35 50 Rollen',
                units: 50, dim: { w: 57, h: 35 }, rollen: 50, fnsku: 'F-B1' }),
      mkMixed({ title: 'Thermorolle 57 × 14 50 Rollen',
                units: 50, dim: { w: 57, h: 14 }, rollen: 50, fnsku: 'F-A2' }),
    ];
    items[0].useItem = '4017279107701';
    items[1].useItem = '9120107187419';
    items[2].useItem = '4017279107701';

    const sorted = sortItemsForPallet(items);
    const fnskus = sorted.map((it) => it.fnsku);
    /* Both 4017279107701 items must be adjacent. */
    const aIdx1 = fnskus.indexOf('F-A1');
    const aIdx2 = fnskus.indexOf('F-A2');
    expect(Math.abs(aIdx1 - aIdx2)).toBe(1);
  });

  it('falls back to rolle-format clustering when useItem is absent', () => {
    /* L1 items without a useItem still cluster by rolle format —
       preserves the 2026-05-07 LST-variant behaviour for legacy
       Aufträge whose parser output lacks the "Zu verwendender
       Artikel" line. */
    const items = [
      mkMixed({ title: 'Ec-Cash Thermorollen 57mm x 18m x 12mm (57x40x12) (50 Rollen)',
                units: 75, dim: { w: 57, h: 18 }, rollen: 50, fnsku: 'F-LST1' }),
      mkMixed({ title: 'Ec-Cash Thermorollen 57mm x 14m x 12mm (50 Rollen)',
                units: 70, dim: { w: 57, h: 14 }, rollen: 50, fnsku: 'F-MID' }),
      mkMixed({ title: '50 EC-Cash Thermorollen im Karton 57mm x 18m x 12mm mit Lastschrifttext ELV',
                units: 15, dim: { w: 57, h: 18 }, rollen: 50, fnsku: 'F-LST2' }),
    ];
    // No useItem on any → fall back to rolle-format bucketing.
    const sorted = sortItemsForPallet(items);
    const fnskus = sorted.map((it) => it.fnsku);
    expect(fnskus).toEqual(['F-LST1', 'F-LST2', 'F-MID']);
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('primaryLevel', () => {
  it('picks dominant level by total volume', () => {
    const items = [
      mkMixed({ title: 'Thermo 57×18', units: 100, dim: { w: 57, h: 18 } }),
      mkMixed({ title: 'Tacho 57×8',   units: 5,   dim: { w: 57, h: 8 } }),
    ];
    expect(primaryLevel(items)).toBe(1);    // L1 dominates
  });

  it('returns 1 for empty pallet', () => {
    expect(primaryLevel([])).toBe(1);
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('sortPallets — Single-SKU useItem clustering', () => {
  function mkPallet(id, items, hasFourSideWarning = false) {
    return { id, items, hasFourSideWarning };
  }
  function mkItem(title, useItem) {
    return { title, units: 100, useItem, isEinzelneSku: false };
  }

  it('clusters Single-SKU pallets sharing the same useItem, even when split in original order', () => {
    const pallets = [
      mkPallet('P1-B1', [mkItem('Thermo 57×18', '4017279107701')], true),  // single, useItem A
      mkPallet('P1-B2', [mkItem('Thermo 80×80', '4017279999999')], true),  // single, useItem B
      mkPallet('P1-B3', [mkItem('Thermo 57×40', '4017279107701')], true),  // single, useItem A — should cluster with P1-B1
      mkPallet('P1-B4', [mkItem('Thermo 80×80', '4017279999999')], true),  // single, useItem B — clusters with P1-B2
    ];
    const sorted = sortPallets(pallets);
    const ids = sorted.map((p) => p.id);
    // Cluster A anchored at index 0 → P1-B1, P1-B3
    // Cluster B anchored at index 1 → P1-B2, P1-B4
    expect(ids).toEqual(['P1-B1', 'P1-B3', 'P1-B2', 'P1-B4']);
  });

  it('Single-SKU clusters interleaved with Mixed pallets reshuffle to stay adjacent', () => {
    const pallets = [
      mkPallet('P1-B1', [mkItem('Thermo 57×18', 'X001AAA0001')], true),       // single A
      mkPallet('P1-B2', [
        mkItem('Thermo 57×18', 'X001AAA0001'),
        mkItem('Thermo 80×80', 'X001AAA0001'),
      ]),                                                                       // Mixed
      mkPallet('P1-B3', [mkItem('Thermo 57×18', 'X001AAA0001')], true),       // single A
    ];
    const sorted = sortPallets(pallets);
    const ids = sorted.map((p) => p.id);
    // Single-SKU pallets share useItem → cluster at the front (1 article tier).
    // Mixed pallet has 2 articles → falls into a higher fewest-articles bucket.
    expect(ids).toEqual(['P1-B1', 'P1-B3', 'P1-B2']);
  });

  it('Single-SKU pallets with DIFFERENT useItems stay separate', () => {
    const pallets = [
      mkPallet('P1-B1', [mkItem('Thermo 57×18', 'X001AAA0001')], true),
      mkPallet('P1-B2', [mkItem('Thermo 80×80', 'X001BBB0002')], true),
      mkPallet('P1-B3', [mkItem('Thermo 57×40', 'X001CCC0003')], true),
    ];
    const sorted = sortPallets(pallets);
    expect(sorted.map((p) => p.id)).toEqual(['P1-B1', 'P1-B2', 'P1-B3']);
  });

  it('Mixed pallets (not Single-SKU) are NOT clustered by useItem', () => {
    const pallets = [
      mkPallet('P1-B1', [mkItem('Thermo 57×18', 'X001AAA0001')]),  // Mixed (no hasFourSideWarning)
      mkPallet('P1-B2', [mkItem('Thermo 80×80', 'X001BBB0002')]),
      mkPallet('P1-B3', [mkItem('Thermo 57×40', 'X001AAA0001')]),
    ];
    const sorted = sortPallets(pallets);
    // Stable order — no useItem-based reshuffle for Mixed pallets.
    expect(sorted.map((p) => p.id)).toEqual(['P1-B1', 'P1-B2', 'P1-B3']);
  });

  it('Single-SKU pallet without a parseable useItem falls back to stable order', () => {
    const pallets = [
      mkPallet('P1-B1', [mkItem('Thermo 57×18', null)], true),
      mkPallet('P1-B2', [mkItem('Thermo 80×80', 'X001AAA0001')], true),
      mkPallet('P1-B3', [mkItem('Thermo 57×40', null)], true),
    ];
    const sorted = sortPallets(pallets);
    expect(sorted.map((p) => p.id)).toEqual(['P1-B1', 'P1-B2', 'P1-B3']);
  });

  it('Single-SKU split palets (no useItem) cluster by FNSKU fallback', () => {
    // Real-world Lynne pattern: a 4-Seiten-Warnung SKU spread across
    // multiple palets without a "Zu verwendender Artikel" line.
    // Same FNSKU across palets must still glue them together.
    const pallets = [
      mkPallet('P1-B1', [{ title: 'Produktion A', units: 36, fnsku: 'X001AAA0001', isEinzelneSku: false }], true),
      mkPallet('P1-B2', [{ title: 'Produktion A', units: 36, fnsku: 'X001AAA0001', isEinzelneSku: false }], true),
      mkPallet('P1-B3', [{ title: 'Produktion B', units: 36, fnsku: 'X001BBB0002', isEinzelneSku: false }], true),
      mkPallet('P1-B4', [{ title: 'Produktion A', units: 36, fnsku: 'X001AAA0001', isEinzelneSku: false }], true),
    ];
    const sorted = sortPallets(pallets);
    // Same FNSKU = same cluster. Anchor of A is index 0 → A's pallets first.
    expect(sorted.map((p) => p.id)).toEqual(['P1-B1', 'P1-B2', 'P1-B4', 'P1-B3']);
  });

  it('cluster key prioritises useItem over FNSKU when both present', () => {
    // useItem is the most specific identifier (parent EAN). If two
    // palets share useItem but have different FNSKU labels, they STILL
    // cluster — Amazon may issue distinct labels for the same parent.
    const pallets = [
      mkPallet('P1-B1', [{ title: 'A', units: 36, useItem: 'X001PARENT', fnsku: 'X001LABEL1', isEinzelneSku: false }], true),
      mkPallet('P1-B2', [{ title: 'B', units: 36, useItem: 'X001OTHER',  fnsku: 'X001LABEL2', isEinzelneSku: false }], true),
      mkPallet('P1-B3', [{ title: 'A', units: 36, useItem: 'X001PARENT', fnsku: 'X001LABEL3', isEinzelneSku: false }], true),
    ];
    const sorted = sortPallets(pallets);
    expect(sorted.map((p) => p.id)).toEqual(['P1-B1', 'P1-B3', 'P1-B2']);
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('distributeEinzelneSku — hard constraints', () => {
  function mkPallet({ id, items = [] as Array<Record<string, unknown>>, hasFourSideWarning = false }: { id: string; items?: Array<Record<string, unknown>>; hasFourSideWarning?: boolean }) {
    return { id, items, hasFourSideWarning };
  }

  it('returns empty distribution when no pallets', () => {
    const r = distributeEinzelneSku([], []);
    expect(r.byPalletId).toEqual({});
    expect(r.unassigned).toEqual([]);
  });

  it('returns empty placement when no ESKU items', () => {
    const r = distributeEinzelneSku([mkPallet({ id: 'P1-B1' })], []);
    expect(r.byPalletId).toEqual({ 'P1-B1': [] });
  });

  it('H7 — refuses to assign ESKU to a Single-SKU pallet (hasFourSideWarning)', () => {
    const single = mkPallet({
      id: 'P1-B1',
      items: [mkMixed({ title: 'Single-SKU thermo 57×18', units: 200, dim: { w: 57, h: 18 } })],
      hasFourSideWarning: true,                  // Amazon 4-Seiten ban
    });
    const normal = mkPallet({
      id: 'P1-B2',
      items: [mkMixed({ title: 'Mixed thermo 57×40', units: 50, dim: { w: 57, h: 40 } })],
    });
    const esku = mkEsku({ title: 'ESKU thermo 57×30', cartons: 3, fnsku: 'EC1' });
    esku.dim = { w: 57, h: 30 };

    const r = distributeEinzelneSku([single, normal], [esku]);
    // Distributor must place on P1-B2 (normal), NOT P1-B1 (4-side).
    expect(r.byPalletId['P1-B1']).toHaveLength(0);
    expect(r.byPalletId['P1-B2'].length).toBeGreaterThan(0);
  });

  it('returns palletStates with weightKg / volCm3 / overloadFlags fields', () => {
    const p = mkPallet({
      id: 'P1-B1',
      items: [mkMixed({ title: 'Thermo 57×18', units: 50, dim: { w: 57, h: 18 } })],
    });
    const r = distributeEinzelneSku([p], []);
    const state = r.palletStates['P1-B1'];
    expect(state).toBeDefined();
    expect(state.weightKg).toBeGreaterThanOrEqual(0);
    expect(state.volCm3).toBeGreaterThanOrEqual(0);
    expect(state.overloadFlags).toBeInstanceOf(Set);
  });

  it('exposes overloadCount + noValidCount summary', () => {
    const r = distributeEinzelneSku(
      [mkPallet({ id: 'P1-B1' })],
      [mkEsku({ title: 'ESKU 1', cartons: 1 })],
    );
    expect(typeof r.overloadCount).toBe('number');
    expect(typeof r.noValidCount).toBe('number');
  });

  it('Klebeband-ESKU exception — L4 ESKU can land on a pallet that holds L5 Produktion', () => {
    // Pallet pre-populated with a Mixed Produktion item (L5). Without the
    // exception, the L4 Klebeband ESKU would fail violatesLevelOrder
    // and end up flagged as NO_VALID_PLACEMENT.
    const p = mkPallet({
      id: 'P1-B1',
      items: [mkMixed({ title: 'Sandsack 50x bedruckt', units: 5 })],
    });
    const esku = mkEsku({ title: 'Klebeband 50m × 36 Pack', cartons: 2, fnsku: 'KB1' });
    const r = distributeEinzelneSku([p], [esku]);
    expect(r.byPalletId['P1-B1'].length).toBeGreaterThan(0);
    expect(r.noValidCount).toBe(0);
  });

  it('Klebeband-ESKU exception does NOT bypass L6/L7 — Klebeband still blocked under Kernöl', () => {
    const p = mkPallet({
      id: 'P1-B1',
      items: [mkMixed({ title: 'Kürbiskernöl 1 L', units: 5 })],
    });
    const esku = mkEsku({ title: 'Klebeband 50m × 24 Pack', cartons: 2, fnsku: 'KB2' });
    const r = distributeEinzelneSku([p], [esku]);
    // Only one pallet, so it gets the carton even as "least bad" — but the
    // NO_VALID_PLACEMENT flag must be raised because L6 > L4 still violates.
    expect(r.noValidCount).toBeGreaterThan(0);
  });

  it('ESKU atomicity — 4 cartons of one FNSKU land on a single pallet, never split', () => {
    // Two eligible empty pallets — splitting was the old behaviour. Atomic
    // placement parks the whole shipment on one (the least-filled) pallet.
    const p1 = mkPallet({ id: 'P1-B1' });
    const p2 = mkPallet({ id: 'P1-B2' });
    const esku = mkEsku({ title: 'Heipa 5505840703 Thermo (5 Stück) 58x64x12', cartons: 4, fnsku: 'Z2-F5FO-F995' });
    const r = distributeEinzelneSku([p1, p2], [esku]);
    const counts = [r.byPalletId['P1-B1'].length, r.byPalletId['P1-B2'].length];
    // Exactly one pallet receives the group, the other gets nothing.
    expect(counts.sort()).toEqual([0, 1]);
    // The receiving pallet's single entry carries ALL 4 cartons.
    const winnerEntries = [...r.byPalletId['P1-B1'], ...r.byPalletId['P1-B2']];
    expect(winnerEntries[0].placementMeta.cartonsHere).toBe(4);
    expect(winnerEntries[0].placementMeta.cartonsTotalGroup).toBe(4);
    // No SPLIT-GROUP flag.
    expect(winnerEntries[0].placementMeta.flags).not.toContain('SPLIT-GROUP');
  });

  it('balance-mode: empty pallet wins over filled format-match pallet (SOP 2026-05-15)', () => {
    // P1-B1: holds a 57x35 thermo AND matches the ESKU format.
    // P1-B2: empty.
    // New SOP — balance is primary; format-match is only a tie-breaker.
    // ESKU goes to the LESS-FILLED pallet (P1-B2), not the format-match pallet.
    const p1 = mkPallet({
      id: 'P1-B1',
      items: [mkMixed({ title: 'Mixed thermo 57×35', units: 30, dim: { w: 57, h: 35 }, rollen: 50, fnsku: 'F1' })],
    });
    const p2 = mkPallet({ id: 'P1-B2' });
    const esku = mkEsku({ title: 'ESKU thermo 57×35', cartons: 3, fnsku: 'EA' });
    esku.dim = { w: 57, h: 35 };
    esku.rollen = 50;
    const r = distributeEinzelneSku([p1, p2], [esku]);
    expect(r.byPalletId['P1-B2'].length).toBeGreaterThan(0);
    expect(r.byPalletId['P1-B1'].length).toBe(0);
  });

  it('under-filled pallet (<70%) relaxes H1-H4 — L1 ESKU goes on a pallet with L3 ÖKO', () => {
    // P1-B1: has L3 ÖKO Mixed item, fill stays well under 70% threshold.
    // Old H1-H4: 3 > 1 → L1 ESKU blocked → NO_VALID_PLACEMENT.
    // New rule: pallet fillPct < 70% → relaxed → L1 lands cleanly.
    const p1 = mkPallet({
      id: 'P1-B1',
      items: [mkMixed({ title: 'THERMALKING ÖKO Thermo 57×35', units: 20, dim: { w: 57, h: 35 }, rollen: 50, fnsku: 'O1' })],
    });
    const esku = mkEsku({ title: 'ESKU L1 thermo 57×35', cartons: 3, fnsku: 'EX' });
    esku.dim = { w: 57, h: 35 };
    esku.rollen = 50;
    const r = distributeEinzelneSku([p1], [esku]);
    expect(r.noValidCount).toBe(0);
    expect(r.byPalletId['P1-B1'].length).toBeGreaterThan(0);
  });

  it('L7 Tacho on a pallet does NOT block lower-level ESKU (SOP 2026-05-15 exception)', () => {
    // P1-B1: has L7 Tacho — under old H1-H4 this would block any L1-L4 ESKU.
    //        New rule: Tacho occupies a pallet corner, not a layer, so it
    //        doesn't block ESKU below.
    // P1-B2: empty.
    // ESKU is L1 Thermo (3 cartons). It MUST be eligible for both pallets.
    // Balance → least-filled (P1-B2) wins, but the key invariant is that
    // P1-B1 wasn't rejected by H1-H4 (otherwise no fallback would matter).
    const p1 = mkPallet({
      id: 'P1-B1',
      items: [mkMixed({ title: 'SWIPARO Tachorollen', units: 50, rollen: 15, fnsku: 'T1' })],
    });
    const p2 = mkPallet({ id: 'P1-B2' });
    const esku = mkEsku({ title: 'ESKU thermo 57×35', cartons: 3, fnsku: 'EA' });
    esku.dim = { w: 57, h: 35 };
    esku.rollen = 50;
    const r = distributeEinzelneSku([p1, p2], [esku]);
    // ESKU lands somewhere (NOT NO_VALID_PLACEMENT) — proves H1-H4 didn't block.
    expect(r.noValidCount).toBe(0);
    // Balance steers it to the empty pallet.
    expect(r.byPalletId['P1-B2'].length).toBeGreaterThan(0);
  });

  it('no format match → group lands on LEAST-FILLED pallet', () => {
    // P1-B1: has a thermo Mixed (some volume used), no format match for the ESKU.
    // P1-B2: empty.
    // Neither pallet matches the ESKU's format → least-filled (P1-B2) wins.
    const p1 = mkPallet({
      id: 'P1-B1',
      items: [mkMixed({ title: 'Mixed thermo 57×18', units: 80, dim: { w: 57, h: 18 }, rollen: 50, fnsku: 'F1' })],
    });
    const p2 = mkPallet({ id: 'P1-B2' });
    const esku = mkEsku({ title: 'ESKU different 80×80', cartons: 3, fnsku: 'EB' });
    esku.dim = { w: 80, h: 80 };
    esku.rollen = 20;
    const r = distributeEinzelneSku([p1, p2], [esku]);
    expect(r.byPalletId['P1-B2'].length).toBeGreaterThan(0);
    expect(r.byPalletId['P1-B1'].length).toBe(0);
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('applyEskuOverrides — manual ESKU rerouting', () => {
  function mkPallet({ id, items = [] as Array<Record<string, unknown>>, hasFourSideWarning = false }: { id: string; items?: Array<Record<string, unknown>>; hasFourSideWarning?: boolean }) {
    return { id, items, hasFourSideWarning };
  }

  it('no overrides → returns the same distribution unchanged', () => {
    const p1 = mkPallet({ id: 'P1-B1' });
    const p2 = mkPallet({ id: 'P1-B2' });
    const esku = mkEsku({ title: 'ESKU thermo 57×35', cartons: 3, fnsku: 'EA' });
    esku.dim = { w: 57, h: 35 }; esku.rollen = 50;
    const auto = distributeEinzelneSku([p1, p2], [esku]);
    const res = applyEskuOverrides(auto, {}, [p1, p2]);
    expect(res).toBe(auto);                          // same reference, no work
  });

  it('moves an ESKU group from its auto-target to a different pallet', () => {
    const p1 = mkPallet({ id: 'P1-B1' });
    const p2 = mkPallet({ id: 'P1-B2' });
    const esku = mkEsku({ title: 'ESKU thermo 57×35', cartons: 3, fnsku: 'EA' });
    esku.dim = { w: 57, h: 35 }; esku.rollen = 50;
    const auto = distributeEinzelneSku([p1, p2], [esku]);
    const autoPid = Object.keys(auto.byPalletId).find((id) => auto.byPalletId[id].length > 0)!;
    const otherPid = autoPid === 'P1-B1' ? 'P1-B2' : 'P1-B1';

    const key = eskuOverrideKey(esku);
    const moved = applyEskuOverrides(auto, { [key]: otherPid }, [p1, p2]);
    expect(moved.byPalletId[otherPid].length).toBe(1);
    expect(moved.byPalletId[autoPid].length).toBe(0);
    expect(moved.byPalletId[otherPid][0].placementMeta.manualOverride).toBe(true);
    expect(moved.byPalletId[otherPid][0].placementMeta.autoTarget).toBe(autoPid);
    expect(moved.byPalletId[otherPid][0].placementMeta.flags).toContain('MANUAL-MOVE');
  });

  it('H7 — refuses to move ESKU onto a Single-SKU pallet (hasFourSideWarning)', () => {
    const single = mkPallet({
      id: 'P1-B1',
      items: [mkMixed({ title: 'Single-SKU thermo', units: 100, fnsku: 'M1' })],
      hasFourSideWarning: true,
    });
    const normal = mkPallet({ id: 'P1-B2' });
    const esku = mkEsku({ title: 'ESKU thermo 57×35', cartons: 3, fnsku: 'EA' });
    esku.dim = { w: 57, h: 35 }; esku.rollen = 50;
    const auto = distributeEinzelneSku([single, normal], [esku]);
    expect(auto.byPalletId['P1-B2'].length).toBe(1);     // sanity

    const key = eskuOverrideKey(esku);
    const res = applyEskuOverrides(auto, { [key]: 'P1-B1' }, [single, normal]);
    // Override rejected → distribution unchanged
    expect(res.byPalletId['P1-B1'].length).toBe(0);
    expect(res.byPalletId['P1-B2'].length).toBe(1);
  });

  it('unknown target palletId → override ignored', () => {
    const p1 = mkPallet({ id: 'P1-B1' });
    const p2 = mkPallet({ id: 'P1-B2' });
    const esku = mkEsku({ title: 'ESKU thermo', cartons: 2, fnsku: 'EA' });
    esku.dim = { w: 57, h: 35 }; esku.rollen = 50;
    const auto = distributeEinzelneSku([p1, p2], [esku]);
    const key = eskuOverrideKey(esku);
    const res = applyEskuOverrides(auto, { [key]: 'NOPE' }, [p1, p2]);
    expect(res.byPalletId).toEqual(auto.byPalletId);
  });

  it('recomputes palletStates after a move (target gets the ESKU vol/weight)', () => {
    const p1 = mkPallet({ id: 'P1-B1' });
    const p2 = mkPallet({ id: 'P1-B2' });
    const esku = mkEsku({ title: 'ESKU thermo 57×35', cartons: 5, fnsku: 'EA' });
    esku.dim = { w: 57, h: 35 }; esku.rollen = 50;
    const auto = distributeEinzelneSku([p1, p2], [esku]);
    const autoPid = Object.keys(auto.byPalletId).find((id) => auto.byPalletId[id].length > 0)!;
    const otherPid = autoPid === 'P1-B1' ? 'P1-B2' : 'P1-B1';
    expect(auto.palletStates[autoPid].volCm3).toBeGreaterThan(0);
    expect(auto.palletStates[otherPid].volCm3).toBe(0);

    const key = eskuOverrideKey(esku);
    const moved = applyEskuOverrides(auto, { [key]: otherPid }, [p1, p2]);
    expect(moved.palletStates[otherPid].volCm3).toBeGreaterThan(0);
    expect(moved.palletStates[autoPid].volCm3).toBe(0);
  });

  it('no-op when override targets the already-assigned pallet', () => {
    const p1 = mkPallet({ id: 'P1-B1' });
    const p2 = mkPallet({ id: 'P1-B2' });
    const esku = mkEsku({ title: 'ESKU thermo', cartons: 2, fnsku: 'EA' });
    esku.dim = { w: 57, h: 35 }; esku.rollen = 50;
    const auto = distributeEinzelneSku([p1, p2], [esku]);
    const autoTarget = Object.keys(auto.byPalletId).find((id) => auto.byPalletId[id].length > 0)!;
    const key = eskuOverrideKey(esku);
    const res = applyEskuOverrides(auto, { [key]: autoTarget }, [p1, p2]);
    expect(res).toBe(auto);
  });
});

/* ════════════════════════════════════════════════════════════════════ */
describe('itemTotalVolumeCm3 + itemTotalWeightKg', () => {
  it('returns positive volume for an item with rollen + dim', () => {
    const it = mkMixed({ title: 'Thermo 57×18', units: 10, dim: { w: 57, h: 18 }, rollen: 50 });
    const v = itemTotalVolumeCm3(it);
    expect(v).toBeGreaterThan(0);
  });

  it('weight of empty pallet items returns 0', () => {
    expect(itemTotalWeightKg(mkMixed({ title: 'x', units: 0 }))).toBe(0);
  });

  it('ESKU heuristic returns positive vol/weight when no dimensions row', () => {
    const it = mkEsku({ title: 'ESKU thermo 57×18', cartons: 5 });
    expect(itemTotalVolumeCm3(it)).toBeGreaterThan(0);
    expect(itemTotalWeightKg(it)).toBeGreaterThan(0);
  });

  it('thermal-roll volume uses 3D bounding-box (W × D × D), not flat cross-section', () => {
    // 57mm × 35mm × 12mm roll — bounding box per roll is W × D × D.
    // 50-roll Einheit must be roughly 50× that × packing slack ~1.30,
    // i.e. several thousand cm³ — not under a thousand.
    const it = mkMixed({
      title: 'Thermorolle 57×35×12',
      units: 1,
      dim: { w: 57, h: 35, normW: 57, normH: 35 },
      rollen: 50,
    });
    const v = itemTotalVolumeCm3(it);
    // 5.7 × 3.5 × 3.5 × 50 × 1.30 ≈ 4534 cm³ ± slack tolerance
    expect(v).toBeGreaterThan(3500);
    expect(v).toBeLessThan(6000);
  });

  it('"57mm × 14m × 12mm" maps roll length to diameter via dim.normH', () => {
    // Title encodes 14m roll-length; parser sets dim.h=14 (m) and
    // dim.normH=35 (real diameter). Heuristic must use normH so this
    // physical roll volume matches the 57×35 case.
    const lengthForm = mkMixed({
      title: 'Thermorolle 57×14m×12mm',
      units: 1,
      dim: { w: 57, h: 14, normW: 57, normH: 35 },
      rollen: 50,
    });
    const diameterForm = mkMixed({
      title: 'Thermorolle 57×35×12mm',
      units: 1,
      dim: { w: 57, h: 35, normW: 57, normH: 35 },
      rollen: 50,
    });
    expect(itemTotalVolumeCm3(lengthForm)).toBeCloseTo(itemTotalVolumeCm3(diameterForm), 0);
  });

  it('heavy thermal-roll pallet (350 × 50-roll Einheiten) reaches near-full fill', () => {
    // Mirrors P1-B3 from a real Lagerauftrag — two L1 articles totalling
    // 350 Einheiten of 50-roll boxes. Previously rendered ~22% fill
    // (heuristic bug). Should now read close to 1.0.
    const PALLET_VOL_CM3 = 1.59 * 1e6;
    const a = mkMixed({
      title: 'THERMALKING 57×35×12 (50 Stk)',
      units: 100,
      dim: { w: 57, h: 35, normW: 57, normH: 35 },
      rollen: 50,
    });
    const b = mkMixed({
      title: 'ECO ROOLLS 57×35×12 (50 Stk)',
      units: 250,
      dim: { w: 57, h: 35, normW: 57, normH: 35 },
      rollen: 50,
    });
    const totalVol = itemTotalVolumeCm3(a) + itemTotalVolumeCm3(b);
    const fill = totalVol / PALLET_VOL_CM3;
    expect(fill).toBeGreaterThan(0.85);    // realistic full-pallet read
    expect(fill).toBeLessThan(1.20);       // not absurdly past capacity
  });
});