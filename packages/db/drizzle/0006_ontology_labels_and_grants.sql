-- The ontology graph's labels and the application role's rights on them
-- (spec section 5.2, ADR 0004).
--
-- AGE creates one table per label inside the graph's schema, owned by
-- whoever first uses the label. Creating every label here, as the migrator,
-- keeps ownership with lance_migrator and means the running apps never need
-- CREATE on the schema. lance_app then gets the four row privileges, which
-- is all a MERGE, SET or DETACH DELETE in Cypher needs.

DO $$
DECLARE
  vlabel text;
  elabel text;
BEGIN
  FOREACH vlabel IN ARRAY ARRAY[
    'Person', 'Organisation', 'Meeting', 'Task', 'Commitment', 'Thread',
    'Document', 'Project', 'Agent'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM ag_catalog.ag_label l
      JOIN ag_catalog.ag_graph g ON g.graphid = l.graph
      WHERE g.name = 'lance_ontology' AND l.name = vlabel
    ) THEN
      -- The arguments are cstring; a literal built by format() coerces, a text variable does not.
      EXECUTE format('SELECT ag_catalog.create_vlabel(%L, %L)', 'lance_ontology', vlabel);
    END IF;
  END LOOP;

  FOREACH elabel IN ARRAY ARRAY[
    'WORKS_AT', 'ATTENDED', 'ORGANISED', 'MENTIONS', 'ASSIGNED_TO', 'OWES',
    'OWED_TO', 'ABOUT', 'DERIVED_FROM', 'PARTICIPATED_IN', 'RELATES_TO', 'SAME_AS'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM ag_catalog.ag_label l
      JOIN ag_catalog.ag_graph g ON g.graphid = l.graph
      WHERE g.name = 'lance_ontology' AND l.name = elabel
    ) THEN
      EXECUTE format('SELECT ag_catalog.create_elabel(%L, %L)', 'lance_ontology', elabel);
    END IF;
  END LOOP;
END
$$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA lance_ontology TO lance_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA lance_ontology TO lance_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE lance_migrator IN SCHEMA lance_ontology
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lance_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE lance_migrator IN SCHEMA lance_ontology
  GRANT USAGE, SELECT ON SEQUENCES TO lance_app;
