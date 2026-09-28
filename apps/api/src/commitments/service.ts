import { COMMITMENT_NOTE_MAX_CHARS, type Commitment } from '@lance/db';
import { dueAtFromDay, firstChaseAt, newUlid, nowIso } from '@lance/shared';
import { TRPCError } from '@trpc/server';
import { DOM_ACTOR, type ApiDeps } from '../deps.js';
import type { CommitmentCountQuery, CommitmentEdit, CommitmentSummary } from './store.js';
import {
  sourceRefsOf,
  toCommitmentView,
  toNoteView,
  toPersonView,
  toSourceContext,
  type CommitmentNoteView,
  type CommitmentView,
  type PersonView,
  type SourceContextView,
} from './view.js';

/**
 * What the Commitments page asks for (spec 12, ADR 0036): the two lists,
 * one commitment with its notes and source context, the status changes,
 * edits and notes the principal makes by hand, and the chase that hands the
 * drafting to the worker. Every change appends a `resolved` ledger event,
 * so what the page shows can always be traced back to who changed it and
 * when (non-negotiable 1).
 */

export type CommitmentDeps = Pick<
  ApiDeps,
  'commitments' | 'ontology' | 'writer' | 'enqueueChase' | 'config' | 'now'
>;

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** The longest description the principal may give a commitment. */
export const COMMITMENT_DESCRIPTION_MAX_CHARS = 500;

const notFound = (id: string): TRPCError =>
  new TRPCError({
    code: 'NOT_FOUND',
    message: `Commitment ${id} does not exist. Check the id on the Commitments page.`,
  });

const changedMeanwhile = (id: string, doing: string): TRPCError =>
  new TRPCError({
    code: 'CONFLICT',
    message: `Commitment ${id} changed while it was being ${doing}. Reload the page and try again.`,
  });

