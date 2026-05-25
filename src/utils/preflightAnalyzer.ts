// @ts-nocheck — incremental TS migration: file renamed, strict typing pending
/* ─────────────────────────────────────────────────────────────────────────
   Pre-flight Auftrag analyzer — pure synchronous rule-based analysis that
   surfaces parsing / capacity / structural / coverage issues BEFORE the
   warehouse worker dives into Pruefen.

   Goal: every issue the operator would hit 30–60 seconds later (overloaded
   pallet, missing dimensions, header-vs-summed-units mismatch, dominant
   level skewing the heuristic weight) gets surfaced upfront in one card,
   each with a concrete target (palletId) and an action.

   Design constraints:
     • Pure function — no React, no fetch, no side effects.
     • Synchronous — runs after parser + dimensions enrichment + Phase-2
       distribution have all completed (already memoized in Pruefen).
     • Severity-driven — every flag carries 'error' | 'warn' | 'info' so
       the UI can collapse / expand / colour without business logic.
     • Cheap to call — pre-flight Auftrag analyser will run on every
       memo recompute; O(items + pallets) is fine, anything slower is not.
   ───────────────────────────────────────────────────────────────────────── */

import { LEVEL_META, getDisplayLevel } from './auftragHelpers.js';

const PALLET_VOL_M3        = 1.59;
const PALLET_VOL_CM3       = PALLET_VOL_M3 * 1e6;
const PALLET_WEIGHT_KG     = 700;
const NEAR_OVERLOAD_PCT    = 0.95;
const DOMINANT_LEVEL_PCT   = 0.70;
const COVERAGE_WARN_PCT    = 0.20;
const HIGH_ESKU_GROUP_HINT = 3;

/**
 * @typedef {Object} Flag
 * @property {'parsing'|'capacity'|'distribution'|'coverage'|'structural'} kind
 * @property {'error'|'warn'|'info'} severity
 * @property {string} code        — stable machine ID (UPPER_SNAKE)
 * @property {string} message     — human-readable, German UI copy
 * @property {{ palletId?: string, itemKey?: string }} target
 * @property {string} [actionLabel]
 * @property {string} [actionHref]
 */

/**
 * @typedef {Object} PreflightBriefing
 * @property {{ palletCount, itemCount, units, eskuGroupCount, eskuItemCount, fourSideCount }} totals
 * @property {Flag[]} flags
 * @property {{ byPallet, summary }} forecast
 * @property {{ totalDistinct, missingDims, missingPct, topMissing }} coverage
 * @property {'ok'|'warn'|'error'} worst
 */

/**
 * Analyze a parsed Auftrag and return a one-shot briefing for the UI.
 *
 * @param {Object} input
 * @param {Object} input.parsed                — output of parseLagerauftragText
 * @param {Object} [input.validation]          — output of validateParsing
 * @param {Object} [input.distribution]        — output of distributeEinzelneSku
 * @param {Array}  [input.enrichedPallets]     — pallets[] with .items containing dim data
 * @param {Array}  [input.enrichedEsku]        — ESKU items with dim data
 * @returns {PreflightBriefing}
 */
export function analyzeAuftrag(input) {
  const safe = input || {};
  const parsed = safe.parsed || { pallets: [], einzelneSkuItems: [] };

  const totals   = computeTotals(parsed);
  const forecast = computeForecast(safe.distribution);
  const coverage = computeCoverage(safe.enrichedPallets, safe.enrichedEsku);

  const flags = [];

  // A. Parsing — pass through validateParsing's issues 1:1
  pushParsingFlags(flags, safe.validation);

  // B. Structural — dominant-level + 4-Seiten + ESKU group count
  pushStructuralFlags(flags, parsed, totals);

  // C. Capacity / distribution — uses the already-computed pallet states
  pushCapacityFlags(flags, safe.distribution);

  // D. Coverage — sku_dimensions gaps
  pushCoverageFlags(flags, coverage);

  // Stable ordering: severity (error → warn → info), then by kind, then by code
  flags.sort(byFlagOrder);

  return {
    totals,
    flags,
    forecast,
    coverage,
    worst: worstSeverity(flags),
  };
}

/* ─── Severity helpers ─────────────────────────────────────────────────── */
const SEV_RANK = { error: 0, warn: 1, info: 2 };
const KIND_RANK = { parsing: 0, capacity: 1, distribution: 1, coverage: 2, structural: 3 };
function byFlagOrder(a, b) {
  const sa = SEV_RANK[a.severity] ?? 9;
  const sb = SEV_RANK[b.severity] ?? 9;
  if (sa !== sb) return sa - sb;
  const ka = KIND_RANK[a.kind] ?? 9;
  const kb = KIND_RANK[b.kind] ?? 9;
  if (ka !== kb) return ka - kb;
  return (a.code || '').localeCompare(b.code || '');
}
function worstSeverity(flags) {
  if (flags.some((f) => f.severity === 'error')) return 'error';
  if (flags.some((f) => f.severity === 'warn')) return 'warn';
  return 'ok';
}

