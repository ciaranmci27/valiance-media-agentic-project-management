-- Team invites: the app's own set-your-password links.
--
-- Inviting someone makes one row here: the sha256 of a random token (the
-- token itself is only ever in the link), who it is for, and a 7-day expiry.
-- The public set-password route checks the hash, the expiry, that it is
-- unused and that the person has never signed in, then sets their password
-- and marks the row used. A new invite or a resend deletes the person's
-- unused rows first, so only the newest link works.
--
-- Service role only: row level security on with no policies, and no grants
-- to anon or authenticated. Additive and safe to re-run; the 1.5.0 code
-- never reads it.

CREATE TABLE IF NOT EXISTS public.team_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  used_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_team_invites_member ON public.team_invites(member_id);

ALTER TABLE public.team_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.team_invites FROM anon, authenticated;
