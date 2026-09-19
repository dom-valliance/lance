# 0002. Model ids and effort live in config

Date: 2026-09-19
Status: Accepted

## Context

Spec section 3.2: Opus for planner and critic, Sonnet for triage, Haiku for watcher classification, ids in config never in code. Current ids at build time are `claude-opus-5`, `claude-sonnet-5` and `claude-haiku-4-5`. Current models use adaptive thinking and an `effort` setting; `budget_tokens` is rejected; assistant prefill is rejected; forced `tool_choice` is rejected on the newest tier.

## Decision

`packages/shared/config` exposes `models.planner`, `models.critic`, `models.critic_draft`, `models.triage`, `models.label`, each with a model id and an effort level, read from environment with the ids above as defaults. A price table in the same config drives cost estimation. Thinking is adaptive on every call. No prefill, no forced tool choice, no `budget_tokens` anywhere.

## Consequences

Swapping a model or retuning effort is an environment change. The price table must be updated when Anthropic changes prices; the weekly review shows estimated cost so drift is visible. Haiku still accepts `budget_tokens`, but the label call does not use thinking, so no code path differs by model family.
