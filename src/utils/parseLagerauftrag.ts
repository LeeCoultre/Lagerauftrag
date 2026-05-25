/* eslint-disable no-irregular-whitespace */
/* ─────────────────────────────────────────────────────────────────────────
   Lagerauftrag parsing — pure functions, testable in Node.

   NOTE: the file contains intentional NBSP (U+00A0) and other
   invisible whitespace — .docx files emit them and the parser MUST
   match literally. eslint's irregular-whitespace rule is disabled
   above for that reason.

   Two formats supported:
     - "standard"  Lagerauftrag with PALETTE markers + tab-separated rows
     - "schilder"  per-carton Schilder (signage) docs without pallet markers

   The detector picks one based on header keywords; both formats expose the
   same shape: { format, meta, pallets, einzelneSkuItems, schilderItems? }.

   Heights config — inner/outer roll diameter equivalence used to normalise
   parsed heights to a canonical bucket. Static for now.
   ───────────────────────────────────────────────────────────────────────── */

/* ── Heights config ─────────────────────────────────────────────────────── */
const DEFAULT_HEIGHTS = [
  { from: 9, to: 30 },
  { from: 14, to: 35 },
  { from: 18, to: 40 },
];
export function normalizeHeight(h) {
  if (h == null) return h;
  for (const e of DEFAULT_HEIGHTS) if (e.from === h || e.to === h) return e.to;
  return h;
}

/* ── Code type / classification ─────────────────────────────────────────── */
export function detectCodeType(fnsku) {
  if (!fnsku) return 'OTHER';
  if (/^X001/i.test(fnsku)) return 'X001';
  if (/^X002/i.test(fnsku)) return 'X002';
  if (/^X000/i.test(fnsku)) return 'X000';
  if (/^B0/i.test(fnsku) || /^BO/i.test(fnsku)) return 'B0';
  return 'OTHER';
}

/* ── Strict field classifiers + cross-field validation ──────────────────
   These are the single source of truth for "what kind of value is
   this?" — used by extractors to detect column drift, mismatched
   FNSKU↔ASIN pairings, and ambiguous integers that might be Menge OR
   Karton-Nr OR a fragment of an EAN.

   FNSKU and ASIN share `X.../B0...` prefix space but are length- and
   prefix-locked. EAN-13 carries an algorithmic check digit — typos
   are caught with > 99% probability by isValidEAN13().

   Returns:
     'fnsku'   X + 9 alphanum   (e.g. X001BVO9LV)
     'asin'    B0 + 8 alphanum  (e.g. B07ABCD123)
     'sku'     Merchant SKU     (e.g. 7W-DM3L-8Z3Y)
     'ean'     EAN-13 with valid check digit
     'decimal' \d+[.,]\d+        (likely Gewicht)
     'integer' \d+               (Menge / Karton-Nr / Index)
     'text'    everything else
*/
export const FIELD_PATTERNS = {
  fnsku:  /^X[0-9][A-Z0-9]{8}$/i,
  asin:   /^B0[A-Z0-9]{8}$/i,
  sku:    /^[A-Z0-9]{2,4}-[A-Z0-9]{4,6}-[A-Z0-9]{4,6}$/i,
  ean13:  /^\d{13}$/,
  ean8:   /^\d{8}$/,
  upc:    /^\d{12}$/,
};

export function isValidEAN13(s: string): boolean {
  if (!FIELD_PATTERNS.ean13.test(s)) return false;
  const digits = s.split('').map((c) => parseInt(c, 10));
  /* Standard EAN-13 weighted checksum: even-index digits ×1, odd ×3,
     sum, take mod 10, complement to next multiple of 10 = 13th digit. */
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += digits[i] * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return check === digits[12];
}

export function isValidEAN8(s: string): boolean {
  if (!FIELD_PATTERNS.ean8.test(s)) return false;
  const digits = s.split('').map((c) => parseInt(c, 10));
  /* EAN-8 weighting is OPPOSITE of EAN-13: odd-index digits ×3, even ×1.
     Sum first 7, mod 10, complement → 8th digit. */
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += digits[i] * (i % 2 === 0 ? 3 : 1);
  const check = (10 - (sum % 10)) % 10;
  return check === digits[7];
}

export function isValidUPC(s: string): boolean {
  if (!FIELD_PATTERNS.upc.test(s)) return false;
  const digits = s.split('').map((c) => parseInt(c, 10));
  /* UPC-A: 12 digits, weighting odd ×3, even ×1 over first 11, mod 10,
     complement = 12th digit. */
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += digits[i] * (i % 2 === 0 ? 3 : 1);
  const check = (10 - (sum % 10)) % 10;
  return check === digits[11];
}

export type FieldKind =
  | 'fnsku' | 'asin' | 'sku' | 'ean'
  | 'decimal' | 'integer' | 'text' | 'empty';

export function classifyField(value: string): FieldKind {
  if (value == null) return 'empty';
  const v = String(value).trim();
  if (!v) return 'empty';
  if (FIELD_PATTERNS.fnsku.test(v)) return 'fnsku';
  if (FIELD_PATTERNS.asin.test(v))  return 'asin';
  if (FIELD_PATTERNS.sku.test(v))   return 'sku';
  if (FIELD_PATTERNS.ean13.test(v) && isValidEAN13(v)) return 'ean';
  if (FIELD_PATTERNS.ean8.test(v))  return 'ean';
  if (/^\d+[.,]\d+$/.test(v)) return 'decimal';
  if (/^\d+$/.test(v))        return 'integer';
  return 'text';
}

/* ── ParseWarning infrastructure ────────────────────────────────────────
   Every item that survives parsing carries `parseWarnings[]`. A warning
   never blocks: the parser still records its best-guess value so the
   workflow remains traversable, but the UI surfaces a yellow / red strip
   in Pruefen so the worker reviews before Focus.

   severity:
     'low'    informational — parser self-corrected (e.g. fnsku was in
              the wrong column but a valid candidate was found elsewhere)
     'medium' value accepted but suspicious — manual glance recommended
     'high'   value missing or ambiguous — manual confirmation required
              before the Auftrag can move to Focus
*/
export type ParseWarningField =
  | 'fnsku' | 'units' | 'useItem' | 'sku' | 'ean' | 'asin'
  | 'dim' | 'rollen' | 'achtung' | 'general';
export type ParseWarningSeverity = 'low' | 'medium' | 'high';
export interface ParseWarning {
  field: ParseWarningField;
  severity: ParseWarningSeverity;
  reason: string;
  original?: string;
  corrected?: string;
  candidates?: string[];
}