export interface ListCommitmentsInput {
  direction?: Commitment['direction'] | undefined;
  status?: Commitment['status'] | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface CommitmentPage {
  items: CommitmentView[];
  nextCursor: string | null;
  /** Every commitment the filters match, across all pages. */
  total: number;
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
  const filter: CommitmentCountQuery = {
    ...(input.direction === undefined ? {} : { direction: input.direction }),
    ...(input.status === undefined ? {} : { status: input.status }),
  };
  // One row beyond the page tells us whether a next page exists; the count
  // runs beside it over the same filters, without the cursor.
  const [rows, total] = await Promise.all([
    deps.commitments.list({
      ...filter,
      limit: size + 1,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    }),
    deps.commitments.count(filter),
  ]);
  const page = rows.slice(0, size);
  const nextCursor = rows.length > size ? (page.at(-1)?.id ?? null) : null;
  return { items: await render(deps, page, now), nextCursor, total };
}

/** Open and overdue counts for both tabs, for the page header and the tab labels. */
export async function commitmentSummary(deps: CommitmentDeps): Promise<CommitmentSummary> {
  return deps.commitments.summary(new Date((deps.now ?? nowIso)()));
}

export async function getCommitment(
  deps: CommitmentDeps,
  id: string,
): Promise<CommitmentView | null> {
  const row = await deps.commitments.get(id);
  if (row === null) return null;
  return renderOne(deps, row, new Date((deps.now ?? nowIso)()));
}

async function renderOne(
  deps: CommitmentDeps,
  row: Commitment,
  now: Date,
): Promise<CommitmentView> {
  const views = await render(deps, [row], now);
  return views[0] as CommitmentView;
}

export interface CommitmentDetail {
  commitment: CommitmentView;
  notes: CommitmentNoteView[];
  /** One entry per provenance ref, in the order the commitment cites them. */
  sources: SourceContextView[];
}

/**
 * The commitment page: the row, the principal's notes on it, and the
 * source records it was read from, as Lance last observed them. Nothing
 * here reaches a source system: the context is what the watchers recorded.
 */
export async function getCommitmentDetail(
  deps: CommitmentDeps,
  id: string,
): Promise<CommitmentDetail | null> {
  const row = await deps.commitments.get(id);
  if (row === null) return null;
  const refs = sourceRefsOf(row.sourceRefs);
  const [commitment, notes, observed] = await Promise.all([
    renderOne(deps, row, new Date((deps.now ?? nowIso)())),
    deps.commitments.notes(id),
    deps.commitments.sources(refs.map((ref) => ({ system: ref.system, recordId: ref.recordId }))),
  ]);
  const sources = refs.map((ref) =>
    toSourceContext(
      ref,
      observed.find(
        (candidate) =>
          candidate.sourceSystem === ref.system && candidate.sourceRecordId === ref.recordId,
      ),
      row.evidenceQuote,
    ),
  );
  return { commitment, notes: notes.map(toNoteView), sources };
}

export interface ChangeCommitmentStatusInput {
  id: string;
  to: Commitment['status'];
  /** Required to drop; kept in the ledger for any other change. */
  reason?: string;
  /** The ledger actor, derived from the verified UPN by the router. */
  actor?: string;
}

/**
 * Moves a commitment to any other status, including back from done or
 * dropped (ADR 0036). A commitment already in that status is left alone
 * and no second event is written, so a double click cannot double-write
 * the ledger. Dropping needs a reason, `chased` is only for a commitment
 * that has been chased at least once, and only an inbound commitment can go
 * back to `unconfirmed`, the triage bucket (ADR 0037).
 */
export async function changeCommitmentStatus(
  deps: CommitmentDeps,
  input: ChangeCommitmentStatusInput,
): Promise<CommitmentView> {
  const ts = (deps.now ?? nowIso)();
  const existing = await deps.commitments.get(input.id);
  if (existing === null) throw notFound(input.id);
  if (existing.status === input.to) return renderOne(deps, existing, new Date(ts));

  const reason = input.reason?.trim();
  if (input.to === 'dropped' && (reason === undefined || reason === '')) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Give a reason to drop commitment ${input.id}; it is kept in the ledger.`,
    });
  }
  if (input.to === 'unconfirmed' && existing.direction === 'outbound') {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `Commitment ${input.id} is one you owe, so there is no doubt it is yours. Only a commitment owed to you can go back to triage.`,
    });
  }
  if (input.to === 'chased' && existing.chaseCount === 0) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: `Commitment ${input.id} has never been chased, so it cannot be marked chased. Choose Open instead.`,
    });
  }

  // `from` is the one status just read, so two changes racing each other
  // cannot both land and both append a ledger event.
  const updated = await deps.commitments.setStatus({
    id: input.id,
    from: [existing.status],
    to: input.to,
    at: new Date(ts),
  });
  if (updated === null) throw changedMeanwhile(input.id, `marked ${input.to}`);

  await deps.writer.append({
    ts,
    actor: input.actor ?? DOM_ACTOR,
    kind: 'resolved',
    sourceSystem: 'lance',
    sourceRecordId: input.id,
    correlationId: newUlid(),
    payload: {
      kind: 'commitment_status',
      commitmentId: input.id,
      from: existing.status,
      to: input.to,
      ...(reason === undefined || reason === '' ? {} : { reason }),
    },
  });

  return renderOne(deps, updated, new Date(ts));
}

export interface ResolveCommitmentInput {
  id: string;
  to: Extract<Commitment['status'], 'done' | 'dropped'>;
  reason?: string;
  actor?: string;
}

/** Marks a commitment done or dropped: the list page's two buttons. */
export async function resolveCommitment(
  deps: CommitmentDeps,
  input: ResolveCommitmentInput,
): Promise<CommitmentView> {
  return changeCommitmentStatus(deps, input);
}

export interface EditCommitmentInput {
  id: string;
  description?: string;
  /** A day written `YYYY-MM-DD`, read in the configured time zone; null clears the date. */
  dueDay?: string | null;
  actor?: string;
}

const sameInstant = (left: Date | null, right: Date | null): boolean =>
  (left?.getTime() ?? null) === (right?.getTime() ?? null);

/**
 * The columns an edit changes, with the chase schedule that follows from a
 * new due date. A date the principal typed carries full confidence. An
 * inbound commitment still running is first chased two days after its new
 * date; one with no date keeps the next chase it already has, or none.
 */
function editFor(
  existing: Commitment,
  description: string | undefined,
  dueAt: Date | null | undefined,
): CommitmentEdit {
  const edit: CommitmentEdit = {};
  if (description !== undefined && description !== existing.description) {
    edit.description = description;
  }
  if (dueAt !== undefined && !sameInstant(dueAt, existing.dueAt)) {
    edit.dueAt = dueAt;
    edit.dueConfidence = dueAt === null ? null : 1;
    const live = existing.status === 'open' || existing.status === 'chased';
    if (existing.direction === 'inbound' && live) {
      if (dueAt !== null) edit.nextChaseAt = firstChaseAt(dueAt);
      else if (existing.chaseCount === 0) edit.nextChaseAt = null;
    }
  }
  return edit;
}

/**
 * Changes a commitment's description or due date by hand. The evidence
 * quote and the provenance stay as the source had them, so the claim can
 * still be checked against the record (non-negotiable 5). An edit that
 * changes nothing writes nothing.
 */
export async function editCommitment(
  deps: CommitmentDeps,
  input: EditCommitmentInput,
): Promise<CommitmentView> {
  const ts = (deps.now ?? nowIso)();
  const existing = await deps.commitments.get(input.id);
  if (existing === null) throw notFound(input.id);

  const description = input.description?.trim();
  if (description === '') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Commitment ${input.id} needs a description. Write what was promised.`,
    });
  }
  let dueAt: Date | null | undefined;
  try {
    dueAt =
      input.dueDay === undefined || input.dueDay === null
        ? input.dueDay
        : dueAtFromDay(input.dueDay, deps.config.timeZone);
  } catch (error) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        error instanceof Error ? error.message : `The due date for ${input.id} is not a day.`,
    });
  }

  const edit = editFor(existing, description, dueAt);
  if (Object.keys(edit).length === 0) return renderOne(deps, existing, new Date(ts));

  const updated = await deps.commitments.update({
    id: input.id,
    set: edit,
    unchangedSince: existing.updatedAt,
    at: new Date(ts),
  });
  if (updated === null) throw changedMeanwhile(input.id, 'edited');

  const changes: Record<string, { from: string | null; to: string | null }> = {};
  if (edit.description !== undefined) {
    changes['description'] = { from: existing.description, to: edit.description };
  }
  if (edit.dueAt !== undefined) {
    changes['dueAt'] = {
      from: existing.dueAt?.toISOString() ?? null,
      to: edit.dueAt?.toISOString() ?? null,
    };
  }
  await deps.writer.append({
    ts,
    actor: input.actor ?? DOM_ACTOR,
    kind: 'resolved',
    sourceSystem: 'lance',
    sourceRecordId: input.id,
    correlationId: newUlid(),
    payload: { kind: 'commitment_edited', commitmentId: input.id, changes },
  });

  return renderOne(deps, updated, new Date(ts));
}

