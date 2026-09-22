import { cn } from 'cn';
import { Play } from 'lucide-react';
import { ActionForm } from '@/components/action-form';
import { InlineFailure } from '@/components/inline-failure';
import { KeyValue, KeyValueGrid } from '@/components/key-value';
import { PageHeader } from '@/components/page-header';
import { SubmitButton } from '@/components/submit-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { formatInstant } from '@/lib/proposal-view';
import {
  connectorHealth,
  retentionLabel,
  retentionRunSummary,
  type ConnectorHealth,
  type ConnectorKey,
} from '@/lib/settings-view';
import { formatDuration } from '@/lib/time';
import { apiClient } from '@/lib/trpc';
import {
  pauseAction,
  resumeAction,
  setCostCeilingAction,
  setInterruptionBudgetAction,
  setModeAction,
} from './actions';
import { PauseForm } from './pause-form';

export const dynamic = 'force-dynamic';

/** Every card on this page shares one shape (design 7.11). */
const CARD = 'flex flex-col gap-4 rounded-xl bg-card p-6';

/** The 16px semibold title row each card opens with. */
const CARD_TITLE_ROW = 'flex flex-wrap items-center justify-between gap-2';

/** A submit control that is 44px at 360 and 36px from the sidebar breakpoint up. */
const SUBMIT_HEIGHT = 'h-11 self-start lg:h-9';

const MODE_OPTIONS = [
  {
    value: 'live',
    label: 'Live',
    description:
      'Proposals wait for your decision, then the executor writes to Microsoft 365, Notion and Slack within what policy allows.',
  },
  {
    value: 'dry_run',
    label: 'Dry run',
    description:
      'Everything runs, proposals are held, nothing is written externally. Use it after a rule change you want to watch first.',
  },
] as const;

const CONNECTOR_COPY: Record<ConnectorKey, string> = {
  graph:
    'Lance reads your mail and calendar with your delegated consent and prepares drafts, categories and holds for your approval. It cannot send mail.',
  jamie:
    "Reads meetings, transcripts and action items. Jamie's API is read-only, so nothing is written back.",
  notion:
    'Reads and writes tasks under your name in the Tasks database. Nothing else in the workspace.',
  slack: "Posts proposals and alerts to Lance's channel and reads your decisions there.",
};

