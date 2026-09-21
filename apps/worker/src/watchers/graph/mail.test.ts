import type {
  DeltaMessagesOptions,
  MailFolder,
  Message,
  MessageDelta,
} from '@lance/connectors/graph';
import { describe, expect, it } from 'vitest';
import type { Observation, SourceRecord } from '../types.js';
import {
  GRAPH_MAIL_SCHEDULES,
  createGraphMailWatcher,
  htmlToText,
  resolveMailFolders,
  type GraphMailRecord,
  type MailLabeller,
} from './mail.js';

const NOW = '2026-09-21T09:00:00.000Z';

function message(overrides: Record<string, unknown> = {}): Message {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    internetMessageId: '<msg-1@northwind.example.com>',
    subject: 'Renewal paperwork',
    from: {
      emailAddress: { name: 'Priya Raman', address: 'priya.raman@northwind.example.com' },
    },
    toRecipients: [{ emailAddress: { name: 'Dom Selvon', address: 'dom@valliance.ai' } }],
    ccRecipients: [],
    receivedDateTime: '2026-09-21T08:12:44Z',
    sentDateTime: '2026-09-21T08:12:39Z',
    isRead: false,
    categories: ['Deals'],
    parentFolderId: 'inbox',
    bodyPreview: 'Sending the renewal paperwork across.',
    body: { contentType: 'text', content: 'Sending the renewal paperwork across.' },
    webLink: 'https://outlook.office365.com/owa/?ItemID=msg-1',
    ...overrides,
  };
}

function delta(overrides: Partial<MessageDelta> = {}): MessageDelta {
  return { messages: [], removed: [], deltaLink: 'delta-2', ...overrides };
}

interface FakeReads {
  calls: DeltaMessagesOptions[];
  deltaMessages(options: DeltaMessagesOptions): Promise<MessageDelta>;
}

function fakeReads(result: MessageDelta): FakeReads {
  const calls: DeltaMessagesOptions[] = [];
  return {
    calls,
    deltaMessages: (options) => {
      calls.push(options);
      return Promise.resolve(result);
    },
  };
}

const constantLabeller: MailLabeller = () => Promise.resolve(['Deals']);

function watcherWith(reads: FakeReads, label: MailLabeller = constantLabeller) {
  return createGraphMailWatcher({ reads, label, now: () => NOW });
}

async function normaliseOne(
  record: SourceRecord,
  partition = 'inbox',
  label: MailLabeller = constantLabeller,
): Promise<Observation> {
  return watcherWith(fakeReads(delta()), label).normalise(record, partition);
}

describe('createGraphMailWatcher', () => {
  it('watches the inbox and sent items with the spec 7.1 schedules', async () => {
    const watcher = watcherWith(fakeReads(delta()));
    expect(watcher.name).toBe('graph-mail');
    expect(watcher.sourceSystem).toBe('graph');
    expect(watcher.schedules).toEqual([...GRAPH_MAIL_SCHEDULES]);
    expect(await watcher.partitions()).toEqual(['inbox', 'sentitems']);
  });

  it('asks Graph for a full sync on the first poll of a folder', async () => {
    const reads = fakeReads(delta());
    await watcherWith(reads).poll('inbox', null);
    expect(reads.calls).toEqual([{ folderId: 'inbox' }]);
    expect(reads.calls[0]).not.toHaveProperty('deltaLink');
  });

  it('passes the stored cursor back to Graph and returns the next delta link', async () => {
    const reads = fakeReads(delta({ deltaLink: 'delta-3' }));
    const result = await watcherWith(reads).poll('inbox', 'delta-2');
    expect(reads.calls).toEqual([{ folderId: 'inbox', deltaLink: 'delta-2' }]);
    expect(result.nextCursor).toBe('delta-3');
  });

  it('turns messages into records and removed ids into removal records', async () => {
    const reads = fakeReads(
      delta({ messages: [message()], removed: ['msg-9'], deltaLink: 'delta-3' }),
    );
    const result = await watcherWith(reads).poll('inbox', null);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({ id: 'msg-1', observedAt: '2026-09-21T08:12:44Z' });
    expect(result.records[0]?.removed).toBeUndefined();
    expect(result.records[1]).toEqual({
      id: 'msg-9',
      observedAt: NOW,
      raw: { id: 'msg-9' },
      removed: true,
    });
  });

  it('dates a sent message by when it was sent', async () => {
    const reads = fakeReads(
      delta({
        messages: [message({ receivedDateTime: null, sentDateTime: '2026-09-21T07:00:00Z' })],
      }),
    );
    const result = await watcherWith(reads).poll('sentitems', null);
    expect(result.records[0]?.observedAt).toBe('2026-09-21T07:00:00Z');
  });

  it('refuses a partition it does not watch', async () => {
    await expect(watcherWith(fakeReads(delta())).poll('archive', null)).rejects.toThrow(
      /not one of its folders/,
    );
  });
});

