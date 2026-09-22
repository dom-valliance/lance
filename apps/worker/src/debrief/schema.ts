import { z } from 'zod';

/** The follow-up email the debrief drafts for external attendees (spec 10.4). */
export const FollowUpDraftSchema = z.object({
  subject: z.string().min(1).max(200),
  bodyText: z.string().min(1).max(6000),
});

export type FollowUpDraft = z.infer<typeof FollowUpDraftSchema>;
