# Offboard a principal

When a colleague leaves Valliance or stops using Lance, offboarding removes what Lance holds for them and keeps the audit trail. It is one action on the admin page; the worker carries out six steps, in this order, each recorded in the principal's own ledger and each safe to repeat:

| Step | What it does | Recorded as |
|---|---|---|
| 1. `status` | Sets the principal's status to `offboarded`, through an admin scope | `offboarding_step`, `step: status` |
| 2. `pause` | Pauses the principal, which holds any approved proposal | `offboarding_step`, `step: pause`, and the usual `pause` event |
| 3. `secrets` | Deletes `graph-refresh-token--<id>`, `jamie-api-key--<id>` and `foundry-refresh-token--<id>` from the principal vault | `offboarding_step`, `step: secrets`, naming each secret and never its value |
| 4. `slack_link` | Revokes their Slack link, so their Slack user no longer acts for anyone | `offboarding_step`, `step: slack_link` |
| 5. `slack_channel` | Archives their private channel. Never `dom-claude-agent` | `offboarding_step`, `step: slack_channel` |
| 6. `retention` | A retention run with a zero-day window over mail bodies, transcripts, what triage copied from them, and model logs | `offboarding_step`, `step: retention`, and a `retention_applied` event with `trigger: offboarding` |

Their ledger rows stay. Nothing deletes a ledger row (ADR 0011): content payloads are nulled now, every other payload at the two-year ledger window, and each row keeps its `payload_hash`. The principal vault has purge protection, so the deleted secrets stay soft-deleted, recoverable by a Key Vault Secrets Officer, until the vault's 90-day retention period ends; nobody can purge them early.

The nightly role check (02:30, `apps/worker/src/roles/roleCheck.ts`) runs the same six steps by itself, as `system:role-check`, for anyone it paused for holding no Lance role who still holds none `OFFBOARD_AFTER_ROLE_LOSS_DAYS` later (default 7). The first night only pauses, so a group change made by mistake costs a pause and nothing else.

## Before you start

Run these first, in this order. Each consumes what the one before it creates.

1. `deploy.md` steps 1 to 10 for the environment, from a build that carries package 5.6. Step 3 creates the principal vault (`infra/modules/principal-vault.bicep`) and the worker's Key Vault Secrets Officer role on it; step 8, the migration job, grants the worker identity `lance_retention`; step 9 ends with the check that the grant is there. Without the grant the `retention` step fails with a message naming step 9.
2. `slack-app-setup.md`: the bot holds `groups:write`, which archiving a private channel needs.
3. You hold `Lance.Admin` (`entra-setup.md` section 8). You cannot offboard yourself from the page; ask another admin.

Known values:

| Value | dev | Command that produces it |
|---|---|---|
| Resource group | `rg-lance-dev` | `az group list --query "[?starts_with(name, 'rg-lance-')].name" -o tsv` |
| Principal vault | `kv-lance-p-dev-<suffix>`, created by `principal-vault.bicep` | `az keyvault list -g rg-lance-dev --query "[?starts_with(name, 'kv-lance-p-')].name" -o tsv` |
| Worker app | `ca-lance-worker-dev` | `az containerapp list -g rg-lance-dev --query "[].name" -o tsv` |
| Group `Lance Users` | object id in `entra-setup.md`'s known values | `az ad group list --filter "displayName eq 'Lance Users'" --query "[0].id" -o tsv` |
| Group `Lance Admins` | object id in `entra-setup.md`'s known values | `az ad group list --filter "displayName eq 'Lance Admins'" --query "[0].id" -o tsv` |

## 1. Remove their Lance access in Entra

Take the person out of both groups, so Microsoft refuses their next sign-in to Lance. This is a change in Entra, made by Dom:

```
PERSON_UPN=<their UPN>
PERSON_OID=$(az ad user show --id "$PERSON_UPN" --query id -o tsv)
echo "$PERSON_OID"
az ad group member remove --group "Lance Users" --member-id "$PERSON_OID"
az ad group member check --group "Lance Admins" --member-id "$PERSON_OID" --query value -o tsv
```

If the last command prints `true`, remove them from `Lance Admins` the same way. Offboarding does not depend on this step, but without it the person could still sign in and would meet the app's refusal for an offboarded principal rather than Microsoft's.

## 2. Find the principal

Open the admin page (`https://<web hostname>/admin`, in the navigation as Admin). The Principals table lists every principal with their status. Note the UPN exactly as it appears; step 3 asks you to type it.

From psql instead (`scripts/psql-admin.sh lance`), since `principals` is readable without a scope:

```sql
SELECT id, upn, status FROM principals WHERE lower(upn) = lower('<their UPN>');
```

Capture the id for the checks in step 5: `PRINCIPAL=<id>`, then `echo "$PRINCIPAL"`.

## 3. Offboard from the admin page

At the foot of the admin page, under Offboard a principal, expand the row with their UPN. Type the UPN in full, give a reason (it goes into the ledger), and press Offboard. The button stays disabled until both are filled.

