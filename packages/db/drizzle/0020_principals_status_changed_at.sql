-- When a principal's status last changed (Phase 5 review).
--
-- The nightly role check offboards a principal it paused who still holds no
-- Lance role once the grace period has passed. It counted from its own
-- latest pause whenever that was, so a principal resumed and paused again
-- by an admin in between was offboarded without the grace night after the
-- later pause. status_changed_at is stamped by the database on every status
-- change, whoever makes it and however (the app, a runbook's SQL); the role
-- check records the stamp its own pause produced and offboards only while
-- the stamp is still that one.
--
-- lance_app has no grant on the column, and the trigger overwrites any
-- value an update supplies, so no role can move it. The trigger is named to
-- fire after principals_guard, which therefore sees each update as written.

ALTER TABLE "principals" ADD COLUMN "status_changed_at" timestamp with time zone;
--> statement-breakpoint
CREATE FUNCTION principals_status_stamp() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := clock_timestamp();
  ELSE
    NEW.status_changed_at := OLD.status_changed_at;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION principals_status_stamp() OWNER TO lance_migrator;
--> statement-breakpoint
CREATE TRIGGER principals_status_stamp BEFORE UPDATE ON principals
  FOR EACH ROW EXECUTE FUNCTION principals_status_stamp();
