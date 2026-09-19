# Runbook: kill switch

Pauses all watchers and the executor within one scheduler tick (default 30 seconds). Reads may continue; writes stop. The flag lives in Postgres (`system_state.paused`) so it survives restarts.

## Pause

Any one of:

- Slack: `/lance pause <reason>`
- Web: Settings, Kill switch, enter a reason, confirm.
- API: `POST https://<api-hostname>/admin/pause` with an Entra bearer token for Dom's UPN and body `{"reason": "..."}`.

Each records a `state_changed` ledger event with actor and reason. Queued executions are marked `held`, not cancelled.

## Confirm it took

`/lance status` shows `paused: true`, the reason and the actor. The Agents page shows every watcher's last run older than the pause time after one tick.

## Resume

`/lance resume`, the Settings button, or `POST /admin/resume`. Held executions are re-evaluated against current policy before being re-queued; any that no longer resolve to `auto` or `approved` stay held with a card update.

## If the api is down

Set the flag directly: connect to Postgres as `lance_migrator` and run

```sql
UPDATE system_state SET paused = true, paused_reason = 'manual: api down', paused_by = 'user:dom';
```

Then insert the ledger event by hand with the same reason so the trail is complete. The worker reads the flag every tick regardless of the api.

## Drill

Phase 5 adds an automated drill in CI. Until then, run a manual drill once per phase: pause during a dry-run window, confirm no `executed` event appears after the pause timestamp, resume, record the drill as a `state_changed` event with reason `drill`.
