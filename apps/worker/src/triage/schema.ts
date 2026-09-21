import { AlertSeveritySchema, CommitmentDirectionSchema } from '@lance/shared';
import { z } from 'zod';

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
  evidenceQuote: z.string().min(1).max(500),
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
  evidenceQuote: z.string().min(1).max(500),
  recordId: z.string().min(1),
});

export const AlertCandidateSchema = z.object({
  kind: z.enum(['risk_language_in_client_mail', 'other']),
  severity: AlertSeveritySchema,
  title: z.string().min(1).max(200),
  evidenceQuote: z.string().min(1).max(500),
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
});

export type TriageOutput = z.infer<typeof TriageOutputSchema>;
export type TaskCandidate = z.infer<typeof TaskCandidateSchema>;
export type AlertCandidate = z.infer<typeof AlertCandidateSchema>;
