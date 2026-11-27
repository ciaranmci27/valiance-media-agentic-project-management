# Security model

What the app guarantees on its own, what you set up once as the person running an install, and what no app can promise. Read it before you give agents real work.

## What the app guarantees

**Agents only ever narrow what a person can do.**

- An agent holds only the powers you gave it, on both its key and its own account. A key never carries more than the person who made it holds.
- Acting for someone (X-Act-For) is the agent's powers and that person's together, never more than either. An agent may act for a person in chat only right after that person wrote to it (within 30 minutes), or when the person allows it from the app while signed in.
- Agents do not send email. They draft replies that a person copies. In chat they message only their own person, a channel an Owner mapped to them, someone who wrote to them in the last 30 minutes, or, with the separate "message people unasked" power (`chat.notify`), any linked member.

**Approvals go to the right people, and are recorded.**

- An agent's approval request (and a question whose answer does something) goes only to its managers, its escalation target, people on the project who are not guests, its orchestrator or an Owner. Anyone else is refused, and the agent is told who it may ask.
- An agent never decides its own request. A connected AI tool never decides one. No agent asks a guest anything.

**Limits are enforced, not just reported.**

- An agent over its budget, or holding a run past its per-run limit, is refused every write, the same as a paused agent. It can still read, report its heartbeat and usage, and finish its run.
- A run's reported spend only goes up, and usage reported under a run counts even when the run itself reports less.
- Writes and messages are counted per agent across all its keys. MCP handshakes count against the key's rate.

**New agents start with safe defaults.** Pre-filled at hire; an Owner can clear or change each one there or later under the agent's Limits. Agents and keys made before these defaults keep what they had.

| Default | Value | Where it lives |
|---|---|---|
| Spend budget | None: spend is what the agent's host reports, so an Owner sets one per agent once real spend is known | Agent page > Limits |
| Writes a minute (all its keys) | 30 | `src/lib/agent-defaults.ts` |
| Messages a minute (chat, notifications, questions, approvals) | 10 | `src/lib/agent-defaults.ts` |
| Key lifetime | 90 days, unless Settings > Developers sets an agent key lifetime | `src/lib/agent-defaults.ts` |

**Keys are managed by the right people.**

- A key with "manage every API key" that is not an Owner's never pauses, revokes, edits or strips an Owner's key, or the key of an agent an Owner manages. Its own keys and the keys it made stay its to manage.
- Keys are random, stored only as a hash, and checked on every request. A paused, expired or revoked key stops at once.

**AI setup is boxed in.** During a one-hour setup session your AI tool can hire and configure agents, but:

- A key it makes carries at most the agent's template powers.
- Powers over money, people, settings, acting for someone, keys, webhooks and stored credentials are left off and wait for your Allow on the setup screen.
- A webhook to a web address no live webhook uses yet is made switched off and waits for your Allow.
- The setup screen lists every key the session made, with Revoke.

**Everything is on the record.** The audit log records who did what, with the key and the person an agent acted for. Most deletes go to Trash, and the database refuses a real delete on those tables ([Backups and recovery](backups-and-recovery.md)).

## What you set up once

1. **Set `APP_ENCRYPTION_KEY`** before adding webhooks or chat connections. It seals bot tokens and webhook secrets in the database. Keep a copy in your password manager.
2. **Set a spending limit with your AI provider** (Anthropic, OpenAI or whoever runs your models). The budget here stops an agent that reports its spend; only the provider can stop the spend itself.
3. **If you host behind your own proxy, configure it to overwrite `X-Forwarded-For`.** Per-visitor limits read the client address from it. Vercel does this for you.
4. **Review the defaults** for your first agents: set a budget per agent once you have seen a month of real spend in Analytics, and keep money and credential powers for agents that read no outside text.
5. **Set up backups** as described in [Backups and recovery](backups-and-recovery.md).

## Known limits

1. **Prompt injection.** An agent reads text written by other people: email, chat, task comments, files, web pages. Any of it can try to give the agent orders. The app cannot stop a model from being fooled. It limits what a fooled agent can do: an agent holds only the powers you gave it, cannot send email, messages only people and channels you mapped, and its tasks, suggestions and approvals are recorded under its name. Give each agent the fewest powers that do its job, keep money and credential powers for agents that read no outside text, and review what an agent wrote before acting on it.
2. **Links in agent text.** Text from an agent can contain links. The app never loads them for you and never shows remote images, but a link you click can carry information in its address. Check where a link goes before you open it.
3. **Budgets.** Spend is what the agent's harness reports. A budget here stops a well-behaved agent and warns you about the rest. Set a hard limit with your model provider as well.
4. **Approvals.** An approval records that a person said yes. The app does not perform or block the action in the other system: the harness must wait for `decision: approved` and check that `decided_via` and `decided_by` are who it expects.
5. **AI setup and Connect AI.** During a setup session your AI tool acts with your powers on the setup routes. Run it in a clean chat, do not let it browse while the session is open, and end the session when you are done. A connected AI tool acts as you within the connect powers: connect only tools you trust.
6. **Self-hosting.** Per-visitor limits use the client address from your proxy. Configure the proxy to overwrite `X-Forwarded-For`, and set `APP_ENCRYPTION_KEY` before adding webhooks or chat connections.
