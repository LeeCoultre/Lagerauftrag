/* TanStack Query hook for the warehouse working schedule.
 *
 * The schedule changes on the order of months (or after an admin edit),
 * so a 1h staleTime is plenty. Every live-timer consumer reads from the
 * same query — admin save invalidates ['workSchedule'] and the new
 * window propagates without remounting components. */

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { getWorkSchedule } from '../marathonApi';
import { resolveSchedule, type WorkScheduleResolved } from '../utils/workTime';
import type { WorkSchedule } from '../types/api';

const DEFAULT_RESOLVED: WorkScheduleResolved = {
  work: { startMin: 7 * 60, endMin: 15 * 60 + 30 },
  lunch: { startMin: 12 * 60, endMin: 12 * 60 + 30 },
  workingDays: new Set([1, 2, 3, 4, 5]),
  tz: 'Europe/Berlin',
};

export interface UseWorkScheduleResult {
  /** Resolved schedule ready for `effectiveElapsedMs` / `workPhaseAt`.
   *  Falls back to the warehouse default when the query is loading or
   *  the endpoint is unreachable, so timers always have something
   *  sensible to compute against. */
  schedule: WorkScheduleResolved;
  /** Raw wire shape — needed by Admin → Arbeitszeit (the editor reads
   *  `workStart` / `workEnd` strings, not minute counts). */
  raw: WorkSchedule | undefined;
  isLoading: boolean;
  isError: boolean;
}

export function useWorkSchedule(): UseWorkScheduleResult {
  const q = useQuery<WorkSchedule>({
    queryKey: ['workSchedule'],
    queryFn: getWorkSchedule,
    staleTime: 60 * 60 * 1000,   // 1h — schedule barely ever changes
    gcTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const schedule = useMemo(
    () => (q.data ? resolveSchedule(q.data) : DEFAULT_RESOLVED),
    [q.data],
  );
  return {
    schedule,
    raw: q.data,
    isLoading: q.isLoading,
    isError: q.isError,
  };
}
