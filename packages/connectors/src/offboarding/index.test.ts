import { describe, expect, it } from 'vitest';
import { FakeClock } from '../core/testing.js';
import { InMemorySecrets } from '../secrets/vault.js';
import {
  createPrincipalSecretPurger,
  createSlackChannelArchiver,
  ProtectedChannelError,
} from './index.js';

const PRINCIPAL = '01K5S9V6QW3SWCCPVB0N0E3A01';
const OTHER = '01K5S9V6QW3SWCCPVB0N0E300H';
const DOM_CLAUDE_AGENT = 'C0BU7P278N5';

describe('createPrincipalSecretPurger', () => {
  it("deletes the principal's three secrets and leaves everyone else's", async () => {
    const vault = new InMemorySecrets({
      [`graph-refresh-token--${PRINCIPAL}`]: 'rt',
      [`jamie-api-key--${PRINCIPAL}`]: 'jk',
      [`graph-refresh-token--${OTHER}`]: 'rt-other',
    });
    const results = await createPrincipalSecretPurger(vault).purge(PRINCIPAL);

    expect(results).toEqual([
      { name: `graph-refresh-token--${PRINCIPAL}`, outcome: 'deleted' },
      { name: `jamie-api-key--${PRINCIPAL}`, outcome: 'deleted' },
      { name: `foundry-refresh-token--${PRINCIPAL}`, outcome: 'absent' },
    ]);
    expect(vault.has(`graph-refresh-token--${OTHER}`)).toBe(true);
  });

  it('finds everything absent when run a second time', async () => {
    const vault = new InMemorySecrets({ [`jamie-api-key--${PRINCIPAL}`]: 'jk' });
    const purger = createPrincipalSecretPurger(vault);
    await purger.purge(PRINCIPAL);
    const again = await purger.purge(PRINCIPAL);
    expect(again.map((result) => result.outcome)).toEqual(['absent', 'absent', 'absent']);
  });

  it('refuses a principal id that is not a ULID, so no other name can be reached', async () => {
    const vault = new InMemorySecrets();
    await expect(createPrincipalSecretPurger(vault).purge('dom')).rejects.toThrow();
    expect(vault.deletes).toEqual([]);
  });
});

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

function stubFetch(responses: Array<{ body: unknown }>) {
  const captured: Captured[] = [];
  const queue = [...responses];
  const fetchImpl = ((url: string, init: RequestInit) => {
    captured.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown> });
    const next = queue.shift() ?? { body: { ok: true } };
    return Promise.resolve(new Response(JSON.stringify(next.body), { status: 200 }));
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

describe('createSlackChannelArchiver', () => {
  const archiver = (responses: Array<{ body: unknown }>) => {
    const stub = stubFetch(responses);
    return {
      ...stub,
      archiver: createSlackChannelArchiver({
        token: 'xoxb-test',
        fetchImpl: stub.fetchImpl,
        clock: new FakeClock(),
        protectedChannelIds: [DOM_CLAUDE_AGENT],
      }),
    };
  };

  it("archives a principal's private channel", async () => {
    const { archiver: subject, captured } = archiver([{ body: { ok: true } }]);
    await expect(subject.archive('G0ANN')).resolves.toBe('archived');
    expect(captured).toEqual([
      { url: 'https://slack.com/api/conversations.archive', body: { channel: 'G0ANN' } },
    ]);
  });

  it('counts a channel already archived, or gone, as done', async () => {
    const { archiver: subject } = archiver([
      { body: { ok: false, error: 'already_archived' } },
      { body: { ok: false, error: 'channel_not_found' } },
    ]);
    await expect(subject.archive('G0ANN')).resolves.toBe('already_archived');
    await expect(subject.archive('G0ANN')).resolves.toBe('not_found');
  });

  it('never archives dom-claude-agent, and sends Slack nothing when asked to', async () => {
    const { archiver: subject, captured } = archiver([]);
    await expect(subject.archive(DOM_CLAUDE_AGENT)).rejects.toBeInstanceOf(ProtectedChannelError);
    expect(captured).toEqual([]);
  });

  it('cannot be built without a protected channel', () => {
    expect(() =>
      createSlackChannelArchiver({ token: 't', clock: new FakeClock(), protectedChannelIds: [''] }),
    ).toThrow(/protected channel/);
  });
});