export interface AddCommitmentNoteInput {
  id: string;
  body: string;
  actor?: string;
}

/** Adds the principal's note to a commitment. Notes are never changed or removed. */
export async function addCommitmentNote(
  deps: CommitmentDeps,
  input: AddCommitmentNoteInput,
): Promise<CommitmentNoteView> {
  const body = input.body.trim();
  if (body === '' || body.length > COMMITMENT_NOTE_MAX_CHARS) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `A note must hold between 1 and ${String(COMMITMENT_NOTE_MAX_CHARS)} characters; this one has ${String(body.length)}.`,
    });
  }
  const existing = await deps.commitments.get(input.id);
  if (existing === null) throw notFound(input.id);

  const actor = input.actor ?? DOM_ACTOR;
  const id = newUlid();
  // The ledger event first: a note that reached the table without its event
  // would be a write the ledger cannot account for (non-negotiable 1).
  await deps.writer.append({
    ts: (deps.now ?? nowIso)(),
    actor,
    kind: 'resolved',
    sourceSystem: 'lance',
    sourceRecordId: input.id,
    correlationId: newUlid(),
    payload: { kind: 'commitment_note_added', commitmentId: input.id, noteId: id, body },
  });
  const note = await deps.commitments.addNote({ id, commitmentId: input.id, body, author: actor });
  return toNoteView(note);
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
export async function chaseCommitment(
  deps: CommitmentDeps,
  id: string,
  actor: string = DOM_ACTOR,
): Promise<ChaseEnqueued> {
  const existing = await deps.commitments.get(id);
  if (existing === null) throw notFound(id);
  const jobId = await deps.enqueueChase(id);
  // The request is in the ledger even if the worker never consumes the job.
  await deps.writer.append({
    ts: (deps.now ?? nowIso)(),
    actor,
    kind: 'resolved',
    sourceSystem: 'lance',
    sourceRecordId: id,
    correlationId: newUlid(),
    payload: { kind: 'commitment_chase_requested', commitmentId: id, jobId },
  });
  return { enqueued: true, jobId };
}
