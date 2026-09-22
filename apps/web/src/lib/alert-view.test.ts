import { describe, expect, it } from 'vitest';
import {
  alertSeverityFilterFrom,
  alertSeveritySelected,
  alertStatusFilterFrom,
  alertStatusSelected,
  canAck,
  canMute,
  canResolve,
  sortAlerts,
} from './alert-view';

describe('alertStatusSelected', () => {
  it('defaults to open when no status is in the query string', () => {
    expect(alertStatusSelected({})).toBe('open');
  });

  it('reads a recognised status from the query string', () => {
    expect(alertStatusSelected({ status: 'acked' })).toBe('acked');
    expect(alertStatusSelected({ status: 'all' })).toBe('all');
  });

  it('falls back to open for a status it does not recognise', () => {
    expect(alertStatusSelected({ status: 'bogus' })).toBe('open');
  });
});

describe('alertStatusFilterFrom', () => {
  it('passes a real status through to the api filter', () => {
    expect(alertStatusFilterFrom({ status: 'suppressed' })).toBe('suppressed');
  });

  it('turns "all" into no filter at all', () => {
    expect(alertStatusFilterFrom({ status: 'all' })).toBeUndefined();
  });
});

describe('alertSeveritySelected', () => {
  it('defaults to all when no severity is in the query string', () => {
    expect(alertSeveritySelected({})).toBe('all');
  });

  it('reads a recognised severity from the query string', () => {
    expect(alertSeveritySelected({ severity: 'P0' })).toBe('P0');
  });

  it('falls back to all for a severity it does not recognise', () => {
    expect(alertSeveritySelected({ severity: 'P9' })).toBe('all');
  });
});

describe('alertSeverityFilterFrom', () => {
  it('passes a real severity through to the api filter', () => {
    expect(alertSeverityFilterFrom({ severity: 'P1' })).toBe('P1');
  });

  it('turns "all" into no filter at all', () => {
    expect(alertSeverityFilterFrom({})).toBeUndefined();
  });
});

describe('sortAlerts', () => {
  it('puts P0 before P1 before P2', () => {
    const alerts = [
      { id: 'a', severity: 'P2' as const, lastSeen: '2026-09-21T10:00:00Z' },
      { id: 'b', severity: 'P0' as const, lastSeen: '2026-09-21T09:00:00Z' },
      { id: 'c', severity: 'P1' as const, lastSeen: '2026-09-21T09:00:00Z' },
    ];
    expect(sortAlerts(alerts).map((alert) => alert.id)).toEqual(['b', 'c', 'a']);
  });

  it('orders alerts of the same severity by most recently seen first', () => {
    const alerts = [
      { id: 'older', severity: 'P1' as const, lastSeen: '2026-09-20T09:00:00Z' },
      { id: 'newer', severity: 'P1' as const, lastSeen: '2026-09-21T09:00:00Z' },
    ];
    expect(sortAlerts(alerts).map((alert) => alert.id)).toEqual(['newer', 'older']);
  });

  it('leaves the source array untouched', () => {
    const alerts = [
      { id: 'a', severity: 'P2' as const, lastSeen: '2026-09-21T10:00:00Z' },
      { id: 'b', severity: 'P0' as const, lastSeen: '2026-09-21T09:00:00Z' },
    ];
    sortAlerts(alerts);
    expect(alerts.map((alert) => alert.id)).toEqual(['a', 'b']);
  });
});

describe('canAck', () => {
  it('allows acking only an open alert', () => {
    expect(canAck({ status: 'open' })).toBe(true);
    expect(canAck({ status: 'acked' })).toBe(false);
    expect(canAck({ status: 'resolved' })).toBe(false);
    expect(canAck({ status: 'suppressed' })).toBe(false);
  });
});

describe('canMute', () => {
  it('allows muting an open or acked alert, not a resolved one', () => {
    expect(canMute({ status: 'open' })).toBe(true);
    expect(canMute({ status: 'acked' })).toBe(true);
    expect(canMute({ status: 'resolved' })).toBe(false);
    expect(canMute({ status: 'suppressed' })).toBe(false);
  });
});

describe('canResolve', () => {
  it('allows resolving an open or acked alert, not a suppressed one', () => {
    expect(canResolve({ status: 'open' })).toBe(true);
    expect(canResolve({ status: 'acked' })).toBe(true);
    expect(canResolve({ status: 'suppressed' })).toBe(false);
    expect(canResolve({ status: 'resolved' })).toBe(false);
  });
});
