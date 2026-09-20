import { UlidSchema } from '@lance/shared';
import { describe, expect, it } from 'vitest';
import { evaluate } from './evaluate.js';
import { seedRuleId, seedRules } from './seed.js';
import { input, T0 } from './testing.js';

const CHANNEL = 'C0BU7P278N5';
const rules = seedRules({ slackChannelId: CHANNEL, createdAt: T0 });

describe('seed rules', () => {
  it('produces ten valid rules with unique ULID-shaped ids', () => {
    expect(rules).toHaveLength(10);
    const ids = new Set(rules.map((r) => r.id));
    expect(ids.size).toBe(10);
    for (const id of ids) expect(UlidSchema.safeParse(id).success).toBe(true);
    expect(seedRuleId(1)).toHaveLength(26);
  });

  it('never grants auto to a hard floor action class', () => {
    for (const actionClass of ['delete', 'send_email', 'rule_change'] as const) {
      expect(evaluate(input({ actionClass, system: 'lance' }), rules).decision).not.toBe('auto');
    }
  });

  it('categorises newsletters automatically and proposes everything else', () => {
    expect(
      evaluate(input({ actionClass: 'apply_category', labels: ['Newsletters'] }), rules).decision,
    ).toBe('auto');
    expect(
      evaluate(input({ actionClass: 'apply_category', labels: ['Notifications'] }), rules).decision,
    ).toBe('auto');
    expect(
      evaluate(input({ actionClass: 'apply_category', labels: ['Deals'] }), rules),
    ).toMatchObject({
      decision: 'propose',
      reason: 'conditions_unmet',
    });
  });

  it('files newsletters into AI-Filed automatically and proposes any other move', () => {
    expect(
      evaluate(
        input({ actionClass: 'move_mail', labels: ['Newsletters'], target: 'AI-Filed' }),
        rules,
      ).decision,
    ).toBe('auto');
    expect(
      evaluate(
        input({ actionClass: 'move_mail', labels: ['Newsletters'], target: 'Archive' }),
        rules,
      ).decision,
    ).toBe('propose');
    expect(
      evaluate(input({ actionClass: 'move_mail', labels: ['Action'], target: 'AI-Filed' }), rules)
        .decision,
    ).toBe('propose');
  });

  it('lets Lance post to its own channel only', () => {
    const self = { actionClass: 'post_slack', counterpartyClass: 'self', system: 'slack' } as const;
    expect(evaluate(input({ ...self, target: CHANNEL }), rules)).toMatchObject({
      decision: 'auto',
      requiresCriticPass: false,
    });
    expect(evaluate(input({ ...self, target: 'C0OTHER' }), rules).decision).toBe('propose');
    expect(
      evaluate(input({ ...self, counterpartyClass: 'internal', target: CHANNEL }), rules).decision,
    ).toBe('propose');
  });

  it('proposes every task and draft action', () => {
    for (const actionClass of ['create_task', 'update_task', 'complete_task'] as const) {
      expect(evaluate(input({ actionClass, system: 'notion' }), rules).decision).toBe('propose');
    }
    expect(evaluate(input({ actionClass: 'draft_email' }), rules).decision).toBe('propose');
    expect(evaluate(input({ actionClass: 'create_calendar_hold' }), rules).decision).toBe(
      'propose',
    );
  });

  it('reads and classifies automatically without a critic', () => {
    expect(evaluate(input({ actionClass: 'read', system: 'jamie' }), rules)).toMatchObject({
      decision: 'auto',
      requiresCriticPass: false,
    });
    expect(evaluate(input({ actionClass: 'classify', system: 'lance' }), rules).decision).toBe(
      'auto',
    );
  });
});
