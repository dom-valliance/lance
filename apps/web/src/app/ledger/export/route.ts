import type { NextRequest } from 'next/server';
import { auth } from '@/auth';
import { serverIdToken } from '@/auth/id-token';
import { ledgerFilterFrom, type SearchParams } from '@/lib/filters';
import { ledgerCsv, ledgerCsvFilename } from '@/lib/ledger-csv';
import { apiClient } from '@/lib/trpc';

/**
 * `GET /ledger/export`: the Ledger page's Export CSV control. It reads the
 * same filters the page did from the query string and streams the matching
 * events back as a file. The ceiling is the api's own maximum, so one
 * export is one query rather than a paging loop.
 */

export const dynamic = 'force-dynamic';

/** The api's hard ceiling on one ledger query (`LedgerQueryInputSchema`). */
const EXPORT_LIMIT = 2000;

/** Next gives a repeated param several times; the filters take the first, as the page does. */
const paramsOf = (search: URLSearchParams): SearchParams => {
  const params: SearchParams = {};
  for (const [key, value] of search) {
    params[key] ??= value;
  }
  return params;
};

export async function GET(request: NextRequest): Promise<Response> {
  const session = await auth();
  if (session === null || session.error !== undefined || (await serverIdToken()) === undefined) {
    return Response.json(
      { error: 'No session. Sign in again to export the ledger.' },
      { status: 401 },
    );
  }

  const filter = ledgerFilterFrom(paramsOf(request.nextUrl.searchParams));
  const client = await apiClient();
  const events = await client.ledger.query.query({ ...filter, limit: EXPORT_LIMIT });

  return new Response(ledgerCsv(events), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${ledgerCsvFilename(filter)}"`,
      'cache-control': 'no-store',
    },
  });
}
