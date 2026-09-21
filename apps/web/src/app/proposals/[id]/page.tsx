import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { LiveRefresh } from '@/components/live-refresh';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { diffPayload, editableFields, formatInstant, REJECT_REASONS } from '@/lib/proposal-view';
import { apiClient } from '@/lib/trpc';
import { approveProposal, editProposal, rejectProposal, snoozeProposal } from '../actions';

export const dynamic = 'force-dynamic';

const INPUT_CLASS =
  'w-full rounded-lg border border-input bg-background px-2 py-1.5 text-sm text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

const LEDGER_PAYLOAD_KEYS = ['action', 'from', 'to', 'note', 'reasonCode', 'status'] as const;

/** A one-line summary of a ledger event, for the status history. */
function summarise(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const record = payload as Record<string, unknown>;
  return LEDGER_PAYLOAD_KEYS.filter((key) => typeof record[key] === 'string')
    .map((key) => `${key}: ${String(record[key])}`)
    .join(', ');
}

export default async function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await apiClient();

  const proposal = await client.proposals.get.query({ proposalId: id });
  if (proposal === null) notFound();

  const trail = await client.ledger.correlation.query({ correlationId: proposal.correlationId });
  const changes = diffPayload(proposal.payload, proposal.editedPayload);

  return (
    <div className="flex flex-col gap-6">
      <LiveRefresh streamUrl="/api/events" watch="proposal" />

      <Button asChild variant="ghost" className="w-fit">
        <Link href="/proposals">Back to proposals</Link>
      </Button>

      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">{proposal.preview}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{proposal.actionClass}</Badge>
            <Badge variant="secondary">{proposal.counterpartyClass}</Badge>
            <Badge variant="outline">{proposal.targetSystem}</Badge>
            <Badge variant={proposal.status === 'pending' ? 'default' : 'secondary'}>
              {proposal.status}
            </Badge>
          </div>

          <p className="text-sm text-muted-foreground">{proposal.rationale}</p>

          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Policy cell</dt>
              <dd>
                {proposal.actionClass} / {proposal.counterpartyClass} / {proposal.targetSystem}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Policy decision</dt>
              <dd>{proposal.policyDecision}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Expires</dt>
              <dd>{formatInstant(proposal.expiresAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Correlation id</dt>
              <dd>
                <Link
                  href={`/ledger/${proposal.correlationId}`}
                  className="underline underline-offset-4 hover:text-primary"
                >
                  {proposal.correlationId}
                </Link>
              </dd>
            </div>
          </dl>

          <div>
            <h2 className="text-sm font-medium">Provenance</h2>
            <ul className="mt-1 flex flex-col gap-1 text-sm text-muted-foreground">
              {proposal.provenance.map((ref) => (
                <li key={`${ref.system}:${ref.recordId}`}>
                  {ref.url === undefined ? (
                    <span>
                      {ref.system}:{ref.recordId}
                    </span>
                  ) : (
                    <a
                      href={ref.url}
                      className="underline underline-offset-4 hover:text-primary"
                      rel="noreferrer"
                    >
                      {ref.system}:{ref.recordId}
                    </a>
                  )}{' '}
                  seen {formatInstant(ref.observedAt)}
                </li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>

      {changes.length === 0 ? null : (
        <Card>
          <CardHeader>
            <CardTitle>What the edit changed</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Field
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Originally
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    After the edit
                  </th>
                </tr>
              </thead>
              <tbody>
                {changes.map((change) => (
                  <tr key={change.field} className="border-t border-border">
                    <td className="py-2 pr-4">{change.field}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{change.before}</td>
                    <td className="py-2">{change.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Decide</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-wrap gap-3">
            <ActionForm action={approveProposal}>
              <input type="hidden" name="proposalId" value={proposal.id} />
              <Button type="submit">Approve</Button>
            </ActionForm>
            <ActionForm action={snoozeProposal}>
              <input type="hidden" name="proposalId" value={proposal.id} />
              <Button type="submit" variant="outline">
                Snooze 4h
              </Button>
            </ActionForm>
          </div>

          <Separator />

          <ActionForm action={editProposal} className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">Edit</h2>
            <input type="hidden" name="proposalId" value={proposal.id} />
            {editableFields(proposal.payload).map(([field, value]) => (
              <label key={field} className="flex flex-col gap-1 text-xs text-muted-foreground">
                {field}
                <textarea
                  name={`field:${field}`}
                  defaultValue={value}
                  rows={value.length > 120 ? 4 : 1}
                  className={INPUT_CLASS}
                />
              </label>
            ))}
            <Button type="submit" variant="outline" className="w-fit">
              Save the edit and execute
            </Button>
          </ActionForm>

          <Separator />

          <ActionForm action={rejectProposal} className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">Reject</h2>
            <input type="hidden" name="proposalId" value={proposal.id} />
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Reason
              <select name="reasonCode" required className={INPUT_CLASS}>
                {REJECT_REASONS.map((reason) => (
                  <option key={reason.value} value={reason.value}>
                    {reason.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Note (optional)
              <textarea name="note" rows={2} className={INPUT_CLASS} />
            </label>
            <Button type="submit" variant="destructive" className="w-fit">
              Reject
            </Button>
          </ActionForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Status history</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              Ledger events for this correlation id, oldest first
            </caption>
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">
                  When
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Kind
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Actor
                </th>
                <th scope="col" className="py-2 font-medium">
                  Detail
                </th>
              </tr>
            </thead>
            <tbody>
              {trail.map((event) => (
                <tr key={event.id} className="border-t border-border">
                  <td className="py-2 pr-4">{formatInstant(event.ts)}</td>
                  <td className="py-2 pr-4">{event.kind}</td>
                  <td className="py-2 pr-4">{event.actor}</td>
                  <td className="py-2 text-muted-foreground">{summarise(event.payload)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
