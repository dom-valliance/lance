import { describe, expect, it } from 'vitest';
import {
  AlertSchema,
  CommitmentSchema,
  CursorSchema,
  LedgerEventInputSchema,
  LedgerEventSchema,
  PolicyDecisionSchema,
  PolicyInputSchema,
  PolicyRuleSchema,
  ProposalSchema,
  ProvenanceRefSchema,
  SystemStateSchema,
  UlidSchema,
  UserSchema,
} from './schemas.js';
import { newUlid } from './ids.js';

const ulid = newUlid();
const ts = '2026-01-15T09:00:00Z';

const provenance = {
  system: 'graph' as const,
  recordId: 'message-1',
  hash: 'abc123',
  observedAt: ts,
};

describe('UlidSchema', () => {
  it('accepts a real ulid', () => {
    expect(UlidSchema.safeParse(newUlid()).success).toBe(true);
  });

  it('rejects a uuid', () => {
    expect(UlidSchema.safeParse('123e4567-e89b-12d3-a456-426614174000').success).toBe(false);
  });
});

describe('ProvenanceRefSchema', () => {
  it('accepts a minimal valid ref without url', () => {
    expect(ProvenanceRefSchema.safeParse(provenance).success).toBe(true);
  });

  it('rejects an unknown source system', () => {
    expect(ProvenanceRefSchema.safeParse({ ...provenance, system: 'sharepoint' }).success).toBe(
      false,
    );
  });
});

describe('LedgerEventSchema', () => {
  const event = {
    id: ulid,
    ts,
    actor: 'agent:triage@1.4.0',
    kind: 'observed' as const,
    sourceSystem: 'graph' as const,
    sourceRecordId: 'message-1',
    sourceRecordHash: 'abc123',
    idempotencyKey: 'graph:message-1:abc123',
    correlationId: newUlid(),
    parentEventId: null,
    policyDecisionId: null,
    payload: { subject: 'hello' },
    payloadHash: 'def456',
  };

  it('accepts a fully populated observed event', () => {
    expect(LedgerEventSchema.safeParse(event).success).toBe(true);
  });

  it.each(['user:dom', 'system:retention', 'agent:executor@1.4.0'])(
    'accepts actor pattern "%s"',
    (actor) => {
      expect(LedgerEventSchema.safeParse({ ...event, actor }).success).toBe(true);
    },
  );

  it.each(['user:Dom', 'agent:triage', 'triage@1.4.0', 'agent:triage@1.4'])(
    'rejects malformed actor "%s"',
    (actor) => {
      expect(LedgerEventSchema.safeParse({ ...event, actor }).success).toBe(false);
    },
  );

  it('rejects a non-ulid correlation id', () => {
    expect(LedgerEventSchema.safeParse({ ...event, correlationId: 'not-a-ulid' }).success).toBe(
      false,
    );
  });

  it('rejects a timestamp with no offset', () => {
    expect(LedgerEventSchema.safeParse({ ...event, ts: '2026-01-15T09:00:00' }).success).toBe(
      false,
    );
  });
});

describe('LedgerEventInputSchema', () => {
  it('omits id and payloadHash but still requires ts from the caller', () => {
    const input = {
      ts,
      actor: 'user:dom',
      kind: 'decided' as const,
      sourceSystem: null,
      sourceRecordId: null,
      sourceRecordHash: null,
      idempotencyKey: null,
      correlationId: newUlid(),
      parentEventId: null,
      policyDecisionId: null,
      payload: null,
    };
    expect(LedgerEventInputSchema.safeParse(input).success).toBe(true);
    const withoutTs: Partial<typeof input> = { ...input };
    delete withoutTs.ts;
    expect(LedgerEventInputSchema.safeParse(withoutTs).success).toBe(false);
  });
});

describe('PolicyRuleSchema', () => {
  const rule = {
    id: ulid,
    version: 1,
    active: true,
    actionClass: 'move_mail' as const,
    counterpartyClass: '*' as const,
    system: 'graph' as const,
    decision: 'auto' as const,
    conditions: {
      labelsAnyOf: ['Newsletters', 'Notifications'],
      targetAnyOf: ['AI-Filed'],
    },
    createdBy: 'user:dom' as const,
    createdAt: ts,
    rationale: 'Seed rule from spec 6.2.',
  };

  it('accepts the wildcard literal on each dimension', () => {
    expect(
      PolicyRuleSchema.safeParse({
        ...rule,
        actionClass: '*',
        counterpartyClass: '*',
        system: '*',
      }).success,
    ).toBe(true);
  });

  it('accepts labelsAnyOf and targetAnyOf conditions', () => {
    expect(PolicyRuleSchema.safeParse(rule).success).toBe(true);
  });

  it('rejects an empty labelsAnyOf', () => {
    expect(PolicyRuleSchema.safeParse({ ...rule, conditions: { labelsAnyOf: [] } }).success).toBe(
      false,
    );
  });

  it('rejects an unknown createdBy', () => {
    expect(PolicyRuleSchema.safeParse({ ...rule, createdBy: 'user:alice' }).success).toBe(false);
  });

  it('rejects an empty rationale', () => {
    expect(PolicyRuleSchema.safeParse({ ...rule, rationale: '' }).success).toBe(false);
  });
});

