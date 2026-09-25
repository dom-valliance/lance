import { principals, type Db, type Principal } from '@lance/db';
import { and, arrayContains, eq } from 'drizzle-orm';

/**
 * Who receives organisation alerts (ADR 0020, ADR 0024): every active
 * principal whose recorded Lance roles include `Lance.Admin`. Roles are
 * recorded in `principals.lance_roles` at each sign-in and Slack link, so
 * until an admin has signed in since roles were recorded there may be
 * none; the principal whose UPN is `fallbackUpn` (`config.dom.email`)
 * receives them then, so an alert always has somewhere to land.
 */
export async function organisationAdmins(root: Db, fallbackUpn: string): Promise<Principal[]> {
  const admins = await root
    .select()
    .from(principals)
    .where(
      and(eq(principals.status, 'active'), arrayContains(principals.lanceRoles, ['Lance.Admin'])),
    )
    .orderBy(principals.id);
  if (admins.length > 0) return admins;
  return root.select().from(principals).where(eq(principals.upn, fallbackUpn)).limit(1);
}
