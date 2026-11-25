# Assistants

For admins. Give every person their own AI assistant: it keeps their tasks and reminders moving, sorts their inbox if they want, and answers them in Slack or Telegram. People never see keys, scopes or templates.

## How it works

- Each assistant is a **personal agent** bound to one person. It sees and does only what that person may, and everything it does records them. Details: [Identity and access](identity-and-access.md#personal-agents).
- The app holds the assistant's identity, settings, switches, chat and audit trail.
- **Your agent service runs the AI.** This is the harness that runs personal agents: it collects each assistant's key, receives its chat messages and work events, calls your model and answers. The app does not run a model itself. Until a service connects an assistant, it reads "Getting ready".

## Set up

### 1. Turn it on

1. Settings > Workspace > Features: turn on **AI agents**. Turn on **Webhooks** too, so chat messages reach the assistant at once.
2. Settings > Assistants: switch on **Turn on assistants**.
3. Optional: **What you call them**, such as "Helper". The sidebar and each person's page use this name.

### 2. Choose who gets one

1. Under **Who gets one**, add a role or a group. Members is the common choice.
2. Press **Give everyone their assistant**. You see who gets one first, then confirm.
3. People who join later with that role or group get theirs when they join.

Removing a role or group later leaves the assistants it gave with their people.

### 3. Connect your agent service

The service needs an API key made by an Owner, carrying `assistants.provision`. With it, it:

1. Lists assistants without a key: `GET /api/v1/assistants?needs_key=true` (MCP `list_assistants`).
2. Collects each key once: `POST /api/v1/assistants/{id}/key`. No person ever handles these keys.
3. Gives each assistant a webhook endpoint filtered to it (`member_id`), subscribed to `assistant.message` and the work events it needs. This needs `webhooks.manage`.
4. Sends a heartbeat for each assistant (`POST /api/v1/agents/heartbeat` with that assistant's key), so Status can tell when the service stops.

Each assistant then works the normal [work loop](work-loop.md) with its own key, and answers chat as below.

All of this can also be done from a chat: [Set up from a chat](setup-by-ai.md#assistant-setups).

### 4. Connect chat (optional)

Settings > Assistants > **Chat**. Bot tokens are stored encrypted.

**Slack**

1. At api.slack.com/apps, create an app for your workspace.
2. Under OAuth & Permissions, add the bot scopes `chat:write`, `im:history` and `app_mentions:read`, then install it.
3. Under App Home, turn on the Messages Tab, so people can message it.
4. In the app, press **Add Slack**. Paste the Bot User OAuth Token (`xoxb-...`) and, from Basic Information, the Signing Secret. Press **Connect**.
5. Copy the **Request URL** the app shows. In your Slack app, open Event Subscriptions, turn it on, paste the URL, and subscribe to the bot events `message.im` and `app_mention`.

**Telegram**

1. In Telegram, message @BotFather and send `/newbot`.
2. Pick a name. BotFather sends you a token.
3. In the app, press **Add Telegram**, paste the token and press **Connect**. The app does the rest.

Then each person links their own chat account from their Assistant page: they message the bot "hi" and open the link it sends while signed in.

### How a chat message travels

1. Slack or Telegram sends the message to the app. The app checks the provider's signature first.
2. The app finds who sent it through their verified linked account.
3. It records the message for that person's assistant and sends `assistant.message` (ids only) to the assistant's webhook. With no webhook, the message waits as pending.
4. The assistant reads the text with its own key (`get_chat_message`, or `list_chat_messages` to poll) and answers with `reply_in_chat` (`POST /api/v1/assistant/messages/{id}/reply`). The app sends the reply in the same conversation, in the thread where the provider has threads. `mark_chat_handled` closes a message that needs no answer.

Who gets a plain one-line answer instead:

| Sender | Answer |
|---|---|
| Not linked yet, in a direct message | A one-time link to connect their account (at most once an hour) |
| Not linked yet, in a shared channel | "Message me directly to connect your account." |
| Suspended | "This account is not active here. Ask your admin." |
| No assistant | "You don't have an assistant yet. Ask your admin to set one up." |
| Assistant paused by them | A link to resume it |
| Assistant paused by an admin | "Your assistant is paused. Your admin has been told." |
| Assistants are off | "Assistants are not turned on yet. Ask your admin." |

## What employees see

Their own page, `/assistant`, under the name you chose. It shows:

- **What needs them**: the assistant's questions, approvals and reply drafts.
- **What it did**, with Undo for tasks it created or finished and inbox sorts.
- **Chat**: connect Slack or Telegram to their account.
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
| Pause | | It does nothing until they resume it. |

## Privacy

- **Chat text stays with the person's assistant.** The webhook carries ids only. Only that assistant's key can read the text (`403 not_a_personal_agent` for any other key, 404 for another assistant's message). Message text never reaches the app's logs.
- **Disconnecting a chat** deletes its chat history in the app. Linked accounts stay, so connecting again picks up where it left off.
- **Personal memory belongs to the person.** Only they and their own assistant (while "Remember things for me" is on) see it. Never an Owner. Deleting an entry deletes it for good.
- **Leaving cleans up.** Suspending a person pauses their assistant and revokes its keys and pending links. Reactivating them un-pauses it; the agent service then collects a new key.

## Troubleshooting "paused"

Settings > Assistants > **Status** lists every assistant. Each one that needs you says why and links to its agent page. The person sees "Paused" and "Your admin has been told", and the admin gets a notification, at most once a day.

| Status | Why | Fix |
|---|---|---|
| Getting ready | Just made. The agent service has not collected its key yet (it has 15 minutes). | Check the service is running and polling `needs_key=true`. |
| Needs you: "It was never connected to the service that runs it." | No live key after 15 minutes, or its key expired or was revoked. | Have the service collect a key (`POST /api/v1/assistants/{id}/key`). If one exists but is expiring, rotate it instead. |
| Needs you: "The service that runs it stopped reporting." | Its last heartbeat is older than three of its promised intervals. | Restart the service. Check it beats for this assistant. |
| Needs you: "An admin paused it." | Someone other than the person suspended the assistant's account. | Reactivate it from the Team page. |
| Paused by them | The person pressed Pause. | Only they resume it, from their page. |

Separate from these: when an Owner pauses every agent (Settings > Security), or pauses this agent from its profile, it can still read and report but its other writes answer `423`. See [Limits and pause](work-loop.md#limits-and-pause).
