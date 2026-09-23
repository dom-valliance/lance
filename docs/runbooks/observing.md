# Observing Lance

What to look at when something did not arrive, in the order that finds the cause fastest. Every command assumes `az login` as the Postgres Entra administrator and the dev resource group `rg-lance-dev`.

## 1. The Alerts page and `/lance status`

Alerts are the first place a failure shows: a connector breaker opening, a watcher stopping on a partition, the spend ceiling, a stale watermark. `/lance status` in Slack answers with the mode, the pause state, every watcher's age and today's spend.

## 2. Job outcomes in pg-boss

Every scheduled thing Lance does is a pg-boss job: watcher polls, triage, the executor, alert delivery, each detector, the briefs. A job that throws is retried twice and then marked `failed`, with the error on the row. This is where a brief that never arrived explains itself.

```
scripts/psql-admin.sh lance -X -P pager=off \
  -c "select name, state, count(*), max(completed_on) from pgboss.job where created_on > now() - interval '24 hours' group by name, state order by name, state;" \
  -c "select name, left(output::text, 400), completed_on from pgboss.job where state = 'failed' order by completed_on desc limit 10;"
```

The helper opens the server firewall to the current address for the session and closes it on exit.

## 3. The worker console log

The worker prints its start-up block and, since the observing fix, one `job failed` line per failed job with the queue, the job ids and the error. Nothing else is logged at info, so an empty tail means nothing has failed since the tail began.

```
az containerapp logs show -g rg-lance-dev -n ca-lance-worker-dev --type console --tail 200
az containerapp logs show -g rg-lance-dev -n ca-lance-api-dev --type console --tail 100
```

## 4. Model runs and spend

`agent_runs` has one row per model call with its status, tokens, cost and error. The Agents page shows the same by agent. To see who spent the day's budget:

```
scripts/psql-admin.sh lance -X -P pager=off \
  -c "select agent, status, count(*), round(sum(estimated_cost_usd)::numeric, 2) as usd from agent_runs where started_at >= date_trunc('day', now() at time zone 'Europe/London') at time zone 'Europe/London' group by agent, status order by usd desc;"
```

The ceiling itself is set on the Settings page and read on every model call. The first poll of a mailbox triages every message in the window, which is the one day the ceiling is likely to be reached by design.

## 5. The ledger

Every read, proposal, decision, alert and state change is a ledger event; the Ledger page filters by kind, actor and correlation id. A brief's correlation id links the planner run, its proposals and the Slack posts.

## 6. Resynchronising a watcher

A watcher's cursor is one row in `cursors`, keyed by watcher and partition. Deleting the row makes the next scheduled poll read the whole window again. Ingestion is idempotent (non-negotiable 6): a record whose content is unchanged produces no new observation, a record whose content changed produces one, so a resync is safe to run at any time and costs one full delta pass.

```
scripts/psql-admin.sh lance -X -P pager=off \
  -c "select watcher, key, updated_at from cursors order by watcher, key;" \
  -c "delete from cursors where watcher = 'graph-calendar' and key = 'calendar';"
```

The calendar poll runs every fifteen minutes. Once it has run, regenerate the brief from the Today page or with `/lance brief` so the new observations reach it.

## What each symptom usually means

| Symptom | Look at | Usual cause |
|---|---|---|
| Nothing arrives in Slack for an hour | `breaker_open` alert for `slack`; failed `alerts-deliver` jobs | One post Slack rejected opened the breaker, and every post behind it waited |
| `/lance brief` posted nothing | failed `brief-morning` job | The Slack breaker was open, or the brief failed to assemble; the brief is stored either way and shown on Today |
| Spend ceiling reached | `agent_runs` by agent | A first-day backfill, or a labeller failing on every message |
| A detector's alert count climbs by three at a time | failed `detector-*` jobs | The job failed after writing the alert and was retried |
| A meeting shows as "(no subject)" with no attendees | the `graph-calendar` observation for the event id | The calendar delta abbreviated an occurrence of a recurring series to id, start and end and the watcher stored it before it read occurrences in full. Resynchronise the watcher (section 6) and regenerate the brief |
