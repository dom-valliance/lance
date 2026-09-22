import { describe, expect, it } from 'vitest';
import { AlertCandidateSchema, CommitmentCandidateSchema, humanReadableQuote } from './schema.js';

describe('humanReadableQuote', () => {
  it.each([
    'Please send the revised SOW by Friday',
    'Our legal team is reviewing the contract',
    'Revised SOW',
    'Board meeting with Alice Smith at 14:00',
    'Note: call moved to Friday',
  ])('accepts a sentence or subject line: %s', (quote) => {
    expect(humanReadableQuote(quote)).toBe(true);
  });

  it.each([
    '"responseStatus":"notResponded"',
    '{"subject":"Board meeting"}',
    '["a","b"]',
    'responseStatus: notResponded',
    'responseStatus:notResponded',
    'isCancelled: false',
  ])('rejects JSON or a key-value fragment: %s', (quote) => {
    expect(humanReadableQuote(quote)).toBe(false);
  });
});

describe('evidenceQuote on the candidate schemas', () => {
  const commitment = {
    direction: 'outbound',
    description: 'Send revised SOW',
    counterpartyName: null,
    counterpartyEmail: null,
    dueAt: null,
    dueConfidence: 0.5,
    recordId: 'm1',
  };

  it('accepts a human-readable quote', () => {
    const result = CommitmentCandidateSchema.safeParse({
      ...commitment,
      evidenceQuote: 'Please send the revised SOW by Friday',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a raw JSON key-value fragment and explains what to quote instead', () => {
    const result = CommitmentCandidateSchema.safeParse({
      ...commitment,
      evidenceQuote: '"responseStatus":"notResponded"',
    });
    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error.issues[0]?.message).toContain('human-readable text');
  });

  it('rejects the same fragment on an alert candidate', () => {
    const result = AlertCandidateSchema.safeParse({
      kind: 'other',
      severity: 'P2',
      title: 'Meeting response',
      evidenceQuote: 'responseStatus: notResponded',
      recordId: 'e1',
    });
    expect(result.success).toBe(false);
  });
});
