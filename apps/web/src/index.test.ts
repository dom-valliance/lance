import { describe, expect, it } from 'vitest';
import { APP_NAME } from './index.js';

describe('APP_NAME', () => {
  it('equals the app name', () => {
    expect(APP_NAME).toBe('@lance/web');
  });
});
