import { ledgerDetail, type LedgerEventView } from '@/lib/ledger-view';

/**
 * The ledger as a CSV document, for the export control on the Ledger page.
 * RFC 4180: fields that hold a comma, a double quote or a line break are
 * quoted and inner quotes are doubled; records end with CRLF. Timestamps
 * are written as ISO 8601 UTC rather than the London display form, because
 * a spreadsheet sorts those and an auditor can compare them with the api.
 */

export const LEDGER_CSV_HEADER = [
  'when',
  'kind',
  'actor',
  'source_system',
  'source_record_id',
  'correlation_id',
  'detail',
  'payload',
] as const;

const NEEDS_QUOTING = /["\n\r,]/;

/** One field, quoted only when RFC 4180 requires it. */
export function csvField(value: string): string {
  return NEEDS_QUOTING.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** One record, fields separated by commas. */
export function csvRow(fields: readonly string[]): string {
  return fields.map(csvField).join(',');
}

const isoOr = (value: Date | string): string => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
};

const compactJson = (payload: unknown): string =>
  payload === null || payload === undefined ? '' : (JSON.stringify(payload) ?? '');

/** Every event as a CSV document, header first, in the order the api returned them. */
export function ledgerCsv(events: readonly LedgerEventView[]): string {
  const rows = [csvRow(LEDGER_CSV_HEADER)];
  for (const event of events) {
    rows.push(
      csvRow([
        isoOr(event.ts),
        event.kind,
        event.actor,
        event.sourceSystem ?? '',
        event.sourceRecordId ?? '',
        event.correlationId,
        ledgerDetail(event),
        compactJson(event.payload),
      ]),
    );
  }
  return `${rows.join('\r\n')}\r\n`;
}

/**
 * "lance-ledger-2026-09-01-2026-09-21.csv". The range the filter asked for,
 * with "all" where there is no start and today where there is no end, so a
 * downloaded file says what it holds.
 */
export function ledgerCsvFilename(
  filter: { from?: string; to?: string },
  now: Date = new Date(),
): string {
  const day = (value: string): string => value.slice(0, 10);
  const from = filter.from === undefined ? 'all' : day(filter.from);
  const to = filter.to === undefined ? day(now.toISOString()) : day(filter.to);
  return `lance-ledger-${from}-${to}.csv`;
}
