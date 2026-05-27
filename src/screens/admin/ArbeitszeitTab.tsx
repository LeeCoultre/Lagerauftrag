/* Admin → Arbeitszeit tab.
 *
 * Editor for the warehouse working schedule (`work_schedule` singleton).
 * Drives `effective_seconds` on the backend (Auftrag.duration_sec at
 * /complete + per-pallet breakdown in Historie) and the live Focus timer
 * on the frontend (which freezes during the break + outside hours).
 *
 *   [QuickStats]          ← current window + break + working days
 *   [Form]                ← 4 time pickers + day checkboxes + Speichern
 *   [Audit-tail]          ← last edit (who + when)
 *
 * Validation matches the backend CHECK constraint:
 *   work_start < break_start < break_end < work_end
 * Only admins reach this tab — the parent already gates on role. */

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { adminUpdateWorkSchedule } from '@/marathonApi.js';
import { Card, T } from '@/components/ui.jsx';
import { useWorkSchedule } from '@/hooks/useWorkSchedule';
import type { WorkSchedule, WorkSchedulePatchPayload } from '@/types/api';

const ISO_DAYS: ReadonlyArray<{ iso: number; short: string; long: string }> = [
  { iso: 1, short: 'Mo', long: 'Montag' },
  { iso: 2, short: 'Di', long: 'Dienstag' },
  { iso: 3, short: 'Mi', long: 'Mittwoch' },
  { iso: 4, short: 'Do', long: 'Donnerstag' },
  { iso: 5, short: 'Fr', long: 'Freitag' },
  { iso: 6, short: 'Sa', long: 'Samstag' },
  { iso: 7, short: 'So', long: 'Sonntag' },
];

function trimToHHMM(s: string | undefined): string {
  // FastAPI's `time` round-trips as 'HH:MM:SS' — input[type=time] wants
  // 'HH:MM'. Trim the seconds off without choking on a missing seconds
  // segment.
  if (!s) return '07:00';
  const [hh = '07', mm = '00'] = s.split(':');
  return `${hh.padStart(2, '0')}:${mm.padStart(2, '0')}`;
}

function validateOrder(p: {
  workStart: string; workEnd: string;
  breakStart: string; breakEnd: string;
}): string | null {
  const minutes = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  const ws = minutes(p.workStart);
  const we = minutes(p.workEnd);
  const bs = minutes(p.breakStart);
  const be = minutes(p.breakEnd);
  if (!(ws < bs)) return 'Arbeitsbeginn muss vor Pausenbeginn liegen.';
  if (!(bs < be)) return 'Pausenbeginn muss vor Pausenende liegen.';
  if (!(be < we)) return 'Pausenende muss vor Arbeitsende liegen.';
  return null;
}

