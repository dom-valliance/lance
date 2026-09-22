import { z } from 'zod';

/** The chase email the worker drafts for an inbound commitment (spec 10.1 item 4). */
export const ChaseDraftSchema = z.object({
  subject: z.string().min(1).max(200),
  bodyText: z.string().min(1).max(3000),
});

export type ChaseDraft = z.infer<typeof ChaseDraftSchema>;
