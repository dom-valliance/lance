import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/**
 * The commitment eval fixture set: synthetic transcripts and sent mail with the
 * commitments a correct extractor should find (spec section 14).
 *
 * The expected shape mirrors `CommitmentCandidateSchema` in
 * `apps/worker/src/triage/schema.ts` minus `recordId`, which the extractor
 * fills in from the record it was given. It is restated here rather than
 * imported because a package may not depend on an app.
 */
export const ExpectedCommitmentSchema = z.object({
  direction: z.enum(['outbound', 'inbound']),
  description: z.string().min(1).max(500),
  counterpartyName: z.string().max(200).nullable(),
  counterpartyEmail: z.string().max(320).nullable(),
  dueAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  dueConfidence: z.number().min(0).max(1),
  evidenceQuote: z.string().min(1).max(500),
});

const ParticipantSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().max(320).nullable(),
});

export const CommitmentFixtureSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    kind: z.enum(['transcript', 'sent_mail']),
    dom: z.object({ name: z.literal('Dom Selvon'), email: z.literal('dom@valliance.ai') }),
    participants: z.array(ParticipantSchema).min(1),
    text: z.string().min(1),
    expected: z.array(ExpectedCommitmentSchema),
    notes: z.string().min(1),
  })
  .strict();

export type ExpectedCommitment = z.infer<typeof ExpectedCommitmentSchema>;
export type CommitmentFixture = z.infer<typeof CommitmentFixtureSchema>;

/** The committed synthetic set, `fixtures/evals/commitments` at the repository root. */
export const COMMITMENTS_FIXTURES_DIR = join(
  fileURLToPath(new URL('../../../../../', import.meta.url)),
  'fixtures',
  'evals',
  'commitments',
);

/** Reads every fixture in the directory, id order, and validates each one. */
export function loadCommitmentFixtures(fixturesDir: string): CommitmentFixture[] {
  const files = readdirSync(fixturesDir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    throw new Error(`No commitment fixtures found in ${fixturesDir}`);
  }
  return files.map((name) => {
    const path = join(fixturesDir, name);
    const parsed = CommitmentFixtureSchema.safeParse(
      JSON.parse(readFileSync(path, 'utf8')) as unknown,
    );
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`Invalid commitment fixture ${path}: ${issues}`);
    }
    if (parsed.data.id !== name.replace(/\.json$/, '')) {
      throw new Error(
        `Commitment fixture ${path} declares id ${parsed.data.id}; rename the file or the id so they match`,
      );
    }
    return parsed.data;
  });
}
