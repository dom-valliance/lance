# Load test: thirty principals on one worker

Package 5.8 (docs/plans/roadmap.md) and the acceptance row in docs/plans/multi-user.md section 8: "Fan-out holds at 30 principals: every synthetic principal's morning brief is stored by 06:35 and posted within the push budget; queue latency p95 under 60 seconds". This runbook says how to run the test, what it measured on 24 September 2026, what was changed because of it, and what is left as a design question.

Nothing here touches Azure, Entra, Anthropic or Slack. Everything runs on one machine against a throwaway container.

## What the harness does

`apps/worker/src/load/run.ts`, run with `tsx`. It is not a test file and `pnpm test` never runs it.

1. Starts `lance-postgres:16` (PostgreSQL 16 with AGE and pgvector) with `pg_stat_statements` loaded, runs the migrations and the seed, and logs the worker in as a `lance_app` member with the retention grant and pg's default pool of ten, as in Azure.
2. Creates 29 synthetic active principals beside the seeded one, each with a `principal_state` row, a private Slack channel id and a Notion user id. It sets the organisation ceiling to GBP 15 times the principals, as multi-user M5 says the admin does.
3. Boots the real worker through `bootWorker`: the registry, the reconciler (694 schedules for thirty principals), a context per principal, every handler, the fair-share limiter and the organisation budget. pg-boss is built exactly as `createBoss` builds it, with one difference: pg-boss's own cron is off, because the harness decides when schedules fall due (step 5).
4. Gives each principal fixture connectors, built from the recordings in `packages/connectors/__fixtures__` and varied per principal:
   - Graph, at the HTTP boundary, through the real connector (rate limit, retry, breaker, schema parsing): an inbox and Sent Items by delta, ten messages a page, and a calendar by delta.
   - Jamie, in memory: three meetings with transcripts and action items.
   - Notion, at the HTTP boundary: one shared All Tasks database of five tasks per principal, honouring the last-edited filter, the open-tasks filter and paging. Every principal's watcher reads it whole, as in production (ADR 0022), and the briefs filter it.
   - Slack: the real surface over a fake Web API that records every post with the time it landed.
   - The agent-logs watcher has no fixture (it reads channel history and App Insights), so it records a skipped run for everyone.
5. Warm-up, the Friday: every principal's watchers poll once (15 read inbox messages, 3 sent, the week's 6 meetings, the Notion database) with an instant model and the limiter bypassed, and the queues drain. Cursors and ledger history now exist, as on a real Monday.
6. The window, the Monday. The fixtures flip to the weekend's arrivals: 40 new unread inbox messages and 5 sent, one meeting moved and one added, the 3 Jamie meetings, one Notion edit per principal. The model runner switches to its measured latency. A virtual clock, real time shifted so the run opens at Monday 06:29 London, runs the reconciler's own schedule rows from pg-boss and sends each job when it falls due. At 06:30 it also sends each principal's mail poll, which the schedule puts at 06:00 and 07:00, so the mail backlog, its triage and the brief all land in the same window (the calendar and Jamie are already due at 06:30 every fifteen minutes). The window closes when every brief is posted and the queues are empty for thirty seconds, or after 60 minutes.
7. The model runner (`apps/worker/src/load/fakeModel.ts`) answers every agent with output its own schema accepts first time, sleeps 3 to 8 seconds per model call drawn from a seeded source, plays a tool loop as one call per turn (triage two turns, the planner three) inside one limiter slot, and reports token counts of the size a real call of that agent has, so budgets and the cost ledger see real-sized spend. About 15 per cent of triage runs return one task candidate, which becomes a proposal card.

Measured, and written to `<LOAD_OUT>/<LOAD_LABEL>.json` with the worker's own log beside it:

- When each principal's `briefs` row was stored and when its Slack parent post and last thread reply landed, against 06:30.
- Push budget: each principal's `slack_push` ledger events and every top-level post in their channel that is not a brief, board, prep or debrief (spec 9.4 exempts those), against `principal_state.push_budget_per_hour`.
- Queue latency per queue, from when a job could first start (`start_after`) to when a worker took it, p50, p95 and p99. A job still waiting at the end counts at the time it had waited, so a backlog cannot flatter the numbers by never starting.
- Model calls by agent and by principal, and each principal's wait at the fair-share limiter.
- Postgres: active and total sessions each second, the worker pool's size and waiting clients, and `pg_stat_statements` reset at the window's start.
- The worker process: CPU, event-loop delay, peak RSS.
- Every failed or retried job, and every `job failed` log line.

## How to run it

1. Node 22 (`nvm use 22`), Docker running, and the Postgres image built: `docker compose build` from the repository root.
2. From the root: `pnpm install`, then `pnpm --filter @lance/worker load`. The warm-up takes about 19 minutes, the window up to 60, so a run at the defaults takes about 80 minutes. The terminal shows progress once a minute; nothing else prints.
3. Read the summary at the end, then the JSON for the detail. Copy the numbers into this runbook when they are a new baseline.

Settings, all environment variables with these defaults:

| Variable | Default | Meaning |
|---|---|---|
| `LOAD_PRINCIPALS` | 30 | Principals, the seeded one included |
| `LOAD_UNREAD` | 40 | New unread inbox messages per principal in the window |
| `LOAD_MEETINGS` | 6 | Meetings on each calendar today |
| `LOAD_JAMIE_MEETINGS` | 3 | Jamie meetings per principal |
| `LOAD_NOTION_TASKS` | 5 | Tasks per principal in the shared database |
| `LOAD_MODEL_MIN_MS`, `LOAD_MODEL_MAX_MS` | 3000, 8000 | Latency of one model call |
| `LOAD_TASK_RATE` | 0.15 | Share of triage runs that propose a task |
| `LOAD_ALIGN_WATCHERS` | 1 | 0 leaves the mail poll on its own schedule |
| `LOAD_MAX_MINUTES` | 60 | Longest window |
| `LOAD_SEED` | 20260924 | Seed for every random draw; same seed, same run |
| `LOAD_OUT`, `LOAD_LABEL` | `$TMPDIR/lance-load`, `run` | Where the report and the worker log go |

The worker's own settings (`MODEL_CONCURRENCY`, `MODEL_PRINCIPAL_BURST`, `MODEL_PRINCIPAL_RUNS_PER_MINUTE`, prices, ceilings) are read by `loadConfig` from the same environment, so a run at the defaults sets none of them. A smoke run for a changed harness: `LOAD_PRINCIPALS=3 LOAD_MODEL_MIN_MS=200 LOAD_MODEL_MAX_MS=500 LOAD_MAX_MINUTES=8`, about ten minutes.

## Where it ran

Apple M4 Pro, 14 cores, 24 GB, macOS 26.5; Docker 29.0.1 with 14 CPUs and 8 GB for the Postgres container; Node 22.23.2. The fixtures answer Graph in 80 to 250 ms, Notion and Jamie in 150 to 400 ms and Slack in 80 to 200 ms per request. A laptop Postgres with a six-hour-old ledger is kinder than Flexible Server with months of history, so read the Postgres numbers as a floor.

## Results

Three runs at the configured defaults: `MODEL_CONCURRENCY` 4, a burst of 6 and 12 runs a minute per principal. Before the change every queue ran on pg-boss's defaults: one worker, one job a fetch, a fetch every two seconds.

- **Before**: the worker as merged at `08005fc`.
- **After**: the same harness and scenario with the two changes below.
- **Final**: after the changes, with the harness no longer sending a second calendar and Jamie poll at 06:30 beside the scheduled ones. The verdicts rest on it where it has numbers, and on the after run for Slack delivery.

The final run was stopped after 33 minutes of its window, before the harness wrote its report, so its numbers below come from the same queries run by hand against its database (`pgboss.job`, `briefs`, `ledger_events`, `agent_runs`); its Slack post times, limiter waits and process figures were not captured. Before and after ran the full 60 minutes.