export function parseTitleMeta(title) {
  if (!title) return { dimStr: null, rollen: null, dim: null };
  const cleanTitle = title.replace(/\s+/g, ' ').trim();
  // Two-step dim extraction:
  //   1) Prefer the parenthetical "(… W×OD×ID …)" triple — canonical
  //      product spec form, e.g. "(Medium - 80x63x12 - 50 Meter -
  //      50 Rollen)". Take W × OD (first two of the triple). This
  //      avoids misreading the title's leading "80mm x 50m x 12mm"
  //      where the second number is LENGTH-in-meters, not diameter.
  //   2) Fall back to the first W×H pair anywhere in the title.
  //      A leading Ø on the second dimension is tolerated — bond-roll
  //      titles spell the diameter as "80mm x Ø80mm x 12mm". Without
  //      the optional Ø the regex would skip the middle group and
  //      return "80 × 12" (width × thickness) instead of "80 × 80".
  let rawW: number | null = null;
  let rawH: number | null = null;
  const tripleParen = cleanTitle.match(/\(\s*[^()]*?(\d+)\s*[xх×]\s*(\d+)\s*[xх×]\s*\d+/i);
  if (tripleParen) {
    rawW = parseInt(tripleParen[1], 10);
    rawH = parseInt(tripleParen[2], 10);
  }
  if (rawW == null) {
    const dimMatch = cleanTitle.match(/(\d+)\s*(?:mm)?\s*[xх×]\s*Ø?\s*(\d+)/i);
    if (dimMatch) {
      rawW = parseInt(dimMatch[1], 10);
      rawH = parseInt(dimMatch[2], 10);
    }
  }
  const dimStr = rawW != null ? `${rawW} × ${rawH}` : null;
  const normH = normalizeHeight(rawH);
  const dim = rawW != null ? { w: rawW, h: rawH, normH, normW: rawW } : null;
  // Rolls-per-Einheit detection. Three patterns, tried in order:
  //   (a) Explicit count anywhere in the title: "50 Rollen" / "10 Stk" /
  //       "(50 Stück)" — the strongest signal.
  //   (b) Brand-sandwiched count before product type, e.g.
  //       "Heipa 50 EC Thermorollen" / "Brand 20 EC-Cash …". Suppliers
  //       like Heipa write count between the brand and "EC" without a
  //       Stk/Rollen suffix, so (a) misses it. Caps at 500 to reject
  //       dimension fragments.
  //   (c) Leading multiplier prefix: "50 EC-Cash Thermorollen…" /
  //       "10x Thermorollen…" — common when the count is the very
  //       first token.
  let rollen: number | null = null;
  const explicit = cleanTitle.match(/(\d+)\s*(?:Stck|Stk|Rollen|Rolls|Stück|Pcs|Pieces|er[\s-]+Pack)\b\.?/i);
  if (explicit) rollen = parseInt(explicit[1], 10);
  if (rollen == null) {
    const ec = cleanTitle.match(/\b(\d{1,3})\s+EC(?:[-\s]?Cash)?\b/i);
    if (ec) {
      const n = parseInt(ec[1], 10);
      if (n > 0 && n <= 500) rollen = n;
    }
  }
  if (rollen == null) {
    const lead = cleanTitle.match(/^(\d+)\s*[xх×]?\s+(?=\D)/);
    if (lead) {
      const n = parseInt(lead[1], 10);
      // Reject obviously-not-a-count prefixes (e.g. zip codes, years,
      // SKUs that start with digits). Pack counts are at most a few
      // hundred; anything bigger almost certainly isn't a multiplier.
      if (n > 0 && n <= 500) rollen = n;
    }
  }
  return { dimStr, rollen, dim };
}

export function classifyItem(title) {
  const t = (title || '').toLowerCase();
  const isTacho = /tachograph|tacho\b|fahrtenschreiber|dtco/i.test(t);
  // Klebeband is its own physical level (sits BELOW Produktion in the
  // stack), so split it out of isProduktion. Catch the same variants
  // getLevel recognises: klebeband, paketband, packband, absperrband.
  const isKlebeband = /klebeband|paketband|packband|absperrband/i.test(t);
  const isProduktion =
    !isKlebeband &&
    /big\s*bag|silosack|sandsack|säcke|bauschutt|holzsack|holzwolle|füllmaterial|kürbiskern/i.test(t);
  const isVeit = /\bveit\b/i.test(t);
  const isHeipa = /\bheipa\b/i.test(t);
  const isThermo =
    !isTacho &&
    !isProduktion &&
    !isKlebeband &&
    !isVeit &&
    !isHeipa &&
    /thermorollen|thermopapier|thermal|kassenrollen|bonrollen|cash\s*roll|ec[-\s]*cash|swiparo|eco\s*roolls/i.test(t);

  let category = 'sonstige';
  if (isThermo) category = 'thermorollen';
  else if (isHeipa) category = 'heipa';
  else if (isVeit) category = 'veit';
  else if (isTacho) category = 'tachographenrollen';
  else if (isKlebeband) category = 'klebeband';
  else if (isProduktion) category = 'produktion';

  return { isThermo, isVeit, isHeipa, isTacho, isKlebeband, isProduktion, category };
}


/* ── Regex char classes ─────────────────────────────────────────────────── */
// All dash variants we've seen between P# and B# in pallet IDs
const DASH_CHARS = '\\-\\u2013\\u2014\\u2212';   // hyphen, en-dash, em-dash, minus
const DASH_RE = `[${DASH_CHARS}]`;
// Arrow / separator chars between pallet-prefix and SKU on item lines.
// Includes: à À, → ⇒ ➤, > 》, em/en-dash + >, plain ->/=>, segmented arrow 🡪
// We accept ANY non-word, non-space sequence — but require at least one
// printable non-ASCII or punctuation char to avoid greedy matches.
const ARROW_RE = '[^\\w\\s\\-]+';

/* ── Header / meta extraction ────────────────────────────────────────────
   mammoth represents table cells as "<label>\t<value>\n". We look for
   each label; the value continues until the next tab or newline. Robust
   to leading/trailing whitespace.
   ──────────────────────────────────────────────────────────────────────── */
function grabField(text, label, captureRe = '([^\\n\\t]+)') {
  // (?:^|\n) — anchor to a line start to avoid catching the same label
  // twice (e.g., "Sendungsnummer" appearing both at top and in a footer).
  const re = new RegExp(`(?:^|\\n)\\s*${label}\\s*[:\\t]\\s*${captureRe}`, 'i');
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

function parseMetaCommon(text) {
  const meta: Record<string, unknown> = {};
  const sn = grabField(text, 'Sendungsnummer');
  if (sn && sn !== 'KARTON NR.' && /[A-Z0-9]/i.test(sn)) meta.sendungsnummer = sn;
  const nn = grabField(text, 'Name');
  if (nn) meta.name = nn;
  const ln = grabField(text, 'Lieferanschrift');
  if (ln) meta.destination = ln;
  const sku = grabField(text, 'SKUs insgesamt', '(\\d+)');
  if (sku) meta.totalSkus = parseInt(sku, 10);
  const eh = grabField(text, 'Einheiten insgesamt', '(\\d+)');
  if (eh) meta.totalUnits = parseInt(eh, 10);

  if (typeof meta.name === 'string') {
    const dm = meta.name.match(
      /\((\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\s+(\d{1,2}):(\d{2})\)/
    );
    if (dm) {
      const [, dd, mm, yy, h, m] = dm;
      const yyyy = yy.length === 2 ? `20${yy}` : yy;
      meta.createdAtIso = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
      meta.createdDate = `${dd.padStart(2, '0')}.${mm.padStart(2, '0')}.${yyyy}`;
      meta.createdTime = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
    }
    const destMatch = (meta.name as string).match(/-([A-Z]{2,5}\d?)\s*$/);
    if (destMatch && !meta.destination) meta.destination = destMatch[1];
  }
  return meta;
}

/* ── Pallet header regex — handles all dash variants ───────────────────── */
function makePalletHeaderRe(global = true) {
  // PALETTE 1 - P1-B1   |   PALETTE 1 - P1 – B1   |   PALETTE 1 — P1-B1
  return new RegExp(
    `PALETTE\\s+(\\d+)\\s*${DASH_RE}\\s*(P\\d+\\s*${DASH_RE}\\s*B\\d+)`,
    global ? 'gi' : 'i'
  );
}

function normalizePalletId(rawId) {
  // Collapse any dash variant + surrounding spaces to ASCII "P#-B#"
  return rawId.replace(new RegExp(`\\s*${DASH_RE}\\s*`, 'g'), '-').toUpperCase();
}

/* ── Item-line regex ───────────────────────────────────────────────────── */
function makePalletItemRegex(palletId, opts: { anchorStart?: boolean; global?: boolean } = {}) {
  const { anchorStart = true, global = false } = opts;
  // palletId is normalized "P1-B1"; on item lines we accept the same with
  // any dash variant and any arrow / non-word separator before the SKU.
  // Item-line format: "P1-B1 <arrow> <SKU>\t<title>\t..."
  const m = String(palletId).match(/^([A-Z]+)(\d+)-(B\d+)$/i);
  if (!m) return null;
  const [, , num, b] = m;
  // Tolerate typos like "B1-B5" instead of "P1-B5" — match any [A-Z]+ prefix
  const head = `[A-Z]+${num}\\s*${DASH_RE}\\s*${b}`;
  const pattern = `${anchorStart ? '^' : ''}${head}\\s*${ARROW_RE}\\s*`;
  return new RegExp(pattern, global ? 'gi' : 'i');
}

/* If the first tab-delimited field still contains both SKU and title (some
   exports omit the tab between them and split with an arrow or space only),
   inject a tab so downstream column parsing stays in sync.
   Example: "VF-Z4DN-RFTL THERMALKING Thermorollen ..." → "VF-Z4DN-RFTL\tTHERMALKING Thermorollen ..." */
const SKU_PATTERN = '[A-Z0-9]{2,5}-[A-Z0-9]{4,6}-[A-Z0-9]{3,6}';
const SKU_HEAD_RE = new RegExp(`^(${SKU_PATTERN})\\s*(?:${ARROW_RE}\\s*)?(\\S.*)$`);
function fixGluedSkuTitle(line) {
  const tabIdx = line.indexOf('\t');
  if (tabIdx < 0) return line;
  const head = line.slice(0, tabIdx);
  // Only intervene when head obviously contains both SKU and prose (arrow,
  // bracket, parenthesis, asterisk, etc.). A bare SKU possibly followed by
  // trailing whitespace contains only word/space/hyphen — leave it alone.
  if (!/[^\w\s-]/.test(head)) return line;
  const m = head.match(SKU_HEAD_RE);
  if (!m) return line;
  const rest = line.slice(tabIdx);
  return `${m[1]}\t${m[2]}${rest}`;
}

/* ── Parse a single tab-separated item row, given the prefix is stripped ── */
function parseItemColumns(rest) {
  const normalized = fixGluedSkuTitle(rest);
  const parts = normalized.split('\t').map((s) => s.trim());
  if (parts.length < 5) return null;
  const sku = parts[0] || '';
  const title = (parts[1] || '').replace(/\s+/g, ' ').trim();
  const asin = parts[2] || '';
  const fnskuRaw = parts[3] || '';
  const codeCol = parts[4] || '';
  const condition = parts[5] || '';
  const prep = parts[6] || '';
  const prepTypeRaw = parts[7] || '';
  const labeler = parts[8] || '';
  const unitsRaw = parts[9] || '';

  const parseWarnings: ParseWarning[] = [];

  /* ── FNSKU — strict classification + drift detection.
     Column 3 SHOULD hold an X-prefix FNSKU. We treat the field with
     the following priority:
       1. parts[3] is 'fnsku' → keep, no warning.
       2. parts[3] is 'asin' but parts[2] is 'fnsku' → SWAP detected;
          take fnsku from parts[2], low warning.
       3. parts[3] is 'asin' alone → ASIN was placed in FNSKU slot
          (some rows do this when no FNSKU was assigned); keep but
          low warning so the worker is aware.
       4. parts[3] is anything else → scan whole row for any FNSKU.
          One match → low warning, multiple → high, none → high. */
  let fnsku = fnskuRaw;
  const fnskuKind = classifyField(fnskuRaw);
  const asinKind  = classifyField(asin);
  if (fnskuKind === 'fnsku') {
    /* canonical layout, nothing to do */
  } else if (fnskuKind === 'asin' && asinKind === 'fnsku') {
    /* swapped — use parts[2] as fnsku. */
    fnsku = asin;
    parseWarnings.push({
      field: 'fnsku',
      severity: 'low',
      reason: 'FNSKU und ASIN scheinen vertauscht — automatisch korrigiert',
      original: fnskuRaw,
      corrected: asin,
    });
  } else if (fnskuKind === 'asin') {
    parseWarnings.push({
      field: 'fnsku',
      severity: 'low',
      reason: 'ASIN statt FNSKU in der FNSKU-Spalte — bitte prüfen',
      original: fnskuRaw,
    });
  } else {
    /* parts[3] is neither fnsku nor asin — drift or missing. */
    const candidates = parts.filter((p) => classifyField(p) === 'fnsku');
    if (candidates.length === 1) {
      fnsku = candidates[0];
      parseWarnings.push({
        field: 'fnsku',
        severity: 'low',
        reason: 'FNSKU stand in unerwarteter Spalte — automatisch korrigiert',
        original: fnskuRaw,
        corrected: candidates[0],
      });
    } else if (candidates.length > 1) {
      fnsku = candidates[0];
      parseWarnings.push({
        field: 'fnsku',
        severity: 'high',
        reason: 'Mehrere FNSKU-Kandidaten in der Zeile — bitte prüfen',
        original: fnskuRaw,
        corrected: candidates[0],
        candidates,
      });
    } else if (fnskuRaw) {
      parseWarnings.push({
        field: 'fnsku',
        severity: 'high',
        reason: 'FNSKU passt zu keinem Muster (X… / B0…)',
        original: fnskuRaw,
      });
    } else {
      parseWarnings.push({
        field: 'fnsku',
        severity: 'high',
        reason: 'FNSKU fehlt komplett',
      });
    }
  }

  let ean = null, upc = null;
  const eanM = codeCol.match(/^EAN:\s*(.+)/i);
  const upcM = codeCol.match(/^UPC:\s*(.+)/i);
  if (eanM) ean = eanM[1].trim();
  else if (upcM) upc = upcM[1].trim();

  /* ── EAN check-digit validation — typo detection (>99% catch rate).
     EAN-13 + EAN-8 share the EAN column; UPC-A lives in upc when
     codeCol starts with "UPC:". All three use the same family of
     weighted-mod-10 checksums (see helpers near line 70). */
  if (ean && FIELD_PATTERNS.ean13.test(ean) && !isValidEAN13(ean)) {
    parseWarnings.push({
      field: 'ean',
      severity: 'medium',
      reason: 'EAN-13 Prüfziffer stimmt nicht — Tippfehler möglich',
      original: ean,
    });
  }
  if (ean && FIELD_PATTERNS.ean8.test(ean) && !isValidEAN8(ean)) {
    parseWarnings.push({
      field: 'ean',
      severity: 'medium',
      reason: 'EAN-8 Prüfziffer stimmt nicht — Tippfehler möglich',
      original: ean,
    });
  }
  if (upc && FIELD_PATTERNS.upc.test(upc) && !isValidUPC(upc)) {
    parseWarnings.push({
      field: 'ean',
      severity: 'medium',
      reason: 'UPC-A Prüfziffer stimmt nicht — Tippfehler möglich',
      original: upc,
    });
  }

  /* ── Units — must be a plain integer in a plausible warehouse range
     AND not equal to a fragment of another field. parseInt() silently
     accepts "70abc" → 70; we reject those by requiring exact \d+. */
  let units = 0;
  if (classifyField(unitsRaw) === 'integer') {
    const n = parseInt(unitsRaw, 10);
    if (n >= 1 && n <= 9999) {
      units = n;
      /* Cross-check: the units value should not appear as a substring
         of the FNSKU or EAN — a sign that column drift fed us a
         fragment of a longer code. */
      const flat = `${fnsku}${ean || ''}${sku}`.replace(/\D/g, '');
      if (n >= 100 && flat.includes(String(n))) {
        parseWarnings.push({
          field: 'units',
          severity: 'medium',
          reason: `Menge ${n} kommt auch in FNSKU/EAN/SKU vor — bitte prüfen`,
          original: unitsRaw,
        });
      }
    } else {
      parseWarnings.push({
        field: 'units',
        severity: 'high',
        reason: `Menge ${n} ausserhalb plausibler Bereich (1–9999)`,
        original: unitsRaw,
      });
    }
  } else if (unitsRaw) {
    /* Non-integer in the units column — try to recover by finding the
       first plausible integer among the row's other parts that is
       NOT another field's value. */
    const fallbacks = parts.filter((p, i) => {
      if (i === 9) return false;             // skip the bad column itself
      if (!/^\d+$/.test(p)) return false;
      const n = parseInt(p, 10);
      return n >= 1 && n <= 9999 && String(n) !== fnsku && String(n) !== ean;
    });
    if (fallbacks.length === 1) {
      units = parseInt(fallbacks[0], 10);
      parseWarnings.push({
        field: 'units',
        severity: 'low',
        reason: 'Menge stand in unerwarteter Spalte — automatisch korrigiert',
        original: unitsRaw,
        corrected: fallbacks[0],
      });
    } else {
      parseWarnings.push({
        field: 'units',
        severity: 'high',
        reason: 'Menge nicht erkennbar — bitte manuell prüfen',
        original: unitsRaw,
        candidates: fallbacks,
      });
    }
  } else {
    parseWarnings.push({
      field: 'units',
      severity: 'high',
      reason: 'Menge fehlt',
    });
  }

  const prepType =
    prepTypeRaw === 'null' || prepTypeRaw === '"--"' || !prepTypeRaw
      ? null
      : prepTypeRaw;

  const { dimStr, rollen, dim } = parseTitleMeta(title);
  const cls = classifyItem(title);
  const codeType = detectCodeType(fnsku);

  /* Thermo items without parsed dim → heuristic volume bucket can't
     pick the right height. Warn so worker checks if the title is just
     missing the W×H or if this is a non-roll accessory mis-classified
     as thermo. Limited to true Thermo families (excludes Tacho/Veit/
     ÖKO accessories which have their own bucket models). */
  if (cls.isThermo && dim == null) {
    parseWarnings.push({
      field: 'dim',
      severity: 'medium',
      reason: 'Thermorolle ohne erkennbare Maße im Titel — Höhen-Bucket nicht zuverlässig',
    });
  }

  return {
    sku, title, asin, fnsku, ean, upc,
    condition, prep, prepType, labeler,
    units, useItem: null, // filled in by caller
    dimStr, rollen, dim,
    isThermo: cls.isThermo,
    isVeit: cls.isVeit,
    isHeipa: cls.isHeipa,
    isTacho: cls.isTacho,
    isKlebeband: cls.isKlebeband,
    isProduktion: cls.isProduktion,
    category: cls.category,
    codeType,
    parseWarnings,
  };
}

function parseItemsFromBlock(block, palletId) {
  const items: ReturnType<typeof parseItemColumns>[] = [];
  // Normalize NBSP and collapse stray spaces inside cells (but keep tabs).
  const lines = block.split('\n').map((l) => l.replace(/ /g, ' ').trim());
  const startRe = makePalletItemRegex(palletId);
  if (!startRe) return items;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!startRe.test(line)) continue;

    const rest = line.replace(startRe, '');
    const parsed = parseItemColumns(rest);
    if (!parsed) continue;

    // Look forward for "Zu verwendender Artikel" until the next item starts
    // or until the next pallet header.
    let useItemFound = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (startRe.test(lines[j])) break;
      if (/^PALETTE\s+\d+/i.test(lines[j])) break;
      const um = lines[j].match(/^Zu\s+verwendender\s+Artikel\s*[:：]?\s*(.+)/i);
      if (um) {
        useItemFound = true;
        /* IMPORTANT: keep the RAW rest-of-line (incl. wrappers like
           "wird von 9120107187501 produziert") as `useItem`. The
           display layer in focusItemView() intentionally renders this
           wrapper text. The bare code is recovered downstream via
           extractUseItemId() which strips the wrapper.

           Validation here only attaches warnings — it never mutates
           the raw value. */
        const rest = um[1].trim();
        parsed.useItem = rest;
        const tokens = rest.split(/[\s,;|()]+/).filter(Boolean);
        const validCodes = tokens.filter((t) => {
          const k = classifyField(t);
          if (k === 'ean' || k === 'fnsku' || k === 'asin' || k === 'sku') return true;
          // Short numeric internal warehouse codes (e.g. Klebeband "41")
          // are valid useItem references regardless of the host item's category.
          if (k === 'integer' && t.length <= 6) return true;
          return false;
        });
        if (validCodes.length > 1) {
          parsed.parseWarnings.push({
            field: 'useItem',
            severity: 'medium',
            reason: 'Mehrere Codes in "Zu verwendender Artikel"-Zeile gefunden',
            original: rest,
            candidates: validCodes,
          });
        } else if (validCodes.length === 0 && rest) {
          parsed.parseWarnings.push({
            field: 'useItem',
            severity: 'high',
            reason: 'Zu verwendender Artikel: kein gültiger Code erkannt',
            original: rest,
          });
        }
        break;
      }
    }
    if (!useItemFound) {
      /* Not all items have a useItem (some are top-level standalone
         products). This is informational only — never blocks. Level 5+
         items in particular often parse without one. */
      parsed.parseWarnings.push({
        field: 'useItem',
        severity: 'low',
        reason: 'Keine "Zu verwendender Artikel"-Zeile gefunden',
      });
    }

    items.push(parsed);
  }
  return items;
}

