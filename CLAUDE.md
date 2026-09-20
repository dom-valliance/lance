# Lance

Personal operating agent for Dom Selvon. Watches mail, calendar, meetings and tasks; keeps a ledger of everything it sees and does; proposes actions through Slack; executes only what policy allows; prepares the day. TypeScript end to end on Azure Container Apps, Postgres with Apache AGE and pgvector, Next.js front end.

The full specification is [Ian-Assistant_Spec_v1.md](Ian-Assistant_Spec_v1.md). Read it before writing code. This file summarises how to work in the repo; it does not replace the spec. Valliance global standards in `~/.claude/CLAUDE.md` apply and are not repeated here.

## Naming

The spec calls the agent Ian. The prototype is called Lance. Ian is reserved for the production identity. Every identifier says Lance:

| Where | Value |
|---|---|
| Repo and root package | `lance` |
| Entra app registration | `Lance (Valliance)` |
| Slack app, bot user, slash command | `Lance`, `/lance` |
| Slack channel | `dom-claude-agent` (C0BU7P278N5), unchanged |
| Postgres roles | `lance_app`, `lance_migrator` |
| AGE graph | `lance_ontology` |
| Ledger `source_system` for Lance itself | `lance` |
| Display name in UI and Slack copy | `AGENT_DISPLAY_NAME` from config, default `Lance` |

Do not introduce `ian_*` identifiers. Where the spec says `ian`, write `lance`.

## How to use the spec

1. Build in the phase order of spec section 15. Do not start a phase until the previous phase's acceptance criteria pass in CI.
2. Record every architectural deviation from the spec as an ADR in `docs/adr/NNNN-title.md` before implementing it. Deviations without an ADR are bugs. Existing ADRs are listed in `docs/adr/README.md`.
3. Where the spec says "default", implement the default and expose the value in configuration. Where it says "hard floor", the value is code, not configuration, and has a test proving it cannot be overridden.
4. Open questions in spec section 16 have stated defaults. Build the default; do not block.
5. All UI copy and log messages are British English. No em dashes anywhere in copy, code comments or docs. No emojis in UI copy.
6. Conventional commits. Feature flags for anything that touches an external system in write mode. Secrets never in the repo, never in container env at build time.

## Non-negotiables

These are enforced in code and tested. Quoted verbatim from spec section 2, with Ian read as Lance.

1. **Ledger first.** No external read or write happens without a ledger event. The ledger table accepts INSERT and SELECT only; the application role has no UPDATE or DELETE grant and a trigger rejects both.
2. **LLMs cannot write to external systems.** Model-backed agents have read tools and one write tool: `create_proposal`. The executor is deterministic code that runs approved proposals. There is no code path from a model response to a connector write.
3. **Policy is data, deletes are code.** Every action resolves through the policy engine to `forbid`, `propose` or `auto`. Delete actions and outbound email sends are hard floors at `forbid` in v1 and no rule can lift them.
4. **Autonomy is per cell.** A rule grants `auto` to one (action class, counterparty class, system) cell. One override by Dom on an `auto` cell demotes it to `propose` and raises an alert.
5. **Provenance on every claim.** Every alert, brief line and proposal carries the source system, record id, record hash and observed-at timestamp. The UI renders these as links.
6. **Idempotent ingestion.** Every watcher keeps a cursor; every observation has an idempotency key of `system:record_id:content_hash`. Re-running a watcher over the same window produces no new events.
7. **Kill switch.** One command pauses all watchers and the executor within one scheduler tick (default 30 s) and cancels queued proposals' execution. Reads may continue; writes stop.
8. **Non-destructive by construction.** Ian never overwrites content it did not create. Updates to Notion tasks touch only fields Ian set or Dom approved in the proposal preview.

## Architecture

Three Container Apps (`web`, `api`, `worker`), one Postgres Flexible Server, one Key Vault. No Redis; pg-boss uses Postgres for queue and cron.