export default async function SettingsPage() {
  const now = new Date();
  const client = await apiClient();
  const [status, state, retention, retentionEvents] = await Promise.all([
    client.systemState.status.query(),
    client.systemState.get.query(),
    client.settings.retention.query(),
    client.ledger.query.query({ kind: 'retention_applied', limit: 1 }),
  ]);

  const connectors = connectorHealth(status);
  const lastRetentionRun = retentionEvents[0] ?? null;
  const removed = lastRetentionRun === null ? null : retentionRunSummary(lastRetentionRun.payload);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Settings"
        summary="Every change here is recorded in the ledger as a state change by user:dom."
      />

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <section className={CARD}>
          <div className={CARD_TITLE_ROW}>
            <h2 className="text-base font-semibold">Mode</h2>
            <Badge tone={status.mode === 'live' ? 'green' : 'pink'} dot>
              {status.mode === 'live' ? 'Live' : 'Dry run'}
            </Badge>
          </div>
          <ActionForm action={setModeAction} className="flex flex-col gap-3">
            {MODE_OPTIONS.map((option) => (
              <label
                key={option.value}
                // `has-checked:` follows the radio, so the highlight moves
                // with the click rather than staying on the saved mode.
                className="grid cursor-pointer grid-cols-[20px_1fr] gap-3 rounded-lg border border-input p-3 transition-colors has-checked:border-brand has-checked:bg-brand-soft/50"
              >
                <input
                  type="radio"
                  name="mode"
                  value={option.value}
                  defaultChecked={status.mode === option.value}
                  className="mt-0.5 size-4 accent-brand"
                />
                <span className="flex flex-col gap-1">
                  <span className="text-sm font-medium">{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.description}</span>
                </span>
              </label>
            ))}
            <SubmitButton pendingLabel="Saving" className={SUBMIT_HEIGHT}>
              Save mode
            </SubmitButton>
          </ActionForm>
        </section>

        <section className={cn(CARD, status.paused && 'ring-1 ring-sem-red-line')}>
          <div className={CARD_TITLE_ROW}>
            <h2 className="text-base font-semibold">Kill switch</h2>
            {status.paused ? (
              <Badge tone="red" dot>
                Paused
              </Badge>
            ) : (
              <span className="text-xs text-muted-foreground">Running</span>
            )}
          </div>
          {status.paused ? (
            <>
              <KeyValueGrid className="gap-x-6 gap-y-3">
                <KeyValue label="Since">
                  {status.pausedAt === null
                    ? 'unknown'
                    : `${formatInstant(status.pausedAt)} (${formatDuration(
                        now.getTime() - new Date(status.pausedAt).getTime(),
                      )})`}
                </KeyValue>
                <KeyValue label="By">
                  <span className="font-mono">{status.pausedBy ?? 'unknown'}</span>
                  {status.pausedBy === 'user:dom' ? ', from the web' : null}
                </KeyValue>
                <KeyValue label="Reason">
                  {status.pausedReason === null ? 'none given' : `"${status.pausedReason}"`}
                </KeyValue>
              </KeyValueGrid>
              <p className="text-sm text-muted-foreground">Every watcher and agent is stopped.</p>
              <ActionForm action={resumeAction} className="flex flex-col gap-3">
                <SubmitButton pendingLabel="Resuming" className={SUBMIT_HEIGHT}>
                  <Play aria-hidden />
                  Resume Lance
                </SubmitButton>
              </ActionForm>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Pause stops every watcher and agent at once. Nothing is lost: cursors hold their
                place and pending proposals keep their expiry. Resume picks up where it stopped.
              </p>
              <PauseForm action={pauseAction} />
              <p className="text-xs text-muted-foreground">
                The button enables once a reason is typed. Pausing also posts to Slack.
              </p>
            </>
          )}
        </section>

        <section className={CARD}>
          <div className={CARD_TITLE_ROW}>
            <h2 className="text-base font-semibold">Quiet hours and push budget</h2>
          </div>
          <ActionForm action={setInterruptionBudgetAction} className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start gap-3">
              <Field label="Quiet from" className="w-32">
                <Input
                  type="time"
                  name="quietHoursStart"
                  defaultValue={state.quietHoursStart}
                  required
                />
              </Field>
              <Field label="Quiet until" className="w-32">
                <Input
                  type="time"
                  name="quietHoursEnd"
                  defaultValue={state.quietHoursEnd}
                  required
                />
              </Field>
            </div>
            <Field label="Unsolicited Slack posts per hour" className="w-28">
              <Input
                type="number"
                name="pushBudgetPerHour"
                min={0}
                max={50}
                step={1}
                defaultValue={state.pushBudgetPerHour}
                required
                className="tabular-nums"
              />
            </Field>
            <p className="text-xs text-muted-foreground">
              Weekends are always quiet. P0 alerts ignore quiet hours and the budget. Everything
              else waits for 07:00 and appears in the morning brief.
            </p>
            <SubmitButton pendingLabel="Saving" className={SUBMIT_HEIGHT}>
              Save
            </SubmitButton>
          </ActionForm>
        </section>

        <section className={CARD}>
          <div className={CARD_TITLE_ROW}>
            <h2 className="text-base font-semibold">Daily model spend ceiling</h2>
          </div>
          <ActionForm action={setCostCeilingAction} className="flex flex-col gap-4">
            <Field label="Ceiling in pounds per day" className="w-36">
              <Input
                type="number"
                name="costCeilingGbp"
                min={0.01}
                max={1000}
                step={0.5}
                defaultValue={state.costCeilingGbp}
                required
                className="tabular-nums"
              />
            </Field>
            <p className="text-xs text-muted-foreground">
              At 80 percent Lance raises a P1. At the ceiling triage, the planner, the critic and
              the chase stop until midnight or until you raise it here. Watchers keep observing.
            </p>
            <SubmitButton pendingLabel="Saving" className={SUBMIT_HEIGHT}>
              Save
            </SubmitButton>
          </ActionForm>
        </section>

        <section className={CARD}>
          <div className={CARD_TITLE_ROW}>
            <h2 className="text-base font-semibold">Retention</h2>
            <span className="text-xs text-muted-foreground">Read-only, set in configuration</span>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
            <RetentionRow label="Mail bodies" days={retention.mailBodiesDays} />
            <RetentionRow label="Transcripts" days={retention.transcriptsDays} />
            <RetentionRow label="Ledger" days={retention.ledgerDays} />
            <RetentionRow label="Model logs" days={retention.modelLogsDays} />
          </dl>
          <p className="text-xs text-muted-foreground">
            Retention runs at 03:00 daily and records what it removed in the ledger.
            {lastRetentionRun === null
              ? ''
              : ` Last run ${formatInstant(lastRetentionRun.ts)}.${
                  removed === null ? '' : ` It removed ${removed}.`
                }`}
          </p>
        </section>

        <section className={cn(CARD, 'lg:col-span-2')}>
          <div className={CARD_TITLE_ROW}>
            <h2 className="text-base font-semibold">Connectors</h2>
          </div>
          <div className="grid gap-4 lg:grid-cols-4">
            {connectors.map((connector) => (
              <ConnectorCard key={connector.key} connector={connector} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function RetentionRow({ label, days }: { label: string; days: number }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm tabular-nums">{retentionLabel(days)}</dd>
    </div>
  );
}

const STATE_BADGES = {
  healthy: { tone: 'green', dot: true, label: 'Healthy' },
  stale: { tone: 'peach', dot: true, label: 'Stale' },
  unknown: { tone: 'outline', dot: false, label: 'No reads yet' },
  unmonitored: { tone: 'outline', dot: false, label: 'Not monitored' },
} as const;

function ConnectorCard({ connector }: { connector: ConnectorHealth }) {
  const badge = STATE_BADGES[connector.state];
  return (
    <article
      className={cn(
        'flex flex-col gap-2.5 rounded-lg bg-background p-4',
        connector.state === 'stale' && 'ring-1 ring-sem-red-line',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{connector.name}</h3>
        <Badge tone={badge.tone} dot={badge.dot} size="sm">
          {badge.label}
        </Badge>
      </div>
      <p className="text-[13px] text-muted-foreground">{CONNECTOR_COPY[connector.key]}</p>
      <p className="text-xs text-muted-foreground">
        {connector.lastReadAt === null
          ? 'Not read yet.'
          : `Last read ${formatInstant(connector.lastReadAt)}.`}
      </p>
      {connector.state === 'stale' && connector.lastReadAt !== null ? (
        <InlineFailure>
          {connector.name} has not been read since {formatInstant(connector.lastReadAt)}. Check the
          Agents page if this lasts.
        </InlineFailure>
      ) : null}
      {connector.key === 'graph' ? (
        <Button asChild variant="outline" size="sm" className="h-11 self-start lg:h-8">
          <a href="/api/graph/connect">
            {connector.state === 'healthy' ? 'Re-authorise' : 'Connect Microsoft 365'}
          </a>
        </Button>
      ) : null}
    </article>
  );
}
