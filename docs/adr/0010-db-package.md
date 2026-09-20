# 0010. Relational schema and pool live in packages/db

Date: 2026-09-20
Status: Accepted

## Context

Spec section 17 lists `shared`, `ledger`, `policy`, `ontology`, `connectors` and `agents` as packages and does not say where the Drizzle schema for proposals, alerts, commitments, briefs, agent runs and system state lives. Putting it in `ledger` misnames it; putting it in `shared` mixes database concerns with pure types and config that the web app also imports.

## Decision

A `packages/db` package owns the Drizzle schema for every relational table in spec section 5.1, the forward-only migrations, the `pg` pool with the Entra token callback from ADR 0008, and the seed scripts. `packages/ledger` depends on `@lance/db` and owns only the ledger writer and reader. Enum value lists are defined once as Zod enums in `@lance/shared` and the Drizzle `pgEnum`s in `@lance/db` are built from those same arrays, with a test asserting they match.

## Consequences

`apps/web` never imports `@lance/db`; it reaches data through tRPC. One migration history for the whole database. The layout table in CLAUDE.md gains one line.
