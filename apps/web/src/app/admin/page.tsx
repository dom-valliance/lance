import { auth } from '@/auth';
import { evidenceAction, offboardAction } from '@/app/admin/actions';
import { AdminView } from '@/app/admin/admin-view';
import { PageHeader } from '@/components/page-header';
import { TextLink } from '@/components/text-link';
import { apiClient } from '@/lib/trpc';

export const dynamic = 'force-dynamic';

/**
 * The admin page (ADR 0024, docs/plans/multi-user.md M7), for a
 * `Lance.Admin` only. It shows how the service is running for each
 * principal and never what any of them wrote or received: every figure is
 * read by the api inside that principal's own scope and is a status, a
 * count, an age or a name. Anyone else who opens the address gets the
 * app's own refusal, and the api refuses them as well.
 */

function Refusal() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Admin" />
      <div className="rounded-xl bg-card p-6 text-sm">
        This page is for Lance admins. Ask a Lance admin to add you to the Lance Admins group if you
        need it. <TextLink href="/today">Go to Today</TextLink>.
      </div>
    </div>
  );
}

export default async function AdminPage() {
  const session = await auth();
  if (!(session?.roles ?? []).includes('Lance.Admin')) return <Refusal />;

  const client = await apiClient();
  const [principals, health, ruleChanges, systemAlerts, me] = await Promise.all([
    client.admin.principals.query(),
    client.admin.health.query(),
    client.admin.ruleChanges.query(),
    client.admin.systemAlerts.query(),
    client.me.query(),
  ]);

  return (
    <AdminView
      principals={principals}
      health={health}
      ruleChanges={ruleChanges}
      systemAlerts={systemAlerts}
      adminPrincipalId={me.principalId}
      today={new Date()}
      offboardAction={offboardAction}
      evidenceAction={evidenceAction}
    />
  );
}
