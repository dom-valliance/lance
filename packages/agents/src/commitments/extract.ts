import type { ModelConfig } from '@lance/shared';
import { runAgent, type AgentDeps } from '../defineAgent.js';
import { commitmentSystemPrompt, commitmentUserPrompt } from './prompt.js';
import {
  CommitmentExtractionSchema,
  CommitmentSourceSchema,
  type CommitmentCandidate,
  type CommitmentSource,
} from './schema.js';

export const COMMITMENT_EXTRACTOR_VERSION = '0.1.0';

export interface CommitmentExtractorOptions {
  agent: AgentDeps;
  model: ModelConfig;
  displayName: string;
}

export type CommitmentExtractor = (
  source: CommitmentSource,
  correlationId: string,
) => Promise<CommitmentCandidate[]>;

/**
 * One structured model call, no tools, so the extractor can only report
 * (non-negotiable 2). Quotes that are not verbatim in the text are dropped
 * here rather than trusted: provenance is a hard requirement (non-negotiable
 * 5) and the eval harness scores what survives this filter.
 */
export function createCommitmentExtractor(
  options: CommitmentExtractorOptions,
): CommitmentExtractor {
  return async (source, correlationId) => {
    const parsed = CommitmentSourceSchema.parse(source);
    const result = await runAgent(
      options.agent,
      {
        name: 'commitments',
        version: COMMITMENT_EXTRACTOR_VERSION,
        model: options.model,
        system: commitmentSystemPrompt(options.displayName),
        tools: [],
        outputSchema: CommitmentExtractionSchema,
        maxIterations: 1,
      },
      { correlationId, prompt: commitmentUserPrompt(parsed) },
    );
    return result.output.commitments
      .filter((candidate) => parsed.text.includes(candidate.evidenceQuote))
      .map((candidate) => ({ ...candidate, recordId: parsed.id }));
  };
}
