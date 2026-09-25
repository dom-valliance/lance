import { runAgent, type AgentDefinition } from '@lance/agents';
import { MemoryRunRecorder } from '@lance/agents/testing';
import { loadConfig } from '@lance/shared';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { plannerSystemPrompt } from '../briefs/planner.js';
import { PlannerOutputSchema } from '../briefs/schema.js';
import { triageSystemPrompt } from '../triage/prompt.js';
import { TriageOutputSchema } from '../triage/schema.js';
import { MailLabelOutputSchema, mailLabelSystemPrompt } from '../watchers/graph/label.js';
import { LatencyModelRunner, agentOf, modelCallScope } from './fakeModel.js';
import { seededRandom } from './random.js';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://unused@localhost/lance',
  DOM_EMAIL: 'dom@valliance.ai',
});

function runner(latency = { min: 0, max: 0 }, taskCandidateRate = 1): LatencyModelRunner {
  return new LatencyModelRunner({
    random: seededRandom(1),
    latencyMs: latency,
    output: { taskCandidateRate },
  });
}

async function run<T>(
  model: LatencyModelRunner,
  system: string,
  schema: z.ZodType<T>,
  prompt: string,
): Promise<T> {
  const definition: AgentDefinition<T> = {
    name: 'probe',
    version: '0.0.0',
    model: config.models.triage,
    system,
    tools: [],
    outputSchema: schema,
  };
  const result = await runAgent(
    {
      runner: model,
      recorder: new MemoryRunRecorder(),
      ledger: { append: () => Promise.resolve({ id: 'e', inserted: true }) },
      config,
      readSpendUsd: () => Promise.resolve(0),
    },
    definition,
    { correlationId: '01K5S9V6QW3SWCCPVB0N0E3Q7H', prompt },
  );
  return result.output;
}

describe('the load harness model runner', () => {
  it('answers each agent with output its own schema accepts, first time', async () => {
    const model = runner();
    const label = await run(model, mailLabelSystemPrompt('Lance'), MailLabelOutputSchema, 'x');
    expect(label.labels.length).toBe(1);
    const triage = await run(
      model,
      triageSystemPrompt('Lance', 'Dom Selvon'),
      TriageOutputSchema,
      'Observation 1\nsystem: graph\nrecordId: P01-msg-0001\nrecord:\n{"from":"priya.raman@northwind.example.com"}',
    );
    expect(triage.taskCandidates[0]?.recordId).toBe('P01-msg-0001');
    const plan = await run(
      model,
      plannerSystemPrompt('Lance', 2),
      PlannerOutputSchema,
      'Meetings:\nMeeting P01-evt-000: Client review\n\nTasks due today or overdue:\n  - task-1 | notion | Task 1 | due none',
    );
    expect(plan.meetings.map((meeting) => meeting.id)).toEqual(['P01-evt-000']);
    expect(plan.tasks.map((task) => task.taskId)).toEqual(['task-1']);
    expect(model.calls.map((call) => call.agent)).toEqual(['mail-label', 'triage', 'planner']);
  });

  it('plays a tool loop as one call per turn, each with its own latency', async () => {
    const model = runner({ min: 30, max: 30 });
    const started = Date.now();
    await run(model, plannerSystemPrompt('Lance', 2), PlannerOutputSchema, 'Meetings:\n  none');
    expect(Date.now() - started).toBeGreaterThanOrEqual(85);
    expect(model.calls[0]?.turns).toBe(3);
  });

  it('records whose call it served from the scope the limiter sets', async () => {
    const model = runner();
    await modelCallScope.run({ principalId: 'p-7' }, () =>
      run(model, mailLabelSystemPrompt('Lance'), MailLabelOutputSchema, 'x'),
    );
    expect(model.calls[0]?.principalId).toBe('p-7');
  });

  it('refuses an agent it has no answer for, naming where to add one', () => {
    expect(() =>
      agentOf({
        model: 'm',
        max_tokens: 1,
        messages: [],
        tools: [],
        system: 'You are someone new.',
      }),
    ).toThrow(/SYSTEM_MARKERS/);
  });
});