describe('graph-mail normalise', () => {
  it('keeps only the canonical fields, dropping the HTML body and attachments', async () => {
    const observation = await normaliseOne({
      id: 'msg-1',
      observedAt: '2026-09-21T08:12:44Z',
      raw: message({ attachments: [{ id: 'att-1', name: 'contract.pdf' }] }),
    });
    const record = observation.record as GraphMailRecord;
    expect(Object.keys(record).sort()).toEqual([
      'bodyPreview',
      'bodyText',
      'ccRecipients',
      'conversationId',
      'folder',
      'from',
      'id',
      'internetMessageId',
      'receivedDateTime',
      'removed',
      'sentDateTime',
      'subject',
      'toRecipients',
    ]);
    expect(record).not.toHaveProperty('body');
    expect(record).not.toHaveProperty('attachments');
    expect(record.from).toEqual({
      name: 'Priya Raman',
      address: 'priya.raman@northwind.example.com',
    });
    expect(record.toRecipients).toEqual([{ name: 'Dom Selvon', address: 'dom@valliance.ai' }]);
    expect(record.folder).toBe('inbox');
    expect(observation.url).toBe('https://outlook.office365.com/owa/?ItemID=msg-1');
    expect(observation.summary).toBe('Priya Raman: Renewal paperwork');
  });

  it('renders an HTML body as plain text on the record', async () => {
    const observation = await normaliseOne({
      id: 'msg-1',
      observedAt: NOW,
      raw: message({
        body: {
          contentType: 'html',
          content:
            '<html><head><style>p{color:red}</style></head><body><p>Hello   Dom</p><p>Fees &amp; terms&nbsp;attached.</p></body></html>',
        },
      }),
    });
    expect((observation.record as GraphMailRecord).bodyText).toBe(
      'Hello Dom Fees & terms attached.',
    );
  });

  it('caps the body text at twenty thousand characters', async () => {
    const observation = await normaliseOne({
      id: 'msg-1',
      observedAt: NOW,
      raw: message({ body: { contentType: 'text', content: 'a'.repeat(25_000) } }),
    });
    expect((observation.record as GraphMailRecord).bodyText).toHaveLength(20_000);
  });

  it('groups a message under its conversation', async () => {
    const observation = await normaliseOne({ id: 'msg-1', observedAt: NOW, raw: message() });
    expect(observation.correlationKey).toBe('conv-1');
  });

  it('falls back to the message id when Graph sends no conversation', async () => {
    const observation = await normaliseOne({
      id: 'msg-1',
      observedAt: NOW,
      raw: message({ conversationId: null }),
    });
    expect(observation.correlationKey).toBe('msg-1');
  });

  it('labels the message with the injected labeller', async () => {
    const seen: Array<Omit<Observation, 'labels'>> = [];
    const observation = await normaliseOne(
      { id: 'msg-1', observedAt: NOW, raw: message() },
      'inbox',
      (input) => {
        seen.push(input);
        return Promise.resolve(['Deals', 'Priority']);
      },
    );
    expect(observation.labels).toEqual(['Deals', 'Priority']);
    expect(seen[0]?.correlationKey).toBe('conv-1');
  });

  it('marks the message Unlabelled and carries on when the labeller throws', async () => {
    const observation = await normaliseOne(
      { id: 'msg-1', observedAt: NOW, raw: message() },
      'inbox',
      () => Promise.reject(new Error('Haiku is down')),
    );
    expect(observation.labels).toEqual(['Unlabelled']);
    expect(observation.correlationKey).toBe('conv-1');
  });

  it('marks the message Unlabelled when the labeller returns nothing', async () => {
    const observation = await normaliseOne(
      { id: 'msg-1', observedAt: NOW, raw: message() },
      'inbox',
      () => Promise.resolve([]),
    );
    expect(observation.labels).toEqual(['Unlabelled']);
  });

  it('spends no label call on a removed message', async () => {
    let calls = 0;
    const observation = await normaliseOne(
      { id: 'msg-9', observedAt: NOW, raw: { id: 'msg-9' }, removed: true },
      'inbox',
      () => {
        calls += 1;
        return Promise.resolve(['Deals']);
      },
    );
    expect(calls).toBe(0);
    expect(observation.labels).toBeUndefined();
    expect((observation.record as GraphMailRecord).removed).toBe(true);
    expect(observation.summary).toBe('Message removed from inbox');
  });
});

describe('htmlToText', () => {
  it('drops scripts, strips tags, decodes entities and collapses whitespace', () => {
    expect(
      htmlToText(
        '<div><script>alert(1)</script>Terms &lt;attached&gt;\n\n  today&#39;s copy</div>',
      ),
    ).toBe("Terms <attached> today's copy");
  });

  it('closes up an inline tag so punctuation stays put', () => {
    expect(htmlToText('<p>Paperwork <b>attached</b>.</p><p>Next line</p>')).toBe(
      'Paperwork attached. Next line',
    );
  });
});

describe('resolveMailFolders', () => {
  const folders: MailFolder[] = [
    { id: 'AAMk-inbox', displayName: 'Inbox' },
    { id: 'AAMk-sent', displayName: 'Sent Items' },
    { id: 'AAMk-filed', displayName: 'AI-Filed' },
  ];

  it('finds the inbox and sent items by display name', async () => {
    expect(await resolveMailFolders({ listMailFolders: () => Promise.resolve(folders) })).toEqual([
      { id: 'AAMk-inbox', kind: 'inbox' },
      { id: 'AAMk-sent', kind: 'sentitems' },
    ]);
  });

  it('names the missing folder when the mailbox has no match', async () => {
    await expect(
      resolveMailFolders({ listMailFolders: () => Promise.resolve([folders[0] as MailFolder]) }),
    ).rejects.toThrow(/"Sent Items"/);
  });
});
