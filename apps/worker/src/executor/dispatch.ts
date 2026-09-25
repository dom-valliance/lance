import type { Db } from '@lance/db';
import { evaluate } from '@lance/policy';
import {
  nowIso,
  type ActionClass,
  type Config,
  type PolicyRule,
  type Proposal,
} from '@lance/shared';
import type { ConnectorWrite } from './index.js';
import { moveDestinationRefusal, policyTarget } from './target.js';

/** The connector operations the executor may perform, as adapters built in main from the real connectors. */
type Written = { id: string; webLink?: string | undefined };

export interface ExecutionWriters {
  graph?: {
    applyCategories: (input: {
      messageId: string;
      categories: readonly string[];
    }) => Promise<Written>;
    moveMessage: (input: { messageId: string; destinationFolderId: string }) => Promise<Written>;
    createDraft: (input: {
      subject: string;
      bodyText: string;
      to: readonly string[];
      cc?: readonly string[];
    }) => Promise<Written>;
    createReplyDraft: (input: { messageId: string; comment: string }) => Promise<Written>;
    createEvent: (input: {
      subject: string;
      start: string;
      end: string;
      timeZone: string;
    }) => Promise<Written>;
    resolveFolderId: (displayName: string) => Promise<string | null>;
  };
  notion?: {
    createTask: (input: unknown) => Promise<{ id: string; url: string }>;
  };
}

export type TargetVerdict = 'unchanged' | 'changed' | 'unknown';

export interface DispatchDeps {
  db: Db;
  writers: ExecutionWriters;
  /** `config.featureFlags`: a target system whose flag is off is never written to. */
  featureFlags: Pick<Config['featureFlags'], 'graphWrites' | 'notionWrites'>;
  loadRules: () => Promise<PolicyRule[]>;
  /** Re-fetches the target and compares its content hash with the provenance (spec 7.5 step 2). */
  verifyTarget: (proposal: Proposal) => Promise<TargetVerdict>;
  /** The classifier labels on the proposal's source records, for label-gated rules. */
  loadLabels: (proposal: Proposal) => Promise<string[]>;
  loadProposal: (proposalId: string) => Promise<Proposal | null>;
  now?: () => string;
}

export class ExecutionRefusedError extends Error {
  override readonly name = 'ExecutionRefusedError';
  constructor(
    readonly reason:
      | 'forbidden_at_execution'
      | 'target_changed'
      | 'unsupported_target'
      | 'missing_proposal'
      | 'bad_payload'
      | 'writes_disabled',
    message: string,
  ) {
    super(message);
  }
}

function str(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function strings(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new ExecutionRefusedError(
      'bad_payload',
      `The proposal payload has no ${what}; the executor performs exactly the write the preview described and cannot guess.`,
    );
  }
  return value;
}

function writesEnabled(
  flags: DispatchDeps['featureFlags'],
  system: Proposal['targetSystem'],
): boolean {
  switch (system) {
    case 'graph':
      return flags.graphWrites;
    case 'notion':
      return flags.notionWrites;
    default:
      return false;
  }
}

function flagNameFor(system: Proposal['targetSystem']): string {
  return `FF_${system.toUpperCase()}_WRITES`;
}

const UNSUPPORTED: ReadonlySet<ActionClass> = new Set([
  'apply_tag',
  'create_tag',
  'update_task',
  'complete_task',
  'post_slack',
  'read',
  'classify',
]);

/**
 * Turns an approved proposal into exactly one connector write (spec 7.5).
 * Policy is evaluated again at execution time with the rules of that moment;
 * the target is re-fetched and compared with the provenance; then the single
 * write runs. Anything the v1 connectors cannot do is refused with a reason
 * that lands in the ledger (ADR 0005 for Jamie tags).
 */
