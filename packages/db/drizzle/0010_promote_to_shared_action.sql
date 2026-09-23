-- The promote_to_shared action class (ADR 0017, ADR 0019): private evidence
-- becomes shared context only through a decided proposal. Hard floor at
-- propose, in packages/policy.

ALTER TYPE "public"."action_class" ADD VALUE IF NOT EXISTS 'promote_to_shared';
