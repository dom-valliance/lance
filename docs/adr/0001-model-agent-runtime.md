# 0001. Model agent runtime is the Anthropic SDK tool runner

Date: 2026-09-19
Status: Accepted

## Context

Spec section 3.2 names `@anthropic-ai/claude-agent-sdk` for model agents. That package is Claude Code as a library. It spawns a bundled CLI subprocess per session, ships built-in Read, Write, Edit, Bash, Glob, Grep, WebSearch and WebFetch tools, and writes session transcripts under `~/.claude/projects` unless redirected. Built-in tools can be removed with `tools: []`, so the spec's non-negotiable 2 (no code path from a model response to a connector write) is satisfiable, but as configuration rather than structure. Transcripts on disk would contain mail bodies, which section 4.4 governs.

The plain `@anthropic-ai/sdk` exposes `client.beta.messages.toolRunner` with `betaZodTool`. It has no built-in tools. Usage, including cache read and creation tokens, is on every returned message. `cache_control` gives prompt caching. `messages.parse` validates a final structured output against a Zod schema. `ANTHROPIC_BASE_URL` is honoured by the client, which keeps section 16 Q4 open for a Foundry endpoint.

Dom confirmed the change on 2026-09-19.

## Decision

Model-backed agents (triage, planner, critic) run on `@anthropic-ai/sdk` through a `defineAgent` wrapper in `packages/agents` over the tool runner. The toolset is fixed per agent: read tools over the ledger, ontology and source records, plus `create_proposal`. No connector write function is registered as a tool. `@anthropic-ai/claude-agent-sdk` is not a dependency.

## Consequences

Non-negotiable 2 is structural: there is no built-in tool to strip. No subprocess, no transcript on disk, and per-call usage feeds `agent_runs` directly. The ESLint boundary rule targets `@anthropic-ai/sdk` imports. Prompt caching and structured output are a few lines each rather than framework features. Forced `tool_choice` is unavailable on current models, so prompts name `create_proposal` explicitly and tools use `strict: true`. If a future need arises for built-in filesystem or web tools inside an agent, that is a new ADR.
