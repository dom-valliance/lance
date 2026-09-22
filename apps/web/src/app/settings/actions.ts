'use server';

import { revalidatePath } from 'next/cache';
import { apiClient } from '@/lib/trpc';

/**
 * The four state changes the Settings page offers (design 7.11). Each one
 * answers `useActionState` with null on success or a message to show, so a
 * failure never travels through the URL (root CLAUDE.md gotcha). Each one
 * is recorded in the ledger as a state change by the api, which is what
 * the page header promises.
 *
 * Both paths are revalidated: `/settings` for the cards, and the root
 * layout because the shell carries the paused banner and the status line.
 */

/** `HH:MM`, 24-hour, the same shape the api's `InterruptionBudgetInputSchema` accepts. */
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

const MAX_PUSHES_PER_HOUR = 50;

const readField = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
};

/** Runs one mutation and refreshes the page and the shell either way. */
async function run(mutate: () => Promise<unknown>): Promise<string | null> {
  try {
    await mutate();
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : 'The change could not be saved. Check the api logs.';
  } finally {
    revalidatePath('/settings');
    revalidatePath('/', 'layout');
  }
}

export async function setModeAction(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const mode = readField(form, 'mode');
  if (mode !== 'live' && mode !== 'dry_run') {
    return 'Choose live or dry run before saving. The mode is unchanged.';
  }
  return run(async () => {
    const client = await apiClient();
    await client.systemState.setMode.mutate({ mode });
  });
}

export async function pauseAction(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const reason = readField(form, 'reason');
  if (reason === '') {
    return 'Type a reason before pausing. Lance is still running.';
  }
  return run(async () => {
    const client = await apiClient();
    await client.systemState.pause.mutate({ reason });
  });
}

export async function resumeAction(): Promise<string | null> {
  return run(async () => {
    const client = await apiClient();
    await client.systemState.resume.mutate();
  });
}

const MAX_COST_CEILING_GBP = 1000;

export async function setCostCeilingAction(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const costCeilingGbp = Number(readField(form, 'costCeilingGbp'));
  if (
    !Number.isFinite(costCeilingGbp) ||
    costCeilingGbp <= 0 ||
    costCeilingGbp > MAX_COST_CEILING_GBP
  ) {
    return `The daily ceiling must be between 0.01 and ${String(MAX_COST_CEILING_GBP)} pounds. Nothing was saved.`;
  }
  return run(async () => {
    const client = await apiClient();
    await client.systemState.setCostCeiling.mutate({
      costCeilingGbp: Math.round(costCeilingGbp * 100) / 100,
    });
  });
}

export async function setInterruptionBudgetAction(
  _previous: string | null,
  form: FormData,
): Promise<string | null> {
  const quietHoursStart = readField(form, 'quietHoursStart');
  const quietHoursEnd = readField(form, 'quietHoursEnd');
  if (!HH_MM.test(quietHoursStart)) {
    return 'Quiet from must be a time in 24-hour form, such as 19:00. Nothing was saved.';
  }
  if (!HH_MM.test(quietHoursEnd)) {
    return 'Quiet until must be a time in 24-hour form, such as 07:00. Nothing was saved.';
  }
  const pushBudgetPerHour = Number(readField(form, 'pushBudgetPerHour'));
  if (
    !Number.isInteger(pushBudgetPerHour) ||
    pushBudgetPerHour < 0 ||
    pushBudgetPerHour > MAX_PUSHES_PER_HOUR
  ) {
    return `Posts per hour must be a whole number between 0 and ${String(MAX_PUSHES_PER_HOUR)}. Nothing was saved.`;
  }
  return run(async () => {
    const client = await apiClient();
    await client.systemState.setInterruptionBudget.mutate({
      quietHoursStart,
      quietHoursEnd,
      pushBudgetPerHour,
    });
  });
}
