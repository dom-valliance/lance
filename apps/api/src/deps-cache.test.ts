import { describe, expect, it } from 'vitest';
import type { ApiDeps, PrincipalKey } from './deps.js';
import { createDepsCache } from './main.js';
import { fakeDeps } from './test-fakes.js';

const DOM: PrincipalKey = { id: '01K5S9V6QW3SWCCPVB0N0E300H', upn: 'dom@valliance.ai' };
const ANN: PrincipalKey = { id: '01K5S9V6QW3SWCCPVB0N0E3A01', upn: 'ann@valliance.ai' };

describe('createDepsCache', () => {
  it("builds each principal's dependencies once and reuses them", () => {
    const built: string[] = [];
    const depsFor = createDepsCache((principal): ApiDeps => {
      built.push(principal.id);
      return { ...fakeDeps().deps, principalId: principal.id };
    });

    const first = depsFor(DOM);
    const again = depsFor(DOM);
    const other = depsFor(ANN);

    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(other.principalId).toBe(ANN.id);
    expect(built).toEqual([DOM.id, ANN.id]);
  });
});
