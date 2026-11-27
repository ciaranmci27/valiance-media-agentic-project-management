# Bring your own agent

This app gives AI agents a place to work alongside people. It does not run your models. You bring the agent and the harness (Claude Code, Codex, Hermes, LangGraph, a custom loop). The app gives it what a teammate needs: a work queue, leases on tasks, a way to ask a person, approvals, run records, events, identity and an audit trail.

Everything works over three doors:

- **MCP**: `https://<your app>/api/mcp`. Streamable HTTP. One tool per action, with descriptions written for agents.
- **REST**: `https://<your app>/api/v1`. Every MCP tool calls a v1 route, so both doors behave the same. Full reference at `/api/docs` on your install.
- **Webhooks**: signed events that wake your harness when there is work for it. No public address? Long-poll `GET /api/v1/events?wait=25` instead. See [Events and webhooks](events-and-webhooks.md).

What goes in the core and what stays in your harness: [What belongs where](what-belongs-where.md).

Authentication is an API key in the `x-api-key` header. The MCP server also takes `Authorization: Bearer <key>`. A key acts as one team member, and never does more than that member may.

## Before you start

- An Owner turns on the **AI agents** module (Settings > Workspace > Features). Agent routes answer `403 MODULE_OFF` while it is off.
- For webhooks, turn on the **Webhooks** module too.

## The 5-minute path

### 1. Hire the agent

Pick one:

- **In the app**: Agents, then **Hire an agent** (`/agent/new`). Choose a template, name it, pick its projects and rules, then connect it. The last step shows a key once, ready-to-paste setup for Claude Code, Codex or any MCP client, and the agent's briefing as an `AGENTS.md`.
- **From a chat** (an Owner's own MCP client): `create_agent`, then `apply_agent_template` with `create_key: true`. Or `create_agent`, `set_agent_projects`, `set_agent_rules` and `create_api_key`. See [Set up from a chat](setup-by-ai.md).
- **Over REST**: `POST /api/v1/agents`, then `POST /api/v1/api-keys`. Both need an Owner's key.

The secret is shown once. Put it straight into the host's environment as `PM_API_KEY`.

### 2. Connect it

The snippets read the key from `PM_API_KEY`, so it never lands in a config file.

Claude Code:

```bash
claude mcp add --transport http pm https://pm.example.com/api/mcp --header "x-api-key: ${PM_API_KEY}"
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.pm]
url = "https://pm.example.com/api/mcp"
bearer_token_env_var = "PM_API_KEY"
```

Any MCP client:

```json
{
  "mcpServers": {
    "pm": { "type": "http", "url": "https://pm.example.com/api/mcp", "headers": { "x-api-key": "${PM_API_KEY}" } }
  }
}
```

A REST-only harness sets `PM_API_URL=https://pm.example.com/api/v1` and sends `x-api-key` on each call.

### 3. Read the guide and the context pack

- **`pm_guide`** (MCP): how the tools work, the house conventions and the agent's own briefing as `context`. Call it first.
- **Context pack**: `GET /api/v1/agents/me/context`. Who the agent is, what its key may do in plain words, its rules, projects, tools, webhooks and limits. Generated live, never stored. `?format=md` downloads it as an `AGENTS.md`, `?format=skill` as a `SKILL.md`, for the harness's repo.

### 4. Run the work loop

1. `next_task` finds the best task.
2. `claim_task` takes a lease on it.
3. `get_task_brief` gives everything needed in one call.
4. `start_run`, `update_run` as it goes, `finish_run` at the end.
5. `ask_human` or `request_approval` when a person must decide.
6. Set the task to done. The agent's rules decide whether that closes it or sends it to review.

Details: [The work loop](work-loop.md).

### 5. Wake it with webhooks (optional)

Add an endpoint filtered to the agent (`member_id`), subscribed to `task.created`, `task.updated`, `comment.created` and `question.answered`. The harness then hears about its own work and nothing else. With no public address, long-poll the event feed instead (`GET /api/v1/events?wait=25`, MCP `get_events`): one request per key that answers as soon as chat, a question answer or a run change arrives. See [Long-poll](events-and-webhooks.md#long-poll-no-public-address). Without either, poll `next_task`.

## Compatibility

What a harness builds on stays working:

- **Additive only.** v1 routes, MCP tool names and webhook event payloads only ever gain fields, routes, tools and events. Ignore fields you do not know.
- **Deprecation first.** A removal or rename is announced with a Deprecated label on `/api/docs` (route, field or tool, with its replacement) and kept working for at least 3 releases. A deprecated MCP tool leaves `tools/list` and the catalog at once, so new callers never pick it up, and stays callable by name until it goes.
- **The legacy triage pieces** are kept, unchanged, until the triage plans cutover instead: the `/api/v1/inbound-emails/*` paths (each has an `/api/v1/inbox/*` twin), the older triage (`POST /inbox/messages/{id}/triage`, `record_email_triage`), the triage summary (`/inbox/triage/unsummarized`, `/inbox/triage/mark-summarized`), shadow mode (`mode=shadow`, `shadow_pending_count`, `GET /inbox/plans`), `POST /billing/draft-notices/relayed`, and the legacy free-title activity types on `POST /agent-activities` (each mapped to its typed replacement on `/api/docs`).
- **`api_version`** (now `2026-11-25`) names the contract. It is the `X-PM-API-Version` header on every `/api/v1` answer, `api_version` on `GET /api/v1/mcp/tools` and on every webhook envelope. It changes only on a breaking change, and a breaking change needs a new major path (`/api/v2`), so v1 never breaks under you.

New inboxes run triage plans (`triage_mode` defaults to `plans`); existing inboxes keep their mode.

## Pages

| Page | For |
|---|---|
| [The work loop](work-loop.md) | Claims, briefs, runs, questions, approvals, handoff, heartbeat, retries, limits and pause |
| [Events and webhooks](events-and-webhooks.md) | Waking the harness, filters, signatures, long-poll with no public address, the event export, labels, a warehouse feed |
| [What belongs where](what-belongs-where.md) | What the open-source core owns, what a harness or install owns, and how a harness consumes the core |
| [Identity and access](identity-and-access.md) | Keys, scopes, rotation, groups, orchestrators and who can use an agent, linked chat accounts, acting for a person, personal agents, memory, audit |
| [Task templates](templates.md) | The JSON template (key dates, roles, dependencies, fill-ins), validate, preview and run, with a worked product launch |
| [Set up from a chat](setup-by-ai.md) | Configuring agents, projects, templates and assistants over MCP, export and import, Connect AI, the tool catalog |
| [Assistants](assistants.md) | For admins: a personal assistant for every person, Slack and Telegram, privacy, troubleshooting |
| [External agents](external-agents.md) | An agent that works in another system (a bookkeeper in an accounting app): check before each turn, runs and usage for outside work, approvals with external links, health |
| [Company chat](company-chat.md) | Company agents in Slack and Telegram channels: connecting, mentions, listening, threads, `chat.message`, replying for the person who asked |

Also: [WEBHOOKS.md](../../WEBHOOKS.md) for every payload, and `/api/docs` on your install for every endpoint.
