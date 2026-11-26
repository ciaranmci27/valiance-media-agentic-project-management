# Company chat

For admins and harness builders. The company bot puts company agents (an "Ops AI", a "Finance Bot") in Slack, Telegram or Discord channels and DMs. Whoever asks is the person the agent works for on that message: it never does more than both the agent and that person may.

Personal assistants use the other bot, the personal one: [Assistants](assistants.md). Each kind needs its own Slack app, Telegram bot or Discord application; you can have both.

## Connect

Settings > Assistants > **Chat** > **Add chat** > **Company AI (channels and DMs)**. Owners only. Bot tokens are stored encrypted.

**Slack**

1. At api.slack.com/apps, create an app for your workspace, separate from the personal assistants app.
2. Under OAuth & Permissions, add the bot scopes `chat:write`, `chat:write.customize`, `im:history`, `im:write`, `channels:history`, `groups:history`, `channels:read` and `groups:read`, then install it.
3. Under App Home, turn on the Messages Tab.
4. In the app, choose Slack, paste the Bot User OAuth Token and the Signing Secret, and press **Connect**.
5. Copy the **Request URL**. In Event Subscriptions, paste it and subscribe to the bot events `message.im`, `message.channels` and `message.groups`.
6. Invite the bot to each channel it should hear: `/invite @your-bot`.

`chat:write.customize` lets each reply carry the agent's own name and avatar. `im:write` lets a reply go privately by DM. `channels:read` lets you map a channel by its name.

**Telegram**

1. Make a bot with @BotFather (`/newbot`) and add it to your groups.
2. To hear every message in a group (listen all, below), send BotFather `/setprivacy` and choose **Disable**. Otherwise Telegram only sends the bot commands, replies to it and mentions of it.
3. In the app, choose Telegram, paste the token and press **Connect**.

Telegram has no per-message name: replies keep the bot's name.

**Discord**

Discord needs one extra piece the others don't. A Discord bot hears ordinary messages only over Discord's Gateway, a live websocket, and the app's host (Vercel) cannot keep one open. So you run a small relay, shipped in the repo at `relay/discord/`, on any server you control. It holds the Gateway and posts each message to the app, signed. Full guide: [relay/discord/README.md](../../relay/discord/README.md).

1. At discord.com/developers/applications, create an application, separate from the personal assistants one.
2. On its Bot page, turn on **Message Content Intent**, then press **Reset Token** and copy the token.
3. In the app, choose Discord, paste the token and press **Connect**.
4. Copy the **relay secret** (shown once) and the **relay address**. Lost the secret? **New relay secret** on the row makes another; the old one stops working.
5. Invite the bot with **Invite the bot to your server**. It asks for View Channels, Send Messages, Read Message History, Send Messages in Threads and Manage Webhooks.
6. Run the relay with `DISCORD_BOT_TOKEN`, `PM_INBOUND_URL` and `PM_RELAY_SECRET` (one Docker or Node command). The row reads **Waiting for relay** until the relay says hello, then **Connected**.

Manage Webhooks lets each reply carry the agent's own name and avatar: the app makes one webhook per channel the first time an agent answers there and keeps it, encrypted, with the bot token. Without it, replies come from the bot with the agent's name in bold on the first line. A thread's messages count as its parent channel's, so a mapped channel's threads route the same way.

## Choose the agents

On the connection, **Choose agents**:

- Only company agents (not personal assistants).
- Each must hold **Act for a person** (`agents.act_for`, Team > Access). Without it the app refuses it (`422 agent_cannot_act_for`).
- One is the **default**: DMs to the bot go there.

## Map channels

Type a channel's name (`#finance`, or a public Telegram group's `@name`) or paste its id (`C0123ABC`, `-100123...`, or a Discord channel id from Copy Channel ID), pick an agent and what it hears:

| Listen | What is recorded |
|---|---|
| **Mentions only** (default) | Only messages that mention the bot or name an agent. |
| **Every message** | Every message, as context for the mapped agent. A mention is still a request. |

Removing an agent from the connection removes its channel mappings.

## Who gets a message

In this order:

1. **An agent named with @** ("@Finance Bot what is our cash?"), in a DM or any channel: a request to that agent.
2. **A DM to the bot**: a request to the default agent.
3. **A mapped channel**: a mention of the bot is a request to the mapped agent. With **Every message**, anything else is context for it.
4. **A mention of the bot in an unmapped channel**: a request to the default agent.
5. Anything else is ignored and not recorded.

A request with nobody to take it (no default set) gets "No AI is set up to answer here yet. Ask your admin."

## Requests and context

- **A request** (`is_request: true`) is from a linked, verified, active person. That person is the principal: the agent acts for them.
- **Context** (`is_request: false`, status `context`) is the rest of a listening channel. It is never a request, never answered (`409 not_a_request`) and needs no marking. It tells the agent what was said.

People not linked yet:

| | |
|---|---|
| Asking in a DM | A one-time link to connect their account (at most once an hour), as for personal chat |
| Asking in a channel | "Message me directly to connect your account.", in the message's thread. No link where others read it. |
| Chatting in a listening channel | Recorded as context with their provider id and no person. Never acted on. |

## Privacy

Channel context is chat like any other: stored in the app with the same privacy as personal chat.

- Only the agent it was recorded for can read it, with its own key. Any other agent reads it as missing (404).
- Webhooks carry ids only, never text. Text never reaches the app's logs.
- Only channels an Owner set to **Every message** are recorded beyond mentions.
- Disconnecting the connection deletes its chat history in the app.

