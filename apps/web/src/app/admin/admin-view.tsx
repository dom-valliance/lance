import { EvidenceForm } from '@/app/admin/evidence-form';
import { OffboardForm } from '@/app/admin/offboard-form';
import type { EvidenceState } from '@/app/admin/actions';
import { ActionForm, type FormAction } from '@/components/action-form';
import { Table, TableCard, Td, Th, Tr } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { PageHeader } from '@/components/page-header';
import { SubmitButton } from '@/components/submit-button';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  PRINCIPAL_STATUS_LABELS,
  PRINCIPAL_STATUS_TONES,
  SECRET_STATE_LABELS,
  SECRET_STATE_TONES,
  connectorLabel,
  isStaleWatcher,
  onboardingStepLabel,
  onboardingSummary,
  type PrincipalStatus,
  type SecretStateValue,
} from '@/lib/admin-view';
import { ageLabel } from '@/lib/agents-view';
import { formatGbp } from '@/lib/brief-view';
import { humanise } from '@/lib/humanise';
import { formatInstant } from '@/lib/proposal-view';
import { SEVERITY_TONES, type AlertSeverity } from '@/lib/tones';

/**
 * The admin page's layout over data the page has already read (ADR 0024).
 * Every value it renders is a status, a count, an age or a name.
 */

export interface AdminPrincipal {
  id: string;
  upn: string;
  status: PrincipalStatus;
  onboarding: { steps: { step: string; done: boolean }[]; complete: boolean };
}

export interface AdminHealth {
  principalId: string;
  upn: string;
  watchers: { watcher: string; lastRunAgeMinutes: number }[];
  breakers: { connector: string; state: 'open' }[];
  secrets: { connector: string; state: SecretStateValue; recordedAt: string | null }[];
  costTodayGbp: number;
  costWeekGbp: number;
}

export interface AdminRuleChange {
  eventId: string;
  ts: string;
  actor: string;
  change: string | null;
  rule: {
    version: number;
    active: boolean;
    actionClass: string;
    counterpartyClass: string;
    system: string;
    decision: string;
  };
}

export interface AdminSystemAlert {
  id: string;
  severity: string;
  kind: string;
  title: string;
  status: string;
  lastSeen: string;
}

export interface AdminViewProps {
  principals: AdminPrincipal[];
  health: AdminHealth[];
  ruleChanges: AdminRuleChange[];
  systemAlerts: AdminSystemAlert[];
  /** The signed-in admin, who is not offered to themselves for offboarding. */
  adminPrincipalId: string;
  today: Date;
  offboardAction: FormAction;
  evidenceAction: (previous: EvidenceState, form: FormData) => Promise<EvidenceState>;
  /** The daily spend ceiling across every principal, from the global row. */
  organisationCeilingGbp: number;
  organisationCeilingAction: FormAction;
}

const CARD = 'flex flex-col gap-4 rounded-xl bg-card p-6';

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

const severityTone = (severity: string) =>
  severity in SEVERITY_TONES ? SEVERITY_TONES[severity as AlertSeverity] : 'neutral';

