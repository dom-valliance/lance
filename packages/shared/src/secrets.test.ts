import { describe, expect, it } from 'vitest';
import { readSecret } from './secrets.js';

describe('readSecret', () => {
  it('returns the value when the variable is set', () => {
    expect(readSecret('ANTHROPIC_API_KEY', { ANTHROPIC_API_KEY: 'sk-super-secret' })).toBe(
      'sk-super-secret',
    );
  });

  it('throws naming the variable and the runbook when missing', () => {
    expect(() => readSecret('SLACK_BOT_TOKEN', {})).toThrowError(
      /SLACK_BOT_TOKEN.*docs\/runbooks\/rotate-secrets\.md/s,
    );
  });

  it('throws when the variable is set to an empty string', () => {
    expect(() => readSecret('NOTION_TOKEN', { NOTION_TOKEN: '' })).toThrow(/NOTION_TOKEN/);
  });

  it('names each secret variable distinctly in its own error', () => {
    expect(() => readSecret('JAMIE_API_KEY', {})).toThrow(/JAMIE_API_KEY/);
    expect(() => readSecret('AGENT_LOG_INGEST_SECRET', {})).toThrow(/AGENT_LOG_INGEST_SECRET/);
    expect(() => readSecret('ENTRA_CLIENT_SECRET', {})).toThrow(/ENTRA_CLIENT_SECRET/);
  });
});
