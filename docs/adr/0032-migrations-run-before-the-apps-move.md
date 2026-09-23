# 0032. Migrations run before the apps move

Date: 2026-09-23
Status: Accepted

## Context

ADR 0014 deploys the apps and then runs the migration job, and says a migration that must precede its code needs a two-step deploy and that ADR revisited. Migration 0009 (ADR 0015) is that case. The Phase 4 api and worker resolve their principal from the `principals` table at start-up, so on the old order they would start against a schema without it. The independent Phase 4 review found this on 2026-09-23.

## Decision

`scripts/run-migration-job.sh` takes the image tag being deployed, points the migration job at `lance-worker:<tag>` and runs it, and `deploy.yml` calls it before `scripts/deploy.sh`. The deployment that follows sets the job to the same image from the template. Every migration must therefore keep the image already running working until the apps are replaced, which forward-only, additive migrations do. The apps also wait at start-up for their principal, retrying for up to ten minutes (`LANCE_STARTUP_WAIT_SECONDS`), so a start that races the job waits for it rather than failing.

## Consequences

New code never starts against an old schema. Old code runs against a new schema for the minute the apps take to move, so a migration that changes what old code can read or write needs a pause around it; the deploy that carries 0009 is the first, and `docs/runbooks/deploy.md` says what to do. The job's image is set outside the template for the length of one step, and the template sets it to the same value straight after, so nothing drifts.
