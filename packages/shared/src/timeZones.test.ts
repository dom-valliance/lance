import { describe, expect, it } from 'vitest';
import { ianaTimeZone, isKnownTimeZone } from './timeZones.js';

describe('ianaTimeZone', () => {
  it('maps the Windows name Graph reports for the UK to Europe/London', () => {
    expect(ianaTimeZone('GMT Standard Time')).toBe('Europe/London');
  });

  it('passes an IANA name through', () => {
    expect(ianaTimeZone('America/New_York')).toBe('America/New_York');
  });

  it('returns null for a name it cannot place, rather than guessing', () => {
    expect(ianaTimeZone('Mars Standard Time')).toBeNull();
    expect(ianaTimeZone('')).toBeNull();
    expect(ianaTimeZone(null)).toBeNull();
  });
});

describe('isKnownTimeZone', () => {
  it('knows an IANA zone and refuses nonsense', () => {
    expect(isKnownTimeZone('Europe/Paris')).toBe(true);
    expect(isKnownTimeZone('Europe/Atlantis')).toBe(false);
    expect(isKnownTimeZone('')).toBe(false);
  });
});