### Against the targets

| Target | Before | After | Final | Verdict |
|---|---|---|---|---|
| Every brief stored by 06:35 | 12 of 30; last 06:41:55; p50 06:35:54 | 30 of 30; last 06:32:11; p50 06:31:09 | 30 of 30; last 06:32:10; p50 06:31:08 | **Pass** after the change |
| Every brief posted | 30 posted, last 06:41:55 | 30, last 06:32:11 | 30 | **Pass** |
| Posted within the push budget (3 an hour) | 1 unsolicited post per principal (a proposal card); the other three top-level posts were debriefs, which spec 9.4 exempts | 1 per principal | 1 per principal (30 cards in all) | **Pass**: most used 1 of 3 |
| Queue latency p95 under 60 s, all jobs | 2,278 s | 2,143 s | 1,397 s (after 33 minutes) | **Fail**, see below |
| Same, queues that do not wait on the model | 676 s (brief-morning); 61.5 s alert delivery | 104.7 s brief-morning, 73.8 s Jamie; every other under 28 s | 103.6 s brief-morning; every other under 41 s | **Fail** only for brief-morning, whose jobs queue behind eight briefs waiting on the planner; see below |
| Failed or retried jobs | none | none | none | **Pass** |

### Queue latency by queue, seconds

| Queue | Jobs (before) | Before p50 / p95 / p99 | After p50 / p95 / p99 | Final p50 / p95 / p99 | Job run p50 (after) |
|---|---|---|---|---|---|
| `watcher-graph-mail` | 120, 107 unfinished | 1,140 / 3,540 / 3,540 | 1,140 / 3,540 / 3,540 | 130 / 1,930 / 1,930 | 258 |
| `triage` | 595, 419 unfinished | 1,624 / 3,075 / 3,242 | 1,615 / 3,146 / 3,229 | 1,033 / 1,902 / 1,909 | 23 |
| `brief-morning` | 30 | 337 / 676 / 699 | 41 / 105 / 106 | 41 / 104 / 105 | 34 |
| `watcher-jamie` | 150 | 38 / 104 / 116 | 26 / 74 / 82 | 21 / 41 / 43 | 1.4 |
| `watcher-graph-calendar` | 150 | 38 / 104 / 117 | 9 / 28 / 31 | 8 / 15 / 16 | 0.2 |
| `watcher-notion` | 120 | 30 / 57 / 60 | 14 / 26 / 27 | 14 / 26 / 28 | 0.9 |
| `alerts-deliver` | 1,770 | 35 / 62 / 65 | 8 / 14 / 15 | 8 / 15 / 15 | 0.0 |
| each detector, `expire-proposals`, `brief-meeting-prep` | 30 to 180 each | about 30 / 57 / 60 | about 8 / 15 / 15 | about 8 / 16 / 16 | 0.0 |
| `jobs-reconcile`, `onboarding-prefill` | 59 each | 1 / 2 / 2 | 1 / 2 / 2 | 1 / 2 / 2 | 0.1 |

Before and after, the aligned 06:30 send added a second calendar and Jamie poll per principal beside the scheduled one; the final run sends only the mail poll, which is why Jamie and the calendar are faster there.

### The model limiter

| | Before | After |
|---|---|---|
| Model runs in the 60 minutes | 1,104: 627 mail labels, 177 triage, 30 planner, 90 each of commitments, debrief draft and critic | 1,069: 602, 167, 30, 90, 90, 90 |
| Median principal's mean wait for a slot | 0.0 s | 0.4 s |
| Worst-served principal's mean wait | 0.7 s (principal 1, p95 5.2 s) | 4.0 s (principal 1, p95 6.3 s) |
| Slots in use, on average | about 2 of 4 | about 2 of 4 |

