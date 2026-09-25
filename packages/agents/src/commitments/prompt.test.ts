import { describe, expect, it } from 'vitest';
import { commitmentSystemPrompt, commitmentUserPrompt } from './prompt.js';

describe('commitment prompts', () => {
  it("name the principal whose transcript it is and never Dom for anyone else's", () => {
    const system = commitmentSystemPrompt('Lance');
    const user = commitmentUserPrompt({
      id: 'jamie-1',
      kind: 'transcript',
      principal: { name: 'Bea Hale', email: 'bea.hale@valliance.ai' },
      participants: [{ name: 'Ann Example', email: 'ann@client.test' }],
      occurredAt: null,
      text: 'Bea: I will send the plan by Friday.',
    });
    expect(user).toContain('Principal: Bea Hale <bea.hale@valliance.ai>');
    expect(`${system}\n${user}`).not.toMatch(/\bDom\b/);
  });
});
