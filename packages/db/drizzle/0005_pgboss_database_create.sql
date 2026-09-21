-- pg-boss runs CREATE SCHEMA IF NOT EXISTS on every start, and Postgres checks
-- the CREATE privilege on the database before it checks whether the schema
-- exists. The schema itself was created by migration 0003; this lets the
-- worker's identity pass that check. CREATE on a database permits creating
-- schemas only, nothing inside existing ones.

DO $$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO lance_app', current_database());
END
$$;
