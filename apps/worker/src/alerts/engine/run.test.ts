import { ActorSchema } from '@lance/shared';
import { describe, expect, it } from 'vitest';
import { allDetectors } from '../detectors/index.js';
import { detectorActor, detectorQueue } from './run.js';

describe('detectorActor', () => {
  it('names a valid ledger actor for every detector, including snake_case names', () => {
    for (const detector of allDetectors()) {
      expect(ActorSchema.safeParse(detectorActor(detector)).success).toBe(true);
    }
    expect(detectorActor({ name: 'budget_guard' })).toBe('system:detector-budget-guard');
  });

  it('gives each detector its own queue', () => {
    const queues = allDetectors().map(detectorQueue);
    expect(new Set(queues).size).toBe(queues.length);
  });
});
