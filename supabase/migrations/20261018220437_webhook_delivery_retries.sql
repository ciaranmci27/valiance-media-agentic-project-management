-- Outbound webhooks retry on their own.
--
-- A delivery used to get one attempt: a non-2xx or a timeout marked it failed,
-- and a dispatcher that died mid-run left its rows in 'delivering' forever.
-- Now:
--   * a failed attempt goes back to 'pending' with next_attempt_at pushed out
--     (1m, 3m, 9m, 27m, 81m, ~4h, then 12h), and is only 'failed' after the
--     8th attempt (WEBHOOK_MAX_ATTEMPTS below);
--   * a claim is a lease: attempt_token identifies the run that holds it and
--     lease_expires_at says when another run may take it back, so a crashed
--     run's deliveries are retried instead of stuck;
--   * deliveries for one invoice reach one endpoint in sequence order: a
--     delivery waits while an earlier event for the same invoice and endpoint
--     is still pending or in flight. An exhausted ('failed') one stops
--     blocking, so one dead event cannot stall an invoice forever;
--   * Resend in Settings > Webhooks goes through requeue_webhook_delivery,
--     which restarts the attempt budget.
--   * Supabase pg_cron checks every minute and, when something is due, POSTs
--     to the app's /api/internal/webhooks/scheduled (webhook_retry_kick). The
--     app is on Vercel Hobby, which allows only daily crons. Needs two Vault
--     secrets, webhook_scheduler_url and webhook_scheduler_secret, and the
--     same secret in the app as WEBHOOK_SCHEDULER_SECRET (with
--     WEBHOOK_SCHEDULER_ENABLED=true).
-- Payload and signature are unchanged.

-- -- Columns ----------------------------------------------------------------

ALTER TABLE public.webhook_deliveries
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS attempt_token uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

-- Rows a crashed run left in 'delivering' are free to take back at once.
UPDATE public.webhook_deliveries
SET lease_expires_at = now()
WHERE status = 'delivering' AND lease_expires_at IS NULL;

DROP INDEX IF EXISTS public.idx_webhook_deliveries_pending;
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due
  ON public.webhook_deliveries (next_attempt_at)
  WHERE status IN ('pending', 'delivering');

-- -- Claim ------------------------------------------------------------------

-- The return type gains attempt_token, so the old function has to go first.
DROP FUNCTION IF EXISTS public.claim_webhook_deliveries(int);

