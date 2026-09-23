'use server';

import type { RegenerateState } from '@/lib/brief-view';
import { apiClient } from '@/lib/trpc';

/**
 * Regenerate on the Today page (design 7.1). The api queues a fresh
 * morning brief on the worker, the same path `/lance brief` takes; nothing
 * is generated here. The action answers `useActionState` with the outcome
 * of queuing, never through the URL. The brief itself arrives later, and
 * the header control watches for it by re-reading the page.
 */
export async function regenerateBrief(
  _previous: RegenerateState,
  form: FormData,
): Promise<RegenerateState> {
  const previous = form.get('generatedAt');
  const previousGeneratedAt = typeof previous === 'string' && previous !== '' ? previous : null;
  try {
    const client = await apiClient();
    await client.briefs.regenerate.mutate();
    return { status: 'queued', at: new Date().toISOString(), previousGeneratedAt };
  } catch (error) {
    return {
      status: 'failed',
      message:
        error instanceof Error
          ? error.message
          : 'The brief could not be queued. Check the api logs.',
    };
  }
}
