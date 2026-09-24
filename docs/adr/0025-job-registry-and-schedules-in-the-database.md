# 0025. Jobs are a registry, and schedules live in the database

Date: 2026-09-24
Status: Accepted

## Context

Schedules are hard-coded `boss.schedule` calls in `apps/worker/src/main.ts`, `briefs/run.ts`, `briefs/weekly.ts`, `alerts/engine/run.ts` and `watchers/runner.ts`. The multi-user plan needs one schedule per principal, watcher and partition (M5); the jobs plan needs a registry a principal can see and manage (J1, `docs/plans/jobs.md`). The roadmap builds the two together (package 5.3, ADR 0031), because both rewrite the scheduler.

## Decision

Code declares every system job with its default schedule, its bounds, whether it is locked, and whether it runs per principal or once for the organisation. A `jobs` table (under row-level security) holds each principal's enabled flag, schedule override and state for each declared job. A reconciler, run at worker start and on every change, turns the declarations and the table into pg-boss schedules keyed `<job>:<principalId>` for per-principal jobs and `<job>` for organisation jobs, and removes schedules for principals who are not active. Every job payload carries `principalId`; the worker's job wrapper checks it against `principals` and runs the handler with a handle scoped to it. Every change to a job is a `state_changed` ledger event with the old and new values. A test fails if code schedules a job the registry does not declare.

## Consequences

Adding a principal adds their schedules without a deploy. A job's schedule can be changed within its declared bounds from the Jobs page and Slack. The single-principal start-up resolution from Phase 4 (ADR 0015) is replaced by per-job and per-request resolution.
