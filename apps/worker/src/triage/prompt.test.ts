import { describe, expect, it } from 'vitest';
import type { LedgerEventRow } from '@lance/ledger';
import { chaseSystemPrompt } from '../chase/prompt.js';
import { followUpSystemPrompt, followUpUserPrompt } from '../debrief/prompt.js';
import { triageSystemPrompt, triageUserPrompt } from './prompt.js';

function event(overrides: Partial<LedgerEventRow>): LedgerEventRow {
  return {
    principalId: '01K5S9V6QW3SWCCPVB0N0E300H',
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    ts: new Date('2026-09-21T08:00:00.000Z'),
    actor: 'agent:watcher-graph-calendar@0.1.0',
    kind: 'observed',
    sourceSystem: 'graph',
    sourceRecordId: 'evt-1',
    sourceRecordHash: 'h1',
    idempotencyKey: 'graph:evt-1:h1',
    correlationId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
    parentEventId: null,
    policyDecisionId: null,
    payload: {},
    payloadHash: 'ph1',
    createdAt: new Date('2026-09-21T08:00:00.000Z'),
    ...overrides,
  };
}

describe('triageSystemPrompt', () => {
  it('tells the model an evidence quote must be human-readable, not a JSON fragment', () => {
    const prompt = triageSystemPrompt('Lance', 'Dom Selvon');
    expect(prompt).toContain('evidenceQuote is human-readable text from the record');
    expect(prompt).toContain('never a field name, JSON or a key-value fragment');
  });
});

describe('agent system prompts for a second principal', () => {
  it('name the principal they act for and never Dom', () => {
    for (const prompt of [
      triageSystemPrompt('Lance', 'Bea Hale'),
      followUpSystemPrompt('Lance', 'Bea Hale'),
      chaseSystemPrompt('Lance', 'Bea Hale'),
      followUpUserPrompt({
        title: 'Plan',
        date: '2026-09-25',
        externalNames: [],
        summary: null,
        decisions: [],
        domOwes: [],
        theyOwe: [],
        openQuestions: [],
      }),
    ]) {
      expect(prompt).not.toMatch(/\bDom\b/);
    }
    expect(triageSystemPrompt('Lance', 'Bea Hale')).toContain('Bea Hale');
  });
});

describe('triageUserPrompt', () => {
  it('renders a calendar record as labelled lines rather than a JSON dump', () => {
    const prompt = triageUserPrompt([
      event({
        sourceSystem: 'graph',
        sourceRecordId: 'evt-1',
        payload: {
          watcher: 'graph-calendar',
          subject: 'Board meeting',
          organizer: { name: 'Alice Smith', address: 'alice@valliance.ai' },
          start: { dateTime: '2026-09-22T09:00:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-09-22T09:30:00.0000000', timeZone: 'UTC' },
          isAllDay: false,
          isCancelled: false,
          attendees: [
            {
              name: 'Bob Jones',
              address: 'bob@example.com',
              type: 'required',
              responseStatus: 'notResponded',
            },
          ],
        },
      }),
    ]);

    expect(prompt).toContain('subject: Board meeting');
    expect(prompt).toContain('organiser: Alice Smith alice@valliance.ai');
    expect(prompt).toContain('start: 2026-09-22T09:00:00.0000000 UTC');
    expect(prompt).toContain('attendees: Bob Jones bob@example.com');
    expect(prompt).toContain('response status: Bob Jones bob@example.com (notResponded)');
    expect(prompt).not.toContain('"responseStatus":"notResponded"');
    expect(prompt).not.toContain('"responseStatus": "notResponded"');
  });

  it('still renders a non-calendar record as JSON', () => {
    const prompt = triageUserPrompt([
      event({
        sourceSystem: 'graph',
        sourceRecordId: 'm1',
        payload: {
          watcher: 'graph-mail',
          subject: 'Revised SOW',
          bodyText: 'Please send the revised SOW by Friday.',
        },
      }),
    ]);

    expect(prompt).toContain('"subject":"Revised SOW"');
  });
});
