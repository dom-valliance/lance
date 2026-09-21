import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatInstant } from '@/lib/proposal-view';
import { apiClient } from '@/lib/trpc';

export const dynamic = 'force-dynamic';

/** The proposal a ledger event is about, when its payload names one. */
function proposalIdIn(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as { proposalId?: unknown }).proposalId;
  return typeof value === 'string' ? value : null;
}

export default async function CorrelationPage({
  params,
}: {
  params: Promise<{ correlationId: string }>;
}) {
  const { correlationId } = await params;
  const client = await apiClient();
  const trail = await client.ledger.correlation.query({ correlationId });

  return (
    <div className="flex flex-col gap-6">
      <Button asChild variant="ghost" className="w-fit">
        <Link href="/ledger">Back to the ledger</Link>
      </Button>

      <Card>
        <CardHeader>
          <CardTitle className="text-2xl">Correlation {correlationId}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {trail.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No events carry that correlation id. Check the id and try again.
            </p>
          ) : (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Every event in this trail, oldest first</caption>
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
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Source system
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Proposal
                  </th>
                </tr>
              </thead>
              <tbody>
                {trail.map((event) => {
                  const proposalId = proposalIdIn(event.payload);
                  return (
                    <tr key={event.id} className="border-t border-border">
                      <td className="py-2 pr-4">{formatInstant(event.ts)}</td>
                      <td className="py-2 pr-4">{event.kind}</td>
                      <td className="py-2 pr-4">{event.actor}</td>
                      <td className="py-2 pr-4">{event.sourceSystem}</td>
                      <td className="py-2">
                        {proposalId === null ? (
                          <span className="text-muted-foreground">none</span>
                        ) : (
                          <Link
                            href={`/proposals/${proposalId}`}
                            className="underline underline-offset-4 hover:text-primary"
                          >
                            {proposalId}
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
