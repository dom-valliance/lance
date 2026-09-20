import { describe, expect, it } from 'vitest';
import { EXECUTOR } from './index.js';

describe('EXECUTOR', () => {
  it('equals the executor entry point name', () => {
    expect(EXECUTOR).toBe('executor');
  });
});
