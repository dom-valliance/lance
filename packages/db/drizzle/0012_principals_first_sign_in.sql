-- First sign-in (ADR 0020, docs/plans/multi-user.md M1). The api resolves the
-- caller's principal from the token's oid; a caller with a Lance app role and
-- no principal either binds their oid to the row that already carries their
-- UPN (Dom's, created before Entra object ids were recorded) or gets a new
-- row in status onboarding. lance_app could only read principals (migration
-- 0009); it gains exactly those two writes, and an admin scope may change a
-- principal's status. The database enforces each limit, not only the code.
--
-- Row-level security is enabled and not forced: lance_migrator owns the
-- table, and the migration job and the seed, which run as its members, keep
-- writing principals as before. lance_app is not the owner and is held to
-- the policies below.

ALTER TABLE principals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The lookup that turns an identity into a principal reads every row.
CREATE POLICY principals_read ON principals FOR SELECT USING (true);
--> statement-breakpoint
-- A first sign-in creates a principal that is onboarding and carries the
-- Entra object id it was created for. Nothing else may be inserted.
CREATE POLICY principals_onboard ON principals FOR INSERT
  WITH CHECK (status = 'onboarding' AND entra_oid IS NOT NULL);
--> statement-breakpoint
-- Binding: a row with no Entra object id may be given one. The guard trigger
-- below holds the rest of the row still.
CREATE POLICY principals_bind ON principals FOR UPDATE
  USING (entra_oid IS NULL)
  WITH CHECK (entra_oid IS NOT NULL);
--> statement-breakpoint
-- An admin scope may change any row's status (the nightly role check pauses
-- a principal who has lost their role).
CREATE POLICY principals_admin_update ON principals FOR UPDATE
  USING (app_is_admin())
  WITH CHECK (app_is_admin());
--> statement-breakpoint
-- Policies see the new row but not the old one, so a trigger compares them.
-- Outside an admin scope an update may only set a null entra_oid, and every
-- other column but updated_at must stay as it was. The owning role (the
-- migration job) is exempt, as it is from the policies.
CREATE FUNCTION principals_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_has_role(current_user, 'lance_migrator', 'USAGE') OR app_is_admin() THEN
    RETURN NEW;
  END IF;

  IF OLD.entra_oid IS NOT NULL OR NEW.entra_oid IS NULL THEN
    RAISE EXCEPTION
      'principals: outside an admin scope an update may only bind a missing entra_oid (ADR 0020)'
      USING HINT = 'A principal already bound to an Entra object keeps it. Changing it is an admin repair.';
  END IF;

  IF (to_jsonb(NEW) - 'entra_oid' - 'updated_at') IS DISTINCT FROM
     (to_jsonb(OLD) - 'entra_oid' - 'updated_at') THEN
    RAISE EXCEPTION
      'principals: binding an entra_oid may not change any other column (ADR 0020)'
      USING HINT = 'Set entra_oid and updated_at alone. Status changes need an admin scope.';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION principals_guard() OWNER TO lance_migrator;
--> statement-breakpoint
CREATE TRIGGER principals_guard BEFORE UPDATE ON principals
  FOR EACH ROW EXECUTE FUNCTION principals_guard();
--> statement-breakpoint
-- Column grants narrow the writes further: an insert names only these four
-- columns (the rest take their defaults), and an update touches only these
-- three. The Slack id, the Notion id and the UPN stay out of lance_app's reach.
GRANT INSERT (id, entra_oid, upn, status) ON principals TO lance_app;
--> statement-breakpoint
GRANT UPDATE (entra_oid, status, updated_at) ON principals TO lance_app;