export function AdminView({
  principals,
  health,
  ruleChanges,
  systemAlerts,
  adminPrincipalId,
  today,
  offboardAction,
  evidenceAction,
  organisationCeilingGbp,
  organisationCeilingAction,
}: AdminViewProps) {
  const healthOf = new Map(health.map((row) => [row.principalId, row]));
  // Every step is idempotent, so an offboarded principal stays listed: a
  // run that stopped part way is finished by running it again.
  const others = principals.filter((principal) => principal.id !== adminPrincipalId);
  const monthAgo = new Date(today.getTime() - 30 * 24 * 3600 * 1000);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Admin"
        summary="How Lance is running for each principal: status, onboarding, connectors, cost, organisation rules and system alerts. Nothing any principal wrote or received is shown here."
      />

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">Principals</h2>
        <TableCard>
          <Table caption="Principals, their status, onboarding progress and cost">
            <thead>
              <tr>
                <Th>Principal</Th>
                <Th>Status</Th>
                <Th>Onboarding</Th>
                <Th>Cost today</Th>
                <Th>Cost 7 days</Th>
              </tr>
            </thead>
            <tbody>
              {principals.map((principal) => {
                const row = healthOf.get(principal.id);
                return (
                  <Tr key={principal.id}>
                    <Td className="font-medium">{principal.upn}</Td>
                    <Td>
                      <Badge tone={PRINCIPAL_STATUS_TONES[principal.status]} size="sm">
                        {PRINCIPAL_STATUS_LABELS[principal.status]}
                      </Badge>
                    </Td>
                    <Td>
                      <p className="text-xs">{onboardingSummary(principal.onboarding.steps)}</p>
                      <ul className="mt-1 flex flex-wrap gap-1" aria-label="Onboarding steps">
                        {principal.onboarding.steps.map((step) => (
                          <li key={step.step}>
                            <Badge tone={step.done ? 'green' : 'outline'} size="sm">
                              {onboardingStepLabel(step.step)}: {step.done ? 'done' : 'to do'}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    </Td>
                    <Td className="whitespace-nowrap">
                      {row === undefined ? 'None' : formatGbp(row.costTodayGbp)}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {row === undefined ? 'None' : formatGbp(row.costWeekGbp)}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </TableCard>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">Connector health</h2>
        {health.length === 0 ? (
          <TableCard>
            <EmptyState>No principal is onboarding, active or paused.</EmptyState>
          </TableCard>
        ) : (
          <TableCard>
            <Table caption="Recorded secrets, open breakers and the last run of each watcher">
              <thead>
                <tr>
                  <Th>Principal</Th>
                  <Th>Secrets</Th>
                  <Th>Breakers</Th>
                  <Th>Watchers, last run</Th>
                </tr>
              </thead>
              <tbody>
                {health.map((row) => (
                  <Tr
                    key={row.principalId}
                    {...(row.breakers.length > 0 ? { accent: 'red' as const } : {})}
                  >
                    <Td className="font-medium">{row.upn}</Td>
                    <Td>
                      <ul className="flex flex-col gap-1">
                        {row.secrets.map((secret) => (
                          <li key={secret.connector} className="text-xs">
                            {connectorLabel(secret.connector)}{' '}
                            <Badge tone={SECRET_STATE_TONES[secret.state]} size="sm">
                              {SECRET_STATE_LABELS[secret.state]}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    </Td>
                    <Td>
                      {row.breakers.length === 0 ? (
                        <span className="text-xs text-muted-foreground">All closed</span>
                      ) : (
                        <ul className="flex flex-wrap gap-1">
                          {row.breakers.map((breaker) => (
                            <li key={breaker.connector}>
                              <Badge tone="red" size="sm">
                                {connectorLabel(breaker.connector)} open
                              </Badge>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Td>
                    <Td>
                      {row.watchers.length === 0 ? (
                        <span className="text-xs text-muted-foreground">No runs yet</span>
                      ) : (
                        <ul className="flex flex-col gap-1">
                          {row.watchers.map((watcher) => (
                            <li key={watcher.watcher} className="text-xs">
                              <span className="font-mono">{watcher.watcher}</span>{' '}
                              <span
                                className={
                                  isStaleWatcher(watcher.lastRunAgeMinutes)
                                    ? 'text-sem-red-fg'
                                    : 'text-muted-foreground'
                                }
                              >
                                {ageLabel(watcher.lastRunAgeMinutes)}
                                {isStaleWatcher(watcher.lastRunAgeMinutes) ? ', stale' : ''}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </TableCard>
        )}
        <p className="text-xs text-muted-foreground">
          Secrets are shown as the ledger records them: stored when connected, deleted at
          offboarding. The api can write to the principal vault and cannot read it.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">System alerts</h2>
        <TableCard>
          {systemAlerts.length === 0 ? (
            <EmptyState>No open alert from the organisation jobs.</EmptyState>
          ) : (
            <Table caption="Alerts the role check and the organisation budget raised for you">
              <thead>
                <tr>
                  <Th>Severity</Th>
                  <Th>Alert</Th>
                  <Th>Status</Th>
                  <Th>Last seen</Th>
                </tr>
              </thead>
              <tbody>
                {systemAlerts.map((alert) => (
                  <Tr key={alert.id}>
                    <Td>
                      <Badge tone={severityTone(alert.severity)} size="sm">
                        {alert.severity}
                      </Badge>
                    </Td>
                    <Td>
                      <p className="font-medium">{alert.title}</p>
                      <p className="text-xs text-muted-foreground">{humanise(alert.kind)}</p>
                    </Td>
                    <Td className="text-xs">{humanise(alert.status)}</Td>
                    <Td className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatInstant(alert.lastSeen)}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </TableCard>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold">Organisation rule changes</h2>
        <TableCard>
          {ruleChanges.length === 0 ? (
            <EmptyState>No organisation-default rule has been changed.</EmptyState>
          ) : (
            <Table caption="Changes to organisation-default policy rules, newest first">
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>By</Th>
                  <Th>Rule</Th>
                  <Th>Change</Th>
                </tr>
              </thead>
              <tbody>
                {ruleChanges.map((change) => (
                  <Tr key={change.eventId}>
                    <Td className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatInstant(change.ts)}
                    </Td>
                    <Td className="text-xs">{change.actor}</Td>
                    <Td className="text-xs">
                      {humanise(change.rule.actionClass)} for{' '}
                      {humanise(change.rule.counterpartyClass)} in {humanise(change.rule.system)}:{' '}
                      {humanise(change.rule.decision)} (version {change.rule.version}
                      {change.rule.active ? '' : ', inactive'})
                    </Td>
                    <Td className="text-xs">
                      {change.change === null ? 'Changed' : humanise(change.change)}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </TableCard>
      </section>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <section className={CARD}>
          <h2 className="text-base font-semibold">Organisation spend ceiling</h2>
          <ActionForm action={organisationCeilingAction} className="flex flex-col gap-4">
            <Field label="Pounds per day, across every principal" className="w-56">
              <Input
                type="number"
                name="costCeilingGbp"
                min={0.01}
                max={10000}
                step={0.5}
                defaultValue={organisationCeilingGbp}
                required
                className="tabular-nums"
              />
            </Field>
            <p className="text-xs text-muted-foreground">
              Each principal also has their own ceiling in Settings. When today&apos;s spend across
              everyone reaches this figure, every principal&apos;s triage, planner, critic and chase
              stop until midnight or until it is raised here. Watchers keep observing.
            </p>
            <SubmitButton pendingLabel="Saving" className="h-11 self-start lg:h-9">
              Save
            </SubmitButton>
          </ActionForm>
        </section>

        <section className={CARD}>
          <h2 className="text-base font-semibold">Evidence export</h2>
          <p className="text-sm text-muted-foreground">
            A signed bundle for the ISO 27001 auditor: access events, rule changes and retention
            runs in the period, and for one principal the metadata of their ledger, never its
            content.
          </p>
          <EvidenceForm
            action={evidenceAction}
            principals={principals.map((principal) => ({ id: principal.id, upn: principal.upn }))}
            defaultFrom={isoDay(monthAgo)}
            defaultTo={isoDay(today)}
          />
        </section>

        <section className={CARD}>
          <h2 className="text-base font-semibold">Offboard a principal</h2>
          <p className="text-sm text-muted-foreground">
            Sets them offboarded, pauses them, deletes their credentials from the principal vault,
            revokes their Slack link and archives their channel, and removes their cached mail,
            transcripts and model logs. Their ledger stays. Deleted secrets remain recoverable,
            soft-deleted, until the vault&apos;s retention period ends.
          </p>
          {others.length === 0 ? (
            <EmptyState>Nobody else can be offboarded.</EmptyState>
          ) : (
            <ul className="flex flex-col gap-3">
              {others.map((principal) => (
                <li key={principal.id}>
                  <details className="rounded-lg border border-border p-3">
                    <summary className="cursor-pointer text-sm font-medium">
                      {principal.upn}
                      {principal.status === 'offboarded'
                        ? ', offboarded: run again to finish any step that failed'
                        : ''}
                    </summary>
                    <div className="mt-3">
                      <OffboardForm
                        action={offboardAction}
                        principalId={principal.id}
                        upn={principal.upn}
                      />
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
