# Inbound commitments to triage

Before ADR 0037, the extractor tagged as inbound a promise made to anyone on a call, so the Owed to me tab holds promises made to the principal's colleagues. New commitments now reach Owed to me only when they are definitely owed to the principal. This runbook moves the open inbound commitments recorded before that into the To confirm tab, where the principal answers each one with Owed to me or Not mine.

Run `transcript-duplicates.md` first. That repair drops only `open` duplicates, and after this move the inbound ones are `unconfirmed`, so a pair recorded twice from one transcript would both land in To confirm. Nothing else needs to run first except `deploy.md`, which puts the command in the worker image.

## What it changes

- Every `open` inbound commitment becomes `unconfirmed`. Each move is the same status change the Commitments page makes, with a `commitment_status` ledger event whose actor is `system:repair-inbound-to-triage` and whose reason names ADR 0037.
- `chased` inbound commitments are left alone: a chase has gone out in the principal's name, so they are theirs.
- Outbound, `done`, `dropped` and already `unconfirmed` commitments are not touched.
- Nothing chases, alerts on or briefs an unconfirmed commitment, so until they are answered the moved commitments are also out of "waiting for" and the overdue alert.
- The move includes inbound commitments recorded after ADR 0037 as definite. There are few, and Owed to me puts each back with one click.

## Known values

| Value | Dev | Read it with |
|---|---|---|
| Resource group | `rg-lance-dev` | `az group list --query "[?starts_with(name, 'rg-lance-')].name" -o tsv` |
| Worker app | `ca-lance-worker-dev`, created by `containerapps.bicep` | `az containerapp list -g rg-lance-dev --query "[].name" -o tsv` |

## 1. Open a shell in the worker

```
az containerapp exec -g rg-lance-dev -n ca-lance-worker-dev --command sh
```

The shell starts in `/app/apps/worker`, where the worker's own database connection and role are already configured.

## 2. List what would move

```
./node_modules/.bin/tsx src/repair/inboundToTriage.cli.ts
```

This changes nothing. It prints one line per active principal with the count, then one line per commitment: id, the day it was recorded, and its description. The count should match the open count on the Owed to me tab.

## 3. Move them

```
./node_modules/.bin/tsx src/repair/inboundToTriage.cli.ts --apply
```

It prints the list again, then how many moved and how many it left because they stopped being open in the meantime.

## 4. Check the page

Owed to me with the Open filter is empty, the Chased filter is unchanged, and To confirm lists the moved commitments with their count in the tab label. Running step 2 again lists nothing.

## Undo

```
./node_modules/.bin/tsx src/repair/inboundToTriage.cli.ts --restore
```

This reopens every commitment the move put in triage that is still waiting there, with a ledger event for each. One the principal has answered since is left as they left it.
