-- Hardens the automated client-communications pipeline against two
-- production failure modes:
--
--   1. Duplicate emails from concurrent eval runs. Two timer stops
--      (or a stop + a budget change) can each read the dedup table,
--      both find the same threshold/milestone "not handled yet", and
--      both insert + send. We add partial unique indexes so the second
--      insert fails at the database, never reaches the SMTP layer.
--
--   2. Lost plain-text bodies on approval. The original send stored
--      only rendered_html, so approving a queued row sent only the
--      HTML alternative (worse deliverability + no a11y fallback).
--      We add rendered_text alongside rendered_html.
--
-- The unique indexes intentionally exclude rows with status='failed'
-- so a failed send doesn't permanently block retries on the next
-- evaluation. They also COALESCE the optional metadata fields to ''
-- because Postgres treats NULL as distinct in unique indexes by
-- default, which would defeat the dedup for legacy rows missing
-- those fields.

ALTER TABLE public.client_communications
  ADD COLUMN IF NOT EXISTS rendered_text text;

CREATE UNIQUE INDEX IF NOT EXISTS ux_client_comm_threshold_dedup
  ON public.client_communications (
    project_id,
    ((metadata->>'threshold')::int),
    coalesce((metadata->>'fired_under_budget_type'), ''),
    coalesce((metadata->>'fired_under_history_id'), '')
  )
  WHERE notification_type = 'budget_threshold'
    AND status <> 'failed'
    AND metadata ? 'threshold';

CREATE UNIQUE INDEX IF NOT EXISTS ux_client_comm_dollar_interval_dedup
  ON public.client_communications (
    project_id,
    ((metadata->>'milestone')::numeric)
  )
  WHERE notification_type = 'dollar_interval'
    AND status <> 'failed'
    AND metadata ? 'milestone';