Fair share held: no principal waited more than a few seconds on average for a slot; the worst-served principal, the same one in both runs, waited 4.0 s against a median of 0.4 s. The limiter was never the constraint; half its slots sat idle because the queues feeding it run one job at a time.

### Postgres and the worker process

| | Before | After |
|---|---|---|
| Active sessions, peak | 9 | 9 |
| Sessions, peak | 12 | 12 |
| Worker pool (max 10) in use, peak | 10 | 10 |
| Clients waiting for a pool connection, peak / mean | 17 / 0.13 | 26 / 1.13 |
| Worker CPU | not captured | 12 per cent of one core |
| Event-loop delay p99 / max | not captured | 108 ms / 160 ms |
| Peak RSS | not captured | 204 MB |

The heaviest statements by total time, after the change: pg-boss's fetch (196,869 calls, 0.02 ms each, 3.2 s in the hour), the harness's own once-a-second progress queries (about 2 s each; ignore them), the daily-spend sum on `agent_runs` that every model run reads (4,459 calls, 0.41 ms), the per-checkout scope `set_config` (258,502 calls, 0.01 ms), and ledger inserts (7,943 calls, 0.10 ms). The slowest by mean were pg-boss's `getSchedules` for the reconciler (3.3 ms, once a minute) and its maintenance lock (1.5 ms). The worker's statements took about ten seconds of Postgres time in the hour. Nothing needs an index.

The pool is the one Postgres resource under pressure: polling every half second put a client in the queue for a connection on average (mean 1.13, peak 26), with no visible cost to latency here. If the pool shows up in production latency, raise the worker's pool (`createDb({ max })`) before anything else.

### Spend

In the final run the 565 model runs of its first 33 minutes, the thirty planner runs among them, recorded USD 7.39. From the per-run costs it recorded (planner USD 0.146, triage USD 0.020, mail label USD 0.0007, commitments, debrief draft and critic about USD 0.02 together per meeting), one principal's Monday morning in this scenario costs about USD 0.64, and thirty principals' about USD 19, or GBP 14.90. That is the single-user organisation ceiling, GBP 15, which `system_state` still carries by default. The harness sets GBP 450 as multi-user M5 says the admin does; if nobody does, every principal's agents stop part way through the first busy morning. Setting the ceiling belongs in the pilot's set-up steps.

## What changed and why

Two changes, measured together in the after run against the before run on the same seed and scenario. They act on different queues, so each queue's numbers show one change alone.

1. **Morning briefs run eight at once** (`MORNING_BRIEF_CONCURRENCY` in `apps/worker/src/jobs/registry.ts`, applied as pg-boss `localConcurrency` through `principalQueueOptions` in `handlers.ts`). One at a time, each brief took about 24 s, most of it waiting for its planner call, so thirty took twelve minutes: 12 of 30 stored by 06:35, the last at 06:41:55. Eight at once: all 30 by 06:32:11. The limiter still caps model calls in flight at `MODEL_CONCURRENCY`; eight only lets briefs queue for it rather than behind each other. Each principal has one brief a day, so two briefs for one principal never run together.
2. **Per-principal queues fetch every half second** (`PRINCIPAL_QUEUE_POLL_SECONDS` in `handlers.ts`). pg-boss waits two seconds between fetches, less the time the last job took, so a queue of quick jobs runs at most one every two seconds. Thirty principals' alert deliveries, due every minute, took the whole minute: p95 61.5 s, and a thirty-first principal would have fallen further behind every minute. At half a second: p95 14.4 s, and the same holds for every detector, expiry and meeting prep. Half a second is pg-boss's floor. The cost is more fetches (197,000 in the hour against 48,000), each 0.02 ms, and more clients waiting for the pool.

Neither touches `packages/policy`, the ledger or the kill switch. Both keep one job at a time for every queue but briefs, so no principal's watcher, delivery or detector ever overlaps itself.

## What is left: model-bound queues

Mail and triage still fail the 60-second target by a wide margin, and the fix is a design choice rather than a setting.