The page records an `offboarding_requested` event in the principal's ledger and puts the job on the worker's `offboard-principal` queue. A failure to queue is shown in red under the form; nothing has changed in that case.

## 4. Watch the worker carry it out

The worker logs one line when it finishes, with each step and its outcome:

```
az containerapp logs show -g rg-lance-dev -n ca-lance-worker-dev --type console --tail 200 \
  | grep -E 'principal offboarded|stopped at the'
```

Expected: `principal offboarded` with `steps` of `status:done`, `pause:done`, `secrets:done`, `slack_link:done` (or `already_done` if they never linked), `slack_channel:done` (or `skipped` if they had no private channel) and `retention:done`. A line containing `stopped at the <step> step` means that step failed; see step 6.

The principal's schedules go at once: only their `retention` schedule remains, because retention runs for every principal whatever their status. The reconciler's own check, every minute, would remove the rest within a minute anyway.

## 5. Check the result

Run the checks as the Entra administrator with `scripts/psql-admin.sh lance -f <file>`, with this in the file and the id from step 2 in the first line. The administrator is not a superuser on Flexible Server, so row-level security applies and the session is scoped to the principal first:

```sql
\set principal '<id>'
SELECT set_config('app.principal', :'principal', false) AS scoped_to;
SELECT upn, status FROM principals WHERE id = :'principal';
SELECT paused, paused_reason FROM principal_state WHERE principal_id = :'principal';
SELECT slack_user_id, revoked_at IS NOT NULL AS revoked FROM slack_links WHERE principal_id = :'principal';
SELECT payload ->> 'step' AS step, payload ->> 'outcome' AS outcome
  FROM ledger_events
 WHERE principal_id = :'principal'
   AND kind = 'state_changed' AND payload ->> 'change' = 'offboarding_step'
 ORDER BY id;
SELECT kind, actor, count(*) AS events, count(payload) AS payloads_held
  FROM ledger_events
 WHERE principal_id = :'principal'
   AND ((kind = 'observed' AND source_system IN ('graph', 'jamie'))
        OR (kind = 'resolved' AND actor LIKE 'agent:triage@%'))
 GROUP BY kind, actor ORDER BY kind, actor;
SELECT count(*) AS observations, count(payload) AS payloads_held FROM observations WHERE principal_id = :'principal';
SELECT payload ->> 'trigger' AS trigger, payload -> 'counts' AS counts
  FROM ledger_events
 WHERE principal_id = :'principal' AND kind = 'retention_applied'
 ORDER BY id DESC LIMIT 1;
```

Expected: status `offboarded`; `paused` true; every Slack link revoked; the six steps in order; and `payloads_held` zero for the mail watcher, the Jamie watcher and triage, with `events` unchanged, since no row was deleted. Two kinds of row keep their payloads, by design: the calendar watcher's (`agent:watcher-graph-calendar@...`), because calendar entries are not mail bodies and follow the two-year ledger window, and triage results built from a Notion task or an agent log rather than from mail or a transcript. The observations count follows the ledger rows, so calendar observations are the ones still held there.

The vault. The first command prints nothing; the second lists each deleted secret with the date it is purged:

```
PKV=$(az keyvault list -g rg-lance-dev --query "[?starts_with(name, 'kv-lance-p-')].name" -o tsv)
echo "$PKV"
az keyvault secret list --vault-name "$PKV" --query "[?contains(name, '$PRINCIPAL')].name" -o tsv
az keyvault secret list-deleted --vault-name "$PKV" \
  --query "[?contains(name, '$PRINCIPAL')].{name:name, purged:scheduledPurgeDate}" -o table
```

Slack. Open the principal's channel (`lance-<first name>`) in Slack: it reads as archived. `dom-claude-agent` is never touched.

## 6. If a step failed

Every step is idempotent. Fix the cause, then offboard again from the admin page: an offboarded principal stays in the list for exactly this, and the steps already done report `already_done`.

| Step | Failure | Fix |
|---|---|---|
| `secrets` | `ForbiddenByRbac` | The worker lacks Key Vault Secrets Officer on the principal vault. Redeploy (`deploy.md` step 3); never grant it by hand |
| `secrets` | `skipped`, no principal vault | The worker has no `PRINCIPAL_KEY_VAULT_URL`. Redeploy from a template that sets it |
| `slack_channel` | `missing_scope` | The bot lacks `groups:write` (`slack-app-setup.md`) |
| `slack_channel` | `skipped`, no bot token | The worker has no `SLACK_BOT_TOKEN`; set `slack-bot-token` (`deploy.md` step 4) |
| `retention` | `may not act as lance_retention` | The migration job has not granted the worker identity the role. Run `deploy.md` steps 8 and 9 |

## What offboarding keeps, and why

