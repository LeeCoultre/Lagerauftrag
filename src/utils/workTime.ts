/* Pure work-time arithmetic — JS mirror of backend/work_time.py.
 *
 * Computes how many milliseconds of an arbitrary `[start, end]` interval
 * fall inside the warehouse's working window (Mon–Fri 07:00–15:30 by
 * default, minus a 12:00–12:30 lunch break in Europe/Berlin).
 *
 * Used by:
 *   - the live Focus timer (BetaTopPill, PositionMeter), so the tick
 *     visually freezes during the lunch break and outside hours;
 *   - the Pause-bis chip that surfaces the next resume time;
 *   - any other place that wants to render an "effective" duration
 *     before the backend persists `durationSec` at /complete.
 *
 * The algorithm matches `backend.work_time.effective_seconds`: iterate
 * by local calendar day, intersect with the work window, subtract the
 * lunch-break overlap. Everything happens in the schedule's timezone via
 * `Intl.DateTimeFormat` part extraction — avoids a Temporal polyfill. */

import type { WorkSchedule } from '../types/api';

/** Local in-memory shape derived from the wire `WorkSchedule`. Times
 *  are decomposed into `{ h, m, s }` so we don't reparse "HH:MM:SS" on
 *  every tick. */
export interface WorkScheduleResolved {
  work: { startMin: number; endMin: number };
  lunch: { startMin: number; endMin: number };
  workingDays: ReadonlySet<number>;
  tz: string;
}

function parseHms(s: string): number {
  // Accept 'HH:MM', 'HH:MM:SS', or 'HH:MM:SS.ffffff' — seconds are
  // truncated since the schedule is minute-granular.
  const parts = s.split(':');
  const h = Number(parts[0] ?? 0);
  const m = Number(parts[1] ?? 0);
  return h * 60 + m;
}

export function resolveSchedule(s: WorkSchedule): WorkScheduleResolved {
  return {
    work: { startMin: parseHms(s.workStart), endMin: parseHms(s.workEnd) },
    lunch: { startMin: parseHms(s.breakStart), endMin: parseHms(s.breakEnd) },
    workingDays: new Set(s.workingDays || [1, 2, 3, 4, 5]),
    tz: s.timezoneName || 'Europe/Berlin',
  };
}

interface LocalDayPart {
  yearMonthDay: string; // 'YYYY-MM-DD' in schedule.tz
  isoWeekday: number;   // 1..7
  minuteOfDay: number;  // 0..1439, position within the local day
}

/* `Intl.DateTimeFormat` with timeZone gives us the wall-clock parts in
   that zone. The ISO weekday is derived from the calendar date alone
   (independent of clock), so we re-use the same parts. */
const _fmtCache = new Map<string, Intl.DateTimeFormat>();
function _fmt(tz: string): Intl.DateTimeFormat {
  const cached = _fmtCache.get(tz);
  if (cached) return cached;
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  _fmtCache.set(tz, f);
  return f;
}

function _localParts(ts: number, tz: string): LocalDayPart {
  const parts = _fmt(tz).formatToParts(new Date(ts));
  const lookup: Record<string, string> = {};
  for (const p of parts) lookup[p.type] = p.value;
  const y = Number(lookup.year);
  const mo = Number(lookup.month);
  const d = Number(lookup.day);
  let h = Number(lookup.hour);
  const mi = Number(lookup.minute);
  if (h === 24) h = 0; // some zones format midnight as 24:00
  const utcMidday = Date.UTC(y, mo - 1, d);
  const dow = new Date(utcMidday).getUTCDay(); // 0..6 Sun..Sat
  const isoWeekday = dow === 0 ? 7 : dow;
  return {
    yearMonthDay: `${lookup.year}-${lookup.month}-${lookup.day}`,
    isoWeekday,
    minuteOfDay: h * 60 + mi,
  };
}

/* Forward-step a YYYY-MM-DD by N days, returning the next string. Used
   to iterate the day cursor without reasoning about UTC offsets. */
