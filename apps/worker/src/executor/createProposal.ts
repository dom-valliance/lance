import type { CreateProposalHandler, CreateProposalOutcome, ProposalDraft } from '@lance/agents';
import { renderProposalCard, type SlackSurface } from '@lance/connectors';
import { policyDecisions, proposals, type Db } from '@lance/db';
import { LedgerWriter, type SystemControl } from '@lance/ledger';
import { evaluate } from '@lance/policy';
import {
  REVERSIBILITY_BY_ACTION_CLASS,
  newUlid,
  nowIso,
  type Config,
  type PolicyRule,
  type Proposal,
  type ProposalStatus,
} from '@lance/shared';
import { eq } from 'drizzle-orm';
import type { CriticVerdict } from '../critic/index.js';

export interface ProposalContext {
  correlationId: string;
  /** Ledger actor of the proposer, for example agent:triage@0.1.0. */
  actor: string;
  /** Classifier labels on the source record, for label-gated rules. */
  labels?: string[];
  /** Target the policy conditions may check, for example a destination folder. */
  target?: string;
  /** True while the originating watcher is in its dry-run window (spec 6.3). */
  watcherDryRun?: boolean;
}

export interface CreateProposalDeps {
  db: Db;
  config: Pick<Config, 'agentDisplayName' | 'timeZone' | 'proposals'>;
  control: Pick<SystemControl, 'read'>;
  loadRules: () => Promise<PolicyRule[]>;
  critique: (draft: ProposalDraft) => Promise<CriticVerdict>;
  /** Null when Slack is not configured (tests, local runs): cards are skipped, everything else proceeds. */
  slack: Pick<SlackSurface, 'post' | 'channelId'> | null;
  enqueueExecute: (proposalId: string) => Promise<void>;
  now?: () => string;
}

export const POLICY_ACTOR = 'system:policy';

/** Maps a proposals row to the shared Proposal shape the renderers take. */
export function toProposal(row: typeof proposals.$inferSelect): Proposal {
  return {
    id: row.id,
    correlationId: row.correlationId,
    actionClass: row.actionClass,
    counterpartyClass: row.counterpartyClass,
    targetSystem: row.targetSystem,
    targetRecordId: row.targetRecordId,
    reversibility: row.reversibility,
    payload: row.payload as Record<string, unknown>,
    preview: row.preview,
    rationale: row.rationale,
    provenance: row.provenance as Proposal['provenance'],
    policyDecision: row.policyDecision,
    policyRuleId: row.policyRuleId,
    status: row.status,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
    decisionNote: row.decisionNote,
    editedPayload: row.editedPayload as Record<string, unknown> | null,
    slackChannel: row.slackChannel,
    slackTs: row.slackTs,
    expiresAt: row.expiresAt.toISOString(),
    executionEventId: row.executionEventId,
  };
}

/**
 * The one path from a model's wish to a proposal (spec 7.2, 7.5): policy is
 * evaluated by deterministic code, the decision and the proposal are recorded,
 * and the routing follows the decision. forbid: ledger only. propose: a card
 * in Slack and the UI. auto: the critic, then the execute queue. In dry_run
 * mode, or while the originating watcher is in its dry-run window, nothing
 * reaches Slack or the queue and the proposal is held.
 */
