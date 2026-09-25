import { describe, expect, it } from 'vitest';
import { ONBOARDING_FACTS, onboardingProgress } from './onboarding.js';

describe('onboardingProgress', () => {
  it('marks a step done when any of its facts is recorded, and nothing else', () => {
    const progress = onboardingProgress(new Set(['credential_migrated:graph', 'slack_linked']));
    expect(progress).toEqual({
      steps: [
        { step: 'notice', done: false },
        { step: 'microsoft365', done: true },
        { step: 'jamie', done: false },
        { step: 'slack', done: true },
        { step: 'hours', done: false },
      ],
      complete: false,
    });
  });

  it('is complete when every step is done', () => {
    expect(onboardingProgress(new Set(ONBOARDING_FACTS)).complete).toBe(true);
  });
});
