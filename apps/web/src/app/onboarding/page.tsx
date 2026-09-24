import { redirect } from 'next/navigation';
import { dataProcessingNotice } from '@/lib/notice';
import { onboardingRedirect } from '@/lib/onboarding-view';
import { apiClient } from '@/lib/trpc';
import { OnboardingChecklist } from './checklist';

/**
 * The onboarding checklist (docs/plans/multi-user.md M3). A principal whose
 * status is onboarding lands here from every page, and the shell renders it
 * centred with no navigation. Each step's state comes from the api, so a
 * reload shows where they stand; each write answers its own form through
 * `useActionState`. When every required step is done, "Open Lance" asks the
 * api to activate them, in dry run. A principal the api no longer counts as
 * onboarding is sent on to the app.
 */

export const dynamic = 'force-dynamic';

function agentDisplayName(): string {
  return process.env['AGENT_DISPLAY_NAME'] ?? 'Lance';
}

export default async function OnboardingPage() {
  const agentName = agentDisplayName();
  const notice = dataProcessingNotice();
  const client = await apiClient();
  const state = await client.onboarding.state.query({ noticeSha256: notice.sha256 });
  const target = onboardingRedirect(state.status);
  if (target !== null) redirect(target);
  return (
    <OnboardingChecklist state={state} noticeMarkdown={notice.markdown} agentName={agentName} />
  );
}
