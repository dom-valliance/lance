import { hashRecord, idempotencyKey } from '@lance/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { fakeDeps, TEST_INGEST_SECRET, type FakeDeps } from '../test-fakes.js';
import { agentLogActor, INGEST_SECRET_HEADER } from './ingest.js';

/** Builds a body with one field left out, to prove the schema requires it. */
const without = <T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};

const VALID_LOG = {
  agent: 'inbox-agent',
  recordId: 'slack-1758351600.123456',
  observedAt: '2026-09-20T09:00:00.000Z',
  level: 'info' as const,
  message: 'Posted the morning digest.',
  attributes: { channel: 'C0BU7P278N5' },
};

let harness: FakeDeps;
let server: FastifyInstance;

const post = async (
  body: unknown,
  secret: string | null = TEST_INGEST_SECRET,
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> =>
  server.inject({
    method: 'POST',
    url: '/ingest/agent-log',
    payload: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { [INGEST_SECRET_HEADER]: secret }),
    },
  });

beforeEach(() => {
  harness = fakeDeps();
  server = buildServer(harness.deps);
});

afterEach(async () => {
  await server.close();
});

describe('POST /ingest/agent-log', () => {
  it('rejects a request with the wrong shared secret', async () => {
    const response = await post(VALID_LOG, 'the-wrong-secret');

    expect(response.statusCode).toBe(401);
    expect(harness.writer.appended).toEqual([]);
  });

  it('rejects a request with no shared secret header', async () => {
    const response = await post(VALID_LOG, null);

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: string }>().error).toContain(INGEST_SECRET_HEADER);
  });

  it('rejects a body missing a required field', async () => {
    const response = await post(without(VALID_LOG, 'recordId'));

    expect(response.statusCode).toBe(400);
    expect(response.json<{ issues: { path: string }[] }>().issues[0]?.path).toBe('recordId');
    expect(harness.writer.appended).toEqual([]);
  });

  it('rejects a body whose level is not a known level', async () => {
    const response = await post({ ...VALID_LOG, level: 'catastrophic' });

    expect(response.statusCode).toBe(400);
    expect(harness.writer.appended).toEqual([]);
  });

  it('rejects a body whose observedAt carries no offset', async () => {
    const response = await post({ ...VALID_LOG, observedAt: '2026-09-20 09:00:00' });

    expect(response.statusCode).toBe(400);
  });

  it('appends one observed event with webhook provenance and answers 202', async () => {
    const response = await post(VALID_LOG);

    expect(response.statusCode).toBe(202);
    expect(response.json<{ id: string; inserted: boolean }>().inserted).toBe(true);

    expect(harness.writer.appended).toHaveLength(1);
    const appended = harness.writer.appended[0];
    const hash = hashRecord(VALID_LOG);

    expect(appended).toMatchObject({
      ts: VALID_LOG.observedAt,
      actor: 'agent:inbox-agent@0.0.0',
      kind: 'observed',
      sourceSystem: 'webhook',
      sourceRecordId: VALID_LOG.recordId,
      sourceRecordHash: hash,
      idempotencyKey: idempotencyKey('webhook', VALID_LOG.recordId, hash),
      payload: { kind: 'agent_log', ...VALID_LOG },
    });
    expect(appended?.correlationId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('accepts a body with no attributes', async () => {
    const withoutAttributes = without(VALID_LOG, 'attributes');
    const response = await post(withoutAttributes);

    expect(response.statusCode).toBe(202);
    expect(harness.writer.appended[0]?.payload).toEqual({
      kind: 'agent_log',
      ...withoutAttributes,
    });
  });
});

describe('agentLogActor', () => {
  it('keeps a name that already matches the actor pattern', () => {
    expect(agentLogActor('inbox-agent')).toBe('agent:inbox-agent@0.0.0');
  });

  it('folds case and replaces runs of unsupported characters with one hyphen', () => {
    expect(agentLogActor('Inbox Agent v2_beta')).toBe('agent:inbox-agent-v-beta@0.0.0');
  });

  it('trims leading and trailing hyphens', () => {
    expect(agentLogActor('  agent 7  ')).toBe('agent:agent@0.0.0');
  });

  it('falls back to unknown when nothing usable is left', () => {
    expect(agentLogActor('123')).toBe('agent:unknown@0.0.0');
  });
});
