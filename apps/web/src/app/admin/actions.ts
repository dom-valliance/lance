'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { dayEndIso, dayStartIso, evidenceFilename } from '@/lib/admin-view';
import { apiClient } from '@/lib/trpc';

/**
 * The admin page's two actions (ADR 0024). Each answers `useActionState`
 * with its failure, never through the URL (root CLAUDE.md gotcha), and the
 * api checks `Lance.Admin` again on both.
 */

const readField = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message !== '' ? error.message : fallback;

const isAdmin = async (): Promise<boolean> => ((await auth())?.roles ?? []).includes('Lance.Admin');

export async function offboardAction(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  if (!(await isAdmin())) return 'Offboarding needs the Lance.Admin role. Nothing was changed.';
  const principalId = readField(form, 'principalId');
  const reason = readField(form, 'reason');
  if (reason === '') return 'Give a reason for the ledger before offboarding. Nothing was changed.';
  try {
    const client = await apiClient();
    await client.admin.offboard.mutate({ principalId, reason });
    return null;
  } catch (error) {
    return messageOf(error, 'The offboarding could not be queued. Check the api logs.');
  } finally {
    revalidatePath('/admin');
  }
}

export type EvidenceState =
  | { status: 'idle' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; filename: string; body: string };

export async function evidenceAction(
  _previous: EvidenceState,
  form: FormData,
): Promise<EvidenceState> {
  if (!(await isAdmin())) {
    return { status: 'failed', message: 'The evidence export needs the Lance.Admin role.' };
  }
  const fromDay = readField(form, 'from');
  const toDay = readField(form, 'to');
  const from = dayStartIso(fromDay);
  const to = dayEndIso(toDay);
  if (from === null || to === null) {
    return { status: 'failed', message: 'Choose a first and a last day for the period.' };
  }
  const principal = readField(form, 'principalId');
  const principalId = principal === '' ? null : principal;
  try {
    const client = await apiClient();
    const bundle = await client.admin.evidence.mutate({ from, to, principalId });
    return {
      status: 'ready',
      filename: evidenceFilename(fromDay, toDay, principalId),
      body: JSON.stringify(bundle, null, 2),
    };
  } catch (error) {
    return {
      status: 'failed',
      message: messageOf(error, 'The evidence export failed. Check the api logs.'),
    };
  }
}
