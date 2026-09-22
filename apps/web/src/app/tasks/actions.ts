'use server';

/* eslint-disable @typescript-eslint/require-await --
 * Next requires every export of a `'use server'` file to be an async
 * function; the await arrives with the mutation described below. */

/**
 * The two writes the Tasks page offers. Neither exists in the api yet:
 * `tasks.complete` and `tasks.create` arrive with the complete-task and
 * create-task proposals (spec 12, "Coming later"). Each action reads and
 * validates its form now, so the form contract is already settled, then
 * answers `useActionState` with a plain-words sentence saying where the
 * change has to be made in the meantime.
 *
 * Wiring the real mutation later is one call in place of that sentence,
 * in the shape `apps/web/src/app/commitments/actions.ts` already uses:
 * `return run(() => client.tasks.complete.mutate(input))`.
 */

/** The trimmed value of a form field, or an empty string when it is absent. */
function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

const missing = (what: string): string =>
  `The form did not carry ${what}. Reload the page and try again.`;

export async function completeTask(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  if (field(form, 'source') === '') return missing('the task source');
  if (field(form, 'sourceId') === '') return missing('the task id');
  return 'Completing a task from here arrives with the complete-task proposal. Until then, open it in Notion.';
}

export async function createTask(_previous: string | null, form: FormData): Promise<string | null> {
  if (field(form, 'title') === '') return 'Give the task a title, then propose it again.';
  return 'Creating a task from here arrives with the create-task proposal. Until then, add it in Notion.';
}