CREATE OR REPLACE FUNCTION public.claim_webhook_deliveries(p_limit int DEFAULT 20)
RETURNS TABLE (
  delivery_id uuid,
  attempt_token uuid,
  attempts int,
  endpoint_id uuid,
  endpoint_url text,
  endpoint_secret text,
  event_public_id text,
  event_type text,
  event_sequence bigint,
  resource_id uuid,
  payload jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  max_attempts constant int := 8;  -- WEBHOOK_MAX_ATTEMPTS
BEGIN
  -- One claimer at a time, so two runs cannot both pass the ordering check
  -- for the same invoice. Released at commit, before any HTTP happens.
  PERFORM pg_advisory_xact_lock(hashtext('public.claim_webhook_deliveries'));

  -- A lease that ran out on the last attempt has nothing left to retry.
  UPDATE public.webhook_deliveries d
  SET status = 'failed',
      last_error = coalesce(d.last_error, 'Delivery did not finish before its lease expired'),
      attempt_token = NULL,
      lease_expires_at = NULL
  WHERE d.status = 'delivering'
    AND coalesce(d.lease_expires_at, '-infinity') <= now()
    AND d.attempts >= max_attempts;

  RETURN QUERY
  WITH due AS (
    SELECT d.id
    FROM public.webhook_deliveries d
    JOIN public.webhook_events ev ON ev.id = d.webhook_event_id
    JOIN public.webhook_endpoints ep ON ep.id = d.endpoint_id
    WHERE ep.is_active
      AND (
        (d.status = 'pending' AND d.next_attempt_at <= now())
        OR (d.status = 'delivering' AND coalesce(d.lease_expires_at, '-infinity') <= now())
      )
      -- Head of the line: nothing earlier for this invoice and endpoint is
      -- still waiting, and nothing for it is in flight under a live lease.
      AND NOT EXISTS (
        SELECT 1
        FROM public.webhook_deliveries other
        JOIN public.webhook_events other_ev ON other_ev.id = other.webhook_event_id
        WHERE other.endpoint_id = d.endpoint_id
          AND other.id <> d.id
          AND other_ev.resource_type = ev.resource_type
          AND coalesce(other_ev.resource_id, other_ev.id) = coalesce(ev.resource_id, ev.id)
          AND (
            (other.status IN ('pending', 'delivering') AND other_ev.sequence < ev.sequence)
            OR (other.status = 'delivering' AND coalesce(other.lease_expires_at, '-infinity') > now())
          )
      )
    ORDER BY ev.sequence
    LIMIT p_limit
    FOR UPDATE OF d SKIP LOCKED
  )
  UPDATE public.webhook_deliveries d
  SET status = 'delivering',
      attempts = d.attempts + 1,
      last_attempt_at = now(),
      attempt_token = gen_random_uuid(),
      lease_expires_at = now() + interval '2 minutes'
  FROM due, public.webhook_events ev, public.webhook_endpoints e
  WHERE d.id = due.id
    AND ev.id = d.webhook_event_id
    AND e.id = d.endpoint_id
  RETURNING d.id, d.attempt_token, d.attempts,
            e.id, e.url, e.secret,
            ev.event_id, ev.event_type, ev.sequence, ev.resource_id,
            public.webhook_payload_for_endpoint(ev.payload, ev.net_amounts, e.amount_basis);
END;
$$;

-- -- Complete ---------------------------------------------------------------

-- Records one attempt's outcome for the run that holds the lease. Returns
-- 'succeeded', 'retrying' (back to pending at next_attempt_at), 'failed'
-- (attempts used up) or 'stale' (the lease was taken back by another run,
-- which will deliver it again; nothing is written).
CREATE OR REPLACE FUNCTION public.complete_webhook_delivery(
  p_delivery_id uuid,
  p_attempt_token uuid,
  p_status_code int,
  p_error text,
  p_response text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  max_attempts constant int := 8;  -- WEBHOOK_MAX_ATTEMPTS
  d public.webhook_deliveries;
  outcome text;
BEGIN
  SELECT * INTO d FROM public.webhook_deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND OR d.status <> 'delivering' OR p_attempt_token IS NULL
     OR d.attempt_token IS DISTINCT FROM p_attempt_token THEN
    RETURN 'stale';
  END IF;

  outcome := CASE
    WHEN p_status_code BETWEEN 200 AND 299 THEN 'succeeded'
    WHEN d.attempts >= max_attempts THEN 'failed'
    ELSE 'retrying'
  END;

  UPDATE public.webhook_deliveries
  SET status = CASE outcome WHEN 'retrying' THEN 'pending' ELSE outcome END,
      delivered_at = CASE WHEN outcome = 'succeeded' THEN now() ELSE delivered_at END,
      next_attempt_at = CASE
        WHEN outcome = 'retrying'
          THEN now() + least(interval '12 hours', interval '1 minute' * power(3, d.attempts - 1))
        ELSE next_attempt_at
      END,
      last_status_code = p_status_code,
      last_error = CASE WHEN outcome = 'succeeded' THEN NULL ELSE left(p_error, 2000) END,
      last_response = left(nullif(p_response, ''), 2000),
      attempt_token = NULL,
      lease_expires_at = NULL
  WHERE id = d.id;

  IF outcome = 'succeeded' THEN
    UPDATE public.webhook_endpoints SET last_delivery_at = now() WHERE id = d.endpoint_id;
  END IF;
  RETURN outcome;
END;
$$;

-- -- Resend -----------------------------------------------------------------

-- Settings > Webhooks "Resend": a failed delivery starts over with a fresh
-- attempt budget. Runs as the caller, so the webhooks.manage RLS policy
-- decides who may. Returns false when the row is not failed (or not visible).
CREATE OR REPLACE FUNCTION public.requeue_webhook_delivery(p_delivery_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  WITH requeued AS (
    UPDATE public.webhook_deliveries
    SET status = 'pending',
        attempts = 0,
        next_attempt_at = now(),
        last_error = NULL,
        attempt_token = NULL,
        lease_expires_at = NULL
    WHERE id = p_delivery_id AND status = 'failed'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM requeued)
$$;

-- -- Scheduler --------------------------------------------------------------

-- pg_cron runs this every minute. When a delivery is due (a retry whose
-- backoff has passed, a new one the in-app kick missed, or an expired lease)
-- it asks the app to dispatch: POST /api/internal/webhooks/scheduled with
-- WEBHOOK_SCHEDULER_SECRET, read from Vault (webhook_scheduler_url,
-- webhook_scheduler_secret). Idle minutes make no request. Returns the
-- pg_net request id, or null when nothing was sent.
CREATE OR REPLACE FUNCTION public.webhook_retry_kick()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  app_url text;
  secret text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.webhook_deliveries d
    JOIN public.webhook_endpoints e ON e.id = d.endpoint_id
    WHERE e.is_active
      AND (
        (d.status = 'pending' AND d.next_attempt_at <= now())
        OR (d.status = 'delivering' AND coalesce(d.lease_expires_at, '-infinity') <= now())
      )
  ) THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO app_url FROM vault.decrypted_secrets WHERE name = 'webhook_scheduler_url';
  SELECT decrypted_secret INTO secret FROM vault.decrypted_secrets WHERE name = 'webhook_scheduler_secret';
  IF app_url IS NULL OR secret IS NULL THEN
    RAISE NOTICE 'webhook_scheduler_url or webhook_scheduler_secret is missing from Vault; webhook retries wait for the next in-app dispatch';
    RETURN NULL;
  END IF;

  RETURN net.http_post(
    url := rtrim(app_url, '/') || '/api/internal/webhooks/scheduled',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || secret),
    body := '{"source":"pg_cron"}'::jsonb,
    timeout_milliseconds := 60000
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_webhook_deliveries(int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_webhook_delivery(uuid, uuid, int, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.requeue_webhook_delivery(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.webhook_retry_kick() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_webhook_deliveries(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_webhook_delivery(uuid, uuid, int, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.requeue_webhook_delivery(uuid) TO authenticated;

-- Supabase only: skipped where pg_cron or pg_net is unavailable (PGlite).
-- Re-running cron.schedule updates the job in place.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_net') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    CREATE EXTENSION IF NOT EXISTS pg_net;
    PERFORM cron.schedule('webhook-retries', '* * * * *', $job$SELECT public.webhook_retry_kick();$job$);
  ELSE
    RAISE NOTICE 'pg_cron or pg_net is unavailable here; webhook retries will not be scheduled';
  END IF;
END;
$do$;
