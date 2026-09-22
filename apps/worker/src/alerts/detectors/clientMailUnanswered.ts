import { organisationDomain } from '@lance/ontology';
import { toLondon } from '@lance/shared';
import { workingDaysBetween } from '../../triage/run.js';
import type { DetectedAlert, Detector, DetectorContext } from './types.js';
import {
  latestObservations,
  payloadRecord,
  payloadString,
  provenanceOf,
  type ObservationRow,
} from './support.js';

/**
 * `client_mail_unanswered` (spec 11): a client wrote to the inbox, nothing
 * has gone back in that conversation, and three working days have passed.
 * Weekends do not count, so a Friday message is not late on Monday.
 *
 * "Client" means an Organisation node of type `client`. When the ontology
 * holds no organisation for the domain at all, the message still counts:
 * an unknown external correspondent left waiting is the case the alert
 * exists for. A domain the ontology knows as something else, a vendor or a
 * partner, is not a client and is left alone.
 */

export const CLIENT_MAIL_SCHEDULE = '0 * * * *';

/** Spec 11: "no reply in 3 working days". */
export const WORKING_DAYS_BEFORE_ALERT = 3;

export const GRAPH_MAIL_WATCHER = 'graph-mail';

interface MailRow {
  observation: ObservationRow;
  conversationId: string;
  at: number;
  subject: string;
  fromAddress: string | null;
  fromName: string | null;
}

function mailRowOf(row: ObservationRow, folder: 'inbox' | 'sentitems'): MailRow | null {
  if (payloadString(row.payload, 'folder') !== folder) return null;
  const conversationId = payloadString(row.payload, 'conversationId');
  if (conversationId === null) return null;
  const stamp =
    payloadString(row.payload, folder === 'inbox' ? 'receivedDateTime' : 'sentDateTime') ??
    row.ts.toISOString();
  const at = Date.parse(stamp);
  if (Number.isNaN(at)) return null;
  const from = payloadRecord(row.payload, 'from');
  const address = from === null ? null : from['address'];
  const name = from === null ? null : from['name'];
  return {
    observation: row,
    conversationId,
    at,
    subject: payloadString(row.payload, 'subject') ?? '(no subject)',
    fromAddress: typeof address === 'string' && address !== '' ? address.toLowerCase() : null,
    fromName: typeof name === 'string' && name !== '' ? name : null,
  };
}

export const clientMailUnansweredDetector: Detector = {
  name: 'client_mail_unanswered',
  schedule: CLIENT_MAIL_SCHEDULE,

  async run(context: DetectorContext): Promise<DetectedAlert[]> {
    const now = context.now();
    const rows = await latestObservations(context.db, {
      sourceSystem: 'graph',
      watcher: GRAPH_MAIL_WATCHER,
    });

    // The newest inbound message per conversation, and when the last thing
    // left the mailbox on it.
    const newestInbound = new Map<string, MailRow>();
    const lastSentAt = new Map<string, number>();
    for (const row of rows) {
      const inbound = mailRowOf(row, 'inbox');
      if (inbound !== null) {
        const held = newestInbound.get(inbound.conversationId);
        if (held === undefined || inbound.at > held.at) {
          newestInbound.set(inbound.conversationId, inbound);
        }
        continue;
      }
      const sent = mailRowOf(row, 'sentitems');
      if (sent === null) continue;
      lastSentAt.set(
        sent.conversationId,
        Math.max(lastSentAt.get(sent.conversationId) ?? 0, sent.at),
      );
    }

    const domDomain = organisationDomain(context.config.dom.email);
    const isClient = new Map<string, boolean>();

    const found: DetectedAlert[] = [];
    for (const [conversationId, message] of newestInbound) {
      if ((lastSentAt.get(conversationId) ?? 0) > message.at) continue;
      if (message.fromAddress === null) continue;
      const domain = organisationDomain(message.fromAddress);
      if (domain === null || domain === domDomain) continue;

      let client = isClient.get(domain);
      if (client === undefined) {
        const organisation = await context.ontology.findOrganisationByDomain(domain);
        client = organisation === null || organisation.properties['type'] === 'client';
        isClient.set(domain, client);
      }
      if (!client) continue;

      const days = workingDaysBetween(new Date(message.at), new Date(now));
      if (days < WORKING_DAYS_BEFORE_ALERT) continue;

      const sender = message.fromName === null ? message.fromAddress : message.fromName;
      found.push({
        kind: 'client_mail_unanswered',
        severity: 'P1',
        dedupeKey: `thread:${conversationId}`,
        title: `No reply to ${sender} after ${String(days)} working days`,
        body: [
          `"${message.subject}" arrived from ${sender} (${domain}) on ${toLondon(new Date(message.at).toISOString())} and nothing has been sent back on that thread since.`,
          'Suggested action: ask Lance to draft a reply, or close the thread if it was answered elsewhere.',
        ].join(' '),
        provenance: [provenanceOf(message.observation)],
      });
    }
    return found;
  },
};