/* ─────────────────────────────────────────────────────────────────────────
   EINZELNE SKU PARSER
   After the last pallet, blocks of:
     ACHTUNG! Jeder Karton mit (X × Y <label>) ...
     <article line>
     Zu verwendender Artikel: ...
   ───────────────────────────────────────────────────────────────────────── */
function parseEinzelneSkuSection(tail) {
  const items: ReturnType<typeof parseEinzelneSkuItemLine>[] = [];
  if (!tail) return items;
  const lines = tail.split('\n').map((l) => l.replace(/ /g, ' ').trim());
  /* ACHTUNG content can contain nested parens, e.g.
     "(10 x 80mm*63mm (5) 50M)". A plain "[^)]*" capture stops at the
     first inner ")", losing the "(5)" count that we need. Allow ONE
     level of nested parens via `(?:[^()]|\([^)]*\))*` so the capture
     spans the full outer payload. */
  const achtungRe =
    /ACHTUNG[!]?\s+Jeder\s+Karton\s+mit\s+\(\s*(\d+)\s*[×x*]\s*(\d+)\s*((?:[^()]|\([^)]*\))*)\)/i;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(achtungRe);
    if (!m) continue;

    const X = parseInt(m[1], 10);
    let Y = parseInt(m[2], 10);
    const contentRaw = (m[3] || '').trim();
    let contentLabel = contentRaw.replace(/^x\s*/i, '').trim() || 'Rollen';
    let recovered: { from: string; via: 'inner-paren' | 'explicit' | 'default-1' } | null = null;

    /* Dimension-poisoned ACHTUNG, e.g. "(10 x 80mm*63mm (5) 50M)".
       The regex greedily captures the first \d+ after × as Y, which here
       is the carton WIDTH (80mm), not the inner-pack count. Detected by
       contentRaw starting with mm/m/M — then scan the remainder for an
       explicit Stk/Rollen/Pcs count or a (\d+) parenthesised count, and
       reset contentLabel to "Rollen" as the sane thermal default.
       The recovery path stashes `recovered` so the item carries a low
       warning (signal G in plan) showing the worker what we substituted. */
    if (/^(mm|m\b|M\b)/.test(contentRaw)) {
      const explicit = contentRaw.match(/(\d+)\s*(Stck|Stk|Rollen|Rolls|Stück|Pcs|Pieces)\b/i);
      const parenCount = contentRaw.match(/\((\d+)\)/);
      if (explicit) {
        Y = parseInt(explicit[1], 10);
        contentLabel = explicit[2];
        recovered = { from: contentRaw, via: 'explicit' };
      } else if (parenCount) {
        Y = parseInt(parenCount[1], 10);
        contentLabel = 'Rollen';
        recovered = { from: contentRaw, via: 'inner-paren' };
      } else {
        Y = 1;
        contentLabel = 'Rollen';
        recovered = { from: contentRaw, via: 'default-1' };
      }
    }

    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (!next) continue;
      if (achtungRe.test(next)) break;
      if (!next.includes('\t')) continue;
      // Strip "Einzelne SKU" prefix with any arrow-like punctuation
      const cleaned = next.replace(/^Einzelne\s+SKU\s*[^\w\s]+\s*/i, '');
      const parsed = parseEinzelneSkuItemLine(cleaned, lines, j, { X, Y, contentLabel, recovered });
      if (parsed) items.push(parsed);
      break;
    }
  }
  return items;
}

