-- An alert folded into an "and N more" overflow post (spec 9.4) shares that
-- post with the other alerts it was batched with. It has no card of its own,
-- so it must not carry the shared ts in slack_ts, where delivery would try to
-- redraw it as a card. batch_ts records the overflow post instead.

ALTER TABLE alerts ADD COLUMN batch_ts text;
