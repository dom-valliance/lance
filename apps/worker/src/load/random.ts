/**
 * A seeded random source for the load harness, so two runs with the same
 * seed draw the same latencies and the same fixture mailboxes and can be
 * compared before and after a change. Mulberry32: small, fast and good
 * enough for spreading delays; not for anything that needs to be secret.
 */
export interface Random {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], both inclusive. */
  between(min: number, max: number): number;
  /** One element of a non-empty list. */
  pick<T>(items: readonly T[]): T;
}

export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    between: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('pick needs a non-empty list.');
      return item;
    },
  };
}
