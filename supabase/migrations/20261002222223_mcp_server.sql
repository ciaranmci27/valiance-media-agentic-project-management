-- PM MCP server (/api/mcp). It is a second front door to the v1 API, not a
-- second API: every tool call runs the same route handler through withApi,
-- with the same key, scopes, member permissions and rate limit.
--
-- team_members.agent_profile decides which tools an agent sees (generic,
-- coordinator, builder, auditor, reviewer). The owner sets it in Team; it
-- only ever narrows what the key could do. api_audit_log.via records whether
-- a write came over REST or MCP.

ALTER TABLE public.team_members ADD COLUMN IF NOT EXISTS agent_profile TEXT NOT NULL DEFAULT 'generic'
  CHECK (agent_profile IN ('generic', 'coordinator', 'builder', 'auditor', 'reviewer'));

ALTER TABLE public.api_audit_log ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT 'rest'
  CHECK (via IN ('rest', 'mcp'));
