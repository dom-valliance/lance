import { describe, expect, it } from 'vitest';
import { ledgerFilterFrom, proposalFilterFrom, selected } from './filters';

describe('proposalFilterFrom', () => {
  it('keeps only the filters the search params carry', () => {
    expect(proposalFilterFrom({ status: 'pending' })).toEqual({ status: 'pending' });
  });

  it('maps the system search param to the api field name', () => {
    expect(proposalFilterFrom({ system: 'notion' })).toEqual({ targetSystem: 'notion' });
  });

  it('drops a value the api would reject', () => {
    expect(proposalFilterFrom({ status: 'lingering', actionClass: 'teleport' })).toEqual({});
  });

  it('takes the first value when a param is repeated', () => {
    expect(proposalFilterFrom({ status: ['approved', 'pending'] })).toEqual({ status: 'approved' });
  });

  it('treats an empty select as no filter', () => {
    expect(proposalFilterFrom({ status: '', system: '' })).toEqual({});
  });

  it('carries a paging cursor that is a ULID', () => {
    expect(proposalFilterFrom({ cursor: '01J8Q4M7X2KD9ZABCDEFGHJKMN' })).toEqual({
      cursor: '01J8Q4M7X2KD9ZABCDEFGHJKMN',
    });
  });

  it('drops a cursor that is not a ULID', () => {
    expect(proposalFilterFrom({ cursor: 'latest' })).toEqual({});
    expect(proposalFilterFrom({ cursor: '01j8q4m7x2kd9zabcdefghjkmn' })).toEqual({});
    expect(proposalFilterFrom({ cursor: '01J8Q4M7X2KD9ZABCDEFGHJKM' })).toEqual({});
    expect(proposalFilterFrom({ cursor: '01J8Q4M7X2KD9ZABCDEFGHJKMI' })).toEqual({});
  });
});

describe('ledgerFilterFrom', () => {
  it('widens a from date to the start of that day and a to date to its end', () => {
    expect(ledgerFilterFrom({ from: '2026-09-21', to: '2026-09-22' })).toEqual({
      from: '2026-09-21T00:00:00.000Z',
      to: '2026-09-22T23:59:59.999Z',
    });
  });

  it('drops a date that is not a calendar day', () => {
    expect(ledgerFilterFrom({ from: 'yesterday' })).toEqual({});
  });

  it('trims an actor and drops a blank one', () => {
    expect(ledgerFilterFrom({ actor: '  user:dom  ' })).toEqual({ actor: 'user:dom' });
    expect(ledgerFilterFrom({ actor: '   ' })).toEqual({});
  });

  it('keeps a recognised kind and source system', () => {
    expect(ledgerFilterFrom({ kind: 'decided', sourceSystem: 'lance' })).toEqual({
      kind: 'decided',
      sourceSystem: 'lance',
    });
  });

  it('passes a full ISO instant through without widening it, so paging moves back', () => {
    expect(ledgerFilterFrom({ to: '2026-09-21T13:05:41.000Z' })).toEqual({
      to: '2026-09-21T13:05:41.000Z',
    });
  });

  it('normalises an instant with an offset to UTC', () => {
    expect(ledgerFilterFrom({ from: '2026-09-21T14:05:41+01:00' })).toEqual({
      from: '2026-09-21T13:05:41.000Z',
    });
  });

  it('drops an instant that is not a time', () => {
    expect(ledgerFilterFrom({ to: '2026-13-45T99:99:99Z' })).toEqual({});
  });
});

describe('selected', () => {
  it('gives a select its current value, or an empty string when unset', () => {
    expect(selected({ status: 'pending' }, 'status')).toBe('pending');
    expect(selected({}, 'status')).toBe('');
  });
});