```
apps/web      Next.js 16 App Router, React 19, Tailwind, shadcn. tRPC over HTTPS plus SSE.
apps/api      Fastify 5, tRPC 11, Zod. Auth (Entra), proposals, policy CRUD, ledger queries,
              Slack events and interactivity, log-ingest webhook.
apps/worker   Node 22. Scheduler, watchers, triage, planner, critic, executor,
              promotion analyser, retention jobs. Model agents on @anthropic-ai/sdk (ADR 0001).
packages/     shared, db (Drizzle schema, migrations, pool; ADR 0010), ledger, policy, ontology (AGE),
              connectors (graph, jamie, notion, slack), agents, telemetry (OTel, pino)
infra/        Bicep
docs/         adr, runbooks, compliance, voice
fixtures/     connector recordings; eval sets arrive as a private submodule in Phase 2
```

Stack decisions and versions are in the ADRs. Model ids live in `packages/shared/config`, never in code: `claude-opus-5` for planner and critic, `claude-sonnet-5` for triage, `claude-haiku-4-5` for watcher labels.

## Conventions

- Strict TypeScript, no `any`. Zod at every boundary.
- ESLint import boundaries: connector write functions are importable only from `apps/worker/src/executor`; `@anthropic-ai/sdk` is importable only inside `packages/agents`.
- Forward-only migrations. CI fails any migration containing `DROP TABLE` or `DROP COLUMN`.
- Feature flags via `packages/shared/config`: `FF_GRAPH_WRITES`, `FF_NOTION_WRITES`, `FF_SLACK_WRITES`. Default off outside `live` mode.
- All times stored UTC, displayed Europe/London.
- Tests beside source. Test names describe behaviour.
- pnpm workspaces with Turborepo. `pnpm lint`, `pnpm typecheck`, `pnpm test` must pass before any task is marked done.
- Local Postgres via `docker-compose.yml` (PostgreSQL 16 with AGE and pgvector). Integration tests start containers through `startPostgresContainer` from `@lance/db/testing`; build the image with `docker compose build` first.
- Shell: Node 22 via nvm (`nvm use 22`), pnpm through corepack. Run `pnpm install` from the root after adding a dependency.

## Open questions and defaults (spec section 16)

| # | Question | Default in force |
|---|---|---|
| Q1 | Jamie REST or MCP | REST, API key, read-only. ADR 0005. |
| Q2 | Agents covered by the agent-logs watcher | Lance itself, the inbox agent, the webhook. |
| Q3 | Retention windows | Mail bodies 90 days, transcripts 180, ontology indefinite, ledger 2 years, model logs 30 days. |
| Q4 | Anthropic direct or Foundry | Anthropic direct. `ANTHROPIC_BASE_URL` configurable. |
| Q5 | AGE or Neo4j | AGE behind `OntologyRepository`. Revisit if meeting-prep p95 exceeds 500 ms at 10k nodes. |
| Q6 | Slack channel | Reuse `dom-claude-agent`; Lance bot posts. |
| Q7 | Notion databases | All Tasks and Meetings only. Add via config. |

## Gotchas

Promoted here when the same lesson appears more than twice in `.claude/notes/`.

- Tasks have one home: the Notion All Tasks DB under Dom's name. There is no Lance-native tasks table. Delegated Jamie tasks carry the delegate's name in round brackets at the end of the title. ADR 0009.
- Jamie's REST API is read-only. Do not write a Jamie write connector or a `FF_JAMIE_WRITES` flag. ADR 0005.
- `@anthropic-ai/claude-agent-sdk` is not used. Agents run on the `@anthropic-ai/sdk` tool runner. ADR 0001.
- Never force `tool_choice` on current models; name the tool in the prompt and use `strict: true`.
- GitHub is Dom's. Plain git only: branches and commits. Never install or use the `gh` CLI, never open PRs. Hand over branch names and commit ranges. ADR 0007.

## Memory

Lessons from corrections live in `.claude/notes/`. Run `/recall` at the start of a non-trivial task and `/learn` after any correction. Commit notes with code.
