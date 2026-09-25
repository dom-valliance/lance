-- The Microsoft 365 consent state, in Postgres (Phase 5 review).
--
-- The api kept each open consent in the memory of the replica that started
-- it. It runs up to two replicas without affinity, so a callback reaching
-- the other replica failed. A row here holds the PKCE code verifier behind
-- one state value, keyed by the SHA-256 of the state so a read of the table
-- cannot finish a consent, and the principal who started it.
--
-- Row-level security is forced and holds every read and write to the
-- principal's own scope: the callback learns the principal from the state
-- value itself and scopes its session to them before it looks. A row is
-- issued unbound and unused for ten minutes at most, bound once when the
-- principal's browser takes the consent cookie, and used once by the
-- callback; the database, not only the code, refuses a second use.

CREATE TABLE "graph_consent_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"principal_id" char(26) DEFAULT app_principal() NOT NULL,
	"code_verifier" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"bound_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	CONSTRAINT "graph_consent_states_principal_id_ulid" CHECK ("principal_id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "graph_consent_states_ten_minutes" CHECK ("graph_consent_states"."expires_at" <= "graph_consent_states"."issued_at" + interval '10 minutes')
);
--> statement-breakpoint
ALTER TABLE "graph_consent_states" ADD CONSTRAINT "graph_consent_states_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "graph_consent_states_expires_at_idx" ON "graph_consent_states" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE graph_consent_states OWNER TO lance_migrator;
--> statement-breakpoint
REVOKE ALL ON graph_consent_states FROM lance_app;
--> statement-breakpoint
ALTER TABLE graph_consent_states ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE graph_consent_states FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY graph_consent_states_read ON graph_consent_states FOR SELECT
  USING (principal_id = app_principal());
--> statement-breakpoint
-- A state is issued in its principal's scope, unbound, unused, for ten
-- minutes at most from now.
CREATE POLICY graph_consent_states_issue ON graph_consent_states FOR INSERT
  WITH CHECK (
    principal_id = app_principal()
    AND bound_at IS NULL
    AND used_at IS NULL
    AND expires_at > now()
    AND expires_at <= now() + interval '10 minutes'
  );
--> statement-breakpoint
-- Binding and using touch only an unused, unexpired row of the principal's own.
CREATE POLICY graph_consent_states_advance ON graph_consent_states FOR UPDATE
  USING (principal_id = app_principal() AND used_at IS NULL AND expires_at > now())
  WITH CHECK (principal_id = app_principal());
--> statement-breakpoint
CREATE POLICY graph_consent_states_prune ON graph_consent_states FOR DELETE
  USING (principal_id = app_principal() AND (expires_at < now() OR used_at IS NOT NULL));
--> statement-breakpoint
-- The insert policy holds what a new row may carry.
GRANT SELECT, INSERT, DELETE ON graph_consent_states TO lance_app;
--> statement-breakpoint
GRANT UPDATE (bound_at, used_at) ON graph_consent_states TO lance_app;
