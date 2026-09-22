import { z } from 'zod';

/**
 * What the Planner returns (spec 7.3): judgement over the assembled facts,
 * never new facts. The brief itself is `MorningBriefContent` from
 * `@lance/shared`, which the api and the Today page also read.
 */
export const PlannerOutputSchema = z.object({
  meetings: z.array(
    z.object({
      /** The meeting id from the prompt. */
      id: z.string(),
      objectives: z.array(z.string().min(1).max(200)).min(1).max(2),
    }),
  ),
  tasks: z
    .array(
      z.object({
        taskId: z.string(),
        rank: z.number().int().min(1).max(5),
        reason: z.string().min(1).max(200),
      }),
    )
    .max(5),
  holdsProposed: z.number().int().min(0),
});

export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;
