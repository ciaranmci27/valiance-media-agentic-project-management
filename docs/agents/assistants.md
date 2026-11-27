# Assistants

For admins. Give every person their own AI assistant: it keeps their tasks and reminders moving, sorts their inbox if they want, and answers them in Slack, Telegram or Discord. People never see keys, scopes or templates.

## How it works

- Each assistant is a **personal agent** bound to one person. It sees and does only what that person may, and everything it does records them. Details: [Identity and access](identity-and-access.md#personal-agents).
- The app holds the assistant's identity, settings, switches, chat and audit trail.
- **Your agent service runs the AI.** This is the harness that runs personal agents: it collects each assistant's key, receives its chat messages and work events, calls your model and answers. The app does not run a model itself. Until a service connects an assistant, it reads "Getting ready". AI > Setup opens with an **Agent service** step that makes the service's key and shows whether it is connected.

## Set up

### 1. Turn it on

1. Settings > Workspace > Features: turn on **AI agents**. Turn on **Webhooks** too, so chat messages reach the assistant at once.
2. AI > Setup: switch on **Turn on assistants**.
3. Optional: **What you call them**, such as "Helper". The sidebar and each person's page use this name.

Turning assistants off puts every assistant on hold: its writes answer `423 assistants_off` (reads, heartbeats and telemetry still work), nobody new gets one, and chat gets "Assistants are off in this workspace right now." People still see theirs on their page, on hold, with Pause, Undo and the switches.

### 2. Choose who gets one

1. Under **Who gets one**, add a role or a group. Members is the common choice.
2. Press **Give everyone their assistant**. You see who gets one first, then confirm.
3. People who join later with that role, are added to that group, or move into that role, get theirs then (while assistants are on).

Removing a role or group later leaves the assistants it gave with their people. A setup whose template is gone, or whose feature is off, says so on its row and in the preview. **Give everyone** reports how many people got one and how many could not.

### 3. Connect your agent service

AI > Setup > **Agent service** > **Make the service key** makes it for you and shows it once: `assistants.provision`, `webhooks.manage` and the scopes your assistants' templates carry (each key the service collects is narrowed to what this key carries). The step reads **Waiting for your service** until the service collects its first assistant's key, then **Connected**. Status rows that need the service link here.

The service needs that API key, made by an Owner, carrying `assistants.provision`. With it, it:

1. Lists assistants without a key: `GET /api/v1/assistants?needs_key=true` (MCP `list_assistants`).
2. Collects each key once: `POST /api/v1/assistants/{id}/key`. No person ever handles these keys.
3. Makes one webhook endpoint for the whole setup: `POST /api/v1/webhook-endpoints` (MCP `create_webhook_endpoint`) with `assistant_setup_id` set to the setup's id (`GET /api/v1/assistant-setups`), subscribed to `chat.message` and the work events its assistants need. (`assistant.message`, the older name, still works unchanged for at least three releases; subscribe to one, not both.) It receives the events of every assistant that setup made, now and later, and each payload's `agent_id` and `member_ids` say which assistant it is for. One URL and one secret for any number of people. This needs `webhooks.manage`. Keys stay one per assistant.
4. Sends a heartbeat for each assistant (`POST /api/v1/agents/heartbeat` with that assistant's key), so Status can tell when the service stops.

Each assistant then works the normal [work loop](work-loop.md) with its own key, and answers chat as below.

A setup with an endpoint cannot be deleted until the endpoint goes: turn the setup off instead, so its assistants keep hearing their chat. An endpoint filtered to one assistant (`member_id`) still works, for a host that runs only some of them.

All of this can also be done from a chat: [Set up from a chat](setup-by-ai.md#assistant-setups).

### 4. Connect chat (optional)

AI > Setup > **Chat** > **Add chat**, then choose **Personal assistants (DMs)**. This is the personal bot: people message it directly and their own assistant answers. It stays out of channels: anything said in a channel or group is ignored. Bot tokens are stored encrypted.

For AI that answers in channels (a company agent such as "Ops AI"), add a second bot of the other kind: [Company chat](company-chat.md). Each kind needs its own Slack app, Telegram bot or Discord application.

**Slack**

1. At api.slack.com/apps, create an app for your workspace.
2. Under OAuth & Permissions, add the bot scopes `chat:write`, `chat:write.customize`, `im:history`, `im:write` and `files:read`, then install it. `chat:write.customize` lets each reply show the assistant's own name and avatar; `im:write` lets the assistant write first (a morning digest); `files:read` lets it read files people send. Changed the scopes later? Reinstall the app.
3. Under App Home, turn on the Messages Tab, so people can message it.
4. In the app, choose Slack, paste the Bot User OAuth Token (`xoxb-...`) and, from Basic Information, the Signing Secret. Press **Connect**.
5. Copy the **Request URL** the app shows. In your Slack app, open Event Subscriptions, turn it on, paste the URL, and subscribe to the bot event `message.im`. If Slack says the URL didn't respond, the signing secret is wrong: use **Replace token or secret** on the row.

**Telegram**

1. In Telegram, message @BotFather and send `/newbot`.
2. Pick a name. BotFather sends you a token.
3. In the app, choose Telegram, paste the token and press **Connect**. The app does the rest.

Telegram has no per-message name, so replies there keep the bot's name.

**Discord**

Discord needs one extra piece: a small relay you run on any server you control (your own, a small VPS, Fly or Railway). Discord sends a bot ordinary messages only over a live connection the app's host cannot keep open; the relay keeps it and passes each message to the app, signed. Guide: [relay/discord/README.md](../../relay/discord/README.md).

1. At discord.com/developers/applications, create an application. On its Bot page, turn on **Message Content Intent**, press **Reset Token** and copy the token.
2. In the app, choose Discord, paste the token and press **Connect**.
3. Copy the relay secret (shown once) and the relay address, and invite the bot with the link the app shows. It needs no permissions in the server: people message it directly, and only need to share a server with it.
4. Run the relay. The row reads **Waiting for relay** until it says hello. A new relay secret resets it to Waiting for relay until the relay says hello with the new one. The relay checks in every 5 minutes; if it then goes quiet for 15 minutes, the row reads **Not receiving** ("The relay stopped checking in") until it is back.

Replies come from the bot with the assistant's name in bold on the first line (Discord bots cannot change their name per message, and DMs have no webhooks).

Then each person links their own chat account from their Assistant page: they message the bot "hi" and open the link it sends while signed in. The link page says they messaged the bot (nobody else asked), and once linked the bot says so in the chat: "Linked. Nova answers you here now."

Each app has one personal and one company connection: a second of the same kind is refused (`409 slot_taken`). A connection's row says honestly how it is:

| Status | Means |
|---|---|
| Waiting for Slack, Waiting for relay, Waiting for first message | Nothing verified has arrived yet. |
| Connected | A verified request in the last 14 days. |
| Quiet | Heard before, nothing in 14 days. |
| Not receiving | The provider's last request failed the check (a wrong signing secret, an old relay secret). |
| Off | Switched off. A person who writes to it gets "This chat is switched off here. Ask your admin.", once a day, and the row stays on their page, tagged Off. |

A wrong or leaked bot token or Slack signing secret is replaced in place (**Replace token**): the connection keeps its Request URL, history and everyone's links. The new token must be for the same bot or Slack workspace.

A connection made before company chat existed is a personal one and works as before, except that it no longer answers in channels.

### How a chat message travels

1. Slack or Telegram sends the message to the app (Discord's through the relay). The app checks the provider's signature first (the relay's, for Discord).
2. The app finds who sent it through their verified linked account.
3. It records the message for that person's assistant and sends `chat.message` (ids only) to the assistant's webhook: the endpoint for its setup, or one filtered to it. An endpoint subscribed to the older `assistant.message` gets exactly what it got before. With no webhook, the message waits as pending.
4. The assistant reads the text with its own key (`get_chat_message`, or `list_chat_messages` to poll) and answers with `reply_in_chat` (`POST /api/v1/chat/messages/{id}/reply`). The app sends the reply in the same DM, under the assistant's name and avatar on Slack. `mark_chat_handled` closes a message that needs no answer.

An assistant can also write first, for an urgent email or a morning digest: `POST /api/v1/chat/messages` (MCP `send_chat_message`) with `text` and, if useful, a `link`. It reaches only its own person, by DM, on a personal connection where they linked an account; anyone else, and any channel, is `403 recipient_not_allowed`. At most 60 an hour per assistant and 20 an hour per person. A paused or on-hold assistant cannot send (`423`). Their reply comes back to it like any message, with `in_reply_to` naming what it answers.

People can send their assistant voice notes, photos and files. The message lists them as `attachments`; the assistant fetches each with `GET /api/v1/chat/messages/{id}/attachments/{n}` (up to 20 MB), through the app, so no bot token leaves it. Slack needs the `files:read` bot scope for this.

The older routes `/api/v1/assistant/messages`, `/api/v1/assistant/messages/{id}`, `.../reply` and `.../handled` still work for personal assistants, unchanged, for at least three releases. They are deprecated: use `/api/v1/chat/messages`.

Who gets a plain one-line answer instead:

| Sender | Answer |
|---|---|
| Not linked yet | A one-time link to connect their account, with a 4-character code; the link page asks for the code, so a link forwarded to someone else links nothing (5 wrong codes use it up). While that link is still open (unused, under 15 minutes), a reminder instead of a second one; once it is used or expired, a fresh one at once. |
| Suspended | "This account is not active here. Ask your admin." |
| No assistant | "You don't have an assistant yet. Ask your admin to set one up." |
| Assistants are off | "Assistants are off in this workspace right now. Ask your admin." |

When the person's assistant will not answer right now, the app says so itself, using the assistant's name. It sends this once per chat until the assistant is back and then stops again.

| Assistant | Answer | The message |
|---|---|---|
| On hold | "Nova is on hold for now. It will reply when it's back." | Recorded and sent to it; it answers once resumed |
| Paused by them | "Nova is paused. Resume it on your Assistant page and it will pick up what you sent." with a link | Held, then sent to it when resumed (the newest 20, oldest first; older ones are kept, not sent) |
| Paused by an admin | "Nova was paused by an admin. It will pick up what you sent when they resume it." | Held, then sent when resumed, the same way |
| Not connected, or its service stopped | "Nova can't answer right now: its key expired or was revoked. Your admin has been told." (the reason, then who fixes it: "Fix it in AI > Setup." for an Owner, or when nobody else could be told) | Recorded and sent to it |

## What employees see

Their own part of AI (`/ai`, Your assistant), under the name you chose. It shows:

- **What needs them**: the assistant's questions, approvals and reply drafts.
- **What it did**, with Undo for tasks it created or finished and inbox sorts.
- **Chat**: connect Slack, Telegram or Discord to their account.
- **What it remembers**, when they turned that on. They see every entry and delete any of them.
- **Settings**: its name, tone (warm, brief or formal), a note on how they like to work, and the switches.

### The switches

The server enforces each one. The assistant is also told in words, so it does not try.

| Switch | Default | When off |
|---|---|---|
| Sort my inbox | Off | It leaves their inbox alone. On, it handles only their own personal inboxes, never shared ones. |
| Create tasks for me | On | The app refuses every task it tries to create. It suggests work instead. |
| Draft replies | On | The app refuses its reply drafts. |
| Remind me | On | The app refuses reminders it writes. |
| Remember things for me | Off | It keeps nothing new about them. |
| Pause | | It does nothing until they resume it. Chat messages they send meanwhile reach it when they resume (the newest 20). |

## Privacy

- **Chat text stays with the person's assistant.** The webhook carries ids only. Only that assistant's key can read the text (404 for any other agent's key; on the older `/api/v1/assistant` routes, `403 not_a_personal_agent` for a key that is not a personal agent's). Message text never reaches the app's logs.
- **Disconnecting a chat** deletes its chat history in the app. People's chat accounts stay, so connecting again picks up where it left off.
- **Personal memory belongs to the person.** Only they and their own assistant (while "Remember things for me" is on) see it. Owners are never shown it in the app. Whoever runs the assistant host holds its key and so could read it; that access is recorded in the audit log. Deleting an entry deletes it for good.
- **Leaving cleans up.** Suspending a person pauses their assistant and revokes its keys and pending links. Reactivating them un-pauses it; the agent service then collects a new key.

## Troubleshooting "paused"

AI > Setup > **Status** lists every assistant. Each one that needs you says why; **Fix** opens the Agent service step at the top of the page. The person sees "Not working" with the reason and who fixes it ("Your admin has been told" only when someone was; an Owner, or someone nobody else could be told about, reads "Fix it in AI > Setup"). The admin gets a notification, at most once a day: an Owner's opens the Agent service step, another admin's opens the agent's page.

| Status | Why | Fix |
|---|---|---|
| Getting ready | Just made. The agent service has not collected its key yet (it has 15 minutes). | Check the service is running and polling `needs_key=true`. |
| Needs you: "It was never connected to the service that runs it." | No key after 15 minutes. | Connect the agent service (AI > Setup > Agent service). |
| Needs you: "Its key expired or was revoked." | It had a key, and it ran out or was revoked (or its person was suspended and is back). | Have the service collect a new key (`POST /api/v1/assistants/{id}/key`). If one exists but is expiring, rotate it instead. |
| Needs you: "The service that runs it stopped reporting." | Its last heartbeat is older than three of its promised intervals. | Restart the service. Check it beats for this assistant. |
| Paused by them | The person pressed Pause. | Only they resume it, from their page. |
| On hold: "Assistants are off." | An Owner switched assistants off. | Turn them on in AI > Setup. |
| On hold: "Paused by an admin." | Someone other than the person suspended the assistant's account. Deliberate, so nobody is notified. | Reactivate it from the Team page or its agent page. |
| On hold: "Every agent is paused." | An Owner paused every agent (Settings > Security). | Resume agents there. |
| On hold: "Paused on its agent page." | Someone paused this agent from its profile or with `paused: true`. | Resume it on its agent page. |
| On hold: "On hold, and the service that runs it is not responding." | On hold, and its service also stopped reporting (the same rule as above). Resuming alone will not bring it back. | Restart the service, then resume. |

On hold is deliberate, so nobody is notified, unless its service also stopped reporting: then the admins get the same notification as above, at most once a day. The person sees "On hold" on their page, with why. While on hold the assistant can still read and report, but its other writes answer `423`, replies in chat included: chat messages are still recorded and sent to it, and it answers once resumed. See [Limits and pause](work-loop.md#limits-and-pause).
