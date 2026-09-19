# 0004. PostgreSQL 16 with Apache AGE and pgvector

Date: 2026-09-19
Status: Accepted

## Context

Spec section 3.2 names Azure Database for PostgreSQL Flexible Server with the `age` extension and pgvector, without a major version. Azure supports AGE 1.6 on PostgreSQL 16, and added PostgreSQL 18 support in April 2026. AGE upstream supports 11 through 18. Azure notes that in-place major version upgrade is not supported for every version when AGE is enabled. The local machine has a PostgreSQL 18 client only.

## Decision

PostgreSQL 16 in Azure. Local development and CI use one Docker image that carries AGE and pgvector on PostgreSQL 16, defined in `docker-compose.yml` and reused by the CI service container and testcontainers.

## Consequences

Same major everywhere, so Cypher and vector behaviour in tests matches production. Moving to 18 later is a new server plus dump and restore rather than in-place, which the restore runbook covers. The `OntologyRepository` interface keeps Neo4j available if AGE limits are hit (spec Q5).
