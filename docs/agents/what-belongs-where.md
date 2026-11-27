# What belongs where

The app is the open-source core every install runs. Your agents run in a harness you bring (Claude Code, Codex, Hermes, LangGraph, a custom loop). This page draws the line, so a feature lands where it can be shared and nothing an install needs is locked inside one harness.

The rule: **if every install would want it and it decides who may do what, it is core. If it is how one company runs its agents, it is the harness or the install.**

## In the core

| Area | What the core owns |
|---|---|
| Identity and permissions | Members, agents, API keys and their scopes, roles, groups, linked chat accounts, acting for a person (`X-Act-For`), the audit log. The core is the only place that decides what a key may do. |
| Chat routing | Chat connections, which agent a message goes to, mentions and listening, `act_for` for company requests, replies under the agent's name, rate limits. |
| The work loop | The queue (`next_task`), claims and leases, briefs, runs, questions, approvals, handoff, heartbeat, limits and pause. |
| Approvals | Who must decide, how they decide, and what an agent may do before and after. |
| Events | Webhooks (signed, retried), the long-poll feed (`GET /api/v1/events`), the agent event export. One contract, documented, additive only. |
| Setup | Hiring an agent, templates, connecting a harness, the context pack and `pm_guide`, AI-guided setup. |
| Docs | Everything a harness builder needs, in `docs/agents/` and at `/api/docs`. |

## In the harness or the install

| Area | Examples |
|---|---|
| Agent personas and prompts | System prompts, tone, skills, the agent's own instructions beyond its briefing. |
| Host scripts | Dispatchers that wake agents, gates that decide when a turn may run, updaters, watchdogs for the host itself, cron jobs on your server. |
| Model choices | Which provider and model, fallbacks, token budgets inside a turn, model followers. |
| Its own chat bots | A bot the harness runs itself (outside the core's chat connections) and how it talks. |
| Server wiring | Containers, tunnels, process managers, secrets on the host, backups of the harness's own state. |
| Install-only features | Pages, tabs, API routes and tables one company needs: `src/custom` and `supabase/migrations/custom` (see the root `AGENTS.md`). |

If a harness script starts deciding permissions, routing or approvals, that logic belongs in the core: propose it (skill `pm-propose-core-change`) so every install gets it and it is enforced in one place.

## How a harness consumes the core

A harness never reads the database. It uses three doors, all as one API key acting as one member:

1. **MCP** (`/api/mcp`): tools for the work loop, chat, questions and setup. Best for an agent that works in turns.
2. **REST** (`/api/v1`): the same actions; every MCP tool calls a v1 route.
3. **Events**, to know when to act:
   - **Webhooks** when the harness has a public address (signed, retried, nothing runs while idle).
   - **Long-poll** when it has only outbound connections: one `GET /api/v1/events?wait=25` loop per key, cursor saved after each batch.
   - **The agent event export** for a data system that wants every event in order.

See [Events and webhooks](events-and-webhooks.md) for the loop, failure handling and cost, and [The work loop](work-loop.md) for what to do once woken.

A harness that wakes on an event still reads current state before it acts: events say something changed, the routes say what is true now.
