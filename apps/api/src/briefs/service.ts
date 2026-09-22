import {
  AfternoonBoardContentSchema,
  MorningBriefContentSchema,
  type BriefKind,
} from '@lance/shared';
import { TRPCError } from '@trpc/server';
import type { z } from 'zod';
import type { ApiDeps } from '../deps.js';
import type { BriefRecord } from './store.js';

/**
 * The Today page's one read (spec 10.1 and 10.2). The stored content is
 * `jsonb`, so it is parsed against its kind's schema before it leaves the
 * api: a brief the planner wrote in an older shape fails here with a message
 * naming it, rather than rendering as a page full of holes.
 */

export type BriefDeps = Pick<ApiDeps, 'briefs'>;

/** Kinds whose content the Today page renders and this api therefore parses. */
const CONTENT_SCHEMAS: Partial<Record<BriefKind, z.ZodType>> = {
  morning_brief: MorningBriefContentSchema,
  afternoon_board: AfternoonBoardContentSchema,
};

export async function latestBrief(deps: BriefDeps, kind: BriefKind): Promise<BriefRecord | null> {
  const record = await deps.briefs.latest(kind);
  if (record === null) return null;

  const schema = CONTENT_SCHEMAS[kind];
  if (schema === undefined) return record;

  const parsed = schema.safeParse(record.content);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue === undefined || issue.path.length === 0 ? 'content' : issue.path.join('.');
    const reason = issue === undefined ? 'it did not match the schema' : issue.message;
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Brief ${record.id} (${kind}) cannot be rendered: "${path}" ${reason}. Regenerate the brief and reload the page.`,
    });
  }

  return { ...record, content: parsed.data };
}
