import { organisationDomain } from '@lance/ontology';
import type { DetectedAlert, Detector, DetectorContext } from './types.js';
import { calendarWindow } from './calendarWindow.js';
import { localDateTime, provenanceOf } from './support.js';

/**
 * `external_meeting_unknown_attendee` (spec 11): a meeting today or
 * tomorrow with somebody the ontology has never heard of, at an
 * organisation it has never heard of either. Either half being known is
 * enough to stay quiet: a new face at a client is prep, not a surprise.
 *
 * A public provider address (gmail and its kind, per `organisationDomain`)
 * names no organisation, so it is not treated as an external party here.
 */

export const UNKNOWN_ATTENDEE_SCHEDULE = '*/15 * * * *';

export const unknownAttendeeDetector: Detector = {
  name: 'external_meeting_unknown_attendee',
  schedule: UNKNOWN_ATTENDEE_SCHEDULE,

  async run(context: DetectorContext): Promise<DetectedAlert[]> {
    const zone = context.config.timeZone;
    const events = await calendarWindow(context);
    if (events.length === 0) return [];

    const domDomain = organisationDomain(context.config.dom.email);
    // One lookup per address and per domain, however many meetings they appear in.
    const knownPerson = new Map<string, boolean>();
    const knownOrganisation = new Map<string, boolean>();

    const found: DetectedAlert[] = [];
    for (const event of events) {
      const unknown: string[] = [];
      for (const attendee of event.attendees) {
        const address = attendee.address?.trim().toLowerCase();
        if (address === undefined || address === '') continue;
        const domain = organisationDomain(address);
        if (domain === null || domain === domDomain) continue;

        let person = knownPerson.get(address);
        if (person === undefined) {
          person = (await context.ontology.findPersonByEmail(address)) !== null;
          knownPerson.set(address, person);
        }
        if (person) continue;

        let organisation = knownOrganisation.get(domain);
        if (organisation === undefined) {
          organisation = (await context.ontology.findOrganisationByDomain(domain)) !== null;
          knownOrganisation.set(domain, organisation);
        }
        if (organisation) continue;

        unknown.push(attendee.name === null ? address : `${attendee.name} <${address}>`);
      }
      if (unknown.length === 0) continue;

      const who = unknown.join(', ');
      found.push({
        kind: 'external_meeting_unknown_attendee',
        severity: 'P2',
        dedupeKey: `event:${event.id}`,
        title: `Unknown attendee at "${event.subject}"`,
        body: [
          `${event.subject} at ${localDateTime(event.start, zone)} has ${unknown.length === 1 ? 'an attendee' : 'attendees'} Lance does not know: ${who}.`,
          'Neither the person nor their organisation is in the ontology.',
          'Suggested action: ask Lance for what it does hold on that domain before the meeting, and confirm who they are.',
        ].join(' '),
        provenance: [provenanceOf(event.observation)],
      });
    }
    return found;
  },
};
