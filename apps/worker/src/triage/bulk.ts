import type { ProposalDraft } from '@lance/agents';
import { proposals, type Db } from '@lance/db';
import { LedgerReader, LedgerWriter, type LedgerEventRow } from '@lance/ledger';
import { organisationDomain, type OntologyRepository } from '@lance/ontology';
import { nowIso, type Config } from '@lance/shared';
import { eq } from 'drizzle-orm';
import type { createProposalHandler } from '../executor/createProposal.js';
import { GRAPH_MAIL_WATCHER_NAME } from '../watchers/graph/mail.js';
import type { TriageJob } from '../watchers/runner.js';
import { labelsOf, proposalContextFor, provenanceFor } from './run.js';

/**
 * Bulk mail skips model triage (ADR 0034). A mail thread whose every
 * message the labeller put only under bulk labels (`config.triage.bulkLabels`,
 * default Newsletters and Notifications) is filed by this deterministic code
 * instead: the category for its labels and the move into AI-Filed, the two
 * actions seed rules 3 and 4 cover, each through the same `create_proposal`
 * handler and policy engine as triage's proposals.
 */

export const BULK_MAIL_VERSION = '0.1.0';
/** Deterministic code, so a system actor; the resolved event carries the version. */
export const BULK_MAIL_ACTOR = 'system:bulk-mail';
/** The folder seed rule 4 lets Lance file into without review. */
export const AI_FILED_FOLDER = 'AI-Filed';
/** A sender at an organisation of these types is worth a model's reading whatever the label says. */
const TRIAGED_ORGANISATION_TYPES: ReadonlySet<string> = new Set(['client', 'prospect']);

export type MailRoute =
  { route: 'bulk'; labels: string[]; reason: string } | { route: 'triage'; reason: string };

/** The fields of an observed graph-mail payload the route reads. */
interface MailPayload {
  watcher: unknown;
  folder: unknown;
  removed: unknown;
  labels: unknown;
  from?: { address?: unknown } | null;
  subject?: unknown;
}

const payloadOf = (event: { payload: unknown }): MailPayload =>
  (event.payload ?? {}) as MailPayload;

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * Whether the batch is bulk mail on its labels alone: every observation an
 * inbox message from the mail watcher, not a removal, with at least one
 * label and none outside the bulk set. Sent mail and tombstones go to
 * triage as before; so does a thread with any other label, `Risk` included.
 */
export function bulkByLabels(
  events: ReadonlyArray<{ payload: unknown }>,
  bulkLabels: readonly string[],
): { bulk: true } | { bulk: false; reason: string } {
  if (events.length === 0) return { bulk: false, reason: 'no observations' };
  for (const event of events) {
    const payload = payloadOf(event);
    if (payload.watcher !== GRAPH_MAIL_WATCHER_NAME) {
      return { bulk: false, reason: 'not an observation from the mail watcher' };
    }
    if (payload.folder !== 'inbox' || payload.removed === true) {
      return { bulk: false, reason: 'not a message arriving in the inbox' };
    }
    const labels = stringsOf(payload.labels);
    if (labels.length === 0) return { bulk: false, reason: 'a message carries no label' };
    const other = labels.filter((label) => !bulkLabels.includes(label));
    if (other.length > 0) {
      return { bulk: false, reason: `a message is labelled ${other.join(', ')}` };
    }
  }
  return { bulk: true };
}

/** The organisation domains of the batch's senders, public mail providers left out. */
export function senderDomains(events: ReadonlyArray<{ payload: unknown }>): string[] {
  const domains = new Set<string>();
  for (const event of events) {
    const address = payloadOf(event).from?.address;
    if (typeof address !== 'string') continue;
    const domain = organisationDomain(address);
    if (domain !== null) domains.add(domain);
  }
  return [...domains];
}

export interface RouteDeps {
  bulkLabels: readonly string[];
  /** The ontology's type for the organisation at a domain, or null when none is known. */
  organisationTypeOf: (domain: string) => Promise<string | null>;
}

/**
 * Where a batch of observations goes: model triage, or the bulk-mail filer.
 * A sender whose domain resolves to an Organisation typed client or
 * prospect sends the batch to triage whatever its labels.
 */
export async function routeMail(
  deps: RouteDeps,
  events: ReadonlyArray<{ payload: unknown }>,
): Promise<MailRoute> {
  const byLabels = bulkByLabels(events, deps.bulkLabels);
  if (!byLabels.bulk) return { route: 'triage', reason: byLabels.reason };
  for (const domain of senderDomains(events)) {
    const type = await deps.organisationTypeOf(domain);
    if (type !== null && TRIAGED_ORGANISATION_TYPES.has(type)) {
      return { route: 'triage', reason: `the sender's domain ${domain} is a ${type}` };
    }
  }
  const labels = labelsOf(events);
  return {
    route: 'bulk',
    labels,
    reason: bulkReason(labels),
  };
}

/** Why a batch was routed around triage, as the ledger records it. */
export function bulkReason(labels: readonly string[]): string {
  return `Every message is labelled only ${labels.join(', ')}, all in the bulk set, and no sender is at a client or prospect, so the seed rules file it without model triage (ADR 0034).`;
}

/** The ontology lookup `routeMail` needs, over the principal's repository. */
export function organisationTypeLookup(
  ontology: Pick<OntologyRepository, 'findOrganisationByDomain'>,
): RouteDeps['organisationTypeOf'] {
  return async (domain) => {
    const node = await ontology.findOrganisationByDomain(domain);
    const type = node?.properties['type'];
    return typeof type === 'string' ? type : null;
  };
}

