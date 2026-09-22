import type { CommitmentCandidate } from '@lance/agents';
import { commitments, type Db } from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import { OntologyRepository, normaliseEmail, type SourceRef } from '@lance/ontology';
import { newUlid, nowIso, type ProvenanceRef } from '@lance/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';

/**
 * Turns extracted commitments into `commitments` rows and their graph
 * relationships (spec 5.1, 5.2). Deterministic: the people are resolved
 * through the ontology, the row is written once, and the ledger records
 * it. A commitment already open with the same direction, counterparty and
 * description is not recorded again.
 */

export const COMMITMENTS_ACTOR = 'system:commitments';

/** How long after the due date an inbound commitment is first chased. */
const CHASE_GRACE_DAYS = 2;

export interface DomIdentity {
  name: string;
  email: string;
  notionUserId?: string | null;
}

export interface KnownPerson {
  name: string;
  email: string | null;
}

export interface RecordCommitmentsDeps {
  db: Db;
  ontology: OntologyRepository;
  dom: DomIdentity;
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
  description: string;
  counterpartyPersonId: string;
}

export interface RecordCommitmentsResult {
  recorded: RecordedCommitment[];
  skipped: number;
}

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

  const dom = await deps.ontology.upsertPerson(
    {
      displayName: deps.dom.name,
      emails: [deps.dom.email],
      notionUserId: deps.dom.notionUserId ?? null,
      isInternal: true,
      sourceRef: { system: 'lance', id: 'dom', observedAt: now() },
    },
    mutation,
  );

  const recorded: RecordedCommitment[] = [];
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
    if (counterparty.id === dom.id) {
      skipped += 1;
      continue;
    }

    const duplicate = await deps.db
      .select({ id: commitments.id })
      .from(commitments)
      .where(
        and(
          eq(commitments.direction, candidate.direction),
          eq(commitments.counterpartyPersonId, counterparty.id),
          inArray(commitments.status, ['open', 'chased']),
          sql`lower(${commitments.description}) = lower(${candidate.description})`,
        ),
      )
      .limit(1);
    if (duplicate.length > 0) {
      skipped += 1;
      continue;
    }

    const id = newUlid();
    const due = dueDate(candidate);
    const nextChaseAt =
      candidate.direction === 'inbound' && due !== null
        ? new Date(due.getTime() + CHASE_GRACE_DAYS * 24 * 3600 * 1000)
        : null;
    // The owner is who owes: Dom for outbound, the counterparty for inbound.
    const ownerPersonId = candidate.direction === 'outbound' ? dom.id : counterparty.id;
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
      status: 'open',
      nextChaseAt,
    });

    await deps.ontology.ensureCommitment(id, mutation);
    await deps.ontology.link(id, 'OWES', ownerPersonId, {}, mutation);
    await deps.ontology.link(
      id,
      'OWED_TO',
      candidate.direction === 'outbound' ? counterparty.id : dom.id,
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
      description: candidate.description,
      counterpartyPersonId: counterparty.id,
    });
  }

  return { recorded, skipped };
}
