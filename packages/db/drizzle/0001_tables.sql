CREATE TYPE "public"."action_class" AS ENUM('read', 'classify', 'draft_email', 'apply_category', 'move_mail', 'create_task', 'update_task', 'complete_task', 'create_tag', 'apply_tag', 'create_calendar_hold', 'post_slack', 'send_email', 'delete', 'rule_change');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."alert_severity" AS ENUM('P0', 'P1', 'P2');--> statement-breakpoint
CREATE TYPE "public"."alert_status" AS ENUM('open', 'acked', 'resolved', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."brief_kind" AS ENUM('morning_brief', 'afternoon_board', 'meeting_prep', 'debrief', 'weekly_review');--> statement-breakpoint
CREATE TYPE "public"."commitment_direction" AS ENUM('outbound', 'inbound');--> statement-breakpoint
CREATE TYPE "public"."commitment_status" AS ENUM('open', 'chased', 'done', 'dropped');--> statement-breakpoint
CREATE TYPE "public"."counterparty_class" AS ENUM('self', 'internal', 'client', 'prospect', 'partner', 'vendor', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."decision" AS ENUM('forbid', 'propose', 'auto');--> statement-breakpoint
CREATE TYPE "public"."ledger_kind" AS ENUM('observed', 'resolved', 'proposed', 'decided', 'executed', 'failed', 'alert_raised', 'alert_acked', 'rule_changed', 'state_changed', 'retention_applied', 'cost_recorded');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'approved', 'edited', 'rejected', 'expired', 'held', 'executing', 'executed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."reversibility" AS ENUM('reversible', 'compensatable', 'irreversible');--> statement-breakpoint
CREATE TYPE "public"."rule_creator" AS ENUM('user:dom', 'agent:promotion-analyser');--> statement-breakpoint
CREATE TYPE "public"."system_mode" AS ENUM('live', 'dry_run');--> statement-breakpoint
CREATE TYPE "public"."target_system" AS ENUM('graph', 'jamie', 'notion', 'slack', 'lance');--> statement-breakpoint
CREATE TABLE "ledger_events" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"actor" text NOT NULL,
	"kind" "ledger_kind" NOT NULL,
	"source_system" text,
	"source_record_id" text,
	"source_record_hash" text,
	"idempotency_key" text,
	"correlation_id" char(26) NOT NULL,
	"parent_event_id" char(26),
	"policy_decision_id" char(26),
	"payload" jsonb,
	"payload_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_events_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "ledger_events_id_ulid" CHECK ("id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "ledger_events_correlation_id_ulid" CHECK ("correlation_id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "ledger_events_parent_event_id_ulid" CHECK ("parent_event_id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "ledger_events_policy_decision_id_ulid" CHECK ("policy_decision_id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"source_system" text NOT NULL,
	"source_record_id" text NOT NULL,
	"source_record_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"correlation_id" char(26) NOT NULL,
	"summary" text,
	"labels" text[] DEFAULT '{}' NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observations_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "observations_id_ulid" CHECK ("id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "observations_correlation_id_ulid" CHECK ("correlation_id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"correlation_id" char(26) NOT NULL,
	"action_class" "action_class" NOT NULL,
	"counterparty_class" "counterparty_class" NOT NULL,
	"target_system" "target_system" NOT NULL,
	"target_record_id" text,
	"reversibility" "reversibility" NOT NULL,
	"payload" jsonb NOT NULL,
	"edited_payload" jsonb,
	"preview" text NOT NULL,
	"rationale" text NOT NULL,
	"provenance" jsonb NOT NULL,
	"policy_decision" "decision" NOT NULL,
	"policy_rule_id" char(26),
	"status" "proposal_status" NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"slack_channel" text,
	"slack_ts" text,
	"expires_at" timestamp with time zone NOT NULL,
	"execution_event_id" char(26),
	"compensation_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_id_ulid" CHECK ("id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "proposals_correlation_id_ulid" CHECK ("correlation_id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "proposals_policy_rule_id_ulid" CHECK ("policy_rule_id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "proposals_execution_event_id_ulid" CHECK ("execution_event_id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "policy_rules" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"action_class" text NOT NULL,
	"counterparty_class" text NOT NULL,
	"system" text NOT NULL,
	"decision" "decision" NOT NULL,
	"conditions" jsonb,
	"created_by" "rule_creator" NOT NULL,
	"rationale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_by" char(26),
	CONSTRAINT "policy_rules_id_ulid" CHECK ("id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "policy_rules_superseded_by_ulid" CHECK ("superseded_by" ~ '^[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "policy_decisions" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"decision" "decision" NOT NULL,
	"rule_id" char(26),
	"reason" text NOT NULL,
	"input" jsonb NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_decisions_id_ulid" CHECK ("id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "policy_decisions_rule_id_ulid" CHECK ("rule_id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "cursors" (
	"watcher" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cursors_watcher_key_pk" PRIMARY KEY("watcher","key")
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"provenance" jsonb NOT NULL,
	"status" "alert_status" DEFAULT 'open' NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"acked_by" text,
	"acked_at" timestamp with time zone,
	"muted_until" timestamp with time zone,
	"slack_ts" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alerts_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "alerts_id_ulid" CHECK ("id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "commitments" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"direction" "commitment_direction" NOT NULL,
	"owner_person_id" text NOT NULL,
	"counterparty_person_id" text NOT NULL,
	"description" text NOT NULL,
	"due_at" timestamp with time zone,
	"due_confidence" real,
	"evidence_quote" text NOT NULL,
	"source_refs" jsonb NOT NULL,
	"status" "commitment_status" DEFAULT 'open' NOT NULL,
	"chase_count" integer DEFAULT 0 NOT NULL,
	"next_chase_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commitments_id_ulid" CHECK ("id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "briefs" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"kind" "brief_kind" NOT NULL,
	"correlation_id" char(26) NOT NULL,
	"content" jsonb NOT NULL,
	"markdown" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "briefs_id_ulid" CHECK ("id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "briefs_correlation_id_ulid" CHECK ("correlation_id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"agent" text NOT NULL,
	"version" text NOT NULL,
	"model" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "agent_run_status" NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"trace_id" text,
	"correlation_id" char(26),
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_id_ulid" CHECK ("id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "agent_runs_correlation_id_ulid" CHECK ("correlation_id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "system_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"paused_reason" text,
	"paused_by" text,
	"paused_at" timestamp with time zone,
	"mode" "system_mode" DEFAULT 'dry_run' NOT NULL,
	"quiet_hours_start" text DEFAULT '19:00' NOT NULL,
	"quiet_hours_end" text DEFAULT '07:00' NOT NULL,
	"push_budget_per_hour" integer DEFAULT 3 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_state_single_row" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" char(26) PRIMARY KEY NOT NULL,
	"upn" text NOT NULL,
	"slack_user_id" text,
	"notion_user_id" text,
	"time_zone" text DEFAULT 'Europe/London' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_upn_unique" UNIQUE("upn"),
	CONSTRAINT "users_id_ulid" CHECK ("id" ~ '^[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE INDEX "ledger_events_correlation_id_idx" ON "ledger_events" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "ledger_events_kind_ts_idx" ON "ledger_events" USING btree ("kind","ts");--> statement-breakpoint
CREATE INDEX "ledger_events_source_record_idx" ON "ledger_events" USING btree ("source_system","source_record_id");--> statement-breakpoint
CREATE INDEX "ledger_events_ts_idx" ON "ledger_events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "observations_correlation_id_idx" ON "observations" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "observations_source_record_idx" ON "observations" USING btree ("source_system","source_record_id");--> statement-breakpoint
CREATE INDEX "observations_ts_idx" ON "observations" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "proposals_status_idx" ON "proposals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "proposals_correlation_id_idx" ON "proposals" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "proposals_expires_at_idx" ON "proposals" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "policy_rules_cell_idx" ON "policy_rules" USING btree ("action_class","counterparty_class","system");--> statement-breakpoint
CREATE INDEX "policy_rules_active_idx" ON "policy_rules" USING btree ("active");--> statement-breakpoint
CREATE INDEX "policy_decisions_evaluated_at_idx" ON "policy_decisions" USING btree ("evaluated_at");--> statement-breakpoint
CREATE INDEX "alerts_status_idx" ON "alerts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "alerts_severity_idx" ON "alerts" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "alerts_last_seen_idx" ON "alerts" USING btree ("last_seen");--> statement-breakpoint
CREATE INDEX "commitments_status_idx" ON "commitments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "commitments_direction_idx" ON "commitments" USING btree ("direction");--> statement-breakpoint
CREATE INDEX "commitments_next_chase_at_idx" ON "commitments" USING btree ("next_chase_at");--> statement-breakpoint
CREATE INDEX "briefs_kind_generated_at_idx" ON "briefs" USING btree ("kind","generated_at");--> statement-breakpoint
CREATE INDEX "briefs_correlation_id_idx" ON "briefs" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "agent_runs_agent_started_at_idx" ON "agent_runs" USING btree ("agent","started_at");--> statement-breakpoint
CREATE INDEX "agent_runs_correlation_id_idx" ON "agent_runs" USING btree ("correlation_id");