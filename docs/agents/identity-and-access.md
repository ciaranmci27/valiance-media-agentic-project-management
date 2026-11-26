# Identity and access

Who an agent is, what it may do, and how every action is traced back to a key and a person.

## Security model in short

- **A key acts as one team member.** What a call may do is the key's scopes, within the member's API permissions, within the projects the member reaches. A `read_only` key refuses every write.
- **No key hands out more than it has.** A new key carries only scopes its member holds and the calling key carries.
- **Only an Owner makes keys for someone else, and only for an agent.** No key creates an Owner or makes anyone one.
- **Revoking cascades.** Revoking a key also revokes every key it made, and every key in its rotation line.
- **Acting for a person never adds access.** It is the agent's access and the person's together: the intersection.
- **A personal agent is bound to one person.** It always works within that person's access, and everything it does records them.
- **People's own AI tools get a fixed, small set**: their projects, tasks, comments, questions and reminders. Never admin powers or keys, even for an Owner, with one exception an Owner grants by hand: one hour of agent setup, on the setup routes only, ended at any time ([Set up agents with AI](setup-by-ai.md#set-up-agents-with-ai-one-hour)).
- **Secrets are shown once.** API key secrets, delegation passes, link URLs and OAuth tokens are stored only as hashes. Chat bot tokens are stored encrypted, and so are webhook signing secrets for endpoints made while `APP_ENCRYPTION_KEY` is set (Settings > Encryption moves older ones).
- **The audit log is append-only**, with secrets removed before anything is written.
- **Profiles narrow tools, never widen them.** An agent profile decides which MCP tools an agent sees. Its keys still decide what each call may do.

## Keys and scopes

Make a key:

- In the app: Settings > Developers > API keys, or the agent's profile.
- From a chat: `create_api_key` (MCP).
- Over REST: `POST /api/v1/api-keys`.

```json
{ "member_id": "5d0a...", "name": "Build agent, production host",
  "scopes": ["tasks.read", "tasks.create", "tasks.manage_assigned", "projects.read", "agent_activity.write"],
  "permissions": "scoped", "expires_in_days": 90 }
```

The answer is `{ key, secret }` (201). The secret appears only here.

Scopes an agent setup usually meets:

| Scope | Allows |
|---|---|
| `agent_activity.write` | Log the agent's own events, runs and heartbeat |
| `questions.ask` | Ask a question or request an approval that names no task or project, and read and withdraw its own, without `tasks.read` ([External agents](external-agents.md)). Admins, members and agents hold it on the API, so whoever sets up an agent can give its key this scope; no key carries it by default. |
| `agents.manage` | Configure agents, read every agent's runs, report fleet health |
| `agents.act_for` | Act for the person who asked (X-Act-For) |
| `team.manage` | Add agents and edit non-Owner members |
| `api_keys.manage_all` | See and revoke every key; make keys for agents (with an Owner's key) |
| `webhooks.manage` | Create, edit and remove webhook endpoints |
| `groups.manage` | Create groups and choose who is in them |
| `identities.link` | Send a person a one-time link to verify a chat account |
| `identities.read` | Look up who a verified chat account belongs to |
| `assistants.provision` | List personal agents and collect each one's key once |
| `context.memory` | A person's own key or AI tool reads and adds to their personal memory |
| `approvals.decide` | A key decides an approval that names its person (or any, for the Owner). Admins and members hold it on the API; no key carries it by default, no agent holds it, and a connected AI tool never decides one. |
| `agent_events.export` | Read every agent event and run from a cursor |
| `audit.read`, `audit.export` | Read the audit log; export it from a cursor |
| `fleet_alerts.write` | Post fleet-wide alerts that name no agent, and nothing else |

An Owner's key can carry any of these. Other roles do not hold `api_keys.manage_all`, `webhooks.manage`, `agent_events.export`, `assistants.provision`, `groups.manage`, `identities.*`, `agents.act_for` or `audit.export` on the API by default. An Owner grants them to a member, such as an agent or a data system's member, in Team > Roles & permissions.

`get_agent_setup` (`GET /api/v1/agents/{id}/setup`) shows `available_scopes`: what a key for that agent may carry.

## Minting rules

| Rule | Refusal |
|---|---|
| Every scope must be held by the key's member on the API | `422 scope_not_held` |
| Every scope must be carried by the calling key | `403 scope_escalation` |
| A key for anyone but yourself needs an Owner's key | `403 owner_only` |
| ...and only for an agent, never a person | `403 not_an_agent` |
| ...and never for an Owner | `403 owner_protected` |
| A personal agent's key comes only from its person or the assistant host | `403 personal_agent_owner_only` |

### Key lineage

A key made over the API records the key that made it (`created_by_key_id`). Revoking a key (`POST /api/v1/api-keys/{id}/revoke`, `revoke_api_key`, or Settings) also revokes:

- every live key it made, and every key those made;
- through rotation, the keys it replaced and everything they made.

The answer lists them in `cascaded_revokes`. Each gets its own audit row. A revoke cannot be undone.

So an Owner's setup key that made ten agent keys can retire all of them in one call.

## Rotation and expiry

- **Expiry**: `expires_in_days` (1 to 3650, or `null` for none) on a new key. Left out, the workspace's lifetime applies: one for agent keys (`agent_key_lifetime_days`), one for people's keys (`personal_key_lifetime_days`). For anyone but an Owner, a lifetime that is set is also the longest a new key may last: a longer one, or no expiry, gets the lifetime instead. An Owner sets both in Settings > Developers > Key lifetimes, or with `PATCH /api/workspace/key-settings` and `PATCH /api/workspace/key-settings/personal`. None by default. Keys made earlier keep their own expiry.
- **Rotation**: `rotate_api_key` (`POST /api/v1/api-keys/{id}/rotate`) makes a successor with the same member, scopes and name. Its secret is in this answer only.
  - The old key keeps working for `overlap_hours` (0 to 168, default 24), then answers `401 api_key_expired`.
  - A key is rotated once: rotate its newest key next time (`409 not_rotatable`).
  - A revoked or expired key cannot be rotated (`409 key_revoked`, `409 key_expired`).
  - The successor keeps the old key's place in the lineage.

To rotate without a gap: rotate, put the new secret in the host, restart, and let the old key run out.

## Pause, edit and list by state

- **Pause**: `pause_api_key` (`POST /api/v1/api-keys/{id}/pause`, or Pause in Settings) stops a key without losing it. Whatever uses it gets `401 api_key_paused`; its secret, name and scopes stay. An agent's own pause is not touched. `resume_api_key` (`POST /api/v1/api-keys/{id}/resume`) brings the same secret back. A paused key is not rotated (`409 key_paused`): resume it first.
- **Edit**: `update_api_key` (`PATCH /api/v1/api-keys/{id}`) renames a key or replaces its scopes in place. Removing scopes is always allowed. A new scope is added only as making a key would allow it: the key's member holds it, and whoever edits holds it too (over the API, the calling key carries it and an Owner's key edits an agent's key). An agent's key never gains a scope agents never carry.
- **AI setup keys** (`pk_setup_`, one hour) stay as they were made: never edited, paused, resumed or rotated (`409 setup_key_fixed`). Revoke one instead.
- **State**: every key in a list has `state` (`active`, `paused`, `expired`, `revoked`). `?state=` narrows a list to one, or to `ended` (expired and revoked).
- Who may pause, resume or revoke a key in Settings: its member, whoever created it, and holders of `api_keys.manage_all`. Over the API: a key with `api_keys.manage_all`. Every pause, resume and edit is in the audit log with the key before and after.

## Groups

Groups (Team > Groups, `/api/v1/groups`) stand wherever one member could:

- ask a question or approval to a group (`asked_to_group`): any member answers;
- let an agent escalate to a group (`agent_escalate_to_group`);
- let a group own an agent (`owner_group_ids`): any member manages it as an owner.

`groups.manage` is Owner-only by default. It is a power permission: its holder can join groups that own agents or decide approvals. Groups take an `external_id` for a directory sync. MCP: `list_groups`, `create_group`, `add_group_members` and the rest.

## Linked chat accounts

A linked identity ties a chat account (Slack, Teams, Telegram, Discord, GitHub, email, or `custom.<name>`) to a team member. Only verified accounts resolve.

Three ways to link:

1. **The person**, from Settings > Account, confirmed through a one-time link the assistant sends them.
2. **The link handshake**, run by a chat harness (below).
3. **An Owner** (`team.manage`), in bulk: `POST /api/v1/identities`.

### The link handshake

1. Someone messages your bot. Look them up: `resolve_identity` (`GET /api/v1/identities/resolve?provider=slack&external_id=U0123&workspace_id=T0456`, scope `identities.read`).
2. Not found (`404 identity_not_found`): make a link with `create_identity_link` (`POST /api/v1/identities/link-requests`, scope `identities.link`). Pass `member_id` whenever you know who it should be.
3. Send the `url` **only as a direct message to that account**, never in a channel.
4. They open it signed in and confirm. The account is stored as verified.

The link works once and lasts 15 minutes. With `member_id` set, anyone else confirming it gets `403 wrong_member`.

Other routes: `GET /api/v1/members/{id}/identities` and `GET /api/v1/groups/{id}/identities` (how to reach someone), `POST /api/v1/identities/{id}/move`, `DELETE /api/v1/identities/{id}` (unlinks, and revokes passes minted for it).

## Acting for a person

A shared agent (a team bot in Slack, a support agent) can act for the person who asked it.

1. The agent's key and the agent both hold `agents.act_for`.
2. Resolve the person's verified account (above).
3. Mint a pass: `POST /api/v1/delegations` with `provider`, `external_id` and `workspace_id`. The answer has `id`, `token` and `expires_at`.
4. Send the token as the `X-Act-For` header, with the agent's own key, on each call made for them. It works on REST and on the MCP connection.

While the header is present:

- the call may do only what the key's scopes, the agent and the person all allow;
- a project the person cannot open is out of reach, even if the agent can open it;
- runs, questions, tasks, comments, events and audit rows record the person as `principal_id`;
- the agent's own bell, inboxes and shared credentials answer `403 act_for_not_allowed`;
- an approval that names the person is decided only with `approvals.decide` on the key, held by the agent and the person (else `403 approval_needs_person`). It is recorded as the person's decision, `decided_via: "act_for"`.

Passes last 15 minutes. Mint one per request you handle. On the company chat bot, each request's `chat.message` carries the body to mint it with (`act_for`), and the reply needs the pass ([Company chat](company-chat.md)). `DELETE /api/v1/delegations/{id}` revokes one early.

Refusals: `401 act_for_invalid` (expired, revoked or another agent's), `403 identity_not_verified`, `403 principal_suspended`, `403 principal_is_agent`, `403 not_an_agent`.

Minting a pass is REST only. There is no MCP tool for it.

## Personal agents

A personal agent is bound to one person (`delegate_of`). It is what powers each person's Assistant ([Assistants](assistants.md)).

- Its access is always its own and its person's together, on every call, with or without `X-Act-For`. A pass it sends must name that same person (`403 delegate_only`).
- Everything it makes records its person as `principal_id`.
- It reads only its person's own inboxes, never shared ones, and sees only projects its person can open.
- It escalates to its person first.
- It hands work on (`delegate_task`) only to company agents, and the chain stays its person's: every agent after it works within that person's access too ([Chains of agents](work-loop.md#chains-of-agents)).
- One per person per template. It never gets a sign-in.

### Provisioning by role or group

1. **Setup**: `create_assistant_setup` (`POST /api/v1/assistant-setups`): a role (`match_role`) or a group (`match_group_id`), and a template (default `personal-assistant`).
2. **Everyone already here**: `provision_assistants` (`POST /api/v1/assistants/provision`). Run `dry_run: true` first. Page with `limit` until `remaining` is 0. Running it again makes nothing new.
3. **New people** with that role get theirs when they join.
4. **Keys**: the host that runs personal agents lists the ones without a key (`list_assistants` with `needs_key: true`) and collects each key once (`POST /api/v1/assistants/{id}/key`, `409 key_exists` if it has one). No person ever handles those keys.

All of these need `assistants.provision` on an Owner's key.

### When someone leaves

Suspending a person, in one step:

- pauses their personal agents (`paused_with_person`);
- revokes those agents' keys, delegation passes and pending links;
- removes the person as owner of any agents until they return;
- disconnects their connected AI tools for good.

Re-binding a personal agent to another person, or unbinding it, revokes its keys and resets its settings.

## Personal memory

Personal memory is the `member` context scope: what a person wants their assistant to remember about how they work.

Who sees it:

- the person, in the app, from their Assistant page;
- the person's own key or connected AI tool, only with `context.memory` (ticked on the Connect AI consent screen);
- their own personal agent, only while they turn on **Remember things for me**.

Never an Owner in the app, and never another agent. Whoever runs a personal agent's host holds its key and so could read that memory through it; every such read is recorded in the audit log. Admins and members hold `context.memory` on the API by default; no agent does.

Routes: `GET`, `POST /api/v1/context` with `scope_type: "member"`, `search_context`, `add_context`. Deleting a memory entry deletes it for good; other scopes are archived.

## Audit log

Every API write, and signed-in changes to members, keys, agents, settings, permissions and modules, is recorded with who did it, who it was for (`principal_id`) and how (`via`: `rest`, `mcp`, `mcp_oauth` for a connected AI tool, or `app`). A change an AI tool makes while setting up agents for an Owner names the tool's key and the Owner as `principal_id`.

- **Append-only**: nothing edits or deletes an entry except the retention clean-up.
- **Redacted at write time**: secrets, tokens and webhook address paths never reach it.
- **In the app**: Settings > Security (Owner). Filter by who, who it was for, action and date. Set how long entries are kept (`audit_retention_days`, cleaned up daily).
- **Read**: `GET /api/v1/audit-log` and `GET /api/v1/audit-log/{entityType}/{entityId}` (scope `audit.read`).
- **Export**: `GET /api/v1/audit/export` (scope `audit.export`, held by Owners). Pass `cursor` from `meta.next_cursor`, optionally `since`. `format=ndjson` gives one row per line, with the cursor in `X-Next-Cursor` and `X-Has-More`.
