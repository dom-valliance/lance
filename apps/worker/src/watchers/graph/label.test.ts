import type { AgentDeps } from '@lance/agents';
import { MemoryRunRecorder, ScriptedRunner, textMessage } from '@lance/agents/testing';
import { MAIL_LABELS, stableUlid, type ModelConfig } from '@lance/shared';
import { describe, expect, it } from 'vitest';
import type { Observation } from '../types.js';
import { MAX_LABEL_BODY_CHARS, createHaikuLabeller, labelsFrom } from './label.js';

const MODEL: ModelConfig = { id: 'claude-haiku-4-5', effort: 'low' };

const agentConfig = {
  prices: {
    'claude-haiku-4-5': {
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
    },
  },
  cost: { dailyCeilingGbp: 15, usdToGbp: 0.78 },
};

function deps(runner: ScriptedRunner): AgentDeps {
  return {
    runner,
    recorder: new MemoryRunRecorder(),
    ledger: { append: () => Promise.resolve({ id: 'event-1' }) },
    config: agentConfig,
    readSpendUsd: () => Promise.resolve(0),
  };
}

function observation(record: Record<string, unknown>): Omit<Observation, 'labels'> {
  return {
    sourceSystem: 'graph',
    recordId: 'msg-1',
    observedAt: '2026-09-21T08:12:44Z',
    record,
    correlationKey: 'conv-1',
  };
}

const mailRecord = {
  subject: 'Renewal paperwork',
  from: { name: 'Priya Raman', address: 'priya.raman@northwind.example.com' },
  bodyText: 'Sending the renewal paperwork across for signature this week.',
};

function promptOf(runner: ScriptedRunner): string {
  return JSON.stringify(runner.calls[0]?.messages[0]?.content);
}

describe('createHaikuLabeller', () => {
  it('builds the prompt from the sender, the subject and the body', async () => {
    const runner = new ScriptedRunner([
      [textMessage(JSON.stringify({ labels: ['Deals'], riskLanguage: false }))],
    ]);
    const labels = await createHaikuLabeller({
      agent: deps(runner),
      model: MODEL,
      displayName: 'Lance',
    })(observation(mailRecord));

    expect(labels).toEqual(['Deals']);
    const prompt = promptOf(runner);
    expect(prompt).toContain('Priya Raman priya.raman@northwind.example.com');
    expect(prompt).toContain('Renewal paperwork');
    expect(prompt).toContain('renewal paperwork across for signature');
  });

  it('caches a system prompt that names every label and asks for no tools', async () => {
    const runner = new ScriptedRunner([
      [textMessage(JSON.stringify({ labels: ['Internal'], riskLanguage: false }))],
    ]);
    await createHaikuLabeller({ agent: deps(runner), model: MODEL, displayName: 'Lance' })(
      observation(mailRecord),
    );

    const call = runner.calls[0];
    const system = call?.system;
    expect(Array.isArray(system) && system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    const systemText = JSON.stringify(system);
    for (const label of MAIL_LABELS) expect(systemText).toContain(label);
    expect(call?.tools).toEqual([]);
    expect(call?.model).toBe('claude-haiku-4-5');
    expect(call?.max_tokens).toBe(300);
    // Haiku 4.5 rejects adaptive thinking and the effort parameter with a 400, so neither is sent.
    expect(call?.thinking).toBeUndefined();
    expect(call?.output_config?.effort).toBeUndefined();
  });

  it('adds Risk when the model reports risk language', async () => {
    const runner = new ScriptedRunner([
      [textMessage(JSON.stringify({ labels: ['Deals', 'Priority'], riskLanguage: true }))],
    ]);
    const labels = await createHaikuLabeller({
      agent: deps(runner),
      model: MODEL,
      displayName: 'Lance',
    })(observation(mailRecord));
    expect(labels).toEqual(['Deals', 'Priority', 'Risk']);
  });

  it('sends only the first 1500 characters of the body', async () => {
    const runner = new ScriptedRunner([
      [textMessage(JSON.stringify({ labels: ['Newsletters'], riskLanguage: false }))],
    ]);
    await createHaikuLabeller({ agent: deps(runner), model: MODEL, displayName: 'Lance' })(
      observation({ ...mailRecord, bodyText: `${'a'.repeat(MAX_LABEL_BODY_CHARS)}STOP` }),
    );
    expect(promptOf(runner)).not.toContain('STOP');
  });

  it('runs under the conversation correlation id the watcher runner derives', async () => {
    const runner = new ScriptedRunner([
      [textMessage(JSON.stringify({ labels: ['Action'], riskLanguage: false }))],
    ]);
    const recorder = new MemoryRunRecorder();
    await createHaikuLabeller({
      agent: { ...deps(runner), recorder },
      model: MODEL,
      displayName: 'Lance',
    })(observation(mailRecord));
    expect(recorder.starts[0]?.correlationId).toBe(stableUlid('graph:conv-1'));
  });

  it('describes a message with no sender or subject without failing', async () => {
    const runner = new ScriptedRunner([
      [textMessage(JSON.stringify({ labels: ['Alerts'], riskLanguage: false }))],
    ]);
    const labels = await createHaikuLabeller({
      agent: deps(runner),
      model: MODEL,
      displayName: 'Lance',
    })(observation({ subject: null, from: null, bodyText: '' }));
    expect(labels).toEqual(['Alerts']);
    expect(promptOf(runner)).toContain('unknown sender');
  });
});

describe('labelsFrom', () => {
  it('leaves the model labels alone when there is no risk language', () => {
    expect(labelsFrom({ labels: ['Deals'], riskLanguage: false })).toEqual(['Deals']);
  });
});