function parseEinzelneSkuItemLine(line, allLines, lineIdx, achtung) {
  const parsed: Record<string, unknown> & { units?: number; isEinzelneSku?: boolean; einzelneSku?: unknown } | null = parseItemColumns(line);
  if (!parsed) return null;

  // Look forward for "Zu verwendender Artikel"
  for (let k = lineIdx + 1; k < Math.min(allLines.length, lineIdx + 5); k++) {
    if (/^ACHTUNG/i.test(allLines[k])) break;
    const um = allLines[k].match(/^Zu\s+verwendender\s+Artikel\s*[:：]?\s*(.+)/i);
    if (um) { parsed.useItem = um[1].trim(); break; }
  }

  /* Title-vs-ACHTUNG cross-check: the title's "(N Stk)" / "N Rollen"
     count (parsed into item.rollen by parseTitleMeta) is usually the
     cleanest signal — ACHTUNG lines like "(10 x 80mm*63mm (5) 50M)"
     are easy to mis-parse. When both exist and disagree, the title
     wins and a warning surfaces in Pruefen so the worker can verify. */
  let itemsPerPack = achtung.Y;
  const titleRolls = (parsed as any).rollen as number | null;
  if (titleRolls != null && titleRolls > 0 && titleRolls !== achtung.Y) {
    /* ≥5× divergence (signal L) gets a louder reason text so worker
       doesn't dismiss it as off-by-one rounding. Severity stays
       'medium' — title-wins fallback already corrected the value. */
    const ratio = Math.max(titleRolls, achtung.Y) / Math.max(1, Math.min(titleRolls, achtung.Y));
    const isLargeDivergence = ratio >= 5;
    parsed.parseWarnings.push({
      field: 'rollen',
      severity: 'medium',
      reason: isLargeDivergence
        ? `Titel sagt ${titleRolls} Stk, ACHTUNG sagt ${achtung.Y} — starke Abweichung (≥5×), Titelwert übernommen, bitte verifizieren`
        : `Titel sagt ${titleRolls} Stk pro Einheit, ACHTUNG sagt ${achtung.Y} — Titelwert übernommen`,
      original: String(achtung.Y),
      corrected: String(titleRolls),
    });
    itemsPerPack = titleRolls;
  }

  /* Signal G: ACHTUNG had dimensions instead of a count, parser
     recovered Y from inner parens / explicit Stk token / default-1.
     Surface that recovery so worker can sanity-check the chosen Y. */
  if (achtung.recovered) {
    const { from, via } = achtung.recovered;
    const viaLabel = via === 'inner-paren' ? 'aus innerer (N) gelesen'
                   : via === 'explicit'    ? 'aus Stk/Rollen-Token gelesen'
                   :                         'auf 1 zurückgefallen';
    parsed.parseWarnings.push({
      field: 'achtung',
      severity: 'low',
      reason: `ACHTUNG enthielt Maßangaben statt Stückzahl — Y=${itemsPerPack} aus "${from}" rekonstruiert (${viaLabel})`,
      original: from,
      corrected: String(itemsPerPack),
    });
  }

  /* Signal H: X (packs per carton) impossibly high. Real X is typically
     1-30; >100 means the regex captured an unrelated number (e.g. a
     dimension or year). Blocking — parser is almost certainly wrong. */
  if (achtung.X > 100) {
    parsed.parseWarnings.push({
      field: 'achtung',
      severity: 'high',
      reason: `ACHTUNG sagt ${achtung.X} Packs pro Karton — unwahrscheinlich hoch, bitte prüfen`,
      original: String(achtung.X),
    });
  }

  /* Signal I: Y (items per pack) impossibly high. Real Y rarely exceeds
     100. >1000 indicates parser captured a length-in-meters or another
     unrelated number. Blocking. */
  if (itemsPerPack > 1000) {
    parsed.parseWarnings.push({
      field: 'achtung',
      severity: 'high',
      reason: `ACHTUNG sagt ${itemsPerPack} Stück pro Pack — unwahrscheinlich hoch, bitte prüfen`,
      original: String(itemsPerPack),
    });
  }

  parsed.isEinzelneSku = true;
  parsed.einzelneSku = {
    packsPerCarton: achtung.X,
    itemsPerPack,
    effectiveRollen: achtung.X * itemsPerPack,
    contentLabel: achtung.contentLabel,
    cartonsCount: Math.max(1, Math.ceil((parsed.units ?? 0) / achtung.X)),
  };
  return parsed;
}

