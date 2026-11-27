# Discord relay

Discord is the one chat app that needs an extra piece. A Discord bot hears ordinary messages only over Discord's Gateway, a live websocket, and a serverless host such as Vercel cannot keep one open. This small relay keeps it open and posts each message to your app, signed. It holds no state, stores nothing and reads nothing but its three settings.

Run it anywhere you control: your own server, a small VPS, Fly or Railway. One relay serves one Discord connection (one bot). A personal bot and a company bot each run their own.

## Set up

1. **Create the bot.** At [discord.com/developers/applications](https://discord.com/developers/applications), press **New Application** and name it. A company bot and a personal assistants bot each need their own application.
2. **Turn on Message Content.** On the app's **Bot** page, under Privileged Gateway Intents, turn on **Message Content Intent** and save. Without it the bot sees mentions only, never the words of other messages.
3. **Copy the token.** On the same page press **Reset Token** and copy it.
4. **Connect it in the app.** Settings > Assistants > Chat apps > **Add chat app** > **Discord**, choose who it serves, paste the token and press **Connect**.
5. **Copy what the app shows once:** the relay secret (`PM_RELAY_SECRET`) and the relay address (`PM_INBOUND_URL`). The secret is never shown again; lost it, press **New relay secret** on the connection's row.
6. **Invite the bot** with the link the app shows (**Invite the bot to your server**). It asks for the permissions the bot needs:

   | Kind | Permissions |
   |---|---|
   | Personal assistants | None in the server: people message the bot directly. It only needs to share a server with them. |
   | Company AI | View Channels, Send Messages, Read Message History, Send Messages in Threads, Manage Webhooks |

   Manage Webhooks lets each agent's reply show its own name and avatar. Without it, replies come from the bot with the agent's name in bold on the first line.
7. **Run the relay** with Docker or Node (below). The connection in the app changes from "Waiting for relay" to "Connected" as soon as the relay says hello.

## Run it

Three settings, as environment variables:

| Variable | What |
|---|---|
| `DISCORD_BOT_TOKEN` | The bot token, the same one you pasted in the app |
| `PM_INBOUND_URL` | The relay address the app shows, `https://<your app>/api/chat/inbound/<connection id>` |
| `PM_RELAY_SECRET` | The relay secret the app showed once (`rsec_...`) |

**Docker**, from the folder that holds this README:

```bash
docker build -t pm-discord-relay . && docker run -d --name pm-discord-relay --restart unless-stopped \
  -e DISCORD_BOT_TOKEN=... -e PM_INBOUND_URL=https://... -e PM_RELAY_SECRET=rsec_... pm-discord-relay
```

**Node** 18.17 or newer:

```bash
npm install --omit=dev && DISCORD_BOT_TOKEN=... PM_INBOUND_URL=https://... PM_RELAY_SECRET=rsec_... npm start
```

**Fly, Railway or similar:** deploy this folder (it has a Dockerfile), set the three variables as secrets, and run one instance. It needs no port, disk or database.

It prints one line when it connects (`connected as Bot#0001 in 2 server(s)`) and only errors after that. Message text is never logged.

## What it sends

Each request is a `POST` to `PM_INBOUND_URL` with a JSON body and this header:

```
X-PM-Relay-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with PM_RELAY_SECRET>
```

The app refuses a request without it, with a wrong one, or more than five minutes old. A message id it already recorded is a duplicate, so a retry never records anything twice.

| Body | When |
|---|---|
| `{ "v": 1, "t": "RELAY_READY", "d": { "bot_id", "guilds" } }` | It connected or resumed. Marks the connection heard. |
| `{ "v": 1, "t": "RELAY_HEARTBEAT", "d": { "interval_seconds": 300 } }` | Every 5 minutes while it is connected. Once a relay has sent one, the app shows "Not receiving" when it hears nothing from it for 15 minutes, so a relay that stopped is noticed. A relay older than 1.1.0 sends none and is never flagged this way. |
| `{ "v": 1, "t": "MESSAGE_CREATE", "d": <Discord's message>, "channel": { "id", "type", "parent_id" } }` | A person wrote in a DM, a channel or a thread the bot can see. `channel` tells a thread (types 10 to 12, with its parent) from a channel or a DM (type 1). |

Bots and webhooks, including the agents' own replies, are never forwarded. A delivery the app asks to retry (429 or 5xx) is retried with backoff, signed afresh each time. Discord.js reconnects and resumes the Gateway by itself; a token Discord refuses, or Message Content turned off, stops the relay with a plain reason.

## Troubleshooting

| You see | Do |
|---|---|
| "Not receiving" with "The relay stopped checking in" | The relay stopped or lost Discord. Start it again and check its log. It reads "Connected" again at its first heartbeat or message. |
| "Waiting for relay" stays in the app | Check the relay is running and printed "connected". Check `PM_INBOUND_URL` is this connection's address. |
| `the app refused the signature` | `PM_RELAY_SECRET` is not this connection's current secret. Make a new one in the app and restart the relay with it. |
| `Turn on Message Content Intent` | Turn it on (step 2) and restart the relay. |
| The bot hears mentions but not other messages | Message Content Intent is off, or the channel is set to **Mentions only** in the app (company bots). |
| Replies come from the bot with the name in bold | Give the bot Manage Webhooks in that channel. The app tries again within an hour. |
