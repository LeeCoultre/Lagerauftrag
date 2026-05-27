/* Unit tests for the API → legacy-shape adapters in state.tsx.
 *
 * These adapters are the bridge between backend DTOs (camelCase post-
 * snake-conversion) and the legacy useAppState() shape consumed by
 * every screen. A silent change to either side has historically caused
 * hours of debugging — most recently a missing assignedToUserId
 * mapping that left `current` stuck at null after a successful Start.
 *
 * Tests focus on:
 *   1. Field-level mappings (snake-case to camel-case is upstream;
 *      these tests verify api.ts → state.ts)
 *   2. Status mapping (queued → ready, error → error)
 *   3. Defaults for optional fields (currentPalletIdx falls back to 0)
 *   4. Date parsing (ISO strings → unix-ms timestamps)
 */

import { describe, it, expect } from 'vitest';
import { toLegacy, toLegacyHistory } from '@/state';
import type { AuftragDetail, AuftragSummary } from '@/types/api';

const baseSummary: AuftragSummary = {
  id: '00000000-0000-0000-0000-000000000001',
  fileName: 'test.docx',
  fbaCode: 'FBA15LL4PK53',
  status: 'queued',
  palletCount: 3,
  articleCount: 27,
  unitsCount: 540,
  eskuCount: 0,
  errorMessage: null,
  createdAt: '2026-05-08T10:00:00.000Z',
  queuePosition: 0,
  assignedToUserId: null,
  assignedToUserName: null,
  startedAt: null,
  finishedAt: null,
  durationSec: null,
  palletTimings: {},
  palletEffectiveSeconds: {},
};

describe('toLegacy', () => {
  it('returns null for null input', () => {
    expect(toLegacy(null)).toBeNull();
    expect(toLegacy(undefined)).toBeNull();
  });

  it('maps queued status → ready', () => {
    const r = toLegacy(baseSummary);
    expect(r?.status).toBe('ready');
  });

  it('maps error status → error', () => {
    const r = toLegacy({ ...baseSummary, status: 'error', errorMessage: 'parse failed' });
    expect(r?.status).toBe('error');
    expect(r?.error).toBe('parse failed');
  });

  it('maps in_progress status → ready (legacy "ready" covers both)', () => {
    /* The legacy shape uses ready|error only; routing decisions for
       in-progress vs queued happen via `step` and `current` selection
       in state.tsx, not status here. */
    const r = toLegacy({ ...baseSummary, status: 'in_progress' });
    expect(r?.status).toBe('ready');
  });

  it('parses createdAt ISO string into unix-ms', () => {
    const r = toLegacy(baseSummary);
    expect(r?.addedAt).toBe(Date.parse('2026-05-08T10:00:00.000Z'));
  });

  it('preserves assignedToUserId — regression for stuck-current bug', () => {
    /* If this mapping breaks, currentSrc filter never matches and the
       UI never switches to Pruefen after Start. See ef18c5d. */
    const r = toLegacy({
      ...baseSummary,
      status: 'in_progress',
      assignedToUserId: '8bfe07c0-f27b-4b8f-93ff-19fc989013b4',
      assignedToUserName: 'D7',
    });
    expect(r?.assignedToUserId).toBe('8bfe07c0-f27b-4b8f-93ff-19fc989013b4');
    expect(r?.assignedToUserName).toBe('D7');
  });

  it('defaults currentPalletIdx + currentItemIdx to 0 when missing', () => {
    /* AuftragSummary has neither field; only AuftragDetail does. The
       adapter must not crash on Summary input. */
    const r = toLegacy(baseSummary);
    expect(r?.currentPalletIdx).toBe(0);
    expect(r?.currentItemIdx).toBe(0);
  });

  it('preserves Detail-only fields when input is AuftragDetail', () => {
    const detail: AuftragDetail = {
      ...baseSummary,
      status: 'in_progress',
      rawText: 'raw',
      parsed: { format: 'standard', meta: {}, pallets: [] },
      validation: { ok: true, errorCount: 0, warningCount: 0, issues: [] },
      step: 'pruefen',
      currentPalletIdx: 2,
      currentItemIdx: 5,
      completedKeys: { 'P1|0|sku-x': 1234 },
    };
    const r = toLegacy(detail);
    expect(r?.step).toBe('pruefen');
    expect(r?.currentPalletIdx).toBe(2);
    expect(r?.currentItemIdx).toBe(5);
    expect(r?.completedKeys).toEqual({ 'P1|0|sku-x': 1234 });
    expect(r?.rawText).toBe('raw');
  });

  it('parses startedAt + finishedAt when present', () => {
    const r = toLegacy({
      ...baseSummary,
      startedAt: '2026-05-08T10:01:00.000Z',
      finishedAt: '2026-05-08T10:05:00.000Z',
      durationSec: 240,
    });
    expect(r?.startedAt).toBe(Date.parse('2026-05-08T10:01:00.000Z'));
    expect(r?.finishedAt).toBe(Date.parse('2026-05-08T10:05:00.000Z'));
    expect(r?.durationSec).toBe(240);
  });

  it('returns undefined for startedAt when null in API', () => {
    const r = toLegacy(baseSummary);
    expect(r?.startedAt).toBeUndefined();
    expect(r?.finishedAt).toBeUndefined();
  });

  it('defaults palletTimings to empty object', () => {
    const r = toLegacy(baseSummary);
    expect(r?.palletTimings).toEqual({});
  });
});

describe('toLegacyHistory', () => {
  const baseHistory: AuftragSummary = {
    ...baseSummary,
    status: 'completed',
    startedAt: '2026-05-08T10:00:00.000Z',
    finishedAt: '2026-05-08T10:30:00.000Z',
    durationSec: 1800,
    assignedToUserName: 'D7',
  };

  it('parses ISO timestamps into unix-ms', () => {
    const r = toLegacyHistory(baseHistory);
    expect(r.startedAt).toBe(Date.parse('2026-05-08T10:00:00.000Z'));
    expect(r.finishedAt).toBe(Date.parse('2026-05-08T10:30:00.000Z'));
  });

  it('returns null for missing timestamps (not undefined)', () => {
    /* Historie sorts by startedAt; null is comparable, undefined isn't. */
    const r = toLegacyHistory({ ...baseHistory, startedAt: null, finishedAt: null });
    expect(r.startedAt).toBeNull();
    expect(r.finishedAt).toBeNull();
  });

  it('preserves assignedToUserName for the "wer hat das gemacht" column', () => {
    const r = toLegacyHistory(baseHistory);
    expect(r.assignedToUserName).toBe('D7');
  });

  it('defaults palletTimings to empty object', () => {
    const r = toLegacyHistory({ ...baseHistory, palletTimings: undefined as unknown as Record<string, never> });
    expect(r.palletTimings).toEqual({});
  });

  it('preserves pallet/article counts', () => {
    const r = toLegacyHistory(baseHistory);
    expect(r.palletCount).toBe(3);
    expect(r.articleCount).toBe(27);
  });
});
