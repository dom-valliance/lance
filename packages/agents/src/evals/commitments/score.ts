/**
 * Scoring for the commitment extraction eval (spec section 14).
 *
 * Precision, recall and F1 are computed over a one-to-one matching between the
 * expected commitments of a record and the ones an extractor produced. Due
 * dates are deliberately kept out of the matching rule and scored separately,
 * so a correct commitment with the wrong date costs due accuracy rather than
 * recall.
 */

/** Direction as the triage schema defines it: outbound means Dom owes. */
export type ScoredDirection = 'outbound' | 'inbound';

/** The fields matching depends on. Extra fields on the input are ignored. */
export interface ScorableCommitment {
  direction: ScoredDirection;
  description: string;
  counterpartyName: string | null;
  counterpartyEmail: string | null;
  dueAt: string | null;
}

export interface CommitmentMatch {
  expectedIndex: number;
  actualIndex: number;
  /** Token Jaccard of the two descriptions, above the threshold. */
  similarity: number;
  /** Whether the pair agrees on the due date, by calendar day or both null. */
  dueMatch: boolean;
}

export interface CommitmentScore {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  /** Matched pairs that agree on the due date. */
  dueMatches: number;
  /** dueMatches over matched pairs, or null when nothing matched. */
  dueAccuracy: number | null;
  matches: CommitmentMatch[];
}

/** A pair below or at this similarity is never matched. */
export const DESCRIPTION_SIMILARITY_THRESHOLD = 0.6;

/**
 * Function words carry no signal about what was promised, so they are dropped
 * before the Jaccard. Verbs that change meaning (send, confirm, review) stay.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'about',
  'after',
  'all',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'before',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'him',
  'his',
  'i',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'not',
  'of',
  'on',
  'once',
  'or',
  'our',
  'ours',
  'out',
  'over',
  'set',
  'she',
  'should',
  'so',
  'some',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'they',
  'this',
  'to',
  'until',
  'up',
  'us',
  'was',
  'we',
  'were',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

/** Lower-cases, splits on anything that is not a letter or digit, drops stop words. */
export function tokenise(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
  return new Set(tokens);
}

/**
 * Jaccard overlap of the two token sets. Returns 0 when either side has no
 * content words left, because two empty sets tell us nothing about agreement.
 */
export function jaccardSimilarity(left: string, right: string): number {
  const a = tokenise(left);
  const b = tokenise(right);
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return intersection / union;
}

function normaliseName(name: string | null): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normaliseEmail(email: string | null): string {
  return (email ?? '').trim().toLowerCase();
}

/**
 * Two commitments are about the same counterparty when both carry an address
 * and the addresses match case insensitively, or, when either address is
 * missing, when the normalised names match.
 */
export function sameCounterparty(left: ScorableCommitment, right: ScorableCommitment): boolean {
  const leftEmail = normaliseEmail(left.counterpartyEmail);
  const rightEmail = normaliseEmail(right.counterpartyEmail);
  if (leftEmail !== '' && rightEmail !== '') {
    return leftEmail === rightEmail;
  }
  return normaliseName(left.counterpartyName) === normaliseName(right.counterpartyName);
}

/** Reduces a due value to a calendar day, or to itself when it is not a date. */
function calendarDay(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  const isoPrefix = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (isoPrefix !== null) {
    return isoPrefix[1] ?? trimmed;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    // Anything ISO-shaped was handled above, so what reaches here is a written
    // date such as 25 September 2026, which parses to local midnight. Reading
    // the local parts keeps it on the day it names.
    const date = new Date(parsed);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${String(date.getFullYear())}-${month}-${day}`;
  }
  return trimmed.toLowerCase();
}

/** True when both due values fall on the same calendar day, or both are absent. */
export function sameCalendarDay(left: string | null, right: string | null): boolean {
  const leftDay = calendarDay(left);
  const rightDay = calendarDay(right);
  if (leftDay === null || rightDay === null) {
    return leftDay === null && rightDay === null;
  }
  return leftDay === rightDay;
}

function ratio(numerator: number, denominator: number, emptyIsPerfect: boolean): number {
  if (denominator === 0) {
    return emptyIsPerfect ? 1 : 0;
  }
  return numerator / denominator;
}

/**
 * Greedy one-to-one matching by highest description similarity, then precision,
 * recall and F1 over the result.
 *
 * A pair is eligible when the direction is identical, the counterparty is the
 * same by the rule above, and the description similarity is above the
 * threshold. Ties are broken by expected index, then actual index, so the score
 * does not depend on iteration order.
 */
export function scoreCommitments(
  expected: readonly ScorableCommitment[],
  actual: readonly ScorableCommitment[],
): CommitmentScore {
  const candidates: Array<{
    expectedIndex: number;
    actualIndex: number;
    similarity: number;
    dueMatch: boolean;
  }> = [];
  for (const [expectedIndex, expectedItem] of expected.entries()) {
    for (const [actualIndex, actualItem] of actual.entries()) {
      if (expectedItem.direction !== actualItem.direction) {
        continue;
      }
      if (!sameCounterparty(expectedItem, actualItem)) {
        continue;
      }
      const similarity = jaccardSimilarity(expectedItem.description, actualItem.description);
      if (similarity <= DESCRIPTION_SIMILARITY_THRESHOLD) {
        continue;
      }
      candidates.push({
        expectedIndex,
        actualIndex,
        similarity,
        dueMatch: sameCalendarDay(expectedItem.dueAt, actualItem.dueAt),
      });
    }
  }

  candidates.sort(
    (left, right) =>
      right.similarity - left.similarity ||
      left.expectedIndex - right.expectedIndex ||
      left.actualIndex - right.actualIndex,
  );

  const takenExpected = new Set<number>();
  const takenActual = new Set<number>();
  const matches: CommitmentMatch[] = [];
  for (const candidate of candidates) {
    if (takenExpected.has(candidate.expectedIndex) || takenActual.has(candidate.actualIndex)) {
      continue;
    }
    takenExpected.add(candidate.expectedIndex);
    takenActual.add(candidate.actualIndex);
    matches.push({ ...candidate });
  }
  matches.sort((left, right) => left.expectedIndex - right.expectedIndex);

  const truePositives = matches.length;
  const falsePositives = actual.length - truePositives;
  const falseNegatives = expected.length - truePositives;
  const precision = ratio(truePositives, truePositives + falsePositives, falseNegatives === 0);
  const recall = ratio(truePositives, truePositives + falseNegatives, falsePositives === 0);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const dueMatches = matches.filter((match) => match.dueMatch).length;

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
    dueMatches,
    dueAccuracy: matches.length === 0 ? null : dueMatches / matches.length,
    matches,
  };
}
