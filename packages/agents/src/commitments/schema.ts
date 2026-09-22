import { CommitmentDirectionSchema } from '@lance/shared';
import { z } from 'zod';

/**
 * A commitment as the model extracts it (spec 7.2, 10.4). `outbound` is
 * something Dom owes; `inbound` is something owed to Dom. The evidence
 * quote is verbatim text from the source; the eval harness checks it.
 */
export const CommitmentCandidateSchema = z.object({
  direction: CommitmentDirectionSchema,
  description: z.string().min(1).max(500),
  counterpartyName: z.string().max(200).nullable(),
  counterpartyEmail: z.string().max(320).nullable(),
  /** ISO date or date-time when the text gives one; null when it does not. */
  dueAt: z.string().max(40).nullable(),
  dueConfidence: z.number().min(0).max(1),
  evidenceQuote: z.string().min(1).max(500),
  recordId: z.string().min(1),
});

export type CommitmentCandidate = z.infer<typeof CommitmentCandidateSchema>;

export const CommitmentExtractionSchema = z.object({
  commitments: z.array(CommitmentCandidateSchema).max(30),
});

export type CommitmentExtraction = z.infer<typeof CommitmentExtractionSchema>;

/** What the extractor reads: one transcript or one sent email. */
export const CommitmentSourceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['transcript', 'sent_mail']),
  dom: z.object({ name: z.string().min(1), email: z.string().min(3) }),
  participants: z.array(z.object({ name: z.string(), email: z.string().nullable() })),
  /** ISO instant the source was written or held, for resolving relative dates. */
  occurredAt: z.string().nullable().default(null),
  text: z.string().min(1),
});

export type CommitmentSource = z.infer<typeof CommitmentSourceSchema>;
