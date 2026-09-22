# @lance/ontology

The graph (spec 5.2) over Apache AGE, graph `lance_ontology`, and entity resolution (spec 5.3).

Every mutation goes through `OntologyRepository`, which runs one Cypher statement with concrete parameters and appends a `resolved` ledger event carrying that statement verbatim. The graph is therefore a function of the ledger: `pnpm --filter @lance/ontology rebuild` empties it and replays every recorded mutation, and the repository test proves the replay reproduces the same nodes with the same ids.

Labels and edges are created by migration 0006 as the migrator, so the running apps need only row privileges on the graph's tables. Each statement runs on a checked-out client with `ag_catalog` first on its search path, which AGE needs to resolve the operators Cypher compiles to.

Resolution order: exact keys (email, Notion user id, Slack id, Jamie participant id) merge at 1.0; then the normalised name is scored with Jaro-Winkler and scaled by organisation; 0.95 and above merges, 0.75 to 0.95 creates the person and a `SAME_AS` candidate for the Ontology page; two people recorded as distinct attendees of the same meeting are never merged automatically.