export default function ArbeitszeitTab() {
  const qc = useQueryClient();
  const { raw, isLoading } = useWorkSchedule();

  const [workStart, setWorkStart] = useState('07:00');
  const [workEnd, setWorkEnd] = useState('15:30');
  const [breakStart, setBreakStart] = useState('12:00');
  const [breakEnd, setBreakEnd] = useState('12:30');
  const [workingDays, setWorkingDays] = useState<Set<number>>(new Set([1, 2, 3, 4, 5]));
  const [bannerOk, setBannerOk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync form state from server load. Re-syncing whenever the cached
  // payload changes keeps the form honest if another admin edits in
  // a parallel tab.
  useEffect(() => {
    if (!raw) return;
    setWorkStart(trimToHHMM(raw.workStart));
    setWorkEnd(trimToHHMM(raw.workEnd));
    setBreakStart(trimToHHMM(raw.breakStart));
    setBreakEnd(trimToHHMM(raw.breakEnd));
    setWorkingDays(new Set(raw.workingDays || [1, 2, 3, 4, 5]));
  }, [raw]);

  const saveMut = useMutation<WorkSchedule, Error, WorkSchedulePatchPayload>({
    mutationFn: adminUpdateWorkSchedule,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workSchedule'] });
      setBannerOk(true);
      setError(null);
      window.setTimeout(() => setBannerOk(false), 2500);
    },
    onError: (e) => setError(e.message || 'Speichern fehlgeschlagen.'),
  });

  const onSubmit = (ev: FormEvent) => {
    ev.preventDefault();
    const orderErr = validateOrder({ workStart, workEnd, breakStart, breakEnd });
    if (orderErr) { setError(orderErr); return; }
    if (workingDays.size === 0) {
      setError('Mindestens ein Arbeitstag muss aktiv sein.');
      return;
    }
    setError(null);
    saveMut.mutate({
      workStart: `${workStart}:00`,
      workEnd: `${workEnd}:00`,
      breakStart: `${breakStart}:00`,
      breakEnd: `${breakEnd}:00`,
      workingDays: Array.from(workingDays).sort((a, b) => a - b),
    });
  };

  const toggleDay = (iso: number) => {
    setWorkingDays((prev) => {
      const next = new Set(prev);
      if (next.has(iso)) next.delete(iso); else next.add(iso);
      return next;
    });
  };

  if (isLoading && !raw) {
    return <Card>Lade…</Card>;
  }

  const daysLabel = Array.from(workingDays).sort((a, b) => a - b)
    .map((iso) => ISO_DAYS.find((d) => d.iso === iso)?.short || '?').join(' · ');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 16,
        }}>
          <Stat label="Arbeitszeit" value={`${trimToHHMM(raw?.workStart)} – ${trimToHHMM(raw?.workEnd)}`} />
          <Stat label="Pause" value={`${trimToHHMM(raw?.breakStart)} – ${trimToHHMM(raw?.breakEnd)}`} />
          <Stat label="Arbeitstage" value={daysLabel || '—'} />
        </div>
      </Card>

      <Card>
        <form onSubmit={onSubmit}>
          <div style={{
            fontFamily: T.font.ui, fontWeight: 600, fontSize: 14,
            color: T.text.primary, marginBottom: 12,
          }}>
            Rahmen
          </div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
            gap: 12, marginBottom: 20,
          }}>
            <TimeField label="Arbeitsbeginn" value={workStart} onChange={setWorkStart} />
            <TimeField label="Pausenbeginn"  value={breakStart} onChange={setBreakStart} />
            <TimeField label="Pausenende"    value={breakEnd}   onChange={setBreakEnd} />
            <TimeField label="Arbeitsende"   value={workEnd}    onChange={setWorkEnd} />
          </div>

          <div style={{
            fontFamily: T.font.ui, fontWeight: 600, fontSize: 14,
            color: T.text.primary, marginBottom: 12,
          }}>
            Arbeitstage
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
            {ISO_DAYS.map((d) => {
              const active = workingDays.has(d.iso);
              return (
                <button
                  key={d.iso}
                  type="button"
                  onClick={() => toggleDay(d.iso)}
                  title={d.long}
                  style={{
                    minWidth: 56,
                    padding: '8px 12px',
                    fontFamily: T.font.ui,
                    fontWeight: 600,
                    fontSize: 13,
                    borderRadius: 999,
                    border: `1px solid ${active ? 'var(--accent)' : T.border.primary}`,
                    background: active ? T.accent.bg : T.bg.surface,
                    color: active ? T.accent.text : T.text.subtle,
                    cursor: 'pointer',
                    transition: 'background 140ms, color 140ms, border-color 140ms',
                  }}
                >
                  {d.short}
                </button>
              );
            })}
          </div>

          <div style={{
            fontFamily: T.font.ui, fontWeight: 500, fontSize: 12,
            color: T.text.subtle, marginBottom: 16, lineHeight: 1.5,
          }}>
            Zeitzone: <strong style={{ color: T.text.primary }}>{raw?.timezoneName || 'Europe/Berlin'}</strong>{' '}
            (aktuell schreibgeschützt). Reihenfolge muss eingehalten werden:
            Arbeitsbeginn &lt; Pausenbeginn &lt; Pausenende &lt; Arbeitsende.
          </div>

          {error && (
            <div role="alert" style={{
              padding: '10px 12px',
              marginBottom: 12,
              borderRadius: 10,
              fontFamily: T.font.ui,
              fontSize: 13,
              color: T.status.danger.text,
              background: T.status.danger.bg,
              border: `1px solid ${T.status.danger.main}`,
            }}>
              {error}
            </div>
          )}
          {bannerOk && (
            <div role="status" style={{
              padding: '10px 12px',
              marginBottom: 12,
              borderRadius: 10,
              fontFamily: T.font.ui,
              fontSize: 13,
              color: T.status.success.text,
              background: T.status.success.bg,
              border: `1px solid ${T.status.success.main}`,
            }}>
              Gespeichert. Live-Timer übernimmt das neue Fenster sofort.
            </div>
          )}

          <button
            type="submit"
            disabled={saveMut.isPending}
            style={{
              padding: '10px 18px',
              fontFamily: T.font.ui,
              fontWeight: 600,
              fontSize: 14,
              color: '#fff',
              background: 'var(--accent)',
              border: 'none',
              borderRadius: 10,
              cursor: saveMut.isPending ? 'wait' : 'pointer',
              opacity: saveMut.isPending ? 0.6 : 1,
              transition: 'opacity 140ms',
            }}
          >
            {saveMut.isPending ? 'Speichere…' : 'Speichern'}
          </button>
        </form>
      </Card>
    </div>
  );
}

function TimeField({ label, value, onChange }: {
  label: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{
        fontFamily: T.font.ui, fontSize: 11, fontWeight: 500,
        color: T.text.subtle, textTransform: 'uppercase', letterSpacing: 0.4,
      }}>
        {label}
      </span>
      <input
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        step={60}
        style={{
          padding: '8px 10px',
          fontFamily: T.font.mono,
          fontSize: 14,
          fontWeight: 600,
          color: T.text.primary,
          background: T.bg.surface,
          border: `1px solid ${T.border.primary}`,
          borderRadius: 8,
          outline: 'none',
          fontVariantNumeric: 'tabular-nums',
        }}
      />
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{
        fontFamily: T.font.ui, fontSize: 11, fontWeight: 500,
        color: T.text.subtle, textTransform: 'uppercase', letterSpacing: 0.4,
        marginBottom: 6,
      }}>
        {label}
      </div>
      <div style={{
        fontFamily: T.font.mono, fontSize: 16, fontWeight: 700,
        color: T.text.primary, fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </div>
    </div>
  );
}
