-- A principal's Notion user id (ADR 0022, docs/plans/multi-user.md M2).
-- Notion stays one organisation integration, so the All Tasks database is
-- shared, and reads filter on the principal's own Notion user id while
-- writes assign that principal. The id is resolved from the Notion users
-- list by the principal's email when it is null, in the principal's own
-- scope.
--
-- Migration 0014 already lets the principal's own scope update their row
-- (principals_self_update) and holds the columns in principals_guard. This
-- migration adds notion_user_id to what that scope may change, once, from
-- null, as 0014 does for slack_channel_id. Every rule of 0014's guard is
-- kept as it was. Correcting a wrong id stays an admin repair.

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
                      - 'notion_user_id' - 'updated_at')
       IS DISTINCT FROM
       (to_jsonb(OLD) - 'lance_roles' - 'roles_recorded_at' - 'slack_channel_id'
                      - 'notion_user_id' - 'updated_at') THEN
      RAISE EXCEPTION
        'principals: a principal''s own scope may change only their roles, their Slack channel and their Notion user id (ADR 0021, ADR 0022, ADR 0023)'
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
GRANT UPDATE (notion_user_id) ON principals TO lance_app;
