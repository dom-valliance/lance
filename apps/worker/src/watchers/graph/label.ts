import { runAgent, type AgentDeps } from '@lance/agents';
import { MAIL_LABELS, MailLabelSchema, stableUlid, type ModelConfig } from '@lance/shared';
import { z } from 'zod';
import type { Observation } from '../types.js';
import type { MailLabeller } from './mail.js';

/**
 * The one Haiku call spec 7.1 allows a watcher: it puts a message into the
 * existing taxonomy and says whether the message uses risk language. No
 * tools, one turn, a small token ceiling. Everything else about `graph-mail`
 * is deterministic.
 */

export const MAIL_LABEL_AGENT_NAME = 'mail-label';
export const MAIL_LABEL_AGENT_VERSION = '0.1.0';

/** Longest slice of body text the label prompt carries. A label needs the opening, not the thread. */
export const MAX_LABEL_BODY_CHARS = 1500;
const MAX_LABEL_TOKENS = 300;

/**
 * Added when the model reports risk language, so triage sees it on the
 * observation and can raise `risk_language_in_client_mail` (spec 11).
 * Outside `MAIL_LABELS` on purpose: it is a flag, not a mailbox category.
 */
export const RISK_LABEL = 'Risk';

export const MailLabelOutputSchema = z.object({
  labels: z.array(MailLabelSchema).min(1).max(3),
  riskLanguage: z.boolean(),
});
export type MailLabelOutput = z.infer<typeof MailLabelOutputSchema>;

/** The fields of the canonical mail record the prompt uses. Anything else is ignored. */
const LabelInputSchema = z.object({
  subject: z.string().nullish(),
  from: z.object({ name: z.string().nullish(), address: z.string().nullish() }).nullish(),
  bodyText: z.string().nullish(),
});

export interface HaikuLabellerOptions {
  agent: AgentDeps;
  /** `config.models.label`: Haiku, effort low (ADR 0002). */
  model: ModelConfig;
  displayName: string;
}

const DEFINITIONS: string[] = [
  'Deals: prospect or client commercial mail.',
  'Internal: senders at valliance.ai.',
  'Action: asks Dom to do something.',
  'Calendar: invitations and scheduling.',
  'Alerts: system or monitoring notices.',
  'Newsletters: bulk editorial mail.',
  'Priority: needs Dom today.',
  'Notifications: automated notifications from tools and services.',
];

/**
 * Stable across every message so the prompt cache hits (spec 13). Anything
 * that varies per message belongs in the user prompt.
 */
export function mailLabelSystemPrompt(displayName: string): string {
  return [
    `You label one mail message for ${displayName}, the personal operating agent for Dom Selvon, a director at Valliance, an AI consultancy.`,
    '',
    `Choose one to three labels from this list and no others: ${MAIL_LABELS.join(', ')}.`,
    '',
    ...DEFINITIONS,
    '',
    'Set riskLanguage true when the message contains complaint, escalation, contract or legal language, false otherwise.',
    '',
    'Reply with only the JSON object: { "labels": string[], "riskLanguage": boolean }.',
  ].join('\n');
}

export function mailLabelUserPrompt(input: {
  sender: string;
  subject: string;
  bodyText: string;
}): string {
  return [
    `From: ${input.sender}`,
    `Subject: ${input.subject}`,
    'Body:',
    input.bodyText,
    '',
    'Label this message.',
  ].join('\n');
}

function promptInputFor(observation: Omit<Observation, 'labels'>): {
  sender: string;
  subject: string;
  bodyText: string;
} {
  const parsed = LabelInputSchema.safeParse(observation.record);
  const record = parsed.success ? parsed.data : {};
  const name = record.from?.name ?? '';
  const address = record.from?.address ?? '';
  const sender = [name, address].filter((part) => part.trim() !== '').join(' ');
  const body = record.bodyText ?? '';
  return {
    sender: sender === '' ? 'unknown sender' : sender,
    subject: record.subject ?? '(no subject)',
    bodyText: body.slice(0, MAX_LABEL_BODY_CHARS),
  };
}

/** The model's answer as the observation's label list, with `Risk` appended when flagged. */
export function labelsFrom(output: MailLabelOutput): string[] {
  return [...new Set(output.riskLanguage ? [...output.labels, RISK_LABEL] : output.labels)];
}

/**
 * Builds the labeller `createGraphMailWatcher` takes. A pure function of its
 * options: the same observation and the same scripted model produce the same
 * labels. Errors are the watcher's problem, not this function's; it lets them
 * out and the watcher falls back to `Unlabelled`.
 */
export function createHaikuLabeller(options: HaikuLabellerOptions): MailLabeller {
  return async (observation) => {
    const result = await runAgent(
      options.agent,
      {
        name: MAIL_LABEL_AGENT_NAME,
        version: MAIL_LABEL_AGENT_VERSION,
        model: options.model,
        system: mailLabelSystemPrompt(options.displayName),
        tools: [],
        outputSchema: MailLabelOutputSchema,
        maxTokens: MAX_LABEL_TOKENS,
        maxIterations: 1,
      },
      {
        // The same correlation id the runner derives, so the label run's cost
        // event sits on the conversation's trail.
        correlationId: stableUlid(`${observation.sourceSystem}:${observation.correlationKey}`),
        prompt: mailLabelUserPrompt(promptInputFor(observation)),
      },
    );
    return labelsFrom(result.output);
  };
}