describe('PolicyInputSchema', () => {
  const input = {
    actionClass: 'move_mail' as const,
    counterpartyClass: 'self' as const,
    system: 'graph' as const,
    at: ts,
  };

  it('defaults stage to "proposal" when omitted', () => {
    const result = PolicyInputSchema.parse(input);
    expect(result.stage).toBe('proposal');
  });

  it('accepts an explicit "execution" stage', () => {
    const result = PolicyInputSchema.parse({ ...input, stage: 'execution' });
    expect(result.stage).toBe('execution');
  });

  it('accepts optional labels and target', () => {
    expect(
      PolicyInputSchema.safeParse({ ...input, labels: ['Newsletters'], target: 'AI-Filed' })
        .success,
    ).toBe(true);
  });

  it('rejects confidence outside 0 to 1', () => {
    expect(PolicyInputSchema.safeParse({ ...input, confidence: 1.5 }).success).toBe(false);
  });
});

describe('PolicyDecisionSchema', () => {
  it('accepts a decision with a nullable ruleId', () => {
    const decision = {
      id: ulid,
      decision: 'propose' as const,
      ruleId: null,
      reason: 'No matching auto rule.',
      input: {
        actionClass: 'draft_email' as const,
        counterpartyClass: 'client' as const,
        system: 'graph' as const,
        at: ts,
        stage: 'proposal' as const,
      },
      evaluatedAt: ts,
    };
    expect(PolicyDecisionSchema.safeParse(decision).success).toBe(true);
  });
});

describe('ProposalSchema', () => {
  const proposal = {
    id: ulid,
    correlationId: newUlid(),
    actionClass: 'draft_email' as const,
    counterpartyClass: 'client' as const,
    targetSystem: 'graph' as const,
    targetRecordId: 'message-1',
    reversibility: 'compensatable' as const,
    payload: { to: 'client@example.com' },
    preview: 'Draft reply to client@example.com',
    rationale: 'Client asked a question in the thread.',
    provenance: [provenance],
    policyDecision: 'propose' as const,
    policyRuleId: null,
    status: 'pending' as const,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    editedPayload: null,
    slackChannel: null,
    slackTs: null,
    expiresAt: ts,
    executionEventId: null,
  };

  it('accepts a pending proposal with one provenance ref', () => {
    expect(ProposalSchema.safeParse(proposal).success).toBe(true);
  });

  it('rejects an empty provenance array', () => {
    expect(ProposalSchema.safeParse({ ...proposal, provenance: [] }).success).toBe(false);
  });
});

describe('AlertSchema', () => {
  it('requires at least one provenance ref', () => {
    const alert = {
      id: ulid,
      severity: 'P1' as const,
      kind: 'watcher_failed' as const,
      dedupeKey: 'watcher:graph-mail',
      title: 'Watcher failed',
      body: 'graph-mail watcher raised an exception.',
      provenance: [],
      status: 'open' as const,
      firstSeen: ts,
      lastSeen: ts,
      count: 1,
      ackedBy: null,
      ackedAt: null,
      slackTs: null,
    };
    expect(AlertSchema.safeParse(alert).success).toBe(false);
    expect(AlertSchema.safeParse({ ...alert, provenance: [provenance] }).success).toBe(true);
  });
});

describe('CommitmentSchema', () => {
  it('accepts a valid outbound commitment', () => {
    expect(
      CommitmentSchema.safeParse({
        id: ulid,
        direction: 'outbound',
        ownerPersonId: 'person-1',
        counterpartyPersonId: 'person-2',
        description: 'Send the revised SOW',
        dueAt: ts,
        dueConfidence: 0.8,
        evidenceQuote: '"I will send the SOW by Friday."',
        sourceRefs: [provenance],
        status: 'open',
        chaseCount: 0,
        nextChaseAt: null,
      }).success,
    ).toBe(true);
  });
});

describe('SystemStateSchema', () => {
  it('accepts the documented HH:MM quiet-hours format', () => {
    expect(
      SystemStateSchema.safeParse({
        paused: false,
        pausedReason: null,
        pausedBy: null,
        mode: 'dry_run',
        quietHoursStart: '19:00',
        quietHoursEnd: '07:00',
        pushBudgetPerHour: 3,
      }).success,
    ).toBe(true);
  });

  it('rejects a malformed quiet-hours value', () => {
    expect(
      SystemStateSchema.safeParse({
        paused: false,
        pausedReason: null,
        pausedBy: null,
        mode: 'live',
        quietHoursStart: '7pm',
        quietHoursEnd: '07:00',
        pushBudgetPerHour: 3,
      }).success,
    ).toBe(false);
  });
});

describe('UserSchema', () => {
  it('defaults timeZone to Europe/London', () => {
    const result = UserSchema.parse({
      id: ulid,
      upn: 'dom@valliance.ai',
      slackUserId: 'U123',
      notionUserId: '1fdd872b-594c-8146-b22f-00028f1f5a41',
    });
    expect(result.timeZone).toBe('Europe/London');
  });

  it('rejects an invalid upn', () => {
    expect(
      UserSchema.safeParse({
        id: ulid,
        upn: 'not-an-email',
        slackUserId: 'U123',
        notionUserId: 'x',
      }).success,
    ).toBe(false);
  });
});

describe('CursorSchema', () => {
  it('accepts a watcher cursor row', () => {
    expect(
      CursorSchema.safeParse({
        watcher: 'graph-mail',
        key: 'inbox',
        value: '2026-01-15T09:00:00Z',
        updatedAt: ts,
      }).success,
    ).toBe(true);
  });
});