/* ─── Totals ───────────────────────────────────────────────────────────── */
function computeTotals(parsed) {
  const pallets = parsed?.pallets || [];
  const eskuItems = parsed?.einzelneSkuItems || [];
  const palletItemCount = pallets.reduce((n, p) => n + (p.items?.length || 0), 0);
  const palletUnits = pallets.reduce(
    (n, p) => n + (p.items || []).reduce((s, it) => s + (it.units || 0), 0),
    0,
  );
  const eskuUnits = eskuItems.reduce((s, it) => s + (it.units || 0), 0);

  const eskuKeys = new Set();
  for (const it of eskuItems) eskuKeys.add(it.fnsku || it.sku || it.title);

  return {
    palletCount:    pallets.length,
    itemCount:      palletItemCount + eskuItems.length,
    units:          palletUnits + eskuUnits,
    eskuItemCount:  eskuItems.length,
    eskuGroupCount: eskuKeys.size,
    fourSideCount:  pallets.filter((p) => p.hasFourSideWarning).length,
  };
}

/* ─── A. Parsing ───────────────────────────────────────────────────────── */
function pushParsingFlags(flags, validation) {
  if (!validation?.issues?.length) return;
  for (const it of validation.issues) {
    flags.push({
      kind: 'parsing',
      severity: it.severity || 'warn',
      code: kindToCode(it.kind),
      message: it.msg || 'Parsing-Auffälligkeit',
      target: it.palletId ? { palletId: it.palletId } : {},
    });
  }
}
function kindToCode(kind) {
  if (!kind) return 'PARSING_ISSUE';
  return String(kind).toUpperCase().replace(/-/g, '_');
}

/* ─── B. Structural ────────────────────────────────────────────────────── */
function pushStructuralFlags(flags, parsed, totals) {
  // Dominant level — heuristic weight gets compounded if 70%+ of all units
  // share one level (especially L4 where heuristic ≈ 0.5 kg per Einheit).
  if (totals.units > 0 && parsed?.pallets?.length) {
    const byLevel = {};
    for (const p of parsed.pallets) {
      for (const it of p.items || []) {
        const lvl = getDisplayLevel(it);
        byLevel[lvl] = (byLevel[lvl] || 0) + (it.units || 0);
      }
    }
    const top = Object.entries(byLevel).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] / totals.units >= DOMINANT_LEVEL_PCT) {
      const lvl = parseInt(top[0], 10);
      const meta = LEVEL_META[lvl] || {};
      const pct = Math.round((100 * top[1]) / totals.units);
      flags.push({
        kind: 'structural',
        severity: 'info',
        code: 'DOMINANT_LEVEL',
        message: `${pct}% aller Einheiten sind L${lvl} ${meta.shortName || ''} — heuristisches Gewicht kann verzerrt sein, sku_dimensions prüfen.`,
        target: {},
        actionLabel: 'sku_dimensions Admin',
        actionHref: '/admin?tab=dimensions',
      });
    }
  }

  // Single-SKU pallets (4-Seiten-Warnung) — strict: ESKU MUST NOT be assigned.
  if (totals.fourSideCount > 0) {
    const ids = (parsed.pallets || [])
      .filter((p) => p.hasFourSideWarning)
      .map((p) => p.id);
    const head = ids.slice(0, 3).join(', ') + (ids.length > 3 ? ` +${ids.length - 3}` : '');
    flags.push({
      kind: 'structural',
      severity: 'info',
      code: 'SINGLE_SKU_PALLET',
      message: `${totals.fourSideCount} Single-SKU-Palette(n) (${head}) — 4-Seiten-Warnung aktiv, keine ESKU.`,
      target: ids.length === 1 ? { palletId: ids[0] } : {},
    });
  }

  // ESKU group density — purely informational, no action.
  if (totals.eskuGroupCount >= HIGH_ESKU_GROUP_HINT) {
    flags.push({
      kind: 'structural',
      severity: 'info',
      code: 'HIGH_ESKU_DENSITY',
      message: `${totals.eskuGroupCount} ESKU-Gruppen — Phase-2-Verteilung kann SPLIT-GROUP-Flags auslösen.`,
      target: {},
    });
  }
}

/* ─── C. Capacity / distribution ──────────────────────────────────────── */
function computeForecast(distribution) {
  const out = {
    byPallet: {},
    summary: { overloadPallets: 0, overloadCount: 0, noValidCount: 0 },
  };
  if (!distribution?.palletStates) return out;

  for (const [pid, ps] of Object.entries(distribution.palletStates)) {
    out.byPallet[pid] = {
      weightKg:   ps.weightKg ?? 0,
      volumeM3:   (ps.volCm3 ?? 0) / 1e6,
      weightPct:  (ps.weightKg ?? 0) / PALLET_WEIGHT_KG,
      volumePct:  (ps.volCm3 ?? 0) / PALLET_VOL_CM3,
      capacityFraction:
        typeof ps.capacityFraction === 'function' ? ps.capacityFraction() : 0,
      overloadFlags: Array.from(ps.overloadFlags || []),
      fillPct: ps.fillPct ?? 0,
    };
  }
  out.summary.overloadPallets = distribution.overloadedPalletCount || 0;
  out.summary.overloadCount   = distribution.overloadCount || 0;
  out.summary.noValidCount    = distribution.noValidCount || 0;
  return out;
}

