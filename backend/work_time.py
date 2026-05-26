"""Pure work-time arithmetic.

Computes how many seconds of an arbitrary `[start, end]` interval fall
inside the warehouse's working window (e.g. Mon–Fri 07:00–15:30 with a
12:00–12:30 lunch break in Europe/Berlin). No DB, no SQLAlchemy — kept
import-light so it can be unit-tested in isolation and mirrored by a
JS port on the frontend.

The algorithm walks day-by-day in the schedule's local timezone:

  1. Skip days that aren't in `working_days` (ISO weekday Mon=1..Sun=7).
  2. For each working day, intersect `[start, end]` with that day's
     `[work_start, work_end]` window.
  3. Subtract the portion of that intersection that overlaps the lunch
     break window.

The sum is the effective number of working seconds.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class WorkSchedule:
    """Immutable working-schedule descriptor consumed by `effective_seconds`."""

    work_start: time
    work_end: time
    break_start: time
    break_end: time
    working_days: frozenset[int]  # ISO weekday: Mon=1, Sun=7
    tz: ZoneInfo


def _overlap_seconds(
    a_start: datetime, a_end: datetime,
    b_start: datetime, b_end: datetime,
) -> float:
    if a_end <= a_start or b_end <= b_start:
        return 0.0
    lo = max(a_start, b_start)
    hi = min(a_end, b_end)
    if hi <= lo:
        return 0.0
    return (hi - lo).total_seconds()


def effective_seconds(
    start: datetime, end: datetime, schedule: WorkSchedule,
) -> int:
    """Effective working seconds inside `[start, end]`.

    Both timestamps must be timezone-aware; they are converted into the
    schedule's local timezone before any arithmetic, so wall-clock work
    hours stay correct across DST.
    """
    if end <= start:
        return 0

    tz = schedule.tz
    start_local = start.astimezone(tz)
    end_local = end.astimezone(tz)

    total = 0.0
    cur_day = start_local.date()
    last_day = end_local.date()
    while cur_day <= last_day:
        if cur_day.isoweekday() in schedule.working_days:
            day_work_start = datetime.combine(cur_day, schedule.work_start, tzinfo=tz)
            day_work_end = datetime.combine(cur_day, schedule.work_end, tzinfo=tz)
            day_break_start = datetime.combine(cur_day, schedule.break_start, tzinfo=tz)
            day_break_end = datetime.combine(cur_day, schedule.break_end, tzinfo=tz)

            work = _overlap_seconds(
                start_local, end_local, day_work_start, day_work_end,
            )
            br = _overlap_seconds(
                max(start_local, day_work_start),
                min(end_local, day_work_end),
                day_break_start, day_break_end,
            )
            total += max(0.0, work - br)
        cur_day += timedelta(days=1)

    return int(total)


DEFAULT_SCHEDULE = WorkSchedule(
    work_start=time(7, 0),
    work_end=time(15, 30),
    break_start=time(12, 0),
    break_end=time(12, 30),
    working_days=frozenset({1, 2, 3, 4, 5}),
    tz=ZoneInfo("Europe/Berlin"),
)
