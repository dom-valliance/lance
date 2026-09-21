import { checkVoice, type PolicyRule, type ProvenanceRef } from '@lance/shared';
import type { ProposalDraft } from '@lance/agents';
import { TASK_PROPERTY_NAMES } from '@lance/connectors';

export interface CriticVerdict {
  passed: boolean;
  notes: string[];
}

export interface CriticOptions {
  /** Notion properties Lance may write (ADR 0009), from config. */
  permittedNotionProperties: readonly string[];
  /**
   * The rule policy matched, or null when the decision fell to the default.
   * The critic confirms the rule authorises this action class (spec 7.4).
   */
  authorisedBy?: PolicyRule | null;
  /**
   * The source records the provenance points at. Any email address the
   * payload would write must already appear in one of them, so Lance never
   * introduces a third party's personal data (spec 7.4).
   */
  sourceRecords?: readonly Record<string, unknown>[];
  /** Optional model-backed check for drafts (spec 7.4). Deterministic checks always run first. */
  reviewDraft?: (draft: ProposalDraft) => Promise<string[]>;
}

/** Where a Notion draft keeps its property values: createTask input or updateTask patch. */
const NOTION_PATCH_KEYS = ['input', 'patch'] as const;
const PROPERTY_NAME_BY_KEY: Record<string, string> = TASK_PROPERTY_NAMES;
const EMAIL_ADDRESS = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function targetInProvenance(draft: ProposalDraft): boolean {
  if (draft.targetRecordId === null) return true;
  return draft.provenance.some((ref: ProvenanceRef) => ref.recordId === draft.targetRecordId);
}

function draftText(draft: ProposalDraft): string | null {
  const body = draft.payload['bodyText'] ?? draft.payload['comment'] ?? draft.payload['body'];
  return typeof body === 'string' ? body : null;
}

function ruleAuthorises(rule: PolicyRule, draft: ProposalDraft): boolean {
  return (
    (rule.actionClass === '*' || rule.actionClass === draft.actionClass) &&
    (rule.system === '*' || rule.system === draft.targetSystem) &&
    (rule.counterpartyClass === '*' || rule.counterpartyClass === draft.counterpartyClass)
  );
}

/** Every email address anywhere in the value, lower-cased and de-duplicated. */
function emailAddressesIn(value: unknown): string[] {
  const found = new Set<string>();
  for (const match of JSON.stringify(value).matchAll(EMAIL_ADDRESS)) {
    found.add(match[0].toLowerCase());
  }
  return [...found];
}

/**
 * The critic (spec 7.4) never approves anything into execution; it can only
 * hold. Checks: the target matches provenance; the authorising rule covers
 * the action; drafts pass the voice hard rules and the optional model
 * review; Notion writes touch only permitted properties; the payload names
 * no email address the source records do not.
 */
export async function critique(
  draft: ProposalDraft,
  options: CriticOptions,
): Promise<CriticVerdict> {
  const notes: string[] = [];

  if (!targetInProvenance(draft)) {
    notes.push(`Target ${draft.targetRecordId ?? ''} is not in the proposal's provenance.`);
  }

  if (options.authorisedBy != null && !ruleAuthorises(options.authorisedBy, draft)) {
    notes.push(
      `Rule ${options.authorisedBy.id} covers ${options.authorisedBy.actionClass} on ${options.authorisedBy.system}, not ${draft.actionClass} on ${draft.targetSystem}.`,
    );
  }

  if (draft.actionClass === 'draft_email') {
    const text = draftText(draft);
    if (text === null) {
      notes.push('Draft has no body text.');
    } else {
      for (const finding of checkVoice(text)) notes.push(`Voice: ${finding.detail}`);
      if (options.reviewDraft !== undefined) {
        for (const note of await options.reviewDraft(draft)) notes.push(`Review: ${note}`);
      }
    }
  }

  if (
    draft.targetSystem === 'notion' &&
    (draft.actionClass === 'update_task' || draft.actionClass === 'create_task')
  ) {
    for (const key of NOTION_PATCH_KEYS) {
      const patch = draft.payload[key];
      if (typeof patch === 'object' && patch !== null) {
        for (const key of Object.keys(patch)) {
          const property = PROPERTY_NAME_BY_KEY[key] ?? key;
          if (!options.permittedNotionProperties.includes(property)) {
            notes.push(`Notion property "${property}" is not one Lance may write (ADR 0009).`);
          }
        }
      }
    }
  }

  if (options.sourceRecords !== undefined) {
    const known = new Set(emailAddressesIn(options.sourceRecords));
    for (const address of emailAddressesIn(draft.payload)) {
      if (!known.has(address)) {
        notes.push(`Address ${address} does not appear in any source record.`);
      }
    }
  }

  return { passed: notes.length === 0, notes };
}
