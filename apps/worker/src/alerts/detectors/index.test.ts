import { describe, expect, it } from 'vitest';
import { allDetectors } from './index.js';

describe('allDetectors', () => {
  it('returns every detector once, with a name that can become a queue', () => {
    const names = allDetectors().map((detector) => detector.name);
    expect(names).toEqual([
      'cost_spike',
      'budget_guard',
      'commitment_overdue_outbound',
      'calendar_conflict',
      'external_meeting_unknown_attendee',
      'client_mail_unanswered',
      'proposal_expiring',
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives the calendar and proposal detectors a quarter-hourly cron and the rest an hourly one', () => {
    const schedules = Object.fromEntries(
      allDetectors().map((detector) => [detector.name, detector.schedule]),
    );
    expect(schedules).toEqual({
      cost_spike: '0 * * * *',
      budget_guard: '*/15 * * * *',
      commitment_overdue_outbound: '0 * * * *',
      calendar_conflict: '*/15 * * * *',
      external_meeting_unknown_attendee: '*/15 * * * *',
      client_mail_unanswered: '0 * * * *',
      proposal_expiring: '*/15 * * * *',
    });
  });

  it('leaves out an excluded detector', () => {
    const names = allDetectors({ exclude: ['cost_spike'] }).map((detector) => detector.name);
    expect(names).not.toContain('cost_spike');
    expect(names).toHaveLength(6);
  });

  it('applies a schedule override without touching the others', () => {
    const detectors = allDetectors({ schedules: { calendar_conflict: '*/5 * * * *' } });
    const byName = Object.fromEntries(
      detectors.map((detector) => [detector.name, detector.schedule]),
    );
    expect(byName['calendar_conflict']).toBe('*/5 * * * *');
    expect(byName['cost_spike']).toBe('0 * * * *');
  });
});
