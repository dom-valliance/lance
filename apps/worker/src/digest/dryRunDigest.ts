import type { SlackSurface } from '@lance/connectors';
import { proposals, type Db } from '@lance/db';
import { and, eq, gte } from 'drizzle-orm';

export interface DigestLine {
  id: string;
  actionClass: string;
  counterpartyClass: string;
  targetSystem: string;
  preview: string;
  wouldHaveBeen: 'auto' | 'propose' | 'forbid';
}

export interface DryRunDigest {
  since: Date;
  lines: DigestLine[];
  text: string;
}

/**
 * What dry run held today (spec 6.3): one message a day instead of a card
 * per proposal, so Dom can see what live mode would have done.
 */
export async function buildDryRunDigest(
  db: Db,
  since: Date,
  displayName: string,
): Promise<DryRunDigest> {
  const rows = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.status, 'held'), gte(proposals.createdAt, since)));
  const lines: DigestLine[] = rows.map((row) => ({
    id: row.id,
    actionClass: row.actionClass,
    counterpartyClass: row.counterpartyClass,
    targetSystem: row.targetSystem,
    preview: row.preview.length > 120 ? `${row.preview.slice(0, 117)}...` : row.preview,
    wouldHaveBeen: row.policyDecision,
  }));
  const counts = { auto: 0, propose: 0, forbid: 0 };
  for (const line of lines) counts[line.wouldHaveBeen] += 1;
  const header =
    lines.length === 0
      ? `${displayName} dry run: nothing was held since ${since.toISOString().slice(0, 16).replace('T', ' ')}.`
      : `${displayName} dry run: ${lines.length} held since ${since.toISOString().slice(0, 16).replace('T', ' ')} (${counts.auto} would have run automatically, ${counts.propose} would have asked you, ${counts.forbid} forbidden).`;
  const body = lines
    .slice(0, 40)
    .map(
      (line) =>
        `${line.wouldHaveBeen.padEnd(7)} ${line.actionClass} / ${line.counterpartyClass} / ${line.targetSystem}: ${line.preview} [${line.id}]`,
    )
    .join('\n');
  const more = lines.length > 40 ? `\nand ${lines.length - 40} more in the Proposals page.` : '';
  return { since, lines, text: body.length === 0 ? header : `${header}\n${body}${more}` };
}

export async function postDryRunDigest(
  db: Db,
  surface: Pick<SlackSurface, 'post'> | null,
  options: { since: Date; displayName: string },
): Promise<DryRunDigest> {
  const digest = await buildDryRunDigest(db, options.since, options.displayName);
  if (surface !== null) await surface.post({ text: digest.text });
  return digest;
}