export function createConnectorWrite(deps: DispatchDeps): ConnectorWrite {
  return {
    async perform(proposalId) {
      const now = deps.now ?? nowIso;
      const proposal = await deps.loadProposal(proposalId);
      if (proposal === null)
        throw new ExecutionRefusedError(
          'missing_proposal',
          `Proposal ${proposalId} does not exist.`,
        );

      // Dom's edit overrides the fields it names and leaves the rest as
      // proposed: the modal and the web form only carry the editable
      // strings, so a replacement would drop recipients and task input.
      const payload: Record<string, unknown> = {
        ...proposal.payload,
        ...(proposal.editedPayload ?? {}),
      };
      if (proposal.actionClass === 'move_mail') {
        const refusal = moveDestinationRefusal(payload);
        if (refusal !== null) throw new ExecutionRefusedError('forbidden_at_execution', refusal);
      }
      const target = policyTarget(proposal.actionClass, payload);
      const labels = await deps.loadLabels(proposal);
      const decision = evaluate(
        {
          actionClass: proposal.actionClass,
          counterpartyClass: proposal.counterpartyClass,
          system: proposal.targetSystem,
          at: now(),
          stage: 'execution',
          criticPassed: proposal.policyDecision === 'auto' ? true : undefined,
          ...(labels.length === 0 ? {} : { labels }),
          ...(target === null ? {} : { target }),
        },
        await deps.loadRules(),
      );
      if (decision.decision === 'forbid') {
        throw new ExecutionRefusedError(
          'forbidden_at_execution',
          `Policy now forbids ${proposal.actionClass} for ${proposal.counterpartyClass} on ${proposal.targetSystem}; nothing was written.`,
        );
      }

      if ((await deps.verifyTarget(proposal)) === 'changed') {
        throw new ExecutionRefusedError(
          'target_changed',
          `The target record ${proposal.targetRecordId ?? ''} changed since the proposal was made; nothing was written.`,
        );
      }

      if (UNSUPPORTED.has(proposal.actionClass)) {
        throw new ExecutionRefusedError(
          'unsupported_target',
          `No connector write exists for ${proposal.actionClass} in v1.`,
        );
      }

      // The per-system write flag is the last gate before a connector is
      // touched (CLAUDE.md conventions): off means the approval stands and
      // the proposal is held until the flag is turned on.
      if (!writesEnabled(deps.featureFlags, proposal.targetSystem)) {
        throw new ExecutionRefusedError(
          'writes_disabled',
          `Writes to ${proposal.targetSystem} are turned off (${flagNameFor(proposal.targetSystem)}); nothing was written. Turn the flag on and resume to execute.`,
        );
      }

      switch (proposal.actionClass) {
        case 'apply_category': {
          const graph = need(deps.writers.graph, 'Graph connector');
          const messageId = need(proposal.targetRecordId, 'target message id');
          const written = await graph.applyCategories({
            messageId,
            categories: strings(payload, 'categories'),
          });
          return { targetRecordId: written.id, url: written.webLink ?? null, compensation: null };
        }
        case 'move_mail': {
          const graph = need(deps.writers.graph, 'Graph connector');
          const messageId = need(proposal.targetRecordId, 'target message id');
          const destinationFolderId =
            str(payload, 'destinationFolderId') ??
            (await graph.resolveFolderId(
              need(str(payload, 'destinationFolderName'), 'destination folder'),
            ));
          const written = await graph.moveMessage({
            messageId,
            destinationFolderId: need(destinationFolderId, 'destination folder id'),
          });
          return {
            targetRecordId: written.id,
            url: written.webLink ?? null,
            compensation: {
              actionClass: 'move_mail',
              messageId: written.id,
              backTo: str(payload, 'sourceFolderId'),
            },
          };
        }
        case 'draft_email': {
          const graph = need(deps.writers.graph, 'Graph connector');
          const replyTo = str(payload, 'replyToMessageId');
          const written =
            replyTo === null
              ? await graph.createDraft({
                  subject: need(str(payload, 'subject'), 'subject'),
                  bodyText: need(str(payload, 'bodyText'), 'body text'),
                  to: strings(payload, 'to'),
                  ...(strings(payload, 'cc').length === 0 ? {} : { cc: strings(payload, 'cc') }),
                })
              : await graph.createReplyDraft({
                  messageId: replyTo,
                  comment: need(str(payload, 'bodyText'), 'body text'),
                });
          return {
            targetRecordId: written.id,
            url: written.webLink ?? null,
            compensation: { actionClass: 'draft_email', draftId: written.id },
          };
        }
        case 'create_calendar_hold': {
          const graph = need(deps.writers.graph, 'Graph connector');
          const written = await graph.createEvent({
            subject: need(str(payload, 'subject'), 'subject'),
            start: need(str(payload, 'start'), 'start'),
            end: need(str(payload, 'end'), 'end'),
            timeZone: str(payload, 'timeZone') ?? 'Europe/London',
          });
          return {
            targetRecordId: written.id,
            url: written.webLink ?? null,
            compensation: { actionClass: 'create_calendar_hold', eventId: written.id },
          };
        }
        case 'create_task': {
          const notion = need(deps.writers.notion, 'Notion connector');
          const written = await notion.createTask(need(payload['input'], 'task input'));
          return {
            targetRecordId: written.id,
            url: written.url,
            compensation: { actionClass: 'create_task', pageId: written.id, status: 'Cancelled' },
          };
        }
        default:
          throw new ExecutionRefusedError(
            'unsupported_target',
            `No connector write exists for ${proposal.actionClass}.`,
          );
      }
    },
  };
}
