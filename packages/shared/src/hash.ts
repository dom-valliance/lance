import { createHash } from 'node:crypto';
import type { SourceSystem } from './enums.js';

/**
 * Recursively sorts object keys and normalises `Date` instances to ISO
 * strings so the same logical value always serialises to the same bytes,
 * regardless of property insertion order. Arrays keep their given order:
 * order is meaningful there. `undefined` object properties are dropped, the
 * same way `JSON.stringify` drops them.
 */
function canonicalise(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalise(item));
  }
  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      const propertyValue = (value as Record<string, unknown>)[key];
      if (propertyValue !== undefined) {
        result[key] = canonicalise(propertyValue);
      }
    }
    return result;
  }
  return value;
}

/**
 * Serialises `value` to JSON with keys sorted at every depth and no
 * whitespace, so two values that are deeply equal but built with different
 * key orders produce identical output. Used wherever a stable content hash
 * is needed (source record hashes, payload hashes, idempotency keys).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

/**
 * Lower-case hex SHA-256 digest of `input`.
 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * SHA-256 digest of `value`'s canonical JSON form. Used for
 * `source_record_hash` and `payload_hash` in the ledger.
 */
export function hashRecord(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * The ledger idempotency key format from spec 5.1: `system:record_id:hash`.
 * Re-running a watcher over the same window must produce the same key for
 * the same observation, so ingestion stays idempotent (non-negotiable 6).
 */
export function idempotencyKey(
  system: SourceSystem,
  recordId: string,
  contentHash: string,
): string {
  return `${system}:${recordId}:${contentHash}`;
}
