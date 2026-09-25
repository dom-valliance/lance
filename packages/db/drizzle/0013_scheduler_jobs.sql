-- The job registry's per-principal rows (ADR 0025, docs/plans/jobs.md
-- section 4). Code declares each system job; a row holds one principal's
-- enabled flag and schedule override for it. Under forced row-level
-- security like every other principal-bearing table (ADR 0015).

CREATE TYPE "public"."job_origin" AS ENUM('system');
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"principal_id" char(26) DEFAULT app_principal() NOT NULL,
	"slug" text NOT NULL,
	"origin" "job_origin" DEFAULT 'system' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"schedule_override" text,
	"locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_id_ulid" CHECK ("id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_principal_slug_idx" ON "jobs" USING btree ("principal_id","slug");
--> statement-breakpoint
-- FORCE applies the policy to the owning role too, as in migration 0009.
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY principal_isolation ON jobs
  USING (principal_id = app_principal()) WITH CHECK (principal_id = app_principal());
--> statement-breakpoint
-- Owned by lance_migrator like every other relational object (migration
-- 0002). The apps create and change rows and never remove one: a job a
-- later build no longer declares keeps its row, and the reconciler ignores it.
ALTER TABLE jobs OWNER TO lance_migrator;
--> statement-breakpoint
ALTER TYPE job_origin OWNER TO lance_migrator;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON jobs TO lance_app;
--> statement-breakpoint
GRANT USAGE ON TYPE job_origin TO lance_app;
