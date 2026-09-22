-- Spec 13: the daily model spend ceiling defaults to GBP 15 and is changed
-- from Settings, like the quiet hours and the push budget beside it. The
-- worker reads it from this row on every run, so a change applies at once.

ALTER TABLE system_state ADD COLUMN cost_ceiling_gbp numeric(10,2) DEFAULT 15 NOT NULL;
