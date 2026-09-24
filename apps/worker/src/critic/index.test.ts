import type { ProposalDraft } from '@lance/agents';
import type { PolicyRule } from '@lance/shared';
import { describe, expect, it } from 'vitest';
import { critique } from './index.js';

const provenance = [
  { system: 'graph' as const, recordId: 'AAMk1', hash: 'h', observedAt: '2026-09-21T08:00:00Z' },
];

const draftEmail = (overrides: Partial<ProposalDraft> = {}): ProposalDraft => ({
  actionClass: 'draft_email',
  counterpartyClass: 'client',
  targetSystem: 'graph',
  targetRecordId: 'AAMk1',
  payload: { subject: 'Re: SOW', bodyText: 'Thanks, sending it today.', to: ['ann@client.test'] },
  preview: 'Reply to Ann',
  rationale: 'Ann asked for the SOW.',
  provenance,
  confidence: 0.9,
  ...overrides,
});

const rule = (overrides: Partial<PolicyRule> = {}): PolicyRule => ({
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  principalId: null,
  version: 1,
  actionClass: 'draft_email',
  counterpartyClass: '*',
  system: 'graph',
  decision: 'propose',
  conditions: {},
  rationale: 'test',
  active: true,
  createdAt: '2026-09-21T00:00:00Z',
  createdBy: 'user:dom',
  ...overrides,
});

const options = { permittedNotionProperties: ['Title', 'Status'] };

describe('critique', () => {
  it('passes a plain draft addressed to someone in the source record', async () => {
    const verdict = await critique(draftEmail(), {
      ...options,
      sourceRecords: [{ from: { address: 'ann@client.test' } }],
    });
    expect(verdict).toEqual({ passed: true, notes: [] });
  });

  it('holds a draft that breaks a voice hard rule', async () => {
    const verdict = await critique(
      draftEmail({ payload: { bodyText: 'Thanks — sending it today.', to: [] } }),
      options,
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.notes[0]).toContain('Voice');
  });

  it('holds a draft whose target is not in its provenance', async () => {
    const verdict = await critique(draftEmail({ targetRecordId: 'AAMk-other' }), options);
    expect(verdict.notes).toEqual(["Target AAMk-other is not in the proposal's provenance."]);
  });

  it('holds an action the authorising rule does not cover', async () => {
    const verdict = await critique(draftEmail(), {
      ...options,
      authorisedBy: rule({ actionClass: 'apply_category' }),
    });
    expect(verdict.notes[0]).toContain('covers apply_category');
  });

  it('accepts a wildcard rule as authorisation', async () => {
    const verdict = await critique(draftEmail(), {
      ...options,
      authorisedBy: rule({ actionClass: '*', system: '*' }),
    });
    expect(verdict.passed).toBe(true);
  });

  it('holds a payload that names an address no source record contains', async () => {
    const verdict = await critique(
      draftEmail({
        payload: { bodyText: 'Copying Bob.', to: ['ann@client.test'], cc: ['bob@else.test'] },
      }),
      { ...options, sourceRecords: [{ from: { address: 'Ann@Client.test' } }] },
    );
    expect(verdict.notes).toEqual(['Address bob@else.test does not appear in any source record.']);
  });

  it('holds a Notion task that writes a property outside ADR 0009', async () => {
    const verdict = await critique(
      {
        actionClass: 'create_task',
        counterpartyClass: 'self',
        targetSystem: 'notion',
        targetRecordId: null,
        payload: { input: { title: 'Send SOW', hubspotTaskId: '42' } },
        preview: 'Create task',
        rationale: 'test',
        provenance,
        confidence: 0.8,
      },
      options,
    );
    expect(verdict.notes).toEqual([
      'Notion property "hubspotTaskId" is not one Lance may write (ADR 0009).',
    ]);
  });

  it('adds the model review notes after the deterministic checks', async () => {
    const verdict = await critique(draftEmail(), {
      ...options,
      reviewDraft: () => Promise.resolve(['Promises a date the source does not mention.']),
    });
    expect(verdict.notes).toEqual(['Review: Promises a date the source does not mention.']);
  });
});
