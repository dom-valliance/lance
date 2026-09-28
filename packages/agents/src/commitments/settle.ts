import type { OwedToPrincipal } from './schema.js';

/**
 * The fields the floor reads. Both the transcript extractor's candidates
 * and mail triage's carry them.
 */
export interface SettleableCandidate {
  direction: 'outbound' | 'inbound';
  promisedTo: string | null;
  owedToPrincipal: OwedToPrincipal | null;
}

export interface PrincipalName {
  name: string;
  email: string;
}

const tokens = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^\p{L}\p{N}@.'-]+/u)
    .filter((token) => token !== '');

/**
 * Whether `promisedTo` names the principal: their email, their full name,
 * or their first name alone, ignoring case. A name with any word the
 * principal's name does not have ("Dom's team", "Priya") is someone else.
 */
export function namesPrincipal(promisedTo: string | null, principal: PrincipalName): boolean {
  if (promisedTo === null) return false;
  const wanted = tokens(promisedTo);
  if (wanted.length === 0) return false;
  if (wanted.includes(principal.email.toLowerCase())) return true;
  const own = new Set(tokens(principal.name));
  return wanted.every((token) => own.has(token));
}

/**
 * The deterministic floor under the model's judgement (ADR 0037). An
 * inbound candidate stays `definite` only when `promisedTo` names the
 * principal; anything else the model was unsure of, or did not say, is
 * `possible`. A promise made to someone else is discarded. The model can
 * make a commitment less certain than it said, never more. Outbound
 * candidates carry no certainty.
 */
export function settleOwedToPrincipal<T extends SettleableCandidate>(
  candidates: readonly T[],
  principal: PrincipalName,
): T[] {
  const settled: T[] = [];
  for (const candidate of candidates) {
    if (candidate.direction === 'outbound') {
      settled.push({ ...candidate, owedToPrincipal: null });
      continue;
    }
    if (candidate.owedToPrincipal === 'not_principal') continue;
    const definite =
      candidate.owedToPrincipal === 'definite' && namesPrincipal(candidate.promisedTo, principal);
    settled.push({ ...candidate, owedToPrincipal: definite ? 'definite' : 'possible' });
  }
  return settled;
}
