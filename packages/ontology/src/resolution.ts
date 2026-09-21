/**
 * Entity resolution (spec 5.3): deterministic first, probabilistic second,
 * human third. Everything here is pure; the repository applies the outcome.
 */

export const AUTO_MERGE_THRESHOLD = 0.95;
export const CANDIDATE_THRESHOLD = 0.75;

/** Providers whose domain says nothing about an organisation. */
export const PUBLIC_EMAIL_PROVIDERS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'live.co.uk',
  'msn.com',
  'yahoo.com',
  'yahoo.co.uk',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'btinternet.com',
  'sky.com',
]);

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'sir', 'dame', 'lord']);

/** Lower case, diacritics stripped, honorifics removed, one space between tokens. */
export function normaliseName(name: string): string {
  const folded = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9' -]+/g, ' ');
  const tokens = folded
    .split(/\s+/)
    .map((token) => token.replace(/\.$/, ''))
    .filter((token) => token.length > 0 && !HONORIFICS.has(token));
  return tokens.join(' ');
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The organisation domain an address implies, or null for a public provider or a malformed address. */
export function organisationDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = email
    .slice(at + 1)
    .toLowerCase()
    .trim();
  if (domain === '' || PUBLIC_EMAIL_PROVIDERS.has(domain)) return null;
  return domain;
}

/** Jaro-Winkler similarity on two already normalised strings, 0 to 1. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const from = Math.max(0, i - window);
    const to = Math.min(b.length - 1, i + window);
    for (let j = from; j <= to; j += 1) {
      if (!bMatched[j] && a[i] === b[j]) {
        aMatched[i] = true;
        bMatched[j] = true;
        matches += 1;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  const jaro =
    (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

export interface NamedParty {
  name: string;
  /** The organisation the party is known to belong to, by domain or ontology id; null when unknown. */
  organisation: string | null;
}

/**
 * Spec 5.3 step 2: name plus organisation. The name similarity is scaled by
 * what the organisations say: the same organisation confirms, an unknown
 * one neither confirms nor denies, a different one all but rules it out.
 */
export function nameOrganisationScore(a: NamedParty, b: NamedParty): number {
  const nameScore = jaroWinkler(normaliseName(a.name), normaliseName(b.name));
  if (a.organisation === null || b.organisation === null) return nameScore * 0.9;
  if (a.organisation.toLowerCase() === b.organisation.toLowerCase()) return nameScore;
  return nameScore * 0.5;
}

export type ResolutionDecision = 'merge' | 'candidate' | 'none';

export function decide(score: number): ResolutionDecision {
  if (score >= AUTO_MERGE_THRESHOLD) return 'merge';
  if (score >= CANDIDATE_THRESHOLD) return 'candidate';
  return 'none';
}
