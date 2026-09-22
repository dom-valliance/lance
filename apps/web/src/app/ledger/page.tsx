import Link from 'next/link';
import { Download } from 'lucide-react';
import { Table, TableCard, TableFooterBar, Td, Th, Tr } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { TextLink } from '@/components/text-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  type LedgerKind,
  LEDGER_KINDS,
  ledgerFilterFrom,
  type SearchParams,
  selected,
  SOURCE_SYSTEMS,
} from '@/lib/filters';
import { humanise, LEDGER_KIND_LABELS, shortId, SYSTEM_LABELS } from '@/lib/humanise';
import {
  formatInstantWithSeconds,
  formatTimeWithSeconds,
  ledgerDetail,
  sourceSystemLabel,
  sourceSystemOf,
} from '@/lib/ledger-view';
import { LEDGER_KIND_TONES, SYSTEM_TONES, TONE_DOT_CLASS } from '@/lib/tones';
import { apiClient } from '@/lib/trpc';

export const dynamic = 'force-dynamic';

/** One screenful. A full page means there is probably more behind it. */
const PAGE_SIZE = 100;

/** The filter parameters the page and the export share, in form order. */
const FILTER_NAMES = ['kind', 'actor', 'sourceSystem', 'from', 'to'] as const;

const queryFrom = (params: SearchParams): URLSearchParams => {
  const query = new URLSearchParams();
  for (const name of FILTER_NAMES) {
    const value = selected(params, name);
    if (value !== '') query.set(name, value);
  }
  return query;
};

const href = (path: string, query: URLSearchParams): string => {
  const search = query.toString();
  return search === '' ? path : `${path}?${search}`;
};

/** A kind straight from a search param, which may be anything the reader typed. */
const kindLabel = (value: string): string =>
  (LEDGER_KINDS as readonly string[]).includes(value)
    ? LEDGER_KIND_LABELS[value as LedgerKind]
    : humanise(value);

/** A sentence naming the filters in force, for the phone summary line. */
function activeFilterSummary(params: SearchParams): string {
  const kind = selected(params, 'kind');
  const actor = selected(params, 'actor');
  const system = selected(params, 'sourceSystem');
  const from = selected(params, 'from');
  const to = selected(params, 'to');
  const parts: string[] = [];
  if (kind !== '') parts.push(kindLabel(kind));
  if (actor !== '') parts.push(actor);
  if (system !== '') parts.push(sourceSystemLabel(system));
  if (from !== '') parts.push(`from ${from}`);
  if (to !== '') parts.push(`to ${to}`);
  return parts.length === 0 ? 'all events' : parts.join(', ');
}

