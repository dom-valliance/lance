# Eval sets

`fixtures/evals/` is ignored by default. The real eval sets are anonymised extracts of Dom's
mail and transcripts, and they belong in the private set that spec section 14 describes, not in
this repository.

`fixtures/evals/commitments/` is the exception and is committed, through negating rules in the
root `.gitignore`. Every record in it is invented: invented people, invented organisations,
`example.test` addresses, invented consultancy content. Nothing in it came from a real mailbox,
calendar or meeting. It is committed so that the commitment extraction harness in
`packages/agents/src/evals/commitments` has a set to run against in CI, on a fresh clone and on
a machine with no access to the private set. Treating the harness as testable only where the
private data exists would leave the scorer itself untested.

## The commitment set

Fifty records, one JSON file each, named after the `id` field:

- 20 `transcript` records in Jamie's markdown style, bold speaker names and `###### mm:ss - mm:ss`
  timestamps.
- 30 `sent_mail` records, from Dom to a counterparty, with a subject, date and body.

Each file holds:

```jsonc
{
  "id": "t01-harlow-brook-sow-kickoff",
  "kind": "transcript",            // or "sent_mail"
  "dom": { "name": "Dom Selvon", "email": "dom@valliance.ai" },
  "participants": [{ "name": "Priya Nandra", "email": "priya.nandra@harlowbrook.example.test" }],
  "text": "...",
  "expected": [],                  // CommitmentCandidate without recordId
  "notes": "what this record is testing"
}
```

`expected` mirrors `CommitmentCandidateSchema` in `apps/worker/src/triage/schema.ts` without
`recordId`, which the extractor fills in from the record it was given. `direction` is `outbound`
when Dom's side owes the counterparty and `inbound` when the counterparty owes Dom.

## Conventions the set follows

- Every `evidenceQuote` is a verbatim substring of `text`. A test enforces it.
- A commitment made by a Valliance colleague on Dom's behalf is `outbound`, with the client as
  the counterparty.
- Promises between two counterparties, hedged intentions, questions, offers and retrospective
  statements are not commitments and are absent from `expected`.
- Due dates resolve against the record's own date, always as `YYYY-MM-DD`:
  an explicit date or weekday gives `dueConfidence` 0.9; a vague window (end of the month, next
  week, within a fortnight) resolves to the end of that window with 0.5; no date at all gives
  `dueAt: null` with 0.
- Ten records expect nothing at all, so precision is measurable and not only recall.

## Running the harness

```sh
pnpm --filter @lance/agents eval:commitments               # the real extractor
EVAL_EXTRACTOR=scripted pnpm --filter @lance/agents eval:commitments   # harness self-check, F1 1.0
```

`EVAL_FILTER` restricts the run to fixture ids containing a substring, and `EVAL_MIN_F1` sets a
regression floor below which the process exits 1.
