import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME, defineConnector } from './index.js';

describe('@lance/connectors', () => {
  it('exports its package name and the connector factory', () => {
    expect(PACKAGE_NAME).toBe('@lance/connectors');
    expect(typeof defineConnector).toBe('function');
  });
});