The cause, from the numbers. In this scenario each principal's morning is 45 mail labels, about 20 triage runs of two model calls each, three Jamie meetings with commitments, a debrief draft and a critic each, and one planner run of three calls. At the measured 5.5 s a call that is about 520 slot-seconds a principal, 15,700 for thirty. At four calls in flight the morning cannot clear in under 65 minutes, whatever the queues do. Today it clears in about two hours, because `watcher-graph-mail` runs one principal at a time (each poll labels 45 messages in sequence, about four and a half minutes) and `triage` runs one job at a time, so only about two of the four slots are ever busy.

Options, with their cost:

| Option | Effect on this morning | Cost |
|---|---|---|
| A. Run `watcher-graph-mail` and `triage` several at once, with at most one job per principal at a time (pg-boss group concurrency keyed on the principal, set where the reconciler schedules and where the runner enqueues triage) | Uses all four slots: the backlog clears in about 65 minutes instead of two hours. Queue latency still fails, because the jobs then wait at the limiter instead of in the queue | A change to the reconciler and the runner's send, and a test that a principal's watcher never overlaps itself; without the group limit two polls of one mailbox would label the same messages twice |
| B. A plus a higher `MODEL_CONCURRENCY` | 8 in flight: about 33 minutes; 16: about 16 minutes; 32: about 8 minutes. The same spend, sooner | The Anthropic organisation's rate limits have to allow it; check the input-token-per-minute limits for Sonnet and Opus at the chosen concurrency |
| C. Do less model work: label mail in batches of ten in one Haiku call, and skip triage for mail labelled Newsletters, Notifications or Alerts | Labels fall from 45 calls to 5 a principal, about 40 per cent of the morning; skipping bulk mail cuts triage further | A deviation from spec 7.1's one label call per message, so an ADR first, and a label eval to show batching does not lose accuracy |
| D. Keep the capacity and change what the target measures: queue latency p95 under 60 s for queues whose jobs do not wait on the model, and a separate target for the model backlog (for example, cleared by 08:00) | None; says what the system can do | An amendment to multi-user section 8 |

Recommendation: D now, so the acceptance row tests what the worker controls; A before the pilot opens to more people, because it doubles throughput at no extra spend; B and C when real traffic says the backlog matters. This scenario is also harsher than a real Monday: the mail watcher polls hourly overnight and at weekends, so forty messages arriving in one 06:30 poll is a first poll after onboarding or an outage, not an ordinary morning.

`brief-morning` itself still misses the queue target, at p95 104 s: thirty briefs share eight workers, each held for about 34 s while its planner call waits at the limiter, so the last few start about a minute and a half after 06:30. They are still stored by 06:32:10. The next change would be `MORNING_BRIEF_CONCURRENCY` at 30, or at the number of active principals, so every brief is taken at once and waits only at the limiter; that was not measured, because the test time ran out.

The morning brief is safe whichever is chosen: it has its own queue, runs eight at once, and waits at the limiter behind at most one label and one triage run of the same principal.

## Worker replicas

One replica is enough for thirty principals. The worker process, harness included, used 12 per cent of one core, 204 MB and at most ten Postgres connections, with an event-loop delay p99 of 108 ms; Postgres spent about ten seconds on the worker's statements in the hour. The constraint is model capacity and queue concurrency, which a second replica does not fix in the right way: each replica runs its own fair-share limiter, so two replicas would put up to eight model calls in flight for the one Anthropic organisation and split fair share per replica, and every queue would run two jobs at once without the per-principal guard option A needs.

Keep `maxReplicas: 1` in `infra/modules/containerapps.bicep`. Raise throughput inside the one process (options A and B above). Revisit replicas when the worker's CPU passes about 60 per cent of its allocation at the morning peak, and then only after the limiter is shared across processes (a Postgres-backed semaphore), with a scale rule on the pg-boss backlog (the KEDA `postgresql` scaler on the count of `created` jobs) and `maxReplicas: 2`. The refresh-token advisory lock from package 5.2 already makes a second replica safe for Graph token rotation.

