# 0011. Retention nulls ledger payloads without lifting immutability

Date: 2026-09-20
Status: Accepted

## Context

Non-negotiable 1 says the ledger accepts INSERT and SELECT only and a trigger rejects UPDATE and DELETE. Spec section 4.4 says the nightly retention job nulls the raw payload column on aged ledger rows and keeps the hash. Both cannot be true for one role and one trigger.

## Decision

The application role `lance_app` keeps SELECT and INSERT only. A separate group role `lance_retention` has UPDATE on `ledger_events(payload)` and nothing else on that table. The `ledger_immutable` trigger rejects every DELETE and TRUNCATE, and rejects every UPDATE unless all three hold: the current role is a member of `lance_retention`, the new `payload` is NULL, and every other column is unchanged. The retention job connects with an identity that is a member of `lance_retention` and of no other application role. The job writes a `retention_applied` ledger event (as INSERT) with counts.

## Consequences

The immutability test suite gains three cases: `lance_app` cannot UPDATE payload to NULL; `lance_retention` cannot change any column other than payload, cannot set payload to a non-NULL value, and cannot DELETE; `lance_retention` can null payload on an aged row. `payload_hash` survives retention so provenance links still verify. The evidence export includes retention runs because they are ledger events.
