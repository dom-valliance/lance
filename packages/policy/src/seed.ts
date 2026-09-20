import type { PolicyRule } from '@lance/shared';
import { validateRules } from './validateRule.js';

export interface SeedOptions {
  /** The only channel post_slack may target automatically. */
  slackChannelId: string;
  /** ISO timestamp recorded as createdAt on every seed rule. */
  createdAt: string;
}

/** Fixed, valid ULID-shaped ids so seed rules are stable across environments. */
export function seedRuleId(n: number): string {
  return `0SEED${String(n).padStart(21, '0')}`;
}

/**
 * Seed rules for v1 from spec 6.2, minus the Jamie rows (ADR 0005) and with
 * create_task pointed at Notion only (ADR 0009). Label and folder gating on
 * apply_category and move_mail is expressed as conditions so that an unmet
 * condition downgrades to propose, which is the "propose otherwise" the spec
 * asks for.
 */
export function seedRules(options: SeedOptions): PolicyRule[] {
  const base = {
    version: 1,
    active: true,
    createdBy: 'user:dom',
    createdAt: options.createdAt,
  } as const;

  const candidates = [
    {
      ...base,
      id: seedRuleId(1),
      actionClass: 'read',
      counterpartyClass: '*',
      system: '*',
      decision: 'auto',
      conditions: { requireCriticPass: false },
      rationale: 'Reads never change an external system.',
    },
    {
      ...base,
      id: seedRuleId(2),
      actionClass: 'classify',
      counterpartyClass: '*',
      system: '*',
      decision: 'auto',
      conditions: { requireCriticPass: false },
      rationale: 'Classification is internal to Lance.',
    },
    {
      ...base,
      id: seedRuleId(3),
      actionClass: 'apply_category',
      counterpartyClass: '*',
      system: 'graph',
      decision: 'auto',
      conditions: { labelsAnyOf: ['Newsletters', 'Notifications'] },
      rationale:
        'Categorising newsletters and notifications is reversible and low value to review.',
    },
    {
      ...base,
      id: seedRuleId(4),
      actionClass: 'move_mail',
      counterpartyClass: '*',
      system: 'graph',
      decision: 'auto',
      conditions: { labelsAnyOf: ['Newsletters', 'Notifications'], targetAnyOf: ['AI-Filed'] },
      rationale: 'Filing newsletters and notifications into AI-Filed; anything else is proposed.',
    },
    {
      ...base,
      id: seedRuleId(5),
      actionClass: 'create_task',
      counterpartyClass: '*',
      system: 'notion',
      decision: 'propose',
      rationale: 'Every task goes to the Notion All Tasks DB after Dom approves it (ADR 0009).',
    },
    {
      ...base,
      id: seedRuleId(6),
      actionClass: 'update_task',
      counterpartyClass: '*',
      system: 'notion',
      decision: 'propose',
      rationale: 'Task updates touch content Dom may have edited.',
    },
    {
      ...base,
      id: seedRuleId(7),
      actionClass: 'complete_task',
      counterpartyClass: '*',
      system: 'notion',
      decision: 'propose',
      rationale: 'Completion is a judgement Dom makes.',
    },
    {
      ...base,
      id: seedRuleId(8),
      actionClass: 'draft_email',
      counterpartyClass: '*',
      system: 'graph',
      decision: 'propose',
      rationale: 'Lance drafts; Dom sends.',
    },
    {
      ...base,
      id: seedRuleId(9),
      actionClass: 'create_calendar_hold',
      counterpartyClass: '*',
      system: 'graph',
      decision: 'propose',
      rationale: 'Holds change the shape of the day.',
    },
    {
      ...base,
      id: seedRuleId(10),
      actionClass: 'post_slack',
      counterpartyClass: 'self',
      system: 'slack',
      decision: 'auto',
      conditions: { requireCriticPass: false, targetAnyOf: [options.slackChannelId] },
      rationale: "Lance's own channel only.",
    },
  ];

  return validateRules(candidates);
}
