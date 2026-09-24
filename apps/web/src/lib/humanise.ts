import type { CommitmentStatus } from '@/lib/commitment-view';
import type {
  ActionClass,
  CounterpartyClass,
  LedgerKind,
  ProposalStatus,
  SourceSystem,
} from '@/lib/filters';
import type { PolicyDecision } from '@/lib/tones';

/**
 * Plain-words labels for every enum the UI shows (design index, decision
 * 6: "Enum values are humanised everywhere"). The raw value still travels
 * in URLs and forms; only what the reader sees changes.
 */

export const ACTION_CLASS_LABELS: Record<ActionClass, string> = {
  read: 'Read',
  classify: 'Classify',
  draft_email: 'Draft email',
  apply_category: 'Apply category',
  move_mail: 'Move mail',
  create_task: 'Create task',
  update_task: 'Update task',
  complete_task: 'Complete task',
  create_tag: 'Create tag',
  apply_tag: 'Apply tag',
  create_calendar_hold: 'Create calendar hold',
  post_slack: 'Post to Slack',
  send_email: 'Send email',
  delete: 'Delete',
  rule_change: 'Rule change',
  promote_to_shared: 'Share with the team',
};

export const SYSTEM_LABELS: Record<SourceSystem, string> = {
  graph: 'Microsoft 365',
  jamie: 'Jamie',
  notion: 'Notion',
  slack: 'Slack',
  lance: 'Lance',
  webhook: 'Webhook',
};

export const COUNTERPARTY_LABELS: Record<CounterpartyClass, string> = {
  self: 'Self',
  internal: 'Internal',
  client: 'Client',
  prospect: 'Prospect',
  partner: 'Partner',
  vendor: 'Vendor',
  unknown: 'Unknown',
};

export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
  pending: 'Pending',
  held: 'Held',
  approved: 'Approved',
  edited: 'Edited',
  executing: 'Executing',
  executed: 'Executed',
  rejected: 'Rejected',
  expired: 'Expired',
  failed: 'Failed',
};

export const LEDGER_KIND_LABELS: Record<LedgerKind, string> = {
  observed: 'Observed',
  resolved: 'Resolved',
  proposed: 'Proposed',
  decided: 'Decided',
  executed: 'Executed',
  failed: 'Failed',
  alert_raised: 'Alert raised',
  alert_acked: 'Alert acknowledged',
  rule_changed: 'Rule changed',
  state_changed: 'State changed',
  retention_applied: 'Retention applied',
  cost_recorded: 'Cost recorded',
};

export const COMMITMENT_STATUS_LABELS: Record<CommitmentStatus, string> = {
  open: 'Open',
  chased: 'Chased',
  done: 'Done',
  dropped: 'Dropped',
};

export const DECISION_LABELS: Record<PolicyDecision, string> = {
  forbid: 'Forbid',
  propose: 'Propose',
  auto: 'Auto',
};

/**
 * A readable fallback for an enum value the tables above do not know:
 * `stale_watermark` becomes "Stale watermark". Used for actor kinds and
 * payload keys, never for the enums that have a table.
 */
export function humanise(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').trim();
  if (words === '') return value;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Ids are shown in full where they are the subject (a correlation page
 * title) and shortened in a table cell: the first eight characters, an
 * ellipsis and the last three, so two ids that share a prefix still
 * differ on screen.
 */
export function shortId(id: string, keep = 8): string {
  if (id.length <= keep + 4) return id;
  return `${id.slice(0, keep)}…${id.slice(-3)}`;
}
