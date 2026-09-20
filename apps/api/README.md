# @lance/api

Fastify 5, tRPC 11 and Zod (spec 3.1). Auth against Entra ID, the kill
switch, ledger queries, Slack's three endpoints and the agent-log webhook.

## Run it

```sh
cp .env.example .env   # then fill in the secrets
pnpm --filter @lance/api dev
```

The server listens on `PORT`, default 3001.

## Routes

| Route                      | Guard                   | What it does                                                          |
| -------------------------- | ----------------------- | --------------------------------------------------------------------- |
| `GET /health/live`         | none                    | Answers without touching Postgres.                                    |
| `GET /health/ready`        | none                    | Reads `system_state`; 503 when it cannot.                             |
| `POST /slack/commands`     | Slack signature         | `/lance status`, `pause`, `resume`; the rest arrive in a later phase. |
| `POST /slack/events`       | Slack signature         | Answers `url_verification`, acknowledges the rest.                    |
| `POST /slack/interactions` | Slack signature         | Acknowledges and logs the action ids.                                 |
| `POST /ingest/agent-log`   | `x-lance-ingest-secret` | Appends an `observed` event with `kind: agent_log`.                   |
| `POST /admin/pause`        | Entra bearer            | Kill switch on, with a reason.                                        |
| `POST /admin/resume`       | Entra bearer            | Kill switch off.                                                      |
| `GET /admin/status`        | Entra bearer            | The status snapshot.                                                  |
| `/trpc/*`                  | Entra bearer            | `systemState.get`, `ledger.query`, `ledger.byCorrelation`.            |

`apps/web` imports the router type only, from `@lance/api/router`.

## Notes

- Slack signature verification needs the exact bytes Slack signed, so the
  `/slack` plugin registers its own content type parsers with
  `parseAs: 'string'` and leaves `request.body` as the raw string. No
  raw-body plugin is involved.
- Pino runs through Fastify's own logger with `redact` over the
  Authorization and cookie headers, the Slack and ingest secret headers,
  and any key named `token` or `secret`.
- `src/main.test.ts` runs the whole server over a Postgres container
  (`lance-postgres:16`); the rest of the suite uses the fakes in
  `src/test-fakes.ts`.

## Container

```sh
docker build -f apps/api/Dockerfile -t lance-api .   # from the repository root
```
