import { describe, expect, it } from 'vitest';
import { csvField, ledgerCsv, ledgerCsvFilename } from './ledger-csv';
import type { LedgerEventView } from './ledger-view';

describe('csvField', () => {
  it('leaves a plain field alone', () => {
    expect(csvField('user:dom')).toBe('user:dom');
  });

  it('quotes a field holding a comma, a quote or a line break', () => {
    expect(csvField('Draft email, client counterparty')).toBe('"Draft email, client counterparty"');
    expect(csvField('He said "no"')).toBe('"He said ""no"""');
    expect(csvField('first\nsecond')).toBe('"first\nsecond"');
  });
});

describe('ledgerCsv', () => {
  const events: LedgerEventView[] = [
    {
      id: '01K5X0000000000000000ONE',
      ts: '2026-09-21T13:05:41.000Z',
      actor: 'user:dom',
      kind: 'decided',
      sourceSystem: 'lance',
      sourceRecordId: null,
      correlationId: '01K5X0000000000000TRAIL',
      payload: { proposalId: 'p1', action: 'reject', reasonCode: 'wrong_target' },
    },
    {
      id: '01K5X0000000000000000TWO',
      ts: '2026-09-21T13:06:02.000Z',
      actor: 'agent:executor',
      kind: 'executed',
      sourceSystem: 'notion',
      sourceRecordId: 'task-42',
      correlationId: '01K5X0000000000000TRAIL',
      payload: { summary: 'Created "Renew, then confirm"' },
    },
  ];

  it('writes a header and one CRLF record per event', () => {
    expect(ledgerCsv(events)).toBe(
      [
        'when,kind,actor,source_system,source_record_id,correlation_id,detail,payload',
        '2026-09-21T13:05:41.000Z,decided,user:dom,lance,,01K5X0000000000000TRAIL,Rejected: wrong target,' +
          '"{""proposalId"":""p1"",""action"":""reject"",""reasonCode"":""wrong_target""}"',
        '2026-09-21T13:06:02.000Z,executed,agent:executor,notion,task-42,01K5X0000000000000TRAIL,' +
          '"Created ""Renew, then confirm""","{""summary"":""Created \\""Renew, then confirm\\""""}"',
        '',
      ].join('\r\n'),
    );
  });

  it('writes the header alone when nothing matched the filter', () => {
    expect(ledgerCsv([])).toBe(
      'when,kind,actor,source_system,source_record_id,correlation_id,detail,payload\r\n',
    );
  });
});

describe('ledgerCsvFilename', () => {
  it('names the range the filter asked for', () => {
    expect(
      ledgerCsvFilename({ from: '2026-09-01T00:00:00.000Z', to: '2026-09-21T23:59:59.999Z' }),
    ).toBe('lance-ledger-2026-09-01-2026-09-21.csv');
  });

  it('says all and today when the range is open', () => {
    expect(ledgerCsvFilename({}, new Date('2026-09-22T09:00:00.000Z'))).toBe(
      'lance-ledger-all-2026-09-22.csv',
    );
  });
});
