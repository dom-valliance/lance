-- The principal's notes on a commitment (ADR 0036).
--
-- A note is commentary the principal writes on the Commitments page. It is
-- append-only, as the ledger is: lance_app may read and add notes and may
-- neither change nor remove one, so a note always reads as it was written.
-- Every note is also recorded in the ledger with its author.
--
-- Row-level security is forced and holds every read and write to the
-- principal's own scope, as it does on commitments.

CREATE TABLE "commitment_notes" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"principal_id" char(26) DEFAULT app_principal() NOT NULL,
	"commitment_id" char(26) NOT NULL,
	"body" text NOT NULL,
	"author" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commitment_notes_id_ulid" CHECK ("id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "commitment_notes_body_length" CHECK (char_length(btrim("body")) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
ALTER TABLE "commitment_notes" ADD CONSTRAINT "commitment_notes_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_notes" ADD CONSTRAINT "commitment_notes_commitment_id_commitments_id_fk" FOREIGN KEY ("commitment_id") REFERENCES "public"."commitments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commitment_notes_commitment_id_idx" ON "commitment_notes" USING btree ("commitment_id","id");
--> statement-breakpoint
ALTER TABLE commitment_notes OWNER TO lance_migrator;
--> statement-breakpoint
REVOKE ALL ON commitment_notes FROM lance_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON commitment_notes TO lance_app;
--> statement-breakpoint
ALTER TABLE commitment_notes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE commitment_notes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY principal_isolation ON commitment_notes
  USING (principal_id = app_principal()) WITH CHECK (principal_id = app_principal());
