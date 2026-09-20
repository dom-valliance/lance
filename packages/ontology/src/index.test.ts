import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('PACKAGE_NAME', () => {
  it('equals the package name', () => {
    expect(PACKAGE_NAME).toBe('@lance/ontology');
  });
});
