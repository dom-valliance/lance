# Transcript duplicate repair

Before `fix/commitments-once-per-transcript`, triage read a Jamie meeting's transcript again every time the meeting was observed again (the summary, tags, title or Jamie's own action items arriving after the transcript). Each reading recorded the same promises under new wording, so the Commitments page shows pairs such as "Read through the SOW" and "Read through the SOW that Brian sent back for review".

This runbook drops those second copies. It applies the rule triage now follows: a run that read a transcript an earlier completed run had already read should have recorded nothing, so every commitment it recorded from that meeting is a duplicate. The earlier run's commitments stay.

Run it once, after the fix is deployed. Nothing needs to run before it except `deploy.md`, which puts the command in the worker image.

## What it changes

- Only `open` commitments are dropped. Each drop is the same status change the Commitments page makes, with a `commitment_status` ledger event whose actor is `system:repair-transcript-duplicates` and whose reason names the meeting and the triage run.
- `chased` duplicates are listed and left alone: a chase has gone out in their name. Resolve them on the Commitments page.
- `done` and `dropped` duplicates are listed and left alone.
- The page cannot reopen a dropped commitment, so the command has a `--restore` mode that reopens every commitment it dropped, unless Dom has resolved it again since.

## What it does not catch

- A second reading made because the transcript text itself changed. Before the fix that reading was not told what the first had recorded, so it could reword it too; those pairs are not listed and are resolved on the Commitments page.
- Commitments the triage model recorded from Jamie action items, which arrive as their own records.

The rule also drops anything the second reading found that the first missed. Step 2's check against the page is the only safeguard for that.

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

## 2. List the duplicates

```
./node_modules/.bin/tsx src/repair/transcriptDuplicates.cli.ts
```

This changes nothing. It prints one line per active principal with the count, then one line per duplicate: commitment id, status, Jamie meeting id and description. Before going on, check on the Commitments page that each listed commitment has a twin from the same meeting that is not listed; a listed one without a twin is a promise only the second reading found, so resolve it by hand instead of applying. For the Brian Vargas-Meinel meeting `1i7wkcv4swax` it should list one copy of each repeated promise, never both.

## 3. Drop the open duplicates

```
./node_modules/.bin/tsx src/repair/transcriptDuplicates.cli.ts --apply
```

It prints the list again, then how many it dropped and how many it left because they were not open.

## 4. Check the page

Open the Commitments page, filter to the meeting's counterparty, and confirm one commitment per promise remains. Running step 2 again lists the dropped rows with status `dropped`; that is expected.

## Undo

```
./node_modules/.bin/tsx src/repair/transcriptDuplicates.cli.ts --restore
```

This reopens every commitment the repair dropped that is still dropped, with a ledger event for each.
