import { ActionForm } from '@/components/action-form';
import { FilterLinks } from '@/components/filter-links';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ageingLabel,
  commitmentDirectionFrom,
  commitmentsRouter,
  commitmentStatusFilterFrom,
  commitmentStatusSelected,
  COMMITMENT_STATUS_FILTERS,
  isCommitmentOpenForAction,
  sortCommitments,
  type CommitmentDirection,
  type CommitmentStatusFilter,
} from '@/lib/commitment-view';
import { type SearchParams } from '@/lib/filters';
import { formatInstant } from '@/lib/proposal-view';
import { apiClient } from '@/lib/trpc';
import { chaseCommitment, dropCommitment, markCommitmentDone } from './actions';

export const dynamic = 'force-dynamic';

const INPUT_CLASS =
  'w-full rounded-lg border border-input bg-background px-2 py-1.5 text-sm text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

const DIRECTION_LABELS: Record<CommitmentDirection, string> = {
  outbound: 'I owe',
  inbound: 'Owed to me',
};

const STATUS_LABELS: Record<CommitmentStatusFilter, string> = {
  open: 'Open',
  chased: 'Chased',
  done: 'Done',
  dropped: 'Dropped',
  all: 'All',
};

/** A link for this page that keeps every current filter except the one being changed. */
function filterHref(
  current: { direction: CommitmentDirection; status: CommitmentStatusFilter },
  change: Partial<{ direction: CommitmentDirection; status: CommitmentStatusFilter }>,
): string {
  const next = { ...current, ...change };
  const query = new URLSearchParams();
  query.set('direction', next.direction);
  if (next.status !== 'open') query.set('status', next.status);
  return `/commitments?${query.toString()}`;
}

export default async function CommitmentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const direction = commitmentDirectionFrom(params);
  const status = commitmentStatusSelected(params);
  const current = { direction, status };

  const client = await apiClient();
  const statusFilter = commitmentStatusFilterFrom(params);
  // exactOptionalPropertyTypes: an optional key must be left out entirely
  // rather than set to `undefined` (mirrors `proposalFilterFrom` in
  // `@/lib/filters`).
  const result = await commitmentsRouter(client).list.query({
    direction,
    limit: 100,
    ...(statusFilter === undefined ? {} : { status: statusFilter }),
  });
  const commitments = sortCommitments(result.items);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Commitments</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <FilterLinks
            label="Direction"
            options={(['outbound', 'inbound'] as const).map((value) => ({
              label: DIRECTION_LABELS[value],
              href: filterHref(current, { direction: value }),
              active: direction === value,
            }))}
          />
          <FilterLinks
            label="Status"
            options={COMMITMENT_STATUS_FILTERS.map((value) => ({
              label: STATUS_LABELS[value],
              href: filterHref(current, { status: value }),
              active: status === value,
            }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="overflow-x-auto">
          {commitments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No commitments match these filters. Clear them to see the whole list.
            </p>
          ) : (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Commitments {direction === 'outbound' ? 'Dom owes' : 'owed to Dom'}, overdue first
              </caption>
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Description
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Counterparty
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Due
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Chased
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Provenance
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {commitments.map((commitment) => (
                  <tr key={commitment.id} className="border-t border-border align-top">
                    <td className="py-2 pr-4">
                      <p>{commitment.description}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        &ldquo;{commitment.evidenceQuote}&rdquo;
                      </p>
                    </td>
                    <td className="py-2 pr-4">{commitment.counterparty.name}</td>
                    <td className="py-2 pr-4">
                      <p>
                        {commitment.dueAt === null ? 'No date' : formatInstant(commitment.dueAt)}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {ageingLabel(commitment)}
                      </p>
                    </td>
                    <td className="py-2 pr-4">{commitment.chaseCount}</td>
                    <td className="py-2 pr-4">
                      {commitment.sourceRefs.length === 0 ? (
                        <span className="text-xs text-muted-foreground">None recorded</span>
                      ) : (
                        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                          {commitment.sourceRefs.map((ref) =>
                            ref.url === undefined ? null : (
                              <li key={`${ref.system}:${ref.recordId}`}>
                                <a
                                  href={ref.url}
                                  className="underline underline-offset-4 hover:text-primary"
                                  rel="noreferrer"
                                >
                                  {ref.system}:{ref.recordId}
                                </a>
                              </li>
                            ),
                          )}
                        </ul>
                      )}
                    </td>
                    <td className="py-2">
                      <div className="flex flex-col gap-2">
                        {isCommitmentOpenForAction(commitment) ? (
                          <div className="flex flex-wrap gap-2">
                            <ActionForm action={markCommitmentDone}>
                              <input type="hidden" name="commitmentId" value={commitment.id} />
                              <Button type="submit" size="sm">
                                Mark done
                              </Button>
                            </ActionForm>
                            <ActionForm
                              action={dropCommitment}
                              className="flex flex-wrap items-end gap-2"
                            >
                              <input type="hidden" name="commitmentId" value={commitment.id} />
                              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                                Reason
                                <input name="reason" required className={INPUT_CLASS} />
                              </label>
                              <Button type="submit" size="sm" variant="destructive">
                                Drop
                              </Button>
                            </ActionForm>
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            No actions: this commitment is {commitment.status}.
                          </p>
                        )}

                        {direction !== 'inbound' ? null : isCommitmentOpenForAction(commitment) ? (
                          <ActionForm action={chaseCommitment}>
                            <input type="hidden" name="commitmentId" value={commitment.id} />
                            <Button type="submit" size="sm" variant="outline">
                              Chase
                            </Button>
                          </ActionForm>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            Chasing is unavailable: this commitment is {commitment.status}.
                          </p>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
