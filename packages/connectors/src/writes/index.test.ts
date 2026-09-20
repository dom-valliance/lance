import { describe, expect, it } from 'vitest';
import { WRITES_ENTRY } from './index.js';

describe('WRITES_ENTRY', () => {
  it('equals the writes entry point name', () => {
    expect(WRITES_ENTRY).toBe('writes');
  });
});