/* ─────────────────────────────────────────────────────────────────────────
   STANDARD-FORMAT PARSER
   ───────────────────────────────────────────────────────────────────────── */
function parseStandard(rawText) {
  const text = rawText
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/ /g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  const meta = parseMetaCommon(text);

  const palletRe = makePalletHeaderRe(true);
  const matches = [...text.matchAll(palletRe)];
  const pallets: { number: number; id: string; hasFourSideWarning: boolean; items: ReturnType<typeof parseItemsFromBlock> }[] = [];

  matches.forEach((m, idx) => {
    const number = parseInt(m[1], 10);
    const id = normalizePalletId(m[2]);
    const start = m.index + m[0].length;
    const end = idx + 1 < matches.length ? matches[idx + 1].index : text.length;
    const block = text.slice(start, end);

    const hasFourSideWarning =
      /SKU\s+Aufkleber\s+auf\s+allen\s+4\s+Seiten/i.test(block);

    const items = parseItemsFromBlock(block, id);
    pallets.push({ number, id, hasFourSideWarning, items });
  });

  const lastPalletEnd = matches.length > 0
    ? matches[matches.length - 1].index + matches[matches.length - 1][0].length
    : 0;
  const tail = text.slice(lastPalletEnd);
  const einzelneSkuItems = parseEinzelneSkuSection(tail);

  return { format: 'standard', meta, pallets, einzelneSkuItems };
}