export function createProposalHandler(
  deps: CreateProposalDeps,
): (draft: ProposalDraft, context: ProposalContext) => Promise<CreateProposalOutcome> {
  return async (draft, context) => {
    const now = deps.now ?? nowIso;
    const ts = now();
    const ledger = new LedgerWriter(deps.db);
    const state = await deps.control.read();
    const dryRun = state.mode === 'dry_run' || context.watcherDryRun === true;

    const input = {
      actionClass: draft.actionClass,
      counterpartyClass: draft.counterpartyClass,
      system: draft.targetSystem,
      confidence: draft.confidence,
      at: ts,
      stage: 'proposal' as const,
      ...(context.labels === undefined ? {} : { labels: context.labels }),
      ...(context.target === undefined ? {} : { target: context.target }),
    };
    const evaluation = evaluate(input, await deps.loadRules());

    const decisionId = newUlid();
    await deps.db.insert(policyDecisions).values({
      id: decisionId,
      decision: evaluation.decision,
      ruleId: evaluation.ruleId,
      reason:
        evaluation.unmetConditions.length > 0
          ? `${evaluation.reason}: ${evaluation.unmetConditions.join(', ')}`
          : evaluation.reason,
      input,
      evaluatedAt: new Date(ts),
    });

    let status: ProposalStatus;
    let decidedBy: string | null = null;
    let decisionNote: string | null = null;
    let critic: CriticVerdict | null = null;

    if (evaluation.decision === 'forbid') {
      status = 'rejected';
      decidedBy = POLICY_ACTOR;
      decisionNote = 'Forbidden by policy.';
    } else if (evaluation.decision === 'auto') {
      critic = await deps.critique(draft);
      if (critic.passed) {
        status = dryRun ? 'held' : 'approved';
        decidedBy = POLICY_ACTOR;
        decisionNote = dryRun ? 'Auto by policy; held in dry run.' : 'Auto by policy.';
      } else {
        status = dryRun ? 'held' : 'pending';
        decisionNote = `Critic held this for review: ${critic.notes.join(' ')}`;
      }
    } else {
      status = dryRun ? 'held' : 'pending';
      if (evaluation.unmetConditions.length > 0) {
        decisionNote = `Proposed because conditions were unmet: ${evaluation.unmetConditions.join(', ')}.`;
      }
    }

    const proposalId = newUlid();
    const expiresAt = new Date(
      new Date(ts).getTime() + deps.config.proposals.expiryHours * 3600 * 1000,
    );
    await deps.db.insert(proposals).values({
      id: proposalId,
      correlationId: context.correlationId,
      actionClass: draft.actionClass,
      counterpartyClass: draft.counterpartyClass,
      targetSystem: draft.targetSystem,
      targetRecordId: draft.targetRecordId,
      reversibility: REVERSIBILITY_BY_ACTION_CLASS[draft.actionClass],
      payload: draft.payload,
      preview: draft.preview,
      rationale: draft.rationale,
      provenance: draft.provenance,
      policyDecision: evaluation.decision,
      policyRuleId: evaluation.ruleId,
      status,
      decidedBy,
      decidedAt: decidedBy === null ? null : new Date(ts),
      decisionNote,
      expiresAt,
    });

    const proposed = await ledger.append({
      ts,
      actor: context.actor,
      kind: 'proposed',
      sourceSystem: draft.targetSystem,
      sourceRecordId: draft.targetRecordId,
      correlationId: context.correlationId,
      policyDecisionId: decisionId,
      payload: {
        proposalId,
        actionClass: draft.actionClass,
        counterpartyClass: draft.counterpartyClass,
        decision: evaluation.decision,
        ruleId: evaluation.ruleId,
        status,
        confidence: draft.confidence,
        provenance: draft.provenance,
        dryRun,
      },
    });

    if (decidedBy !== null) {
      await ledger.append({
        ts,
        actor: POLICY_ACTOR,
        kind: 'decided',
        sourceSystem: 'lance',
        correlationId: context.correlationId,
        parentEventId: proposed.id,
        policyDecisionId: decisionId,
        payload: { proposalId, status, note: decisionNote, critic: critic?.notes ?? [] },
      });
    }

    if (status === 'pending' && deps.slack !== null) {
      const rows = await deps.db
        .select()
        .from(proposals)
        .where(eq(proposals.id, proposalId))
        .limit(1);
      const row = rows[0];
      if (row !== undefined) {
        const card = renderProposalCard(toProposal(row), {
          displayName: deps.config.agentDisplayName,
          timeZone: deps.config.timeZone,
        });
        const posted = await deps.slack.post(
          { text: card.text, blocks: card.blocks },
          { correlationId: context.correlationId, proposalId },
        );
        await deps.db
          .update(proposals)
          .set({ slackChannel: posted.channel, slackTs: posted.ts, updatedAt: new Date(now()) })
          .where(eq(proposals.id, proposalId));
      }
    }

    if (status === 'approved') {
      await deps.enqueueExecute(proposalId);
    }

    return {
      proposalId,
      decision: evaluation.decision,
      status,
      ...(decisionNote === null ? {} : { note: decisionNote }),
    };
  };
}

/** Binds a context so the agents package sees the plain handler shape. */
export function boundCreateProposal(
  handler: ReturnType<typeof createProposalHandler>,
  context: ProposalContext,
): CreateProposalHandler {
  return (draft) => handler(draft, context);
}
