-- Inbound commitments that may not be owed to the principal (ADR 0037).
--
-- The recorder gives a commitment this status when the extractor could not
-- say for certain that the promise was made to the principal. The chase job,
-- the overdue alert and the briefs read only open and chased commitments,
-- so an unconfirmed one waits on the Commitments page's triage tab until the
-- principal opens or drops it. The value is added, never used, in this
-- migration: PostgreSQL does not let a new enum value be used in the
-- transaction that adds it.

ALTER TYPE "public"."commitment_status" ADD VALUE 'unconfirmed';