/* ─────────────────────────────────────────────────────────────────────────
   SCHILDER-FORMAT PARSER
   Layout (from real docs):
     ACHTUNG! VERWENDEN SIE KARTON K8 (400x400x400 mm) 2wellig
     <header rows: SKU, FNSKU, NON AMAZON NUMMER/LAGERPLATZ, MENGE, GEWICHT, KARTON NR.>
     <data: SKU on its own line, then FNSKU/NON-AMZ/MENGE/GEWICHT/KARTON in 5 successive lines>
     <total row: blanks + total MENGE + total GEWICHT + blank>
     SENDUNGSNUMMER  /  KARTON NR.
     <SN-number>     /  <karton-id>

   The order of the 5 follow-up lines varies between docs (sometimes
   FNSKU comes first, sometimes NON-AMZ first). We classify each line
   by its content pattern instead of relying on position.
   ───────────────────────────────────────────────────────────────────────── */
const SCHILDER_KARTON_RE = /VERWENDEN\s+SIE\s+KARTON\s+([A-Z]+\d*)\s*\((\d+)\s*[xх×]\s*(\d+)\s*[xх×]\s*(\d+)\s*mm\)\s*([^\n]+)?/i;
const SCHILDER_SKU_RE = /^[A-Z0-9]{2,4}-[A-Z0-9]{4,6}-[A-Z0-9]{4,6}$/;
const FNSKU_RE = /^[XB]0[A-Z0-9]{8}$/i;

