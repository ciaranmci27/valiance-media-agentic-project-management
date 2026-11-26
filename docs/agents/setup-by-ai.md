# Set up from a chat

Everything the agent setup screens do is also an MCP tool and a REST route. An Owner can connect their own AI tool to the MCP server and say "set up a triage agent for the Support project", and the AI does it through the same checks as the screens.

## Who sees the setup tools

A tool shows up only for a key that holds its permission, on both the key and its member, with its module on. Setup tools need Owner-level permissions (`team.manage`, `api_keys.manage_all`, `webhooks.manage`, `assistants.provision`), so in practice:

- **An Owner's own key** in their MCP client sees them, and `pm_guide` adds a setup section.
- **Agents' keys** normally do not, so their tool list stays about doing the work.
- **A person's connected AI tool** (Connect AI) does not, even for an Owner, except for the hour an Owner lets it set up agents (below).

## Set up agents with AI (one hour)

The first screen of Hire an agent (`/agent/new`) asks: **Set it up with AI** (recommended) or **Step by step**. With AI, an Owner lets their own AI tool do the setup for one hour:

- **A connected tool** (Connect AI): "Let Claude set up agents for the next hour", after a consent step that lists exactly what it allows. For that hour the connection also gets the agent setup tools below, with the Owner's own API powers. Its other tools stay what they were.
- **No connected tool**: a one-hour setup key of the Owner's own (`pk_setup_...`, shown once), with copy-ready settings that carry it in a header, never the URL. It carries only `team.read`, `team.manage`, `project_members.manage`, `projects.read`, `api_keys.manage_all` and `webhooks.manage`, and works on the setup routes only (`403 ai_setup_only` anywhere else).

A ready prompt to copy tells the AI to read `pm_guide` first (in a session it explains the session and lists the agent templates), ask what it needs, hire each agent with `hire_agent`, and read each one back. The page lists each agent as the AI hires it, with its role, powers and projects, and a link to its profile.

The rules:

- **Setup tools only**: `pm_guide`, `list_agent_templates`, `list_agent_profiles`, `list_projects`, `list_team`, `list_groups`, `list_agents`, `get_agent_setup`, `get_agent_context`, `hire_agent`, `create_agent`, `apply_agent_template`, `update_agent`, `set_agent_projects`, `set_project_agent`, `remove_project_agent`, `create_api_key`, `list_webhook_endpoints`, `create_webhook_endpoint` (the list is `AI_SETUP_TOOLS` in `src/lib/ai-setup.ts`).
- **Agents only**: a key or a webhook it makes names an agent (`member_id`), never a person or the Owner; every agent a call names must be an agent (`403 ai_setup_agents_only`).
- **Never more than the Owner**: every call goes through the same routes and checks as the screens (`hireAgent`, the scope grants, the key rules), against the Owner's live access. Only an Owner starts one; someone who stops being one loses it at once.
- **It ends on its own** after an hour. **End now** on the same page or in Settings > Account > Connect AI stops it at once (a setup key is disabled). The agents and keys it made stay.
- **Audited**: starting and ending are recorded as the Owner (`entity_type: ai_setup_session`); each change it makes is recorded with the tool's key (`api_key_id`), the Owner as `team_member_id` and `principal_id`, and `via` `mcp_oauth` (a connected tool) or `mcp` / `rest` (a setup key).

Session routes (signed in): `GET /api/workspace/ai-setup` (connected tools, live and recent sessions, the agents each made), `POST /api/workspace/ai-setup` (`{ kind: "connection", grant_id }` or `{ kind: "key" }`), `DELETE /api/workspace/ai-setup/{id}`.

Secrets (keys, signing secrets) come back once. The AI should hand them straight to the person or the agent's host, never into a task, comment or reminder.

## Set up an agent

One call does it all: `hire_agent` (`POST /api/v1/agents/hire`), the same as the Hire an agent screen: name, `template_key`, `project_ids` with `project_settings`, owners, rules, and with `create_key` a key carrying `scopes`. Everything is checked before anything is written; a failure partway undoes what it made.

Or step by step, in the order `pm_guide` recommends:

1. `create_agent`: name, and an email only this agent uses. Optional title, role label, description, owners and `agent_profile`. Owner keys only. (`POST /api/v1/agents`)
2. `apply_agent_template` (optional): a template's rules, and with `create_key: true` a key with its scopes. (`POST /api/v1/agents/{id}/template`)
3. `set_agent_projects`: which projects it may open. (`PATCH /api/v1/agents/{id}/projects`)
4. `set_project_agent`: its assignment on a project, with the template's settings and instructions for that project only. (`PUT /api/v1/projects/{id}/agents/{agentId}`)
5. `set_agent_rules` or `update_agent`: self-assign, close policy, create policy, who it escalates to, its owners. `update_agent` also sets its limits (an Owner only) and pauses or resumes it.
6. `create_api_key`: unless the template step made one. (`POST /api/v1/api-keys`)
7. `create_webhook_endpoint` with `member_id` set to the agent, so its harness wakes on its own work.
8. `get_agent_setup`: read the whole setup back and confirm it with the person.

Then `get_agent_context` with `format: "md"` gives the `AGENTS.md` to hand the agent's host.

Other tools: `list_agents` (filter by role, owner, template, project), `remove_project_agent`, `list_api_keys`, `revoke_api_key`, `rotate_api_key`, `list_webhook_endpoints`, `update_webhook_endpoint`, `delete_webhook_endpoint`.

What an agent may do comes from its role and its overrides, set by an Owner in Team > Roles & permissions. A key carries only scopes the agent holds and the calling key carries. If something is missing, the AI tells the person what to grant; it cannot widen either.

## Set up a project

`setup_project` (`POST /api/v1/projects/setup`) does it in one call:

- `project`: the fields `POST /api/v1/projects` takes;
- `members`: member ids;
- `brief`: entries with `section` (overview, goals, rules, decisions, links, glossary, history), `content` and `pinned`;
- `goals`: title, description, target date;
- `agents`: agent id, template, settings, instructions, status.

Every part is checked before anything is written. Pinned brief entries go into every agent's context pack and task brief.

## Knowledge at every level

| Level | Who writes | Tool |
|---|---|---|
| Company (`workspace`) | An Owner, or `settings.manage` | `add_context` |
| Group (`group`) | Its managers, and members with `project_context.manage` | `add_context` |
| Project brief (`project`) | `project_context.manage` | `add_project_context`, `add_context` |
| Agent notes (`agent`) | The agent itself, and people who manage it | `add_context` |
| Personal memory (`member`) | The person, and their own assistant while they allow it | `add_context` |

`search_context` searches every level the caller can read. REST: `/api/v1/context` and `/api/v1/context/search`.

## Templates

A template is a starting setup: rules, suggested key scopes, suggested webhook events, a brief added to the agent's context, an optional starting role, profile and limits, and the settings fields it fills in per project.

Core ships: `data-health-watcher`, `inbox-triage`, `builder`, `weekly-reporter`, `personal-assistant` and `external-agent` (works in another system: no projects, no task queue; see [External agents](external-agents.md)).

Add your own two ways:

- **In code**: `src/custom/agent-templates.ts` in your install. Reviewed and deployed with your code.
- **As data**: `create_agent_template` (`POST /api/v1/agent-templates`), `update_agent_template` to change or archive one. Owner only, no deploy needed. A key that code already uses is refused (`409 registry_key_taken`).

Templates grant nothing the caller could not grant: applying one needs every scope it suggests (`403 scope_escalation` otherwise).

## Profiles

A profile names which MCP tools an agent sees. Core ships `generic`: every tool its keys allow.

- **In code**: `src/custom/agent-profiles.ts`.
- **As data**: `create_agent_profile` (`POST /api/v1/agent-profiles`), `update_agent_profile`. A profile agents still use cannot be archived (`409 profile_in_use`).

A profile only narrows. The key still decides what each call may do.

## Assistant setups

To give every person their own assistant ([Assistants](assistants.md)):

