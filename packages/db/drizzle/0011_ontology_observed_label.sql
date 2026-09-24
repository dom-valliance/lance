-- The OBSERVED edge label (ADR 0033): a principal's private sighting of a
-- shared node, carrying the record id and URL the shared node no longer
-- holds. Created here, as the migrator, for the reason 0006 gives: AGE
-- makes one table per label, owned by whoever first uses it, and the apps
-- must neither own graph tables nor need CREATE on the graph's schema.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ag_catalog.ag_label l
    JOIN ag_catalog.ag_graph g ON g.graphid = l.graph
    WHERE g.name = 'lance_ontology' AND l.name = 'OBSERVED'
  ) THEN
    -- The arguments are cstring; a literal built by format() coerces, a text variable does not.
    EXECUTE format('SELECT ag_catalog.create_elabel(%L, %L)', 'lance_ontology', 'OBSERVED');
  END IF;
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA lance_ontology TO lance_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA lance_ontology TO lance_app;
