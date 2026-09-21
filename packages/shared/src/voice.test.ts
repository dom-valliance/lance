import { describe, expect, it } from 'vitest';
import { checkVoice } from './voice.js';

describe('checkVoice', () => {
  it('passes a plain British draft', () => {
    expect(
      checkVoice('Thanks for the update. I have moved the meeting to Thursday at 10. Dom'),
    ).toEqual([]);
  });

  it('flags em and en dashes', () => {
    expect(checkVoice('One thing — two things').map((f) => f.rule)).toEqual(['em_dash']);
    expect(checkVoice('2019–2020').map((f) => f.rule)).toEqual(['em_dash']);
  });

  it('flags emojis', () => {
    expect(checkVoice('Great news \u{1F389}').map((f) => f.rule)).toContain('emoji');
  });

  it('flags correlative conjunctions only when both halves appear', () => {
    expect(checkVoice('Not only fast but also cheap.').map((f) => f.rule)).toContain('correlative');
    expect(checkVoice('It is fast, but also cheap.').map((f) => f.rule)).not.toContain(
      'correlative',
    );
    expect(checkVoice('Either works for me.').map((f) => f.rule)).not.toContain('correlative');
  });

  it('flags banned phrases and soft closes on word boundaries', () => {
    const findings = checkVoice('We should leverage this. Let me know if that works.');
    expect(findings.map((f) => f.detail)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('leverage'),
        expect.stringContaining('let me know if'),
      ]),
    );
    expect(checkVoice('The quietest room.')).toEqual([]);
    expect(checkVoice('A quiet room.').map((f) => f.rule)).toEqual(['banned_phrase']);
  });

  it('flags American spellings and names the British form', () => {
    const findings = checkVoice('We will organize the program.');
    expect(findings.map((f) => f.detail)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('organise'),
        expect.stringContaining('programme'),
      ]),
    );
  });
});