function classifySchilderField(value) {
  const v = value.trim();
  if (!v) return 'empty';
  if (FNSKU_RE.test(v)) return 'fnsku';
  if (SCHILDER_SKU_RE.test(v)) return 'sku';
  // a number with a decimal point is GEWICHT
  if (/^\d+[.,]\d+$/.test(v)) return 'gewicht';
  // pure digits = MENGE or KARTON_NR or NON-AMZ position
  if (/^\d+$/.test(v)) return 'integer';
  // alphanumeric like X001IC3FFT but with leading space — already caught above
  // any other text token (e.g., "10 Stk" or label) — unknown
  return 'text';
}

function parseSchilder(rawText) {
  const text = rawText.replace(/\r/g, '');
  const meta: Record<string, unknown> = {};

  // Karton spec
  const km = text.match(SCHILDER_KARTON_RE);
  if (km) {
    meta.karton = {
      type: km[1],
      length: parseInt(km[2], 10),
      width: parseInt(km[3], 10),
      height: parseInt(km[4], 10),
      note: (km[5] || '').trim() || null,
    };
  }

  // Sendungsnummer in Schilder docs is a long numeric like "1035876500597740802500"
  // sitting under "SENDUNGSNUMMER" / "KARTON NR." headers.
  const snMatch = text.match(/SENDUNGSNUMMER[\s\S]*?\n\s*(\d{15,})/i);
  if (snMatch) meta.sendungsnummer = snMatch[1];

  // Try to extract a SN-like FBA code from the document title or any FBA code
  const fbaMatch = text.match(/\bFBA\d[A-Z0-9]+\b/i);
  if (fbaMatch && !(typeof meta.sendungsnummer === 'string' && meta.sendungsnummer.startsWith('FBA')))
    meta.fbaCode = fbaMatch[0].toUpperCase();

  // Parse rows. Strategy: find every SKU-pattern line; for each, look at the
  // next ~6 non-empty lines and pull out fnsku/integer/gewicht by pattern.
  const lines = text.split('\n').map((l) => l.replace(/ /g, ' ').trim());

  const items: Array<Record<string, unknown>> = [];
  let totalUnits = 0;
  let totalWeight = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!SCHILDER_SKU_RE.test(line)) continue;
    const sku = line;

    // Collect up to 8 following non-empty lines (5 fields + safety margin)
    const tokens: string[] = [];
    for (let j = i + 1; j < lines.length && tokens.length < 8; j++) {
      const v = lines[j];
      if (!v) continue;
      // Stop if we've hit the next SKU
      if (SCHILDER_SKU_RE.test(v)) break;
      if (/^SENDUNGSNUMMER/i.test(v)) break;
      if (/^ACHTUNG/i.test(v)) break;
      tokens.push(v);
    }

    let fnsku: string | null = null, nonAmz: string | null = null;
    let menge: number | null = null, gewicht: number | null = null, kartonNr: number | null = null;
    const integers: number[] = [];
    for (const t of tokens) {
      const kind = classifySchilderField(t);
      if (kind === 'fnsku' && !fnsku) fnsku = t.toUpperCase();
      else if (kind === 'gewicht' && gewicht == null)
        gewicht = parseFloat(t.replace(',', '.'));
      else if (kind === 'integer') integers.push(parseInt(t, 10));
      else if (kind === 'text' && !fnsku && /^X[0-9]/i.test(t)) {
        // sometimes FNSKU has trailing space or odd char — fallback
        fnsku = t.replace(/\s+/g, '').toUpperCase();
      }
    }

    // Among the integers: typically [non-amz-pos, menge, karton-nr] — but the
    // non-amz-pos can also be alphanumeric so we may have only [menge, karton].
    // Heuristic: the LAST integer is the KARTON_NR (small, usually 1-9), the
    // SECOND-TO-LAST is the MENGE (the actual qty), and any earlier integer
    // is the non-amz position.
    if (integers.length >= 2) {
      kartonNr = integers[integers.length - 1];
      menge = integers[integers.length - 2];
      if (integers.length >= 3) nonAmz = String(integers[0]);
    } else if (integers.length === 1) {
      menge = integers[0];
    }
    // If we still don't have non-amz but a "text" token starts with X, it's
    // probably the NON-AMZ asin-like reference (X000xxx or similar).
    if (!nonAmz) {
      for (const t of tokens) {
        if (t === fnsku) continue;
        if (/^X[0-9]/i.test(t) && !FNSKU_RE.test(t)) {
          nonAmz = t.replace(/\s+/g, '').toUpperCase();
          break;
        }
      }
    }

    if (menge != null) totalUnits += menge;
    if (gewicht != null) totalWeight += gewicht;

    items.push({
      sku,
      fnsku: fnsku || '',
      nonAmz: nonAmz || '',
      units: menge || 0,
      weightKg: gewicht || 0,
      kartonNr: kartonNr ?? null,
      // Provide title-shaped fields for compatibility with downstream UI
      title: nonAmz ? `Schilder ${nonAmz}` : `Schilder ${sku}`,
      asin: '',
      ean: null,
      upc: null,
      condition: '',
      prep: '',
      prepType: null,
      labeler: '',
      useItem: null,
      dimStr: null,
      rollen: null,
      dim: null,
      isSchilder: true,
      category: 'sonstige',
      codeType: detectCodeType(fnsku),
    });
  }

  // Schilder docs ship as one carton — synthesize a single virtual pallet
  // so the rest of the UI works without special cases.
  const pallets = items.length
    ? [{
        number: 1,
        id: 'P1-K1',
        hasFourSideWarning: false,
        items,
      }]
    : [];

  meta.totalUnits = totalUnits;
  meta.totalWeightKg = Math.round(totalWeight * 100) / 100;
  meta.totalSkus = new Set(items.map((it) => it.fnsku || it.sku)).size;

  return { format: 'schilder', meta, pallets, einzelneSkuItems: [] };
}

/* ─────────────────────────────────────────────────────────────────────────
   FORMAT DETECTOR + PUBLIC ENTRY
   ───────────────────────────────────────────────────────────────────────── */
export function detectFormat(rawText) {
  const text = rawText.replace(/\r/g, '');
  // Standard if any PALETTE marker is present
  if (makePalletHeaderRe(false).test(text)) return 'standard';
  // Standard header is "Sendungsnummer\tFBA..." — even without pallets we
  // treat it as standard (yields empty pallets but valid meta).
  if (/^Sendungsnummer\b/im.test(text) && !/VERWENDEN\s+SIE\s+KARTON/i.test(text))
    return 'standard';
  // Schilder hallmark
  if (/VERWENDEN\s+SIE\s+KARTON/i.test(text)) return 'schilder';
  return 'standard';
}

export function parseLagerauftragText(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { format: 'unknown', meta: {}, pallets: [], einzelneSkuItems: [] };
  }
  const fmt = detectFormat(rawText);
  return fmt === 'schilder' ? parseSchilder(rawText) : parseStandard(rawText);
}

