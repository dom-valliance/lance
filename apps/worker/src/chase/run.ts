import { runAgent, type AgentDeps, type ProposalDraft } from '@lance/agents';
import { commitments, type Commitment, type Db } from '@lance/db';
import { LedgerWriter } from '@lance/ledger';
import type { OntologyRepository } from '@lance/ontology';
import {
  newUlid,
  nowIso,
  ProvenanceRefSchema,
  type Config,
  type PrincipalIdentity,
  type ProvenanceRef,
} from '@lance/shared';
import { eq } from 'drizzle-orm';
import type { createProposalHandler } from '../executor/createProposal.js';
import { chaseSystemPrompt, chaseUserPrompt } from './prompt.js';
import { ChaseDraftSchema } from './schema.js';

/**
 * The chase (spec 9.2, spec 10.1 item 4): one email draft for something
 * somebody owes Dom, created as a `draft_email` proposal. The model writes
 * the words and nothing else; the proposal, the policy decision and the
 * status change are deterministic code, and no email is sent from here
 * (non-negotiables 2 and 3).
 */

export const CHASE_VERSION = '0.1.0';
export const CHASE_ACTOR = `agent:chase@${CHASE_VERSION}`;

/** How long after a chase the next one is due. */
const NEXT_CHASE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ChaseDeps {
  db: Db;
  config: Pick<Config, 'agentDisplayName' | 'models'>;
  /** The principal the chase is sent for, named in the draft's instructions. */
  principal: Pick<PrincipalIdentity, 'name'>;
  agent: AgentDeps;
  ontology: Pick<OntologyRepository, 'getNode'>;
  createProposal: ReturnType<typeof createProposalHandler>;
  now?: () => string;
}

export interface ChaseInput {
  commitmentId: string;
  /** Supplied by a caller that already has a trail to join; otherwise a new one. */
  correlationId?: string;
}

export type ChaseResult =
  | { status: 'drafted'; proposalId: string; correlationId: string }
  | { status: 'refused'; reason: string; correlationId: string };

interface Person {
  name: string;
  email: string | null;
}

function personOf(id: string, node: { properties: Record<string, unknown> } | null): Person {
  if (node === null) return { name: id, email: null };
  const displayName = node.properties['display_name'];
  const emails = node.properties['emails'];
  const email = Array.isArray(emails)
    ? (emails.find((value): value is string => typeof value === 'string' && value !== '') ?? null)
    : null;
  return {
    name: typeof displayName === 'string' && displayName !== '' ? displayName : id,
    email,
  };
}

function provenanceOf(value: unknown): ProvenanceRef[] {
  if (!Array.isArray(value)) return [];
  const refs: ProvenanceRef[] = [];
  for (const entry of value) {
    const parsed = ProvenanceRefSchema.safeParse(entry);
    if (parsed.success) refs.push(parsed.data);
  }
  return refs;
}