- **Ledger rows**, with content payloads nulled and hashes kept, for the two-year audit trail (ADR 0011). The other payloads (decisions, state changes, rule changes) are nulled at the ledger window like everyone's.
- **The ontology's recorded mutations**, which the graph is rebuilt from; the spec keeps ontology facts indefinitely. The principal's private graph evidence therefore stays in the graph, visible to nobody, since only their own scope reads it. Whether it should be removed is a decision for the DPO (`docs/compliance/retention.md`, open decisions).
- **Rows in `proposals`, `commitments`, `briefs` and `alerts`**, under row-level security, readable only in the principal's own scope. Same DPO decision.
- **Soft-deleted secrets** for the vault's 90-day retention period.
- **Messages in the archived Slack channel**, under Valliance's Slack retention settings.
- **Tasks in the Notion All Tasks database** assigned to them: the organisation's records, not Lance's.

For the principal whose UPN is `DOM_EMAIL`, the pre-ADR 0022 secrets `graph-refresh-token` and `jamie-api-key` in the static vault are not touched by offboarding; they are removed by the follow-up that retires the legacy copy (`deploy.md`, last section).

## Rehearse in dev with a synthetic principal

Once per environment, before the first real offboarding: add a test account to `Lance Users`, sign in to the web app once with it (which creates an `onboarding` principal), then run steps 2 to 5 for that account and step 1 last. Record the date and the principal id in `docs/adr/0000-phase-log.md`, Multi-user track, row "Offboarding is defined and exercised".

## Worked example: local rehearsal, 2026-09-24

Exercised against a throwaway container of the local image (`lance-postgres:16`), with the migration job's three commands run as the job runs them, a role standing in for the worker identity, and a synthetic principal. `apps/worker/src/offboarding/drill.ts` plants the principal and their data (a mail observation, a transcript, a triage result quoting the mail, an approved proposal, a Slack link and channel), then calls the worker's own `offboardPrincipal` as a login role holding what the worker identity holds. The vault is in memory and the Slack archiver records what it is asked, so nothing reached Azure or Slack; on a second run both answer as the real services would, secrets absent and channel already archived. The drill refuses any database that is not on this machine.

```
docker run -d --name lance-offboard-drill -p 55432:5432 \
  -e POSTGRES_DB=lance -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres lance-postgres:16
export DATABASE_URL=postgres://postgres:postgres@localhost:55432/lance

$ psql -c 'CREATE ROLE "id-lance-worker-local" LOGIN'
CREATE ROLE
$ cd packages/db && tsx src/migrate.ts && tsx src/seed.ts && LANCE_RETENTION_MEMBER=id-lance-worker-local tsx src/grants.ts
Migrations applied.
Seed applied.
Granted lance_retention to id-lance-worker-local for SET ROLE only.

$ cd apps/worker && tsx src/offboarding/drill.ts          # first run
{
  "principalId": "01K5S9V6QW3SWCCPVB0N0E3D01",
  "correlationId": "01M39S9RQTWKVV0TY2R119KJ69",
  "steps": [
    { "step": "status", "outcome": "done" },
    { "step": "pause", "outcome": "done" },
    { "step": "secrets", "outcome": "done" },
    { "step": "slack_link", "outcome": "done" },
    { "step": "slack_channel", "outcome": "done" },
    { "step": "retention", "outcome": "done" }
  ],
  "vaultDeletes": [
    "graph-refresh-token--01K5S9V6QW3SWCCPVB0N0E3D01",
    "jamie-api-key--01K5S9V6QW3SWCCPVB0N0E3D01",
    "foundry-refresh-token--01K5S9V6QW3SWCCPVB0N0E3D01"
  ],
  "slackArchived": ["G0DRILLSYNTH"]
}

$ tsx src/offboarding/drill.ts                            # second run
status already_done, pause already_done, secrets already_done,
slack_link already_done, slack_channel already_done, retention already_done

$ psql -f offboard-check.sql                              # the step 5 queries
 scoped_to: 01K5S9V6QW3SWCCPVB0N0E3D01

                upn                 |   status
------------------------------------+------------
 synthetic.offboarding@valliance.ai | offboarded

 paused |         paused_reason
--------+-------------------------------
 t      | Offboarded: offboarding drill

 slack_user_id | revoked
---------------+---------
 U0DRILL       | t

     step      |   outcome
---------------+--------------
 status        | done
 pause         | done
 secrets       | done
 slack_link    | done
 slack_channel | done
 retention     | done
 status        | already_done
 pause         | already_done
 secrets       | already_done
 slack_link    | already_done
 slack_channel | already_done
 retention     | already_done

   kind   |             actor              | events | payloads_held
----------+--------------------------------+--------+---------------
 observed | agent:watcher-graph-mail@0.1.0 |      1 |             0
 observed | agent:watcher-jamie@0.1.0      |      1 |             0
 resolved | agent:triage@1.0.0             |      1 |             0

 observations | payloads_held
--------------+---------------
            2 |             0

   trigger   | counts (latest run)
-------------+-------------------------------------------------------------
 offboarding | all zero: the first run had already nulled everything
```

The first run's `retention_applied` counts were `mailBodies 1, transcripts 1, derivedFromMail 1, observations 2`. The membership check from `deploy.md` step 9 returned `id-lance-worker-local | f | t`, and no row for `lance_app`. Remove the container with `docker rm -f lance-offboard-drill`.
