-- Integration secrets an Owner sets in the app instead of the host's
-- environment variables (Settings > Email > Receiving, Settings > Updates,
-- Settings > Developers > Webhooks). Each value is sealed with the app key
-- (APP_ENCRYPTION_KEY) by the server before it is stored, bound to its name,
-- so this table only ever holds ciphertext. No API role can read or write it:
-- only the app's server (service role) does. The environment variables stay
-- as a fallback.
-- Also: webhook retries without hand-made secrets. A service-role-only
-- function writes the scheduler secret and the app URL into Supabase Vault,
-- under the two fixed names the retry job reads, and nothing else.
-- Additive and safe to run twice; 1.9 code never reads it.

CREATE TABLE IF NOT EXISTS public.app_secrets (
  name text PRIMARY KEY CHECK (name IN (
    'resend_api_key',
    'resend_webhook_secret',
    'github_token',
    'github_repo',
    'webhook_scheduler_secret'
  )),
  value text NOT NULL CHECK (value LIKE 'pm1:%'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.app_secrets IS
  'Integration secrets set in the app, sealed with APP_ENCRYPTION_KEY by the server. Service role only.';

ALTER TABLE public.app_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_secrets FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_secrets TO service_role;

-- Vault is a Supabase extension; without it the function is not made and the
-- app says webhook retries need it.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault') THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public.store_webhook_scheduler(p_url text, p_secret text)
      RETURNS void
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = ''
      AS $body$
      DECLARE
        existing uuid;
      BEGIN
        IF p_url IS NULL OR p_url !~ '^https?://' THEN
          RAISE EXCEPTION 'The app URL must start with http:// or https://';
        END IF;
        IF p_secret IS NULL OR length(p_secret) < 32 OR length(p_secret) > 512 THEN
          RAISE EXCEPTION 'The scheduler secret must be 32 to 512 characters';
        END IF;
        -- Only these two names, which public.webhook_retry_kick() reads.
        SELECT id INTO existing FROM vault.secrets WHERE name = 'webhook_scheduler_url';
        IF existing IS NULL THEN
          PERFORM vault.create_secret(p_url, 'webhook_scheduler_url', 'PM app: where webhook retries are sent');
        ELSE
          PERFORM vault.update_secret(existing, p_url);
        END IF;
        SELECT id INTO existing FROM vault.secrets WHERE name = 'webhook_scheduler_secret';
        IF existing IS NULL THEN
          PERFORM vault.create_secret(p_secret, 'webhook_scheduler_secret', 'PM app: bearer secret for webhook retries');
        ELSE
          PERFORM vault.update_secret(existing, p_secret);
        END IF;
      END;
      $body$
    $fn$;
    EXECUTE 'REVOKE ALL ON FUNCTION public.store_webhook_scheduler(text, text) FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.store_webhook_scheduler(text, text) TO service_role';
  END IF;
END
$do$;
