import { seedRules } from '@lance/policy';
import type { Proposal } from '@lance/shared';
import { describe, expect, it, vi } from 'vitest';
import { createConnectorWrite, ExecutionRefusedError, type ExecutionWriters } from './dispatch.js';

const rules = seedRules({ slackChannelId: 'C0BU7P278N5', createdAt: '2026-09-21T00:00:00.000Z' });

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    correlationId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    actionClass: 'apply_category',
    counterpartyClass: 'unknown',
    targetSystem: 'graph',
    targetRecordId: 'AAMk1',
    reversibility: 'reversible',
    payload: { categories: ['Newsletters'] },
    preview: 'Apply category Newsletters',
    rationale: 'Newsletter.',
    provenance: [
      { system: 'graph', recordId: 'AAMk1', hash: 'h', observedAt: '2026-09-21T08:00:00.000Z' },
    ],
    policyDecision: 'auto',
    policyRuleId: null,
    status: 'approved',
    decidedBy: 'system:policy',
    decidedAt: '2026-09-21T08:00:00.000Z',
    decisionNote: null,
    editedPayload: null,
    slackChannel: null,
    slackTs: null,
    expiresAt: '2026-09-23T08:00:00.000Z',
    executionEventId: null,
    ...overrides,
  };
}

function writers(): ExecutionWriters & {
  graph: NonNullable<ExecutionWriters['graph']>;
  notion: NonNullable<ExecutionWriters['notion']>;
} {
  return {
    graph: {
      applyCategories: vi
        .fn()
        .mockResolvedValue({ id: 'AAMk1', webLink: 'https://outlook.test/m1' }),
      moveMessage: vi.fn().mockResolvedValue({ id: 'AAMk1-moved' }),
      createDraft: vi.fn().mockResolvedValue({ id: 'draft-1', webLink: 'https://outlook.test/d1' }),
      createReplyDraft: vi.fn().mockResolvedValue({ id: 'draft-2' }),
      createEvent: vi.fn().mockResolvedValue({ id: 'evt-1' }),
      resolveFolderId: vi.fn().mockResolvedValue('folder-ai-filed'),
    },
    notion: {
      createTask: vi.fn().mockResolvedValue({ id: 'page-1', url: 'https://notion.so/page-1' }),
    },
  };
}

function dispatch(
  p: Proposal,
  w = writers(),
  verdict: 'unchanged' | 'changed' | 'unknown' = 'unchanged',
) {
  return {
    write: createConnectorWrite({
      db: {} as never,
      writers: w,
      loadRules: () => Promise.resolve(rules),
      verifyTarget: () => Promise.resolve(verdict),
      loadProposal: (id) => Promise.resolve(id === p.id ? p : null),
      now: () => '2026-09-21T10:00:00.000Z',
    }),
    w,
  };
}

describe('connector dispatch', () => {
  it('applies categories through Graph and reports no compensation', async () => {
    const { write, w } = dispatch(proposal());
    const outcome = await write.perform(proposal().id);
    expect(w.graph.applyCategories).toHaveBeenCalledWith({
      messageId: 'AAMk1',
      categories: ['Newsletters'],
    });
    expect(outcome).toEqual({
      targetRecordId: 'AAMk1',
      url: 'https://outlook.test/m1',
      compensation: null,
    });
  });

  it('moves mail, resolving a folder name to an id, and records how to move it back', async () => {
    const p = proposal({
      actionClass: 'move_mail',
      payload: { destinationFolderName: 'AI-Filed', sourceFolderId: 'inbox' },
    });
    const { write, w } = dispatch(p);
    const outcome = await write.perform(p.id);
    expect(w.graph.resolveFolderId).toHaveBeenCalledWith('AI-Filed');
    expect(w.graph.moveMessage).toHaveBeenCalledWith({
      messageId: 'AAMk1',
      destinationFolderId: 'folder-ai-filed',
    });
    expect(outcome.compensation).toMatchObject({ actionClass: 'move_mail', backTo: 'inbox' });
  });

  it('uses the edited payload when Dom edited the proposal', async () => {
    const p = proposal({
      actionClass: 'draft_email',
      counterpartyClass: 'client',
      status: 'edited',
      policyDecision: 'propose',
      payload: { subject: 'Re: SOW', bodyText: 'Original', to: ['a@example.com'] },
      editedPayload: { subject: 'Re: SOW', bodyText: 'Edited by Dom', to: ['a@example.com'] },
    });
    const { write, w } = dispatch(p);
    await write.perform(p.id);
    expect(w.graph.createDraft).toHaveBeenCalledWith({
      subject: 'Re: SOW',
      bodyText: 'Edited by Dom',
      to: ['a@example.com'],
    });
  });

  it('creates a reply draft when the payload names a message to reply to', async () => {
    const p = proposal({
      actionClass: 'draft_email',
      policyDecision: 'propose',
      payload: { replyToMessageId: 'AAMk1', bodyText: 'Thanks.' },
    });
    const { write, w } = dispatch(p);
    const outcome = await write.perform(p.id);
    expect(w.graph.createReplyDraft).toHaveBeenCalledWith({
      messageId: 'AAMk1',
      comment: 'Thanks.',
    });
    expect(outcome.compensation).toMatchObject({ actionClass: 'draft_email', draftId: 'draft-2' });
  });

  it('creates a Notion task from the connector input and records the cancel compensation', async () => {
    const p = proposal({
      actionClass: 'create_task',
      counterpartyClass: 'self',
      targetSystem: 'notion',
      targetRecordId: null,
      policyDecision: 'propose',
      payload: { dataSourceId: 'ds', input: { title: 'Send SOW', assigneeIds: ['dom'] } },
    });
    const { write, w } = dispatch(p);
    const outcome = await write.perform(p.id);
    expect(w.notion.createTask).toHaveBeenCalledWith({ title: 'Send SOW', assigneeIds: ['dom'] });
    expect(outcome).toMatchObject({
      targetRecordId: 'page-1',
      url: 'https://notion.so/page-1',
      compensation: { pageId: 'page-1', status: 'Cancelled' },
    });
  });

  it('refuses when the target changed since the proposal', async () => {
    const { write } = dispatch(proposal(), writers(), 'changed');
    await expect(write.perform(proposal().id)).rejects.toMatchObject({ reason: 'target_changed' });
  });

  it('refuses when policy now forbids the action', async () => {
    const p = proposal({ actionClass: 'send_email', policyDecision: 'propose' });
    const { write, w } = dispatch(p);
    await expect(write.perform(p.id)).rejects.toMatchObject({ reason: 'forbidden_at_execution' });
    expect(w.graph.createDraft).not.toHaveBeenCalled();
  });

  it('refuses Jamie tags and other v1 gaps with unsupported_target', async () => {
    const p = proposal({
      actionClass: 'apply_tag',
      targetSystem: 'jamie',
      policyDecision: 'propose',
    });
    const { write } = dispatch(p);
    await expect(write.perform(p.id)).rejects.toBeInstanceOf(ExecutionRefusedError);
    await expect(write.perform(p.id)).rejects.toMatchObject({ reason: 'unsupported_target' });
  });

  it('refuses a payload missing what the write needs, before calling anything', async () => {
    const p = proposal({
      actionClass: 'create_calendar_hold',
      policyDecision: 'propose',
      payload: { subject: 'Hold' },
    });
    const { write, w } = dispatch(p);
    await expect(write.perform(p.id)).rejects.toMatchObject({ reason: 'bad_payload' });
    expect(w.graph.createEvent).not.toHaveBeenCalled();
  });
});
