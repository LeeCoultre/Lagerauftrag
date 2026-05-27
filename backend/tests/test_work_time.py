"""Pure-function unit tests for `backend.work_time.effective_seconds`.

No DB, no fixtures — these tests run even if the suite-level DB guard
trips, because the underlying module imports nothing from `backend.*`
beyond `work_time` itself.
"""

from datetime import datetime, time, timezone as dt_timezone
from zoneinfo import ZoneInfo

from backend.work_time import WorkSchedule, effective_seconds


BERLIN = ZoneInfo("Europe/Berlin")
DEFAULT = WorkSchedule(
    work_start=time(7, 0),
    work_end=time(15, 30),
    break_start=time(12, 0),
    break_end=time(12, 30),
    working_days=frozenset({1, 2, 3, 4, 5}),
    tz=BERLIN,
)


def _at(y: int, m: int, d: int, hh: int, mm: int = 0) -> datetime:
    return datetime(y, m, d, hh, mm, tzinfo=BERLIN)


# 2026-05-25 is a Monday — used as the canonical "ordinary working day".


def test_range_inside_workday_no_break():
    # 08:00 → 11:00 = 3h
    assert effective_seconds(_at(2026, 5, 25, 8), _at(2026, 5, 25, 11), DEFAULT) == 3 * 3600


def test_range_crosses_lunch_break():
    # 11:55 → 12:35 = 40 wall − 30 lunch = 10 effective
    assert effective_seconds(_at(2026, 5, 25, 11, 55), _at(2026, 5, 25, 12, 35), DEFAULT) == 10 * 60


def test_range_entirely_inside_lunch():
    assert effective_seconds(_at(2026, 5, 25, 12, 5), _at(2026, 5, 25, 12, 20), DEFAULT) == 0


def test_range_starts_before_work():
    # 06:55 → 07:10 → 10 effective
    assert effective_seconds(_at(2026, 5, 25, 6, 55), _at(2026, 5, 25, 7, 10), DEFAULT) == 10 * 60


def test_range_ends_after_work():
    # 15:25 → 16:00 → 5 effective
    assert effective_seconds(_at(2026, 5, 25, 15, 25), _at(2026, 5, 25, 16, 0), DEFAULT) == 5 * 60


def test_range_outside_work_hours():
    assert effective_seconds(_at(2026, 5, 25, 18), _at(2026, 5, 25, 22), DEFAULT) == 0


def test_full_workday():
    # 07:00 → 15:30 = 8.5h wall − 30 lunch = 8h
    assert effective_seconds(_at(2026, 5, 25, 7), _at(2026, 5, 25, 15, 30), DEFAULT) == 8 * 3600


def test_range_spans_weekend():
    # Fri 2026-05-22 15:25 → Mon 2026-05-25 07:05
    # Fri: 5 min · Sat/Sun: 0 · Mon: 5 min = 10 min
    assert effective_seconds(_at(2026, 5, 22, 15, 25), _at(2026, 5, 25, 7, 5), DEFAULT) == 10 * 60


def test_zero_when_end_before_start():
    assert effective_seconds(_at(2026, 5, 25, 10), _at(2026, 5, 25, 9), DEFAULT) == 0


def test_lunch_partial_overlap_pre_lunch():
    # 11:00 → 12:15 → 75 wall − 15 lunch = 60 effective
    assert effective_seconds(_at(2026, 5, 25, 11), _at(2026, 5, 25, 12, 15), DEFAULT) == 60 * 60


def test_lunch_partial_overlap_post_lunch():
    # 12:15 → 13:00 → 45 wall − 15 lunch = 30 effective
    assert effective_seconds(_at(2026, 5, 25, 12, 15), _at(2026, 5, 25, 13, 0), DEFAULT) == 30 * 60


def test_weekend_only_zero():
    # Sat 10:00 → Sun 14:00 (2026-05-23 / 2026-05-24)
    assert effective_seconds(_at(2026, 5, 23, 10), _at(2026, 5, 24, 14), DEFAULT) == 0


def test_utc_input_normalized_to_local():
    # 06:00 UTC = 08:00 CEST (Europe/Berlin in May) — 3h to 09:00 UTC = 11:00 CEST
    s = effective_seconds(
        datetime(2026, 5, 25, 6, 0, tzinfo=dt_timezone.utc),
        datetime(2026, 5, 25, 9, 0, tzinfo=dt_timezone.utc),
        DEFAULT,
    )
    assert s == 3 * 3600


def test_dst_spring_forward_doesnt_affect_business_hours():
    # 2026-03-29 is a Sunday; spring-forward at 02:00 → 03:00. Monday
    # 2026-03-30 starts as usual at 07:00. Range 07:00 → 09:00 stays 2h.
    assert effective_seconds(_at(2026, 3, 30, 7), _at(2026, 3, 30, 9), DEFAULT) == 2 * 3600


def test_multi_day_full_weeks_of_work():
    # Mon 07:00 → Fri 15:30 of the same week = 5 × 8h = 40h
    s = effective_seconds(_at(2026, 5, 25, 7), _at(2026, 5, 29, 15, 30), DEFAULT)
    assert s == 5 * 8 * 3600
