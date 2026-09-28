import type { CommitmentCandidate } from '@lance/agents';
import { commitments, type Commitment, type Db } from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import { OntologyRepository, normaliseEmail, type SourceRef } from '@lance/ontology';
import {
  firstChaseAt,
  newUlid,
  nowIso,
  type PrincipalIdentity,
  type ProvenanceRef,
} from '@lance/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';

/**
 * Turns extracted commitments into `commitments` rows and their graph
 * relationships (spec 5.1, 5.2). Deterministic: the people are resolved
 * through the ontology, the row is written once, and the ledger records
 * it. A commitment already open with the same direction, counterparty and
 * description is not recorded again.
 *
 * An inbound commitment only possibly owed to the principal is recorded
 * `unconfirmed` (ADR 0037), where nothing chases or alerts on it. When a
 * later source makes the same promise definitely, the waiting row is
 * opened rather than a second one recorded.
 */

export const COMMITMENTS_ACTOR = 'system:commitments';

export interface KnownPerson {
  name: string;
  email: string | null;
}

export interface RecordCommitmentsDeps {
  db: Db;
  ontology: OntologyRepository;
  /** The principal whose context this is; the Person every commitment is owed by or to. */
  principal: PrincipalIdentity;
  now?: () => string;
}

export interface RecordCommitmentsContext {
  correlationId: string;
  actor: string;
  /** Where the commitments came from; at least one ref, the first names the source record. */
  provenance: ProvenanceRef[];
  /** Ontology node the commitments derive from (a Meeting or Thread), when one exists. */
  derivedFromNodeId?: string | null;
  /** People named in the source, to fill in an email the model did not give. */
  directory?: readonly KnownPerson[];
}

export interface RecordedCommitment {
  id: string;
  direction: CommitmentCandidate['direction'];
  /** `open`, or `unconfirmed` for an inbound promise the principal may not be owed. */
  status: RecordedStatus;
  description: string;
  counterpartyPersonId: string;
}

export interface RecordCommitmentsResult {
  recorded: RecordedCommitment[];
  /** Unconfirmed rows a definite repeat of the same promise opened. */
  confirmed: string[];
  skipped: number;
}

export type RecordedStatus = Extract<Commitment['status'], 'open' | 'unconfirmed'>;

/**
 * The status a candidate is recorded with: open for anything the principal
 * owes and anything definitely owed to them, unconfirmed otherwise. A
 * candidate that reached here without a certainty is treated as possible.
 */
export function recordedStatusOf(
  candidate: Pick<CommitmentCandidate, 'direction' | 'owedToPrincipal'>,
): RecordedStatus {
  if (candidate.direction === 'outbound') return 'open';
  return candidate.owedToPrincipal === 'definite' ? 'open' : 'unconfirmed';
}

/** Why the recorder opened an unconfirmed commitment, in its ledger event. */
export const CONFIRMED_BY_REPEAT_REASON =
  'A later source made the same promise to the principal directly.';

function sourceRefOf(ref: ProvenanceRef): SourceRef {
  return {
    system: ref.system,
    id: ref.recordId,
    observedAt: ref.observedAt,
    ...(ref.url === undefined ? {} : { url: ref.url }),
  };
}

function counterpartyEmail(
  candidate: CommitmentCandidate,
  directory: readonly KnownPerson[],
): string | null {
  if (candidate.counterpartyEmail !== null && candidate.counterpartyEmail.includes('@')) {
    return normaliseEmail(candidate.counterpartyEmail);
  }
  const wanted = candidate.counterpartyName?.trim().toLowerCase();
  if (wanted === undefined || wanted === '') return null;
  const hit = directory.find(
    (person) => person.email !== null && person.name.trim().toLowerCase() === wanted,
  );
  return hit?.email === undefined || hit.email === null ? null : normaliseEmail(hit.email);
}