## After ADR 0034

One run on 24 September 2026, same machine, seed and scenario as above, at `1fd06c1`: bulk mail filed without model triage (ADR 0034) and load-test option A, with `watcher-graph-mail` and `triage` each running `MODEL_QUEUE_CONCURRENCY` (default 4) jobs at once and never two of one principal's (pg-boss `localGroupConcurrency: 1`, the principal as each job's group). The limiter is unchanged: `MODEL_CONCURRENCY` 4, a burst of 6, 12 runs a minute per principal. The window ran its full 60 minutes. The warm-up, with an instant model, drained in 149 s against about 19 minutes before.

### Against the targets

| Target | Before | Final | After ADR 0034 | Verdict |
|---|---|---|---|---|
| Every brief stored by 06:35 | 12 of 30; last 06:41:55 | 30 of 30; last 06:32:10 | 30 of 30; last 06:32:18; p50 06:31:06 | **Pass** |
| Every brief posted | 30, last 06:41:55 | 30 | 30, last 06:32:18 | **Pass** |
| Posted within the push budget (3 an hour) | 1 unsolicited post per principal | 1 per principal | 0 per principal | **Pass**. The one card per principal of earlier runs did not appear; the cause was not established in this run |
| Queue latency p95 under 60 s, all jobs | 2,278 s | 1,397 s (33 minutes) | 1,007 s | **Fail** |
| Same, queues that do not wait on the model | 676 s brief-morning | 104 s brief-morning; every other under 41 s | 96 s brief-morning; every other under 40 s; `bulk-mail` 1.6 s | **Fail** only for brief-morning, as before |
| Failed or retried jobs | none | none | none | **Pass** |

### The model-bound queues, seconds

| Queue | Jobs | Unfinished at the end | Latency p50 / p95 / p99 | Job run p50 | Before: unfinished, p95 |
|---|---|---|---|---|---|
| `watcher-graph-mail` | 120 | 100 | 1,140 / 3,379 / 3,540 | 701 | 107, 3,540 |
| `triage` | 687 | 53 | 705 / 1,217 / 1,375 | 17 | 419, 3,075 |
| `bulk-mail` | 103 | 0 | 0.6 / 1.6 / 1.8 | 0.0 | new |

### The model limiter

| | After (before this change) | After ADR 0034 |
|---|---|---|
| Model runs in the 60 minutes | 1,069: 602 mail labels, 167 triage, 30 planner, 90 each of commitments, debrief draft and critic | 1,878: 942 mail labels, 636 triage, 30 planner, 90 each of commitments, debrief draft and critic |
| Model calls, counting triage's two turns and the planner's three | about 1,400 | about 2,570 |
| Slots in use, on average | about 2 of 4 | about 3.9 of 4 (2,570 calls at the 5.5 s mean is 14,100 slot-seconds in 3,600 s) |
| Median principal's mean wait for a slot | 0.4 s | 7.3 s |
| Worst-served principal's mean wait | 4.0 s | 10.2 s (principal 4, p95 19.0 s) |

Postgres: active sessions peak 8, sessions peak 12, the worker pool at its ten, clients waiting for a connection peak 36 and mean 1.79 (26 and 1.13 before). The worker used 12 per cent of one core, an event-loop delay p99 of 111 ms and 209 MB at peak. Nothing needs an index; the heaviest statement is still pg-boss's fetch at 0.01 ms a call.

### What it shows

Option A did what the table above predicted: the limiter's four slots are now busy almost all the hour, and the same hour carried 1.8 times the model runs, 636 triage runs against 167. Queue latency still fails, because the jobs now wait at the limiter instead of in the queue: 2,570 calls at 5.5 s is the whole hour of four slots, so the morning still cannot clear in it.

The bypass filed 103 threads in the window with no model call, each in under two seconds. The harness's labeller draws one of the eight labels at random for each message, so only about a quarter of its mail is bulk; the share of a real Monday's mail that is Newsletters or Notifications decides how much triage the bypass saves in production.

