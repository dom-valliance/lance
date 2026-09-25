import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { PLACEHOLDER_SECRET_VALUE } from '@lance/shared';
import { describe, expect, it } from 'vitest';
import {
  checkPeriod,
  evidenceSignerFromEnv,
  evidenceSignerFromPem,
  toMetadata,
  type EventRow,
} from './evidence.js';

const ed25519 = (): string =>
  generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });

describe('the evidence signer', () => {
  it('signs the exact text with Ed25519, verifiable with the public key it carries', () => {
    const signer = evidenceSignerFromPem(ed25519());
    const text = JSON.stringify({ format: 'lance-evidence/1', n: 1 });
    const signature = signer.sign(text);

    expect(signature.algorithm).toBe('Ed25519');
    expect(signature.keyId).toMatch(/^[0-9a-f]{16}$/);
    const key = createPublicKey(signature.publicKey);
    expect(verify(null, Buffer.from(text), key, Buffer.from(signature.value, 'base64'))).toBe(true);
    expect(verify(null, Buffer.from(`${text} `), key, Buffer.from(signature.value, 'base64'))).toBe(
      false,
    );
  });

  it('keeps one key id for one key', () => {
    const pem = ed25519();
    expect(evidenceSignerFromPem(pem).keyId).toBe(evidenceSignerFromPem(pem).keyId);
  });

  it('refuses a key that is not Ed25519, and text that is not a key', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    });
    expect(() => evidenceSignerFromPem(rsa)).toThrow(/Ed25519/);
    expect(() => evidenceSignerFromPem('not a key')).toThrow(/openssl genpkey/);
  });

  it("is absent while the secret is unset or still the template's placeholder", () => {
    expect(evidenceSignerFromEnv({})).toBeNull();
    expect(evidenceSignerFromEnv({ EVIDENCE_SIGNING_KEY: PLACEHOLDER_SECRET_VALUE })).toBeNull();
    expect(evidenceSignerFromEnv({ EVIDENCE_SIGNING_KEY: ed25519() })).not.toBeNull();
  });
});

describe('the evidence period', () => {
  it('accepts up to 366 days and refuses anything longer, reversed or unreadable', () => {
    expect(checkPeriod('2026-01-01T00:00:00Z', '2027-01-02T00:00:00Z').to.toISOString()).toBe(
      '2027-01-02T00:00:00.000Z',
    );
    expect(() => checkPeriod('2026-01-01T00:00:00Z', '2027-01-03T00:00:00Z')).toThrow(/366 days/);
    expect(() => checkPeriod('2026-09-24T00:00:00Z', '2026-09-01T00:00:00Z')).toThrow(/end after/);
    expect(() => checkPeriod('yesterday', '2026-09-01T00:00:00Z')).toThrow(/ISO-8601/);
  });
});

describe('the per-principal ledger metadata', () => {
  it('carries the payload hash and never the source record hash', () => {
    const row = {
      id: '01K5S9V6QW3SWCCPVB0N0E3E01',
      principal_id: '01K5S9V6QW3SWCCPVB0N0E300H',
      ts: '2026-09-22T08:00:00.000Z',
      created_at: '2026-09-22T08:00:01.000Z',
      actor: 'watcher:graph-mail',
      kind: 'observed',
      source_system: 'graph',
      source_record_hash: 'hash-of-the-mail-content',
      correlation_id: 'corr-1',
      payload_hash: 'hash-of-the-payload',
      payload: { subject: 'Private' },
    } as EventRow;

    const metadata = toMetadata(row);

    expect(metadata.payloadHash).toBe('hash-of-the-payload');
    expect(metadata.payloadHeld).toBe(true);
    expect(JSON.stringify(metadata)).not.toContain('hash-of-the-mail-content');
    expect(JSON.stringify(metadata)).not.toContain('Private');
  });
});
