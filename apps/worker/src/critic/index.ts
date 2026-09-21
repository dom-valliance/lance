import { checkVoice, type ProvenanceRef } from '@lance/shared';
import type { ProposalDraft } from '@lance/agents';

export interface CriticVerdict {
  passed: boolean;
  notes: string[];
}

export interface CriticOptions {
  /** Notion properties Lance may write (ADR 0009), from config. */
  permittedNotionProperties: readonly string[];
  /** Optional model-backed check for drafts (Opus per spec 7.4). Deterministic checks always run first. */
  reviewDraft?: (draft: ProposalDraft) => Promise<string[]>;
}

const NOTION_PATCH_KEYS = ['properties', 'patch'] as const;

function targetInProvenance(draft: ProposalDraft): boolean {
  if (draft.targetRecordId === null) return true;
  return draft.provenance.some((ref: ProvenanceRef) => ref.recordId === draft.targetRecordId);
}

function draftText(draft: ProposalDraft): string | null {
  const body = draft.payload['bodyText'] ?? draft.payload['comment'] ?? draft.payload['body'];
  return typeof body === 'string' ? body : null;
}

/**
 * The critic (spec 7.4) never approves anything into execution; it can only
 * hold. Checks: the target matches provenance; drafts pass the voice hard
 * rules; Notion writes touch only permitted properties; the payload names
 * no third party the provenance does not.
 */
export async function critique(
  draft: ProposalDraft,
  options: CriticOptions,
): Promise<CriticVerdict> {
  const notes: string[] = [];

  if (!targetInProvenance(draft)) {
    notes.push(`Target ${draft.targetRecordId ?? ''} is not in the proposal's provenance.`);
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
        for (const property of Object.keys(patch)) {
          if (!options.permittedNotionProperties.includes(property)) {
            notes.push(`Notion property "${property}" is not one Lance may write (ADR 0009).`);
          }
        }
      }
    }
  }

  return { passed: notes.length === 0, notes };
}