The mail watcher is now the worst queue. Each poll labels 45 messages one after another, and each label waits about 7 s for a slot, so a poll runs for about 12 minutes (701 s, against 258 s before). With four mail jobs in flight only four principals have their mail labelled at once: 20 of the 120 polls finished, and ten principals' mail was not labelled within the hour.

### What to change next

Not measured; each needs its own run.

1. Raise the mail watcher's team size to the number of active principals (30 here), leaving triage at 4. A mail job waiting at the limiter holds no connection and no slot, and the fair-share limiter already hands slots to principals in turn, so every principal's labelling would progress together instead of four at a time. Split `MODEL_QUEUE_CONCURRENCY` into one setting per queue to do it.
2. Option C's batched labelling: labels were half the runs and about 37 per cent of the slot time. Ten messages a Haiku call would take about a third of the morning's model time away. It needs its own ADR (spec 7.1 allows one label call per message) and a label eval.
3. Option B: `MODEL_CONCURRENCY` above 4, if the Anthropic organisation's rate limits allow it. At 8 the same work takes about 30 minutes.
4. Option D still stands: queue latency p95 under 60 s is met by every queue that does not wait on the model except brief-morning (96 s), so the acceptance row should measure those queues and give the model backlog a target of its own.

One thing this run cannot show: every principal here is in dry run, so the bulk proposals were held and nothing reached the `execute` queue. In live mode each bulk message adds two approved proposals to `execute`, which runs one job at a time at pg-boss's default fetch interval. Its order matters (the category before the move, because the move gives the message a new id), so speed it up with a faster poll rather than more concurrency.

## After raising model concurrency to 16

One run on 25 September 2026, same machine, seed and scenario, at `06478d4`: `MODEL_CONCURRENCY` 16 and `MODEL_QUEUE_CONCURRENCY` 16, chosen after reading the account's limits (10,000 requests and 10 million input tokens a minute for Haiku and Sonnet; the thirty-principal morning used about 31 requests a minute at 4). Run by the lead, once, capped at the harness's 60-minute window; it finished in 23.5 minutes.

| Target | At 4 (after ADR 0034) | At 16 | Verdict |
|---|---|---|---|
| Briefs stored by 06:35 | 30, last 06:32:18 | 30, p50 62 s and max 124 s after 06:30 | Pass |
| Briefs posted within the push budget | 30, 0 pushes used | 30, at most 1 push per principal | Pass |
| Queue latency p95, all jobs | 1,007 s | 305 s (p50 12 s, p99 395 s) | Fail |
| The Monday backlog cleared | not within the hour; 53 triage jobs left | every queue empty at 06:52, 22 minutes after 06:30 | |
| Failures | none | none | |

- By queue: `watcher-graph-mail` p95 547 s (30 polls, each running about 500 s because it labels its 45 messages one after another); `triage` p95 351 s over 957 jobs, none left; `brief-morning` p95 97 s; every queue that does not wait on the model p95 under 41 s.
- Model: 2,607 calls (1,350 of them mail labels, 957 triage); median wait for a slot 5.3 s, the worst principal 7.2 s, so the fair share held.
- Postgres: active sessions peak 9, connections 12; clients waiting for a pool connection peak 53, mean 4.47 (36 and 1.79 at 4). The pool of 10 is now the next thing a larger worker will queue on.
- Worker: 14 per cent of one core, 400 MB, event-loop delay p99 101 ms.

What is left, not measured: the latency target still fails because a Monday is a burst of about a thousand model jobs, and any finite concurrency makes the last of them wait. The mail watcher is the longest wait, and half the calls are Haiku labels made one per message. Batching the label calls (several messages to one call) is the next change; it alters how labelling works, so it needs its own ADR and a label eval first. Raising the pool size with it. Neither blocks the two-principal pilot, where the same morning is a fifteenth of this load.
