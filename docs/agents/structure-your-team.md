# How to structure your agent team

The simplest team that works, for a company of any size. Start here, then grow it one agent at a time.

## The shape

1. **One personal assistant per person.** Each person gets their own assistant. It works only for them, within what they can see: their tasks, reminders and inbox, from their own chat. Give one from Hire > Personal assistant, or give everyone one by role or group in the assistants settings.
2. **One company orchestrator.** Work for the company reaches the orchestrator first. It hands each piece to the right agent on its team, settles their blockers and questions itself, and keeps the parent task up to date. Hire it from the **Orchestrator** template.
3. **Specialists under the orchestrator.** A builder, a reviewer, a triage agent, a reporter: each works for the orchestrator (Access > Works for). Add a second orchestrator under the first only when one team grows too big to route well, up to four levels.
4. **People only for real decisions.** Agents ask their orchestrator first. The orchestrator brings a person only what only a person can decide (money, a client, anything that cannot be undone), as one short question with choices. It lands in Needs you, answered in one click.

```
You and your team
  each person ── their personal assistant

The company
  Orchestrator
    ├── Builder
    ├── Reviewer
    └── Inbox triage
```

## The rules the app keeps

- **No skipping levels.** An agent hands work only to the agents directly under it. To reach an agent further down, work goes through the agent above it (`403 not_your_report` otherwise).
- **Who can use an agent narrows down the chart.** A person may use an agent only if they are in its own "Who can use it" and in every orchestrator's above it. The agent's Access tab shows the limit it inherits in plain words.
- **Only through its orchestrator.** Turn it on for a specialist and people reach it only by asking its orchestrator.
- **Ask first.** Turn it on and the agent's managers approve once before it takes work from someone who does not manage it.
- **Acting for the person who asked.** A company agent works for the person behind each request, within what that person may do, at every hop of the chain.

## What it may do: one list

An agent's powers and its key are one list, on its Access tab (`GET`/`PUT /api/v1/agents/{id}/powers`). Saving puts the list on every key it has, so a key never lacks what the agent was given, and the agent never keeps a power no key shows. Replace a key in one click when it leaks or a host moves; revoke keys nobody used in 90 days from Settings > Developers.

## Setting it up

- **On the screens**: Hire > Company agent walks through template, who it works for, who can use it, what it may do, connect, and ends with "It works, try it". When you hire a second company agent and none has an orchestrator yet, the hire screen suggests adding one.
- **From a chat**: an Owner's own AI tool can do the same. See [Set up from a chat](setup-by-ai.md): hire the orchestrator first (`hire_agent` with `template_key: "orchestrator"`), then each specialist, then set `orchestrator_id` with `set_agent_access`.