/** The observed events a job names, as triage reads them. */
export async function observedEventsOf(db: Db, job: TriageJob): Promise<LedgerEventRow[]> {
  return (await new LedgerReader(db).byCorrelation(job.correlationId)).filter(
    (event) => event.kind === 'observed' && job.observationEventIds.includes(event.id),
  );
}

export interface MailRouterDeps {
  db: Db;
  config: Pick<Config, 'triage'>;
  ontology: Pick<OntologyRepository, 'findOrganisationByDomain'> | null;
  sendTriage: (job: TriageJob) => Promise<void>;
  sendBulk: (job: TriageJob) => Promise<void>;
}

/**
 * What the watcher runner calls in place of a plain triage send: mail
 * batches are routed, everything else goes to triage unread.
 */
export function createMailRouter(deps: MailRouterDeps): (job: TriageJob) => Promise<void> {
  const organisationTypeOf =
    deps.ontology === null ? () => Promise.resolve(null) : organisationTypeLookup(deps.ontology);
  return async (job) => {
    if (job.watcher !== GRAPH_MAIL_WATCHER_NAME) {
      await deps.sendTriage(job);
      return;
    }
    const events = await observedEventsOf(deps.db, job);
    const route = await routeMail(
      { bulkLabels: deps.config.triage.bulkLabels, organisationTypeOf },
      events,
    );
    await (route.route === 'bulk' ? deps.sendBulk(job) : deps.sendTriage(job));
  };
}

function subjectOf(event: { payload: unknown }): string {
  const subject = payloadOf(event).subject;
  return typeof subject === 'string' && subject.trim() !== '' ? subject.trim() : '(no subject)';
}

/**
 * The proposals for one bulk message: its labels as Outlook categories,
 * then the move into AI-Filed. In that order, because the move gives the
 * message a new id and the category is applied to the one observed.
 */
export function bulkFilingDrafts(event: LedgerEventRow): ProposalDraft[] {
  const recordId = event.sourceRecordId;
  if (recordId === null) return [];
  const provenance = provenanceFor([event], recordId);
  if (provenance.length === 0) return [];
  const labels = stringsOf(payloadOf(event).labels);
  const subject = subjectOf(event);
  const labelled = `The mail labeller put this message under ${labels.join(', ')} only`;
  const base = {
    counterpartyClass: 'unknown',
    targetSystem: 'graph',
    targetRecordId: recordId,
    provenance,
    // Deterministic: given the labels, the rule applies with certainty. The
    // uncertainty is the label's, and the label call reports none.
    confidence: 1,
  } as const;
  return [
    {
      ...base,
      actionClass: 'apply_category',
      payload: { categories: labels },
      preview: `Apply category ${labels.join(', ')} to "${subject}"`,
      rationale: `${labelled}; bulk mail is categorised by label without model triage (ADR 0034).`,
    },
    {
      ...base,
      actionClass: 'move_mail',
      payload: { destinationFolderName: AI_FILED_FOLDER, sourceFolderId: 'inbox' },
      preview: `Move "${subject}" from Inbox to ${AI_FILED_FOLDER}`,
      rationale: `${labelled}; bulk mail is filed into ${AI_FILED_FOLDER} without model triage (ADR 0034).`,
    },
  ];
}

export interface BulkMailDeps {
  db: Db;
  config: Pick<Config, 'watchers' | 'triage'>;
  createProposal: ReturnType<typeof createProposalHandler>;
  now?: () => string;
}

export interface BulkMailResult {
  correlationId: string;
  proposalIds: string[];
}

/** `actionClass|targetRecordId` to proposal id for the proposals already on a correlation id. */
async function existingProposals(db: Db, correlationId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({
      id: proposals.id,
      actionClass: proposals.actionClass,
      targetRecordId: proposals.targetRecordId,
    })
    .from(proposals)
    .where(eq(proposals.correlationId, correlationId));
  return new Map(rows.map((row) => [`${row.actionClass}|${row.targetRecordId ?? ''}`, row.id]));
}

/**
 * Files one bulk-mail batch: proposes each message's category and move,
 * then records in the ledger that the batch was routed around triage and
 * why. A retried job proposes nothing twice.
 */
export async function fileBulkMail(deps: BulkMailDeps, job: TriageJob): Promise<BulkMailResult> {
  const now = deps.now ?? nowIso;
  const events = await observedEventsOf(deps.db, job);
  if (events.length === 0) {
    throw new Error(`Bulk-mail job for ${job.correlationId} names no observed events that exist.`);
  }
  const context = await proposalContextFor(
    { db: deps.db, config: deps.config, now },
    job,
    events,
    BULK_MAIL_ACTOR,
  );
  const existing = await existingProposals(deps.db, job.correlationId);
  const proposalIds: string[] = [];
  for (const event of events) {
    for (const draft of bulkFilingDrafts(event)) {
      const already = existing.get(`${draft.actionClass}|${draft.targetRecordId ?? ''}`);
      if (already !== undefined) {
        proposalIds.push(already);
        continue;
      }
      const outcome = await deps.createProposal(draft, context);
      proposalIds.push(outcome.proposalId);
    }
  }
  const labels = labelsOf(events);
  await new LedgerWriter(deps.db).append({
    ts: now(),
    actor: BULK_MAIL_ACTOR,
    kind: 'resolved',
    sourceSystem: 'lance',
    correlationId: job.correlationId,
    payload: {
      kind: 'bulk_mail',
      version: BULK_MAIL_VERSION,
      routedAroundTriage: true,
      reason: bulkReason(labels),
      labels,
      bulkLabels: [...deps.config.triage.bulkLabels],
      proposalIds,
      observationEventIds: events.map((event) => event.id),
      watcherDryRun: context.watcherDryRun,
    },
  });
  return { correlationId: job.correlationId, proposalIds };
}
