-- The organisation's daily spend ceiling across every principal defaults to
-- GBP 30 (Dom, 2026-09-24, after the Phase 5 load test): one busy morning for
-- two principals fits under it. Only the default changes; an environment's
-- existing value stays until an admin sets it (admin.setOrganisationCeiling).

ALTER TABLE "system_state" ALTER COLUMN "cost_ceiling_gbp" SET DEFAULT 30;