function wholeDaysBetween(from: Date, to: Date): number {
  const days = Math.floor((to.getTime() - from.getTime()) / DAY_MS);
  return days < 0 ? 0 : days;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/**
 * Chases one commitment. Every refusal is a ledger event rather than a
 * thrown error: a job that cannot be chased has still been looked at, and
 * the reason belongs in the trail.
 */
export async function runChase(deps: ChaseDeps, input: ChaseInput): Promise<ChaseResult> {
  const now = deps.now ?? nowIso;
  const ts = now();
  const correlationId = input.correlationId ?? newUlid();
  const ledger = new LedgerWriter(deps.db);

  const refuse = async (reason: string): Promise<ChaseResult> => {
    await ledger.append({
      ts: now(),
      actor: CHASE_ACTOR,
      kind: 'failed',
      sourceSystem: 'lance',
      sourceRecordId: input.commitmentId,
      correlationId,
      payload: { kind: 'commitment_chase_refused', commitmentId: input.commitmentId, reason },
    });
    return { status: 'refused', reason, correlationId };
  };

  const rows = await deps.db
    .select()
    .from(commitments)
    .where(eq(commitments.id, input.commitmentId))
    .limit(1);
  const commitment: Commitment | undefined = rows[0];
  if (commitment === undefined) {
    return refuse(`Commitment ${input.commitmentId} does not exist, so there is nothing to chase.`);
  }
  if (commitment.direction !== 'inbound') {
    return refuse(
      `Commitment ${commitment.id} is outbound: Dom owes it, so it is not his to chase.`,
    );
  }
  if (commitment.status !== 'open' && commitment.status !== 'chased') {
    return refuse(
      `Commitment ${commitment.id} is ${commitment.status}, and only an open or chased commitment is worth chasing.`,
    );
  }

  const provenance = provenanceOf(commitment.sourceRefs);
  if (provenance[0] === undefined) {
    return refuse(
      `Commitment ${commitment.id} carries no usable provenance, and no proposal may be made without it (non-negotiable 5).`,
    );
  }

  const counterparty = personOf(
    commitment.counterpartyPersonId,
    await deps.ontology.getNode(commitment.counterpartyPersonId),
  );
  const owner =
    commitment.ownerPersonId === commitment.counterpartyPersonId
      ? counterparty
      : personOf(commitment.ownerPersonId, await deps.ontology.getNode(commitment.ownerPersonId));
  if (counterparty.email === null) {
    return refuse(
      `${counterparty.name} has no email address in the ontology, so the chase for commitment ${commitment.id} cannot be addressed.`,
    );
  }

  const at = new Date(ts);
  const due = commitment.dueAt;
  const draft = await runAgent(
    deps.agent,
    {
      name: 'chase-draft',
      version: CHASE_VERSION,
      model: deps.config.models.triage,
      system: chaseSystemPrompt(deps.config.agentDisplayName, deps.principal.name),
      tools: [],
      outputSchema: ChaseDraftSchema,
      maxIterations: 1,
    },
    {
      correlationId,
      prompt: chaseUserPrompt({
        counterpartyName: firstName(counterparty.name),
        description: commitment.description,
        evidenceQuote: commitment.evidenceQuote,
        dueDate: due === null ? null : due.toISOString().slice(0, 10),
        overdueDays:
          due === null || due.getTime() >= at.getTime() ? null : wholeDaysBetween(due, at),
        ageDays: wholeDaysBetween(commitment.createdAt, at),
        chaseCount: commitment.chaseCount,
      }),
    },
  );

  const proposal: ProposalDraft = {
    actionClass: 'draft_email',
    counterpartyClass: 'unknown',
    targetSystem: 'graph',
    targetRecordId: null,
    payload: {
      subject: draft.output.subject,
      bodyText: draft.output.bodyText,
      to: [counterparty.email],
      commitmentId: commitment.id,
    },
    preview: `Chase ${counterparty.name} for "${commitment.description}"`,
    rationale: `${owner.name} owes this since ${commitment.createdAt.toISOString().slice(0, 10)} and the draft states only what the source record supports.`,
    provenance,
    confidence: 0.7,
  };
  const outcome = await deps.createProposal(proposal, { correlationId, actor: CHASE_ACTOR });
  if (outcome.decision === 'forbid') {
    // Policy refused the draft, so nothing reached Dom and the commitment
    // is not chased: it stays where it was, with the refusal in the ledger.
    return refuse(`Policy forbids a chase email for commitment ${commitment.id}.`);
  }

  // The row update and its ledger event commit together; a held proposal
  // (dry run) still counts as a chase, because the draft exists and is
  // released to Dom on resume.
  await deps.db.transaction(async (tx) => {
    await tx
      .update(commitments)
      .set({
        status: 'chased',
        chaseCount: commitment.chaseCount + 1,
        nextChaseAt: new Date(at.getTime() + NEXT_CHASE_DAYS * DAY_MS),
        updatedAt: at,
      })
      .where(eq(commitments.id, commitment.id));
    await ledger.append(
      {
        ts: now(),
        actor: CHASE_ACTOR,
        kind: 'resolved',
        sourceSystem: 'lance',
        sourceRecordId: commitment.id,
        correlationId,
        payload: {
          kind: 'commitment_chased',
          commitmentId: commitment.id,
          proposalId: outcome.proposalId,
          proposalStatus: outcome.status,
        },
      },
      tx,
    );
  });

  return { status: 'drafted', proposalId: outcome.proposalId, correlationId };
}
