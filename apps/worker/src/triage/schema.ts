import { AlertSeveritySchema, CommitmentDirectionSchema } from '@lance/shared';
import { z } from 'zod';

const STARTS_LIKE_JSON = /^[[{]/;
const JSON_KEY_VALUE_FRAGMENT = /":\s*"/;

/**
 * True for a bare `key: value` pair (`responseStatus: notResponded`) and
 * false for prose that happens to contain a colon (`Note: call moved to
 * Friday`). The distinction is the value: a field dump's value is a single
 * token with no sentence punctuation of its own; a sentence's is not.
 */
function isBareKeyValue(value: string): boolean {
  const match = /^[A-Za-z][A-Za-z0-9]*\s*:\s*(.+)$/.exec(value);
  const rest = match?.[1];
  if (rest === undefined) return false;
  return !/[\s.,;!?]/.test(rest.trim());
}

/**
 * Rejects an evidenceQuote that is raw JSON or a key-value fragment rather
 * than human-readable text (spec 7.2's provenance rule, tightened after
 * triage quoted `"responseStatus":"notResponded"` straight out of a
 * calendar record). The message is what the model sees: the agent runtime
 * retries once with the Zod issue in context, so it has to be an
 * instruction, not just a description of the failure.
 */
export function humanReadableQuote(value: string): boolean {
  const trimmed = value.trim();
  if (STARTS_LIKE_JSON.test(trimmed)) return false;
  if (JSON_KEY_VALUE_FRAGMENT.test(trimmed)) return false;
  if (isBareKeyValue(trimmed)) return false;
  return true;
}

const HUMAN_READABLE_QUOTE_MESSAGE =
  'evidenceQuote must be human-readable text from the record: a sentence from a body, a subject line, or for a calendar event the subject with the organiser and the time. Quote that instead of a field name, JSON or a key-value fragment.';

const evidenceQuote = z
  .string()
  .min(1)
  .max(500)
  .refine(humanReadableQuote, HUMAN_READABLE_QUOTE_MESSAGE);

export const EntityRefSchema = z.object({
  kind: z.enum(['person', 'organisation', 'project']),
  name: z.string().min(1).max(200),
  email: z.string().max(320).nullable(),
  domain: z.string().max(253).nullable(),
  confidence: z.number().min(0).max(1),
});

export const CommitmentCandidateSchema = z.object({
  direction: CommitmentDirectionSchema,
  description: z.string().min(1).max(500),
  counterpartyName: z.string().max(200).nullable(),
  counterpartyEmail: z.string().max(320).nullable(),
  dueAt: z.string().max(40).nullable(),
  dueConfidence: z.number().min(0).max(1),
  evidenceQuote,
  recordId: z.string().min(1),
});

export const TaskCandidateSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  /** Who the source assigns it to; null means Dom. Names other than Dom are delegates (ADR 0009). */
  assigneeName: z.string().max(200).nullable(),
  priority: z.enum(['Low', 'Medium', 'High', 'Critical Milestone']).nullable(),
  evidenceQuote,
  recordId: z.string().min(1),
});

export const AlertCandidateSchema = z.object({
  kind: z.enum(['risk_language_in_client_mail', 'other']),
  severity: AlertSeveritySchema,
  title: z.string().min(1).max(200),
  evidenceQuote,
  recordId: z.string().min(1),
});

/** A decision or an open question from a meeting transcript (spec 10.4), with its quote. */
export const QuotedPointSchema = z.object({
  text: z.string().min(1).max(300),
  evidenceQuote,
  recordId: z.string().min(1),
});

/** Spec 7.2. Proposals are submitted through the create_proposal tool, so the output only counts them. */
export const TriageOutputSchema = z.object({
  importance: z.number().min(0).max(1),
  urgency: z.number().min(0).max(1),
  summary: z.string().min(1).max(300),
  entities: z.array(EntityRefSchema).max(30),
  commitments: z.array(CommitmentCandidateSchema).max(20),
  taskCandidates: z.array(TaskCandidateSchema).max(20),
  proposalsSubmitted: z.number().int().min(0),
  alertCandidates: z.array(AlertCandidateSchema).max(10),
  /** Meeting transcripts only (spec 10.4); empty for everything else. */
  decisions: z.array(QuotedPointSchema).max(20).default([]),
  openQuestions: z.array(QuotedPointSchema).max(20).default([]),
});

export type TriageOutput = z.infer<typeof TriageOutputSchema>;
export type TaskCandidate = z.infer<typeof TaskCandidateSchema>;
export type AlertCandidate = z.infer<typeof AlertCandidateSchema>;
export type QuotedPoint = z.infer<typeof QuotedPointSchema>;
