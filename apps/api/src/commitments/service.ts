import { newUlid, nowIso } from '@lance/shared';
import { TRPCError } from '@trpc/server';
import type { Commitment } from '@lance/db';
import { DOM_ACTOR, type ApiDeps } from '../deps.js';
import { toCommitmentView, toPersonView, type CommitmentView, type PersonView } from './view.js';

/**
 * What the Commitments page asks for (spec 12): the two lists, one
 * commitment, the two resolutions Dom can make himself, and the chase that
 * hands the drafting to the worker. Every resolution appends a `resolved`
 * ledger event, so a status the page shows can always be traced back to who
 * changed it and when (non-negotiable 1).
 */

export type CommitmentDeps = Pick<
  ApiDeps,
  'commitments' | 'ontology' | 'writer' | 'enqueueChase' | 'now'
>;

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** The statuses a commitment can be resolved from; done and dropped are final. */
const RESOLVABLE_FROM: Commitment['status'][] = ['open', 'chased'];

export interface ListCommitmentsInput {
  direction?: Commitment['direction'] | undefined;
  status?: Commitment['status'] | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface CommitmentPage {
  items: CommitmentView[];
  nextCursor: string | null;
}

/**
 * Resolves person ids to names once each, so a page of commitments between
 * the same two people costs two graph reads rather than two per row.
 */
function personLoader(deps: CommitmentDeps): (id: string) => Promise<PersonView> {
  const seen = new Map<string, Promise<PersonView>>();
  return (id) => {
    const cached = seen.get(id);
    if (cached !== undefined) return cached;
    const loading = deps.ontology.getNode(id).then((node) => toPersonView(id, node));
    seen.set(id, loading);
    return loading;
  };
}

async function render(
  deps: CommitmentDeps,
  rows: readonly Commitment[],
  now: Date,
): Promise<CommitmentView[]> {
  const person = personLoader(deps);
  const views: CommitmentView[] = [];
  for (const row of rows) {
    views.push(
      toCommitmentView(
        row,
        {
          owner: await person(row.ownerPersonId),
          counterparty: await person(row.counterpartyPersonId),
        },
        now,
      ),
    );
  }
  return views;
}

export async function listCommitments(
  deps: CommitmentDeps,
  input: ListCommitmentsInput,
): Promise<CommitmentPage> {
  const now = new Date((deps.now ?? nowIso)());
  const size = Math.min(input.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  // One row beyond the page tells us whether a next page exists without a count.
  const rows = await deps.commitments.list({
    limit: size + 1,
    ...(input.direction === undefined ? {} : { direction: input.direction }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  });
  const page = rows.slice(0, size);
  const nextCursor = rows.length > size ? (page.at(-1)?.id ?? null) : null;
  return { items: await render(deps, page, now), nextCursor };
}

export async function getCommitment(
  deps: CommitmentDeps,
  id: string,
): Promise<CommitmentView | null> {
  const row = await deps.commitments.get(id);
  if (row === null) return null;
  const views = await render(deps, [row], new Date((deps.now ?? nowIso)()));
  return views[0] ?? null;
}

export interface ResolveCommitmentInput {
  id: string;
  to: Extract<Commitment['status'], 'done' | 'dropped'>;
  reason?: string;
}

/**
 * Marks a commitment done or dropped. A commitment already in that status
 * is left alone and no second event is written, so a double click on the
 * page cannot double-write the ledger.
 */
export async function resolveCommitment(
  deps: CommitmentDeps,
  input: ResolveCommitmentInput,
): Promise<CommitmentView> {
  const ts = (deps.now ?? nowIso)();
  const existing = await deps.commitments.get(input.id);
  if (existing === null) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `Commitment ${input.id} does not exist. Check the id on the Commitments page.`,
    });
  }
  if (existing.status === input.to) {
    const views = await render(deps, [existing], new Date(ts));
    return views[0] as CommitmentView;
  }
  if (!RESOLVABLE_FROM.includes(existing.status)) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `Commitment ${input.id} is already ${existing.status}, so it cannot be marked ${input.to}.`,
    });
  }

  const updated = await deps.commitments.setStatus({
    id: input.id,
    from: RESOLVABLE_FROM,
    to: input.to,
    at: new Date(ts),
  });
  if (updated === null) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `Commitment ${input.id} changed while it was being marked ${input.to}. Reload the page and try again.`,
    });
  }

  await deps.writer.append({
    ts,
    actor: DOM_ACTOR,
    kind: 'resolved',
    sourceSystem: 'lance',
    sourceRecordId: input.id,
    correlationId: newUlid(),
    payload: {
      kind: 'commitment_status',
      commitmentId: input.id,
      from: existing.status,
      to: input.to,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    },
  });

  const views = await render(deps, [updated], new Date(ts));
  return views[0] as CommitmentView;
}

export interface ChaseEnqueued {
  enqueued: true;
  jobId: string;
}

/**
 * Puts the commitment on the `chase` queue. The api drafts nothing: the
 * worker loads the commitment, runs the model and creates the proposal, so
 * there is no path from this request to an outbound email.
 */
export async function chaseCommitment(deps: CommitmentDeps, id: string): Promise<ChaseEnqueued> {
  const existing = await deps.commitments.get(id);
  if (existing === null) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `Commitment ${id} does not exist. Check the id on the Commitments page.`,
    });
  }
  const jobId = await deps.enqueueChase(id);
  return { enqueued: true, jobId };
}
