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

/** Whether `pathname` is `href` or a page beneath it. */
export function isUnder(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The title the mobile top bar shows for `pathname`. */
export function pageTitleFor(pathname: string): string {
  const item = NAV_ITEMS.find((candidate) => isUnder(pathname, candidate.href));
  if (item === undefined) return 'Lance';
  return pathname === item.href ? item.label : (item.singular ?? item.label);
}

/** The counts the navigation shows beside an item, when they are known. */
export interface NavCounts {
  pendingProposals: number | null;
  openAlerts: number | null;
}
