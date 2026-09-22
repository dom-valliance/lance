'use server';

/**
 * Regenerate, the one control the Today page offers beyond Chase.
 *
 * The brief is written by the planner, which arrives in Phase 3, and the
 * api has no `briefs.regenerate` procedure yet. So the action validates
 * its input and answers in plain words instead of pretending. When the
 * planner lands, the body below becomes one call and a revalidate:
 *
 *   const client = await apiClient();
 *   await client.briefs.regenerate.mutate({ kind });
 *   revalidatePath('/today');
 *   return null;
 *
 * Nothing else about the page changes: the form already carries the kind
 * and `ActionForm` already renders whatever comes back beside the button.
 */

const REGENERATE_KINDS = ['morning_brief', 'afternoon_board'] as const;

const PENDING_MESSAGE =
  'Regeneration arrives with the Phase 3 planner. The scheduler builds the brief at 06:30.';

/* The planner call that replaces this body is awaited; until it lands the
   action answers from memory, so there is nothing here to wait for. */
// eslint-disable-next-line @typescript-eslint/require-await
export async function regenerateBrief(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const kind = form.get('kind');
  if (typeof kind !== 'string' || !(REGENERATE_KINDS as readonly string[]).includes(kind)) {
    return 'The form did not say which brief to rebuild. Reload the page and try again.';
  }
  return PENDING_MESSAGE;
}