function dueDate(candidate: CommitmentCandidate): Date | null {
  if (candidate.dueAt === null) return null;
  const parsed = new Date(candidate.dueAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function recordCommitments(
  deps: RecordCommitmentsDeps,
  candidates: readonly CommitmentCandidate[],
  context: RecordCommitmentsContext,
): Promise<RecordCommitmentsResult> {
  const now = deps.now ?? nowIso;
  const ledger = new LedgerWriter(deps.db);
  const mutation = { correlationId: context.correlationId, actor: context.actor };
  const first = context.provenance[0];
  if (first === undefined) {
    throw new Error('Commitments cannot be recorded without provenance (non-negotiable 5).');
  }
  const sourceRef = sourceRefOf(first);
  const directory = context.directory ?? [];

  const principal = await deps.ontology.upsertPerson(
    {
      displayName: deps.principal.name,
      emails: [deps.principal.email],
      notionUserId: deps.principal.notionUserId,
      isInternal: true,
      sourceRef: { system: 'lance', id: 'principal', observedAt: now() },
    },
    mutation,
  );

  const recorded: RecordedCommitment[] = [];
  const confirmed: string[] = [];
  let skipped = 0;

  for (const candidate of candidates) {
    const email = counterpartyEmail(candidate, directory);
    const name = candidate.counterpartyName?.trim() || email || null;
    if (name === null) {
      skipped += 1;
      continue;
    }
    const counterparty = await deps.ontology.resolvePerson(
      { displayName: name, emails: email === null ? [] : [email], sourceRef },
      mutation,
    );
    if (counterparty.id === principal.id) {
      skipped += 1;
      continue;
    }

    const status = recordedStatusOf(candidate);
    const duplicates = await deps.db
      .select({ id: commitments.id, status: commitments.status })
      .from(commitments)
      .where(
        and(
          eq(commitments.direction, candidate.direction),
          eq(commitments.counterpartyPersonId, counterparty.id),
          inArray(commitments.status, ['open', 'chased', 'unconfirmed']),
          sql`lower(${commitments.description}) = lower(${candidate.description})`,
        ),
      )
      .limit(1);
    const duplicate = duplicates[0];
    if (duplicate !== undefined) {
      if (duplicate.status === 'unconfirmed' && status === 'open') {
        await confirmByRepeat(deps.db, ledger, duplicate.id, now(), {
          ...mutation,
          provenance: context.provenance,
        });
        confirmed.push(duplicate.id);
      } else {
        skipped += 1;
      }
      continue;
    }

    const id = newUlid();
    const due = dueDate(candidate);
    const nextChaseAt =
      candidate.direction === 'inbound' && due !== null ? firstChaseAt(due) : null;
    // The owner is who owes: the principal for outbound, the counterparty for inbound.
    const ownerPersonId = candidate.direction === 'outbound' ? principal.id : counterparty.id;
    await deps.db.insert(commitments).values({
      id,
      direction: candidate.direction,
      ownerPersonId,
      counterpartyPersonId: counterparty.id,
      description: candidate.description,
      dueAt: due,
      dueConfidence: candidate.dueConfidence,
      evidenceQuote: candidate.evidenceQuote,
      sourceRefs: context.provenance,
      status,
      nextChaseAt,
    });

    await deps.ontology.ensureCommitment(id, mutation);
    await deps.ontology.link(id, 'OWES', ownerPersonId, {}, mutation);
    await deps.ontology.link(
      id,
      'OWED_TO',
      candidate.direction === 'outbound' ? counterparty.id : principal.id,
      {},
      mutation,
    );
    if (context.derivedFromNodeId) {
      await deps.ontology.link(id, 'DERIVED_FROM', context.derivedFromNodeId, {}, mutation);
    }

    await ledger.append({
      ts: now(),
      actor: context.actor,
      kind: 'resolved',
      sourceSystem: first.system,
      sourceRecordId: first.recordId,
      correlationId: context.correlationId,
      payload: {
        kind: 'commitment_recorded',
        commitmentId: id,
        direction: candidate.direction,
        status,
        promisedTo: candidate.promisedTo,
        owedToPrincipal: candidate.owedToPrincipal,
        description: candidate.description,
        counterpartyPersonId: counterparty.id,
        counterpartyResolution: counterparty.decision,
        dueAt: due === null ? null : due.toISOString(),
        provenance: context.provenance,
      },
    });
    recorded.push({
      id,
      direction: candidate.direction,
      status,
      description: candidate.description,
      counterpartyPersonId: counterparty.id,
    });
  }

  return { recorded, confirmed, skipped };
}

/**
 * Opens an unconfirmed commitment a definite repeat has confirmed. The
 * status is part of the WHERE clause, so a principal who dropped it in the
 * meantime keeps their decision and no event is written.
 */
async function confirmByRepeat(
  db: Db,
  ledger: LedgerWriter,
  id: string,
  ts: string,
  context: { correlationId: string; actor: string; provenance: ProvenanceRef[] },
): Promise<void> {
  const rows = await db
    .update(commitments)
    .set({ status: 'open', updatedAt: new Date(ts) })
    .where(and(eq(commitments.id, id), eq(commitments.status, 'unconfirmed')))
    .returning({ id: commitments.id });
  if (rows.length === 0) return;
  const first = context.provenance[0];
  await ledger.append({
    ts,
    actor: context.actor,
    kind: 'resolved',
    sourceSystem: first?.system ?? 'lance',
    sourceRecordId: first?.recordId ?? id,
    correlationId: context.correlationId,
    payload: {
      kind: 'commitment_status',
      commitmentId: id,
      from: 'unconfirmed',
      to: 'open',
      reason: CONFIRMED_BY_REPEAT_REASON,
      provenance: context.provenance,
    },
  });
}
