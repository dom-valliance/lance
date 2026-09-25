import type { Config } from './config.js';

/**
 * The person Lance acts for in one principal's context: who the prompts
 * name, whose Person node the ontology keeps, whose declined meetings do
 * not clash, whose Notion rows are theirs. Built once per principal
 * context from the `principals` row, never from `config.dom`, so one
 * principal's triage never speaks for, or writes over, another's.
 */
export interface PrincipalIdentity {
  /** How prompts and the principal's own Person node name them. */
  name: string;
  /** The principal's UPN, lower-cased: their mailbox and their Person key. */
  email: string;
  /** `principals.notion_user_id` or the principal's own Notion credential; null while unresolved (ADR 0022). */
  notionUserId: string | null;
}

/**
 * True for the principal whose data the pre-Phase-4 graph and the legacy
 * credentials are: the one whose UPN is `config.dom.email`.
 */
export const isLegacyOwner = (upn: string, config: Pick<Config, 'dom'>): boolean =>
  upn.toLowerCase() === config.dom.email.toLowerCase();

const capitalise = (part: string): string =>
  part === '' ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`;

/**
 * A principal's display name. `principals` carries no name yet (M6), so
 * the legacy owner keeps `config.dom.name` and anyone else is named from
 * the local part of their UPN (`bea.hale@valliance.ai` is "Bea Hale"),
 * which is how colleagues address them in a transcript. Never Dom's name
 * for anyone else.
 */
export function principalDisplayName(upn: string, config: Pick<Config, 'dom'>): string {
  if (isLegacyOwner(upn, config)) return config.dom.name;
  const local = upn.split('@')[0] ?? upn;
  const name = local
    .split(/[._-]+/)
    .filter((part) => part !== '')
    .map(capitalise)
    .join(' ');
  return name === '' ? upn : name;
}

/** Builds one principal's identity from their row; see `PrincipalIdentity`. */
export function principalIdentity(
  principal: { readonly upn: string; readonly notionUserId?: string | null },
  config: Pick<Config, 'dom'>,
  notionUserId: string | null = principal.notionUserId ?? null,
): PrincipalIdentity {
  return {
    name: principalDisplayName(principal.upn, config),
    email: principal.upn.toLowerCase(),
    notionUserId,
  };
}
