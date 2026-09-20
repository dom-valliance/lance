import { describe, expect, it } from 'vitest';
import { HARD_FLOORS, hardFloorDecision, isHardFloorActionClass } from './hardFloors.js';

describe('hard floors', () => {
  it('treats delete, send_email and rule_change as hard floor action classes', () => {
    expect(isHardFloorActionClass('delete')).toBe(true);
    expect(isHardFloorActionClass('send_email')).toBe(true);
    expect(isHardFloorActionClass('rule_change')).toBe(true);
  });

  it('does not treat ordinary action classes as hard floors', () => {
    expect(isHardFloorActionClass('draft_email')).toBe(false);
    expect(isHardFloorActionClass('read')).toBe(false);
  });

  it('forbids delete and send_email and caps rule_change at propose', () => {
    expect(hardFloorDecision('delete')).toBe('forbid');
    expect(hardFloorDecision('send_email')).toBe('forbid');
    expect(hardFloorDecision('rule_change')).toBe('propose');
    expect(Object.keys(HARD_FLOORS)).toHaveLength(3);
  });
});