## What the harness receives

`chat.message`, on a webhook endpoint filtered to the agent (`member_id`). Ids only. Full payload: [WEBHOOKS.md](../../WEBHOOKS.md).

```json
{
  "type": "chat.message",
  "data": {
    "message": { "id": "6f1e...", "provider": "slack", "connection_kind": "company", "conversation_id": "C0FIN", "thread_id": null, "external_message_id": "1732550000.000100", "external_user_id": "U0ANA" },
    "agent_id": "a1a1...",
    "is_request": true,
    "route": "channel",
    "channel": { "id": "C0FIN", "name": "#finance", "direct": false, "mapped_agent_id": "a1a1...", "listen": "all" },
    "thread": { "id": null, "message_ids": ["5d0a..."] },
    "person": { "id": "98b9...", "name": "Ana Lopez" },
    "act_for": { "method": "POST", "path": "/api/v1/delegations", "body": { "provider": "slack", "external_id": "U0ANA", "workspace_id": "T0ACME" } },
    "read": { "method": "GET", "path": "/api/v1/chat/messages/6f1e..." },
    "reply": { "method": "POST", "path": "/api/v1/chat/messages/6f1e.../reply" }
  }
}
```

No webhook? Poll `GET /api/v1/chat/messages` (MCP `list_chat_messages`); `?status=context` lists context.

## How the harness answers

1. Read the text: `GET /api/v1/chat/messages/{id}` (MCP `get_chat_message`) with the agent's key.
2. If `is_request` is false, stop: it is context.
3. Mint a pass for the sender with the `act_for` body: `POST /api/v1/delegations`. Send its token as `X-Act-For` on every call made for them, so a project they cannot open stays closed to the agent too. See [Acting for a person](identity-and-access.md#acting-for-a-person).
4. Reply: `POST /api/v1/chat/messages/{id}/reply` (MCP `reply_in_chat`) with `X-Act-For`. Without it: `403 act_for_required`; with a pass for someone else: `403 act_for_mismatch`.

```json
{ "text": "About 40k in checking.", "also_send_to_channel": false, "private": false }
```

- In a channel the reply goes in a thread under the message, under the agent's name and avatar (Slack).
- `also_send_to_channel: true` also shows it in the channel (Slack `reply_broadcast`).
- `private: true` sends it to the sender by DM instead.
- On Discord, a reply to a channel message shows in the channel: as a reply to it (from the bot, the name in bold) or, through the channel webhook, under the agent's name with a mention of the asker, since a webhook cannot reply to a message. Discord has no `reply_broadcast`, so `also_send_to_channel` changes nothing there. Inside a thread it answers in the thread.
- In a DM it answers in place.

## Starting a conversation

A company agent can post first: a daily report in its channel, an alert to the person it works for. `POST /api/v1/chat/messages` (MCP `send_chat_message`).

```json
{ "channel": "#finance", "text": "Cash at close: 41,200.", "link": { "url": "https://pm.example.com/reports/cash", "label": "Open the report" } }
```

Who it may reach:

| Where | Rule |
|---|---|
| A channel | Only a channel mapped to the agent on a company connection that lists it. Being the default agent does not widen this: the default answers DMs, it does not post wherever it likes. Map the channel to it. Otherwise `403 channel_not_allowed`. |
| A person's DM (`person_id`) | Only an active member with a verified linked account on that connection, and only while acting for them (`X-Act-For` naming them; `403 act_for_mismatch` for anyone else), or unasked with **Message people unasked** (`chat.notify`) on both the agent and its key (`403 chat_notify_required`). No role holds `chat.notify` by default: an Owner grants it to the agent under Team > Access and adds it to the key. |

- Each connection allows 60 started messages an hour per agent and 20 an hour per recipient, a person or a channel, whichever agents send (`429 chat_rate_limited`).
- A paused or on-hold agent cannot send (`423`, like other writes).
- It goes under the agent's own name and avatar where the provider allows, as replies do. `link` shows as a Slack link, a Telegram button under the message or a Discord link.
- It is recorded as a started message (no webhook event). A reply to it comes back to the same agent as a request, route `reply`, with `in_reply_to` naming it: in its thread (Slack), quoting it (Telegram, Discord), or in a DM the next messages after it, until a day passes with no word or the person names another agent.
- Approve and reject buttons are not offered yet: send a `link` to the approval instead.

## Files

People can send the bot photos, voice notes, audio, video and documents (Telegram, Slack and Discord). The message lists them as `attachments` (`index`, `kind`, `name`, `mime_type`, `size`, `duration_seconds`, `download`); `chat.message` says `has_attachments` and `attachment_count`. A file with no words is still a request. A caption is the message's text.

The app stores only the provider's reference, never the bytes. The agent fetches a file with `GET /api/v1/chat/messages/{id}/attachments/{n}` and its own key; the app gets it from the provider and streams it through, so the bot token and the provider's address never leave the server. Only the agent the message was routed to can fetch it. Files over 20 MB are refused (`413 attachment_too_large`). Slack needs the `files:read` bot scope for this. Chat retention forgets file references with the text.

## When the agent will not answer

If the agent is on hold (paused on its agent page, or every agent paused), the app says so once per chat until it is back: "Ops AI is on hold right now and will answer when it's back." The message is still recorded and sent to it.

If it is suspended, never connected, or its host stopped reporting: "Ops AI can't answer right now. Try again later." A suspended agent is never sent the message.

In a channel the line goes in the message's thread.
