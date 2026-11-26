-- Set up agents with AI: an Owner lets their own AI tool hire and configure
-- agents for one hour, from the first screen of Hire an agent.
--
-- - pm.ai_setup_sessions: one hour of agent setup by an AI tool, for one
--   person (an Owner). Either a connected AI tool (kind connection, its
--   pm.oauth_grants row), whose calls on the agent setup routes carry the
--   person's own API powers while the session lives, or a setup key (kind
--   key, an API key of the person's own that lasts as long as the session
--   and works on the setup routes only). scopes are the person's API powers
--   when the session started; every call is checked against their access
--   again. A session ends on its own at expires_at, or early (ended_at)
--   when the person ends it; ending a key session disables its key.
--   Server only: members hold nothing on it.
--
-- Additive and safe to run twice. The previous release's code never reads
-- the table and keeps working: no session exists until this release's code
-- makes one.

CREATE TABLE IF NOT EXISTS pm.ai_setup_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES pm.team_members(id) ON DELETE CASCADE,
  kind text NOT NULL,
  -- The connection it elevates (kind connection).
  grant_id uuid REFERENCES pm.oauth_grants(id) ON DELETE CASCADE,
  -- The key its calls come with: the connection's key, or the setup key.
  api_key_id uuid REFERENCES pm.api_keys(id) ON DELETE SET NULL,
  client_name text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  ended_by uuid REFERENCES pm.team_members(id) ON DELETE SET NULL,
  CONSTRAINT ai_setup_sessions_kind_check CHECK (kind IN ('connection', 'key')),
  CONSTRAINT ai_setup_sessions_target_check CHECK (
    (kind = 'connection' AND grant_id IS NOT NULL) OR (kind = 'key' AND grant_id IS NULL)
  ),
  CONSTRAINT ai_setup_sessions_length_check CHECK (expires_at > created_at AND expires_at <= created_at + interval '2 hours')
);

COMMENT ON TABLE pm.ai_setup_sessions IS
  'One hour of agent setup by an AI tool for a person (an Owner): a connected tool elevated to the agent setup routes, or a setup key. Ends at expires_at or when ended early.';

CREATE INDEX IF NOT EXISTS idx_ai_setup_sessions_grant ON pm.ai_setup_sessions (grant_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ai_setup_sessions_key ON pm.ai_setup_sessions (api_key_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ai_setup_sessions_member ON pm.ai_setup_sessions (member_id, created_at DESC);

ALTER TABLE pm.ai_setup_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pm.ai_setup_sessions FROM PUBLIC, anon, authenticated;