function pushCapacityFlags(flags, distribution) {
  if (!distribution?.palletStates) return;

  for (const [pid, ps] of Object.entries(distribution.palletStates)) {
    const overloads = Array.from(ps.overloadFlags || []);
    const wPct = (ps.weightKg ?? 0) / PALLET_WEIGHT_KG;
    const vPct = (ps.volCm3 ?? 0) / PALLET_VOL_CM3;

    if (overloads.length > 0) {
      flags.push({
        kind: 'capacity',
        severity: 'error',
        code: 'PREDICTED_OVERLOAD',
        message: `${pid}: ${overloads.join(', ')} — Soft-Limit überschritten (${Math.round((ps.volCm3 || 0) / 1e4) / 100} m³ / ${Math.round(ps.weightKg || 0)} kg).`,
        target: { palletId: pid },
      });
    } else {
      // Near-limit warnings — only when the pallet is actually almost full,
      // not when fill% is high because of one heavy item with bad heuristic.
      if (vPct >= NEAR_OVERLOAD_PCT) {
        flags.push({
          kind: 'capacity',
          severity: 'warn',
          code: 'NEAR_OVERLOAD_V',
          message: `${pid}: Volumen ${Math.round(vPct * 100)}% (${(ps.volCm3 / 1e6).toFixed(2)} m³) — knapp am 1.59 m³ Soft-Limit.`,
          target: { palletId: pid },
        });
      }
      // No NEAR_OVERLOAD_W warning — user explicitly wants silence until
      // the actual OVERLOAD-W triggers (weight > 705 kg with tolerance).
      // The 95% near-limit warning at ~665 kg was too noisy for normal
      // operation; OVERLOAD-W is the only weight signal the worker sees.
    }
  }

  // Red flag is reserved for ESKU that ended up on NO pallet at all
  // (the priority is: lose nothing). NO_VALID_PLACEMENT means the
  // distributor still routed the carton to a least-bad pallet — that's
  // a soft escalation, not a loss.
  const unassignedCount = distribution.unassigned?.length || 0;
  if (unassignedCount > 0) {
    flags.push({
      kind: 'distribution',
      severity: 'error',
      code: 'ESKU_UNASSIGNED',
      message: `${unassignedCount} ESKU-Karton(s) konnten auf KEINER Palette platziert werden — manuelle Zuordnung erforderlich.`,
      target: {},
    });
  }
}

/* ─── D. Coverage (sku_dimensions gaps) ───────────────────────────────── */
function computeCoverage(enrichedPallets, enrichedEsku) {
  const empty = { totalDistinct: 0, missingDims: 0, missingPct: 0, topMissing: [] };
  const allItems = [
    ...(enrichedPallets || []).flatMap((p) => p.items || []),
    ...(enrichedEsku || []),
  ];
  if (allItems.length === 0) return empty;

  // Group by FNSKU || SKU || title — any single instance with dims counts.
  const byKey = new Map();
  for (const it of allItems) {
    const key = it.fnsku || it.sku || it.title || '_unknown';
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        title: it.title || it.sku || it.fnsku || '—',
        hasDims: false,
        units: 0,
      });
    }
    const slot = byKey.get(key);
    if (it.hasDimensions || it.dimensions) slot.hasDims = true;
    slot.units += it.units || 0;
  }

  const totalDistinct = byKey.size;
  const missing = [...byKey.values()].filter((s) => !s.hasDims);
  const missingDims = missing.length;
  const missingPct = totalDistinct > 0 ? missingDims / totalDistinct : 0;
  const topMissing = missing
    .sort((a, b) => b.units - a.units)
    .slice(0, 5)
    .map((s) => ({ label: shortenTitle(s.title), key: s.key, units: s.units }));

  return { totalDistinct, missingDims, missingPct, topMissing };
}

function pushCoverageFlags(flags, coverage) {
  if (coverage.totalDistinct === 0) return;
  if (coverage.missingPct < COVERAGE_WARN_PCT) return;
  const labels = coverage.topMissing.map((m) => m.label).join(', ');
  flags.push({
    kind: 'coverage',
    severity: 'warn',
    code: 'MISSING_DIMS',
    message: `${coverage.missingDims} von ${coverage.totalDistinct} Artikeln ohne sku_dimensions — Gewichts-/Volumen-Schätzung verlässt sich auf Heuristik. Top: ${labels}.`,
    target: {},
    actionLabel: 'Admin · Dimensions',
    actionHref: '/admin?tab=dimensions',
  });
}

function shortenTitle(title) {
  const s = String(title || '').trim();
  return s.length > 36 ? s.slice(0, 33) + '…' : s;
}