/* ─────────────────────────────────────────────────────────────────────────
   STRICT VALIDATION — independently re-scans the raw text and compares
   ───────────────────────────────────────────────────────────────────────── */
export function validateParsing(rawText, parsed) {
  const text = rawText.replace(/\r/g, '');
  const issues: Array<{ severity: string; kind: string; msg: string; palletId?: string }> = [];

  if (parsed.format === 'schilder') {
    // For Schilder we just sanity-check: every SKU-pattern line yielded an item.
    const skuCount = (text.split('\n').filter((l) => SCHILDER_SKU_RE.test(l.trim()))).length;
    if (skuCount !== parsed.pallets[0]?.items.length) {
      issues.push({
        severity: 'error',
        kind: 'schilder-item-count',
        msg: `Schilder: erwartet ${skuCount} SKU-Zeilen, geparst ${parsed.pallets[0]?.items.length || 0}`,
      });
    }
  } else {
    // 1. Pallet count
    const palletMatches = [...text.matchAll(makePalletHeaderRe(true))];
    if (palletMatches.length !== parsed.pallets.length) {
      issues.push({
        severity: 'error',
        kind: 'pallet-count',
        msg: `Paletten im Text: ${palletMatches.length}, geparst: ${parsed.pallets.length}`,
      });
    }

    // 2. Item count per pallet
    const palletExpectedItems = {};
    palletMatches.forEach((m, idx) => {
      const palletId = normalizePalletId(m[2]);
      const start = m.index + m[0].length;
      const end =
        idx + 1 < palletMatches.length
          ? palletMatches[idx + 1].index
          : text.length;
      const block = text.slice(start, end);
      const itemRe = makePalletItemRegex(palletId, { anchorStart: false, global: true });
      palletExpectedItems[palletId] = itemRe ? (block.match(itemRe) || []).length : 0;
    });
    parsed.pallets.forEach((p) => {
      const expected = palletExpectedItems[p.id];
      if (expected != null && expected !== p.items.length) {
        issues.push({
          severity: 'error',
          kind: 'item-count',
          palletId: p.id,
          msg: `${p.id}: erwartet ${expected} Artikel, geparst ${p.items.length}`,
        });
      }
    });

    // 3. Missing identifiers — escalate to `missing-identifier` when
    //    BOTH FNSKU and SKU are absent (item literally cannot be picked).
    //    Falls back to the original `missing-fnsku` flag when SKU is
    //    present (worker can still scan something). Only one of the two
    //    fires per item so Hinweise doesn't double-count.
    parsed.pallets.forEach((p) =>
      p.items.forEach((it) => {
        if (!it.fnsku && !it.sku) {
          issues.push({
            severity: 'error',
            kind: 'missing-identifier',
            palletId: p.id,
            msg: `${p.id}: Artikel ohne FNSKU und ohne SKU — nicht eindeutig identifizierbar — "${it.title?.slice(0, 40) || '—'}"`,
          });
        } else if (!it.fnsku) {
          issues.push({
            severity: 'error',
            kind: 'missing-fnsku',
            palletId: p.id,
            msg: `${p.id}: Artikel ohne FNSKU — "${it.title?.slice(0, 40) || '—'}"`,
          });
        }
      })
    );
  }

  // 4. Header totals cross-check (works for both formats)
  const eskuItems = parsed.einzelneSkuItems || [];
  const allEntries = [
    ...parsed.pallets.flatMap((p) => p.items),
    ...eskuItems,
  ];
  const uniqueFnskus = new Set();
  allEntries.forEach((it) => { if (it.fnsku) uniqueFnskus.add(it.fnsku); });
  const totalSkus = uniqueFnskus.size;
  const totalEntries = allEntries.length;
  const totalUnits = allEntries.reduce((s, it) => s + (it.units || 0), 0);
  // Header totals are user-entered in the Word template and frequently have
  // off-by-N typos. We surface mismatches as warnings (so the operator can
  // verify), while pallet-count + per-pallet item-count above are the
  // structural errors that indicate real parsing failures.
  // Header totals are user-entered in the Word template. A mismatch with
  // the actual sum is now treated as a HARD error (was warn) — these
  // discrepancies have caused live picking errors that cost real money,
  // so we block the Focus step until the operator reconciles them.
  if (parsed.meta?.totalSkus != null && parsed.format !== 'schilder' && parsed.meta.totalSkus !== totalSkus) {
    issues.push({
      severity: 'error',
      kind: 'sku-mismatch',
      msg: `Header zeigt ${parsed.meta.totalSkus} eindeutige SKUs, im Auftrag erkannt: ${totalSkus}`,
    });
  }
  if (parsed.meta?.totalUnits != null && parsed.format !== 'schilder' && parsed.meta.totalUnits !== totalUnits) {
    issues.push({
      severity: 'error',
      kind: 'unit-mismatch',
      msg: `Header zeigt ${parsed.meta.totalUnits} Einheiten, summiert: ${totalUnits} (Δ ${parsed.meta.totalUnits - totalUnits})`,
    });
  }

  // 5. Per-item checks
  parsed.pallets.forEach((p) =>
    p.items.forEach((it) => {
      if (!it.units || it.units <= 0) {
        // Zero-units is now a HARD error: a row that survived parsing
        // with units=0 means we either misread the .docx column layout
        // or the user typed an empty cell. Either way, picking the
        // pallet against this row is impossible.
        issues.push({
          severity: 'error',
          kind: 'zero-units',
          palletId: p.id,
          msg: `${p.id} / ${it.fnsku || it.sku}: Menge = 0 oder fehlt`,
        });
      }
      if (parsed.format !== 'schilder') {
        if (!it.asin) {
          issues.push({
            severity: 'warn', kind: 'missing-asin', palletId: p.id,
            msg: `${p.id} / ${it.fnsku}: ASIN leer`,
          });
        }
        if (!it.ean && !it.upc) {
          issues.push({
            severity: 'warn', kind: 'missing-code', palletId: p.id,
            msg: `${p.id} / ${it.fnsku}: kein EAN/UPC`,
          });
        }
      }
    })
  );

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warn');
  return {
    ok: errors.length === 0,
    issues,
    errorCount: errors.length,
    warningCount: warnings.length,
    counts: {
      palletsParsed: parsed.pallets.length,
      itemsParsed: totalSkus,
      entriesParsed: totalEntries,
      itemsExpectedFromHeader: parsed.meta?.totalSkus,
      unitsParsed: totalUnits,
      unitsExpectedFromHeader: parsed.meta?.totalUnits,
    },
  };
}