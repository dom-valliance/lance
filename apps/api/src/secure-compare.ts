import { timingSafeEqual } from 'node:crypto';

/**
 * Compares two secrets without leaking which byte differed. `timingSafeEqual`
 * throws on differing lengths, so the length is checked first; that leaks
 * the length of the supplied value, never its contents.
 */
export const constantTimeEquals = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};