function _addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86_400_000;
  const dt = new Date(t);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function _isoWeekdayOf(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

function _overlap(a: number, b: number, c: number, d: number): number {
  const lo = Math.max(a, c);
  const hi = Math.min(b, d);
  return hi > lo ? hi - lo : 0;
}

/** Effective working **milliseconds** between `startMs` and `endMs`
 *  under the given schedule. Returns 0 when the range is empty or
 *  entirely outside working hours. Inputs are unix-ms (UTC). */
export function effectiveElapsedMs(
  startMs: number,
  endMs: number,
  sched: WorkScheduleResolved,
): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 0;
  }
  const startLocal = _localParts(startMs, sched.tz);
  const endLocal = _localParts(endMs, sched.tz);

  // First and last day in local-timezone calendar form.
  let cursor = startLocal.yearMonthDay;
  let totalMin = 0;

  // Safety: max scan window of 366 days; long-running Aufträge spanning
  // a year+ would be a bug elsewhere.
  for (let guard = 0; guard < 366; guard += 1) {
    const iso = _isoWeekdayOf(cursor);
    if (sched.workingDays.has(iso)) {
      const isFirst = cursor === startLocal.yearMonthDay;
      const isLast = cursor === endLocal.yearMonthDay;
      const rangeStart = isFirst ? startLocal.minuteOfDay : 0;
      const rangeEnd = isLast ? endLocal.minuteOfDay : 24 * 60;
      const workOverlap = _overlap(
        rangeStart, rangeEnd, sched.work.startMin, sched.work.endMin,
      );
      // Lunch overlap is computed against the work-windowed slice, so
      // a worker who clocked in at 11:00 and out at 12:15 gets 60 min
      // (overlap with [12:00, 12:30] only contributes 15 min).
      const inWorkStart = Math.max(rangeStart, sched.work.startMin);
      const inWorkEnd = Math.min(rangeEnd, sched.work.endMin);
      const lunchOverlap = inWorkEnd > inWorkStart
        ? _overlap(inWorkStart, inWorkEnd, sched.lunch.startMin, sched.lunch.endMin)
        : 0;
      totalMin += Math.max(0, workOverlap - lunchOverlap);
    }
    if (cursor === endLocal.yearMonthDay) break;
    cursor = _addDays(cursor, 1);
  }

  // Minute-granular schedule → multiply by 60_000 to return ms.
  return totalMin * 60_000;
}

/** Describes whether `now` falls inside a working interval, outside
 *  business hours, or in the lunch break. Used by the BetaTopPill chip. */
export type WorkPhase = 'working' | 'before_work' | 'after_work' | 'lunch' | 'non_working_day';

export interface PhaseInfo {
  phase: WorkPhase;
  /** Next minute (unix-ms) at which work resumes — null when never (e.g. the
   *  schedule has no working days, which would be a configuration error). */
  nextResumeMs: number | null;
}

/** Where `nowMs` sits in the working week. Computes the next resume
 *  time so the UI can render a "Pause bis 12:30" countdown without
 *  re-running its own scan loop. */
export function workPhaseAt(nowMs: number, sched: WorkScheduleResolved): PhaseInfo {
  const local = _localParts(nowMs, sched.tz);
  const today = local.yearMonthDay;
  const isWorkingDay = sched.workingDays.has(local.isoWeekday);

  // Helper: build a unix-ms anchor for a given YYYY-MM-DD + minute-of-day
  // by binary-search inside that local day. `Intl.DateTimeFormat` is the
  // source of truth — we walk by 30-min steps and pick the closest one
  // that lands on the target minute-of-day in `tz`. 30min steps mean
  // worst case ~30 iterations to land on a minute-boundary boundary.
  const anchorMs = (ymd: string, minuteOfDay: number): number => {
    const [y, mo, d] = ymd.split('-').map(Number);
    // Start by guessing the timestamp as if UTC, then nudge using the
    // observed local minute-of-day to land on the right local instant.
    let guess = Date.UTC(y, mo - 1, d, 0, 0, 0) + minuteOfDay * 60_000;
    for (let i = 0; i < 4; i += 1) {
      const p = _localParts(guess, sched.tz);
      const drift = minuteOfDay - p.minuteOfDay;
      if (drift === 0 && p.yearMonthDay === ymd) return guess;
      guess += drift * 60_000;
    }
    return guess;
  };

  if (!isWorkingDay) {
    // Find next working day, starting from tomorrow.
    let day = _addDays(today, 1);
    for (let i = 0; i < 14; i += 1) {
      if (sched.workingDays.has(_isoWeekdayOf(day))) {
        return { phase: 'non_working_day', nextResumeMs: anchorMs(day, sched.work.startMin) };
      }
      day = _addDays(day, 1);
    }
    return { phase: 'non_working_day', nextResumeMs: null };
  }

  const m = local.minuteOfDay;
  if (m < sched.work.startMin) {
    return { phase: 'before_work', nextResumeMs: anchorMs(today, sched.work.startMin) };
  }
  if (m >= sched.lunch.startMin && m < sched.lunch.endMin) {
    return { phase: 'lunch', nextResumeMs: anchorMs(today, sched.lunch.endMin) };
  }
  if (m >= sched.work.endMin) {
    // Next working day, otherwise tomorrow scan.
    let day = _addDays(today, 1);
    for (let i = 0; i < 14; i += 1) {
      if (sched.workingDays.has(_isoWeekdayOf(day))) {
        return { phase: 'after_work', nextResumeMs: anchorMs(day, sched.work.startMin) };
      }
      day = _addDays(day, 1);
    }
    return { phase: 'after_work', nextResumeMs: null };
  }
  return { phase: 'working', nextResumeMs: null };
}

/** Format a unix-ms timestamp as 'HH:MM' in the schedule's timezone.
 *  Used by the Pause-bis chip. */
export function formatTimeInTz(ms: number, tz: string): string {
  const f = _fmt(tz);
  const parts = f.formatToParts(new Date(ms));
  const lookup: Record<string, string> = {};
  for (const p of parts) lookup[p.type] = p.value;
  return `${lookup.hour}:${lookup.minute}`;
}
