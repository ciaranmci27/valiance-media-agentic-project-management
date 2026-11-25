# Bring your own agent

This app gives AI agents a place to work alongside people. It does not run your models. You bring the agent and the harness (Claude Code, Codex, Hermes, LangGraph, a custom loop). The app gives it what a teammate needs: a work queue, leases on tasks, a way to ask a person, approvals, run records, events, identity and an audit trail.

Everything works over three doors:

- **MCP**: `https://<your app>/api/mcp`. Streamable HTTP. One tool per action, with descriptions written for agents.
- **REST**: `https://<your app>/api/v1`. Every MCP tool calls a v1 route, so both doors behave the same. Full reference at `/api/docs` on your install.
- **Webhooks**: signed events that wake your harness when there is work for it. See [Events and webhooks](events-and-webhooks.md).

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

Add an endpoint filtered to the agent (`member_id`), subscribed to `task.created`, `task.updated`, `comment.created` and `question.answered`. The harness then hears about its own work and nothing else. Without webhooks, poll `next_task`.

## Pages

| Page | For |
|---|---|
| [The work loop](work-loop.md) | Claims, briefs, runs, questions, approvals, handoff, heartbeat, retries, limits and pause |
| [Events and webhooks](events-and-webhooks.md) | Waking the harness, filters, signatures, the event export, labels, a warehouse feed |
| [Identity and access](identity-and-access.md) | Keys, scopes, rotation, groups, linked chat accounts, acting for a person, personal agents, memory, audit |
| [Set up from a chat](setup-by-ai.md) | Configuring agents, projects, templates and assistants over MCP, export and import, Connect AI, the tool catalog |
| [Assistants](assistants.md) | For admins: a personal assistant for every person, Slack and Telegram, privacy, troubleshooting |

Also: [WEBHOOKS.md](../../WEBHOOKS.md) for every payload, and `/api/docs` on your install for every endpoint.
