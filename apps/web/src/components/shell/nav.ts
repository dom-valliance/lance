/**
 * The ten pages in their sidebar order (spec 12). `singular` names a
 * detail page under the item when the mobile top bar needs a title.
 */
export interface NavItem {
  href: string;
  label: string;
  singular?: string;
}

/** The Sign out form posts here: a fixed URL, so a page from the previous build still signs out after a deploy. */
export const SIGN_OUT_PATH = '/api/sign-out';

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/today', label: 'Today' },
  { href: '/proposals', label: 'Proposals', singular: 'Proposal' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/commitments', label: 'Commitments' },
  { href: '/alerts', label: 'Alerts', singular: 'Alert' },
  { href: '/ontology', label: 'Ontology' },
  { href: '/policies', label: 'Policies', singular: 'Policy' },
  { href: '/ledger', label: 'Ledger', singular: 'Correlation' },
  { href: '/agents', label: 'Agents', singular: 'Agent' },
  { href: '/settings', label: 'Settings' },
];

/** The admin page (ADR 0024). Listed only for a `Lance.Admin`; everyone else never sees it. */
export const ADMIN_NAV_ITEM: NavItem = { href: '/admin', label: 'Admin' };

/** The pages a person sees in the navigation: the ten, and Admin for a `Lance.Admin`. */
export function navItemsFor(isAdmin: boolean): readonly NavItem[] {
  return isAdmin ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : NAV_ITEMS;
}

/** Whether `pathname` is `href` or a page beneath it. */
export function isUnder(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The title the mobile top bar shows for `pathname`. */
export function pageTitleFor(pathname: string): string {
  const item = navItemsFor(true).find((candidate) => isUnder(pathname, candidate.href));
  if (item === undefined) return 'Lance';
  return pathname === item.href ? item.label : (item.singular ?? item.label);
}

/** The counts the navigation shows beside an item, when they are known. */
export interface NavCounts {
  pendingProposals: number | null;
  openAlerts: number | null;
}
