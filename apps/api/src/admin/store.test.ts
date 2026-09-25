import { describe, expect, it } from 'vitest';
import { fakePrincipal } from '../test-fakes.js';
import { offboardingNeedsConfirmation } from './store.js';

const OWNER = 'dom@valliance.ai';
const dom = fakePrincipal({
  id: '01K5S9V6QW3SWCCPVB0N0E300H',
  upn: OWNER,
  lanceRoles: ['Lance.Admin'],
});
const tarek = fakePrincipal({
  id: '01K5S9V6QW3SWCCPVB0N0E3T01',
  upn: 'tarek@valliance.ai',
  lanceRoles: ['Lance.User', 'Lance.Admin'],
});
const priya = fakePrincipal({
  id: '01K5S9V6QW3SWCCPVB0N0E3T02',
  upn: 'priya@valliance.ai',
  lanceRoles: ['Lance.User'],
});

describe('offboardingNeedsConfirmation', () => {
  it('asks again before offboarding the organisation owner, whatever their roles', () => {
    expect(offboardingNeedsConfirmation(dom, [dom, tarek, priya], OWNER)).toContain(
      "organisation's owner",
    );
    expect(offboardingNeedsConfirmation(dom, [dom], 'DOM@valliance.ai')).not.toBeNull();
  });

  it('asks again before offboarding the last active Lance.Admin', () => {
    const pausedDom = { ...dom, status: 'paused' as const };

    expect(offboardingNeedsConfirmation(tarek, [pausedDom, tarek, priya], OWNER)).toContain(
      'last active Lance.Admin',
    );
  });

  it('lets an admin go without a second confirmation while another active admin remains', () => {
    expect(offboardingNeedsConfirmation(tarek, [dom, tarek, priya], OWNER)).toBeNull();
  });

  it('needs nothing more for a principal who is not an admin', () => {
    expect(offboardingNeedsConfirmation(priya, [dom, tarek, priya], OWNER)).toBeNull();
  });
});