1. `create_assistant_setup`: a role (`match_role`) or a group (`match_group_id`), and a template (default `personal-assistant`).
2. `provision_assistants` with `dry_run: true`. Read the plan back to the person.
3. `provision_assistants` again without `dry_run`, until `remaining` is 0.
4. The host that runs them collects each key once (`list_assistants` with `needs_key: true`, then `POST /api/v1/assistants/{id}/key`, REST only).

Also: `list_assistant_setups`, and `PATCH` or `DELETE /api/v1/assistant-setups/{id}`.

## Export and import

### One agent

- `export_agent_config` (`GET /api/v1/agents/{id}/export`): the agent's setup as a file (format `pm-agent-config`). No secrets, no hashes.
- `import_agent_config` (`POST /api/v1/agents/import`): create a new agent from it, or update one with `agent_id`.

Import rules:

- Run `dry_run: true` first and read the plan back.
- Projects and the escalation target match by id, then by exact name. Anything that does not match is listed in `unmatched`, never guessed.
- Projects are only added, never removed.
- Keys are made only with `create_keys`, webhook endpoints only with `create_webhooks`. Their secrets are in that answer only.
- If it fails partway, the keys and endpoints it made are revoked or deleted, and it answers `500 IMPORT_INCOMPLETE` saying what remains.

### Templates and profiles

- `export_agent_registries` (`GET /api/v1/agent-registries/export`): the workspace's own templates and profiles as one document. Code's are left out; they ship with the code.
- `import_agent_registries` (`POST /api/v1/agent-registries/import`): create or update each one. `dry_run: true` first. Refused entries are listed with why.

Use these to copy a setup from a staging install to production.

## Connect AI: people's own AI tools

Anyone can connect Claude, ChatGPT, Cursor, Claude Code or Codex to their own work. No key changes hands.

For a person:

1. Open Settings > Account > Connect AI.
2. Copy the MCP address and paste it into the AI tool.
3. Sign in to the app when the tool asks, and choose Allow.

A personal key is offered for tools that cannot sign in.

What a connected tool may do: the person's own projects, tasks, comments, questions and reminders, never more than they can. Never admin powers, keys, people, settings or agents, even for an Owner, unless an Owner lets it set up agents for an hour ([above](#set-up-agents-with-ai-one-hour)). With the person's tick on the consent screen, it also reads and adds to their personal memory.

Each person sees their connected apps and can disconnect any of them. An Owner turns connections off for everyone in Settings > Security (`403 connect_ai_off`). Suspending a person disconnects their tools for good.

For tool builders, the MCP server is an OAuth 2.1 protected resource:

| Step | Where |
|---|---|
| Discovery | `/.well-known/oauth-protected-resource` (also with `/api/mcp` after it), `/.well-known/oauth-authorization-server` |
| Registration | `POST /api/oauth/register` (open client registration) |
| Authorization | `GET /oauth/authorize`, code flow with PKCE (`S256` required) and `resource` set to the MCP address |
| Tokens | `POST /api/oauth/token`: `authorization_code` and `refresh_token`. Refresh tokens rotate; reusing an old one revokes the connection. |

Access tokens last an hour, refresh tokens 30 days. Send the token as `Authorization: Bearer` on the MCP server and `GET /api/v1/mcp/tools`. Other v1 routes refuse it (`401 connect_token_not_accepted`). Audit rows record `via: mcp_oauth`.

## The tool catalog: re-offering these tools

An enterprise's own MCP gateway can offer this app's tools inside its own.

1. Read `GET /api/v1/mcp/tools`. It lists every tool the caller may use, with `name`, `description`, `inputSchema` (JSON Schema), `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`) and `routes` (the v1 calls each makes), plus a `version` to cache by.
2. Read it per person (or per agent and person) when what people may do differs.
3. Forward each call to this app's MCP server as the person who asked:
   - with the person's own Connect AI token, as `Authorization: Bearer`; or
   - with your agent's key, holding `agents.act_for`, plus a delegation pass for that person in `X-Act-For` ([Acting for a person](identity-and-access.md#acting-for-a-person)).
4. Forward arguments unchanged. Every call still goes through this app's permissions, project reach, rate limit and audit log, so the gateway cannot widen what a person may do.
