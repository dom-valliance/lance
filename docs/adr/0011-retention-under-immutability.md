# 0011. Retention nulls ledger payloads without lifting immutability

Date: 2026-09-20
Status: Accepted

## Context

Non-negotiable 1 says the ledger accepts INSERT and SELECT only and a trigger rejects UPDATE and DELETE. Spec section 4.4 says the nightly retention job nulls the raw payload column on aged ledger rows and keeps the hash. Both cannot be true for one role and one trigger.

## Decision

The application role `lance_app` keeps SELECT and INSERT only. A separate group role `lance_retention` has UPDATE on `ledger_events(payload)` and nothing else on that table. The `ledger_immutable` trigger rejects every DELETE and TRUNCATE, and rejects every UPDATE unless all three hold: the current role is a member of `lance_retention`, the new `payload` is NULL, and every other column is unchanged. The retention job connects with an identity that is a member of `lance_retention` and of no other application role. The job writes a `retention_applied` ledger event (as INSERT) with counts.

## Consequences

The immutability test suite gains three cases: `lance_app` cannot UPDATE payload to NULL; `lance_retention` cannot change any column other than payload, cannot set payload to a non-NULL value, and cannot DELETE; `lance_retention` can null payload on an aged row. `payload_hash` survives retention so provenance links still verify. The evidence export includes retention runs because they are ledger events.

## Amendment, 2026-09-24 (package 5.6)

The retention job runs in the worker, not under an identity of its own. The worker's database identity is granted `lance_retention` `WITH INHERIT FALSE, SET TRUE` by the migration job (`packages/db/src/grants.ts`, from `LANCE_RETENTION_MEMBER`, which the template sets to the worker identity's name): every worker session still runs as `lance_app` and gains nothing from the grant, and the job takes the role only by `SET LOCAL ROLE lance_retention` inside its own transaction, one per principal, on a handle scoped to that principal, so row-level security holds it to their rows. It sets the role back before appending `retention_applied` in the same transaction. `lance_app` is never a member, so no app session can null a payload; `grants.ts` refuses to grant the role to `lance_app` or `lance_migrator`. A separate identity would need its own Container App or job, its own Postgres principal and its own secrets for no gain in what it can reach, since the SET ROLE path already confines the write to one transaction. This supersedes "of no other application role" above.

Migration 0016 adds `UPDATE (error)` on `agent_runs`, whose error text can quote model output, to what the role may change.

What each window nulls (`packages/ledger/src/retention.ts`): the mail watcher's `observed` payloads at `RETENTION_MAIL_BODIES_DAYS`; Jamie's `observed` payloads at `RETENTION_TRANSCRIPTS_DAYS`; triage `resolved` payloads at the window of the source whose observations they were built from; agent `failed` events carrying rejected model output, and `agent_runs.error`, at `RETENTION_MODEL_LOGS_DAYS`; every other payload at `RETENTION_LEDGER_DAYS`, except the ontology's recorded mutations, which the graph is rebuilt from and the spec keeps indefinitely. `observations` follows its ledger row. Ages run from `created_at`.

The Phase 2 review's open decision is settled this way: evidence quotes copied into triage results go at the transcript window when they came from a transcript (and at the mail window from mail). The trigger admits only a whole payload set to NULL, so the whole triage result is nulled, not the quote fields alone; loosening the trigger to allow partial rewrites was rejected because it would let retention edit, not only empty, the ledger. Nothing reads a triage result after its run.

The job is the per-principal `retention` job in the registry, locked, nightly at 03:00, and the one job the reconciler schedules for every principal whatever their status. Offboarding runs it at once with the three content windows at zero.
