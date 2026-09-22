import Link from 'next/link';
import { Download } from 'lucide-react';
import { TableCard } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { TextLink } from '@/components/text-link';
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
import { humanise, LEDGER_KIND_LABELS, SYSTEM_LABELS } from '@/lib/humanise';
import { sourceSystemLabel } from '@/lib/ledger-view';
import { pageLinks, PAGE_SIZES, shownLabel } from '@/lib/pagination';
import { apiClient } from '@/lib/trpc';
import { LedgerTable } from './ledger-table';

export const dynamic = 'force-dynamic';

/** The filter parameters the page and the export share, in form order. */
const FILTER_NAMES = ['kind', 'actor', 'sourceSystem', 'from', 'to'] as const;

/**
 * The ledger has no row cursor: it pages by the timestamp of the oldest
 * event shown, in the same `to` parameter the filter form writes.
 */
const CURSOR_PARAM = 'to';

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
  const events = await client.ledger.query.query({ ...filter, limit: PAGE_SIZES.ledger });

  const exportHref = href('/ledger/export', queryFrom(params));

  // A full page means there is probably more behind it, and the oldest
  // event shown is where the next page starts.
  const oldest = events.at(-1);
  const nextCursor =
    events.length === PAGE_SIZES.ledger && oldest !== undefined
      ? new Date(oldest.ts).toISOString()
      : null;
  const links = pageLinks({
    path: '/ledger',
    params,
    keep: FILTER_NAMES,
    nextCursor,
    cursorParam: CURSOR_PARAM,
  });
  const footer = (
    <Pagination summary={shownLabel(events.length)} {...links} nextLabel="Show older" />
  );

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

      {events.length === 0 ? (
        <TableCard>
          <EmptyState>
            No events match these filters. <TextLink href="/ledger">Clear them</TextLink> to see the
            whole ledger.
          </EmptyState>
          {footer}
        </TableCard>
      ) : (
        <LedgerTable events={events} footer={footer} />
      )}

      <p className="text-xs text-muted-foreground lg:hidden">
        Dates are today, Europe/London. Scroll the table sideways for actor and system.
      </p>
    </div>
  );
}
