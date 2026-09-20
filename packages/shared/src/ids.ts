import { monotonicFactory } from 'ulid';

/**
 * Crockford base32, 26 characters: the canonical ULID shape used for every
 * id in the relational schema (spec 5.1: "Ids are ULIDs").
 */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * A ULID string, branded so it cannot be mixed up with an arbitrary string
 * at the type level. The brand is compile-time only; at runtime a `Ulid` is
 * just a string.
 */
export type Ulid = string & { readonly __brand: 'Ulid' };

/**
 * Generates a new, lexicographically sortable ULID. Monotonic within this
 * process, so two ids minted in the same millisecond still order correctly.
 *
 * Uses the `ulid` npm package rather than a hand-rolled generator: ULID
 * generation must be monotonic-safe and cryptographically random, and a
 * small, widely used, dependency-free implementation is less risk than
 * maintaining the same logic in this repository.
 */
const nextUlid = monotonicFactory();

export function newUlid(): Ulid {
  return nextUlid() as Ulid;
}

/**
 * Narrows `value` to `Ulid` when it is 26 characters of Crockford base32.
 */
export function isUlid(value: string): value is Ulid {
  return ULID_PATTERN.test(value);
}
