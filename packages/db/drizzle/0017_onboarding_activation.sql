-- Onboarding (docs/plans/multi-user.md M3, package 5.5). A principal in
-- status onboarding works through a checklist; when every required step is
-- done, the api moves them to active in an admin scope, in one transaction
-- with its ledger event (actor system:onboarding), and records when.
--
-- activated_at is when that happened. SystemControl reads it in the
-- principal's own scope to hold them in dry run for five working days. It
-- is null for a principal who was never onboarded (Dom), who is exempt.
--
-- The principal's own scope gains one column: time_zone, which onboarding
-- step 6 confirms and the worker prefills from their mailbox settings.
-- Every rule of migration 0015's guard is kept as it was, and two are
-- added: outside the migration role, activated_at is set once, only in the
-- update that moves a principal from onboarding to active, which that
-- update must do; and a time zone must be one Postgres knows.

ALTER TABLE "principals" ADD COLUMN "activated_at" timestamp with time zone;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION principals_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_has_role(current_user, 'lance_migrator', 'USAGE') THEN
    RETURN NEW;
  END IF;

  -- Written only by slack_links_sync, which runs as lance_migrator.
  IF NEW.slack_user_id IS DISTINCT FROM OLD.slack_user_id THEN
    RAISE EXCEPTION
      'principals: slack_user_id follows the principal''s active Slack link (ADR 0021)'
      USING HINT = 'Link the Slack user through /lance login, which writes slack_links.';
  END IF;

  -- The activation time is what the five working days of dry run count
  -- from, so no scope may move it once set or set it apart from the
  -- activation itself.
  IF NEW.activated_at IS DISTINCT FROM OLD.activated_at
     AND NOT (OLD.activated_at IS NULL AND OLD.status = 'onboarding'
              AND NEW.status = 'active' AND NEW.activated_at IS NOT NULL) THEN
    RAISE EXCEPTION
      'principals: activated_at is set once, when onboarding moves the principal to active (package 5.5)'
      USING HINT = 'Complete onboarding through the api; correcting an activation time is a migration-role repair.';
  END IF;

  IF OLD.status = 'onboarding' AND NEW.status = 'active' AND NEW.activated_at IS NULL THEN
    RAISE EXCEPTION
      'principals: a principal leaving onboarding for active carries their activation time (package 5.5)'
      USING HINT = 'Set activated_at in the same update as the status.';
  END IF;

  IF NEW.time_zone IS DISTINCT FROM OLD.time_zone THEN
    -- Raises invalid_parameter_value for a zone Postgres does not know.
    PERFORM now() AT TIME ZONE NEW.time_zone;
  END IF;

  IF app_is_admin() THEN
    RETURN NEW;
  END IF;

  IF OLD.entra_oid IS NULL AND NEW.entra_oid IS NOT NULL THEN
    IF (to_jsonb(NEW) - 'entra_oid' - 'updated_at') IS DISTINCT FROM
       (to_jsonb(OLD) - 'entra_oid' - 'updated_at') THEN
      RAISE EXCEPTION
        'principals: binding an entra_oid may not change any other column (ADR 0020)'
        USING HINT = 'Set entra_oid and updated_at alone. Status changes need an admin scope.';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.id = app_principal() THEN
    IF OLD.slack_channel_id IS NOT NULL
       AND NEW.slack_channel_id IS DISTINCT FROM OLD.slack_channel_id THEN
      RAISE EXCEPTION
        'principals: a principal''s Slack channel is set once (ADR 0023)'
        USING HINT = 'Changing or archiving a principal''s channel is an admin action.';
    END IF;
    IF OLD.notion_user_id IS NOT NULL
       AND NEW.notion_user_id IS DISTINCT FROM OLD.notion_user_id THEN
      RAISE EXCEPTION
        'principals: a principal''s Notion user id is recorded once (ADR 0022)'
        USING HINT = 'Correcting a recorded Notion user id is an admin repair.';
    END IF;
    IF (to_jsonb(NEW) - 'lance_roles' - 'roles_recorded_at' - 'slack_channel_id'
                      - 'notion_user_id' - 'time_zone' - 'updated_at')
       IS DISTINCT FROM
       (to_jsonb(OLD) - 'lance_roles' - 'roles_recorded_at' - 'slack_channel_id'
                      - 'notion_user_id' - 'time_zone' - 'updated_at') THEN
      RAISE EXCEPTION
        'principals: a principal''s own scope may change only their roles, their Slack channel, their Notion user id and their time zone (ADR 0021, ADR 0022, ADR 0023, package 5.5)'
        USING HINT = 'Status changes need an admin scope; the Entra object id is bound once.';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'principals: outside an admin scope an update may only bind a missing entra_oid (ADR 0020)'
    USING HINT = 'A principal already bound to an Entra object keeps it. Changing it is an admin repair.';
END;
$$;
--> statement-breakpoint
GRANT UPDATE (time_zone, activated_at) ON principals TO lance_app;
