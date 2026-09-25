import type { CreateProposalHandler, CreateProposalOutcome, ProposalDraft } from '@lance/agents';
import { renderProposalCard, type SlackSurface } from '@lance/connectors';
import { policyDecisions, proposals, type Db } from '@lance/db';
import { LedgerWriter, toProposal, type SystemControl } from '@lance/ledger';
import { evaluate } from '@lance/policy';
import {
  REVERSIBILITY_BY_ACTION_CLASS,
  newUlid,
  nowIso,
  type Config,
  type PolicyRule,
  type ProposalStatus,
} from '@lance/shared';
import { eq } from 'drizzle-orm';
import { recordPush, remainingPushes } from '../alerts/engine/budget.js';
import type { CriticVerdict } from '../critic/index.js';
import { moveDestinationRefusal, policyTarget } from './target.js';

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
  config: Pick<Config, 'agentDisplayName' | 'timeZone' | 'proposals' | 'interruption'>;
  control: Pick<SystemControl, 'read'>;
  loadRules: () => Promise<PolicyRule[]>;
  /** The critic (spec 7.4), given the draft, its context and the rule policy matched. */
  critique: (
    draft: ProposalDraft,
    context: ProposalContext,
    ruleId: string | null,
  ) => Promise<CriticVerdict>;
  /** Null when Slack is not configured (tests, local runs): cards are skipped, everything else proceeds. */
  slack: Pick<SlackSurface, 'post' | 'channelId'> | null;
  enqueueExecute: (proposalId: string) => Promise<void>;
  now?: () => string;
}

export const POLICY_ACTOR = 'system:policy';

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

    // A context that names no target takes it from the draft, as the
    // executor does, so a move into AI-Filed meets seed rule 4 here too.
    const target = context.target ?? policyTarget(draft.actionClass, draft.payload) ?? undefined;
    const input = {
      actionClass: draft.actionClass,
      counterpartyClass: draft.counterpartyClass,
      system: draft.targetSystem,
      confidence: draft.confidence,
      at: ts,
      stage: 'proposal' as const,
      ...(context.labels === undefined ? {} : { labels: context.labels }),
      ...(target === undefined ? {} : { target }),
    };
    const evaluated = evaluate(input, await deps.loadRules());
    // A move whose destination is ambiguous or a deletion folder is refused
    // before any rule can grant it, like a hard floor.
    const moveRefusal =
      draft.actionClass === 'move_mail' ? moveDestinationRefusal(draft.payload) : null;
    const evaluation =
      moveRefusal === null
        ? evaluated
        : { ...evaluated, decision: 'forbid' as const, ruleId: null, unmetConditions: [] };

    const decisionId = newUlid();
    await deps.db.insert(policyDecisions).values({
      id: decisionId,
      decision: evaluation.decision,
      ruleId: evaluation.ruleId,
      reason:
        moveRefusal ??
        (evaluation.unmetConditions.length > 0
          ? `${evaluation.reason}: ${evaluation.unmetConditions.join(', ')}`
          : evaluation.reason),
      input,
      evaluatedAt: new Date(ts),
    });

    let status: ProposalStatus;
    let decidedBy: string | null = null;
    let decisionNote: string | null;
    let critic: CriticVerdict | null = null;

    if (evaluation.decision === 'forbid') {
      status = 'rejected';
      decidedBy = POLICY_ACTOR;
      decisionNote = moveRefusal ?? 'Forbidden by policy.';
    } else {
      // The critic reads every proposal that could reach Dom or the
      // executor (spec 7.4), so a draft's voice and provenance checks run
      // whether policy said auto or propose. It can only hold, never approve.
      critic = await deps.critique(draft, context, evaluation.ruleId);
      if (evaluation.decision === 'auto' && critic.passed) {
        status = dryRun ? 'held' : 'approved';
        decidedBy = POLICY_ACTOR;
        decisionNote = dryRun ? 'Auto by policy; held in dry run.' : 'Auto by policy.';
      } else if (evaluation.decision === 'auto') {
        status = dryRun ? 'held' : 'pending';
        decisionNote = `Critic held this for review: ${critic.notes.join(' ')}`;
      } else {
        status = dryRun ? 'held' : 'pending';
        const notes: string[] = [];
        if (evaluation.unmetConditions.length > 0) {
          notes.push(
            `Proposed because conditions were unmet: ${evaluation.unmetConditions.join(', ')}.`,
          );
        }
        if (!critic.passed) notes.push(`Critic notes: ${critic.notes.join(' ')}`);
        decisionNote = notes.length === 0 ? null : notes.join(' ');
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

    // A card is an unsolicited post and counts against the hourly push
    // budget (spec 9.4). When the hour is spent the proposal stays pending
    // without a card; alert delivery posts it once the budget allows.
    const allowance =
      status === 'pending' && deps.slack !== null
        ? await remainingPushes({
            db: deps.db,
            perHour: (await deps.control.read()).pushBudgetPerHour,
            now,
          })
        : 0;
    if (status === 'pending' && deps.slack !== null && allowance > 0) {
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
        await recordPush(deps.db, {
          reason: 'proposal_card',
          correlationId: context.correlationId,
          slackTs: posted.ts,
          ids: [proposalId],
          now,
        });
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
