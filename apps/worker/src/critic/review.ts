import { runAgent, type AgentDeps, type ProposalDraft } from '@lance/agents';
import type { ModelConfig } from '@lance/shared';
import { z } from 'zod';

export const CRITIC_VERSION = '0.1.0';

const ReviewSchema = z.object({
  /** Empty when the draft is fit to send as Dom's own words. */
  notes: z.array(z.string().min(1)).max(10),
});

export interface DraftReviewerOptions {
  agent: AgentDeps;
  model: ModelConfig;
  displayName: string;
}

function reviewSystemPrompt(displayName: string): string {
  return [
    `You are the critic for ${displayName}, an assistant that drafts email in Dom's voice.`,
    'You never send or edit anything. You read one draft and return notes on anything that would make Dom refuse to send it as written.',
    'Report only: a claim the draft makes that its source material does not support; a commitment, date or price the source does not contain; a tone that is not plain, direct and warm; text addressed to the wrong person; anything that reads as written by a machine.',
    'Style rules already checked by code, so do not report them: em dashes, emojis, correlative pairs.',
    'Return an empty list when the draft is fine. Each note is one sentence, British English, naming the exact phrase.',
  ].join('\n');
}

function reviewPrompt(draft: ProposalDraft): string {
  return [
    `Action: ${draft.actionClass} to ${draft.counterpartyClass} on ${draft.targetSystem}.`,
    `Preview: ${draft.preview}`,
    `Rationale: ${draft.rationale}`,
    'Payload:',
    JSON.stringify(draft.payload, null, 2),
  ].join('\n');
}

/**
 * The model half of the critic (spec 7.4): one structured call, no tools,
 * so the reviewer can only return notes. Used on `draft_email` only; the
 * deterministic checks in `index.ts` run first and regardless.
 */
export function createDraftReviewer(
  options: DraftReviewerOptions,
): (draft: ProposalDraft, correlationId: string) => Promise<string[]> {
  return async (draft, correlationId) => {
    const result = await runAgent(
      options.agent,
      {
        name: 'critic',
        version: CRITIC_VERSION,
        model: options.model,
        system: reviewSystemPrompt(options.displayName),
        tools: [],
        outputSchema: ReviewSchema,
        maxIterations: 1,
      },
      { correlationId, prompt: reviewPrompt(draft) },
    );
    return result.output.notes;
  };
}
