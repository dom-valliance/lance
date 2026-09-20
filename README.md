# Lance

Lance is the prototype of Ian, a personal operating agent that watches mail, calendar, meetings
and tasks, keeps a ledger of everything it sees and does, and proposes actions through Slack.

## Prerequisites

- Node 22, via nvm (`nvm use`)
- pnpm 12.4.2, via corepack (`corepack enable`)
- Docker, for local Postgres

## Getting started

```sh
pnpm install
docker compose up -d
pnpm lint typecheck test
```
