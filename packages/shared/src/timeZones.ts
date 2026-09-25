/**
 * Time zone names. Lance stores IANA names (`Europe/London`), which is what
 * `Intl` and Postgres read. Microsoft Graph's mailbox settings usually carry
 * a Windows name (`GMT Standard Time`) unless the mailbox was set up with an
 * IANA one, so a name read from Graph goes through `ianaTimeZone` first.
 */

/**
 * The Windows zones the Valliance tenant is likely to meet, mapped to the
 * IANA zone CLDR names as their primary. A name not listed here is left
 * for the principal to choose; nothing is guessed.
 */
const WINDOWS_TO_IANA: Readonly<Record<string, string>> = {
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  UTC: 'UTC',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Israel Standard Time': 'Asia/Jerusalem',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Calcutta',
  'Singapore Standard Time': 'Asia/Singapore',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'E. South America Standard Time': 'America/Sao_Paulo',
};

/** True when `Intl` knows `name` as a time zone. */
export function isKnownTimeZone(name: string): boolean {
  if (name.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * The IANA name for a zone as Graph reports it: an IANA name passes
 * through, a Windows name listed above is mapped, and anything else is
 * null so the caller can fall back and say so.
 */
export function ianaTimeZone(name: string | null | undefined): string | null {
  if (name === null || name === undefined) return null;
  const trimmed = name.trim();
  const mapped = WINDOWS_TO_IANA[trimmed];
  if (mapped !== undefined) return mapped;
  return trimmed.includes('/') && isKnownTimeZone(trimmed) ? trimmed : null;
}
