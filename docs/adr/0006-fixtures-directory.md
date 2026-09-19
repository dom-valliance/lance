# 0006. Fixtures directory before a private submodule

Date: 2026-09-19
Status: Accepted

## Context

Spec section 17 places connector recordings and eval sets in `fixtures/` as a private submodule. No such repository exists yet, and Phase 0 and Phase 1 need only synthetic connector recordings.

## Decision

`fixtures/` is a plain directory in the main repository. Synthetic connector recordings under `fixtures/connectors/<name>/` are committed. `fixtures/evals/` is gitignored and becomes the mount point for the private submodule when Phase 2 needs anonymised eval sets.

## Consequences

Nothing personal is committed to the main repository. The submodule is added in Phase 2 with its own ADR line noting the repository.