/** The five controls, rendered once for the desktop row and once inside the phone details. */
function FilterFields({ params }: { params: SearchParams }) {
  return (
    <>
      <Field label="Kind" className="lg:w-44">
        <Select name="kind" defaultValue={selected(params, 'kind')}>
          <option value="">Any kind</option>
          {LEDGER_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {LEDGER_KIND_LABELS[kind]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Actor" className="lg:w-52">
        <Input
          name="actor"
          defaultValue={selected(params, 'actor')}
          placeholder="user:dom or agent:triage"
          className="font-mono text-[13px]"
        />
      </Field>
      <Field label="Source system" className="lg:w-44">
        <Select name="sourceSystem" defaultValue={selected(params, 'sourceSystem')}>
          <option value="">Any system</option>
          {SOURCE_SYSTEMS.map((system) => (
            <option key={system} value={system}>
              {SYSTEM_LABELS[system]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="From" className="lg:w-40">
        <Input type="date" name="from" defaultValue={selected(params, 'from')} />
      </Field>
      <Field label="To" className="lg:w-40">
        <Input type="date" name="to" defaultValue={selected(params, 'to')} />
      </Field>
    </>
  );
}

function FilterActions({ exportHref, size }: { exportHref: string; size: 'default' | 'lg' }) {
  return (
    <div className="flex flex-wrap items-center gap-3 lg:ml-auto">
      <Button type="submit" size={size}>
        Apply filters
      </Button>
      <Button asChild variant="ghost" size={size}>
        <Link href="/ledger">Clear</Link>
      </Button>
      <Button asChild variant="outline" size={size}>
        <Link href={exportHref}>
          <Download aria-hidden />
          Export CSV
        </Link>
      </Button>
    </div>
  );
}

export default async function LedgerPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filter = ledgerFilterFrom(params);
  const client = await apiClient();
  const events = await client.ledger.query.query({ ...filter, limit: PAGE_SIZE });

  const query = queryFrom(params);
  const exportHref = href('/ledger/export', query);
  const oldest = events[events.length - 1];
  const olderQuery = new URLSearchParams(query);
  if (oldest !== undefined) olderQuery.set('to', new Date(oldest.ts).toISOString());
  const olderHref = href('/ledger', olderQuery);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Ledger"
        summary="Every observation, proposal, decision and execution. Append-only; nothing here can be edited."
      />

      <div className="rounded-xl bg-card px-6 py-4">
        <form method="get" className="hidden lg:flex lg:flex-wrap lg:items-end lg:gap-3">
          <FilterFields params={params} />
          <FilterActions exportHref={exportHref} size="default" />
        </form>
        <details className="lg:hidden">
          <summary className="cursor-pointer text-sm font-medium">
            Filters
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {activeFilterSummary(params)}
            </span>
          </summary>
          <form method="get" className="mt-4 flex flex-col gap-3">
            <FilterFields params={params} />
            <FilterActions exportHref={exportHref} size="lg" />
          </form>
        </details>
      </div>

      <TableCard>
        {events.length === 0 ? (
          <EmptyState>
            No events match these filters. <TextLink href="/ledger">Clear them</TextLink> to see the
            whole ledger.
          </EmptyState>
        ) : (
          <>
            <Table caption="Ledger events, newest first" className="text-[13px] tabular-nums">
              <thead>
                <tr>
                  <Th className="sticky left-0 bg-card">When</Th>
                  <Th>Kind</Th>
                  <Th>Actor</Th>
                  <Th>Source system</Th>
                  <Th className="hidden lg:table-cell">Detail</Th>
                  <Th>Correlation id</Th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => {
                  const system = sourceSystemOf(event.sourceSystem);
                  return (
                    <Tr key={event.id}>
                      <Td className="sticky left-0 bg-card py-2.5 whitespace-nowrap">
                        <span className="hidden lg:inline">
                          {formatInstantWithSeconds(event.ts)}
                        </span>
                        <span className="lg:hidden">{formatTimeWithSeconds(event.ts)}</span>
                      </Td>
                      <Td className="py-2.5 whitespace-nowrap">
                        <span className="inline-flex items-center gap-2">
                          <span
                            aria-hidden
                            className={`size-2 shrink-0 rounded-full ${TONE_DOT_CLASS[LEDGER_KIND_TONES[event.kind]]}`}
                          />
                          {LEDGER_KIND_LABELS[event.kind]}
                        </span>
                      </Td>
                      <Td className="py-2.5 font-mono text-xs whitespace-nowrap">{event.actor}</Td>
                      <Td className="py-2.5">
                        {system === null ? (
                          <span className="text-muted-foreground">none</span>
                        ) : (
                          <Badge tone={SYSTEM_TONES[system]} size="sm">
                            {SYSTEM_LABELS[system]}
                          </Badge>
                        )}
                      </Td>
                      <Td className="hidden py-2.5 text-muted-foreground lg:table-cell">
                        {ledgerDetail(event)}
                      </Td>
                      <Td className="py-2.5">
                        <TextLink
                          href={`/ledger/${event.correlationId}`}
                          mono
                          title={event.correlationId}
                        >
                          {shortId(event.correlationId, 12)}
                        </TextLink>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
            <TableFooterBar>
              <span>{events.length} shown</span>
              {events.length < PAGE_SIZE ? (
                <span>The whole range is here</span>
              ) : (
                <TextLink href={olderHref}>Show older</TextLink>
              )}
            </TableFooterBar>
          </>
        )}
      </TableCard>

      <p className="text-xs text-muted-foreground lg:hidden">
        Dates are today, Europe/London. Scroll the table sideways for actor and system.
      </p>
    </div>
  );
}
