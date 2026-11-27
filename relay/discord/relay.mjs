// The Discord relay for a PM app install. Discord passes ordinary messages
// to a bot only over its Gateway, a websocket that a serverless host (such
// as Vercel) cannot hold open. This process holds it and posts each message
// to the app's inbound address for one chat connection, signed with that
// connection's relay secret. It keeps no state and reads nothing else.
//
// Environment:
//   DISCORD_BOT_TOKEN  the bot token, the same one pasted in the app
//   PM_INBOUND_URL     the connection's relay address, from the app
//   PM_RELAY_SECRET    the relay secret the app showed once
//
// What it posts (JSON, signed, see sign.mjs):
//   { v: 1, t: 'RELAY_READY', d: { bot_id, guilds } }        when it connects or resumes
//   { v: 1, t: 'RELAY_HEARTBEAT', d: { interval_seconds } }  every 5 minutes while connected,
//                                                            so the app sees a relay that stopped
//   { v: 1, t: 'MESSAGE_CREATE', d: <Discord's message>,
//     channel: { id, type, parent_id } }                      for each message from a person
// channel tells a thread (types 10 to 12, with its parent channel) from a
// channel (0, 5) or a DM (1). Message text is never logged.

import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { SIGNATURE_HEADER, signatureHeader } from './sign.mjs';

const { DISCORD_BOT_TOKEN, PM_INBOUND_URL, PM_RELAY_SECRET } = process.env;
const missing = Object.entries({ DISCORD_BOT_TOKEN, PM_INBOUND_URL, PM_RELAY_SECRET }).filter(([, value]) => !value).map(([name]) => name);
if (missing.length) {
  console.error(`[relay] set ${missing.join(', ')} first (see README.md)`);
  process.exit(1);
}
if (!/^https?:\/\//.test(PM_INBOUND_URL)) {
  console.error('[relay] PM_INBOUND_URL is the full address the app shows, starting with https://');
  process.exit(1);
}

const DELIVERY_TRIES = 5;
// The app reads a relay that sent heartbeats and then nothing for 15 minutes as stopped.
const HEARTBEAT_SECONDS = 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Posts one event to the app, signed afresh on every try; retries what the app asks to retry. */
async function deliver(payload) {
  const body = JSON.stringify(payload);
  for (let attempt = 0; attempt < DELIVERY_TRIES; attempt++) {
    try {
      const response = await fetch(PM_INBOUND_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signatureHeader(PM_RELAY_SECRET, body) },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return;
      if (response.status === 401) {
        console.error('[relay] the app refused the signature: check PM_RELAY_SECRET and PM_INBOUND_URL (make a new secret in the app if it was lost)');
        return;
      }
      // 429 and 5xx: the app asks for a retry. Anything else will not change.
      if (response.status !== 429 && response.status < 500) {
        console.error(`[relay] the app answered ${response.status} for ${payload.t}`);
        return;
      }
    } catch {
      // Network trouble: retried below.
    }
    await sleep(1000 * 2 ** attempt);
  }
  console.error(`[relay] gave up delivering ${payload.t} after ${DELIVERY_TRIES} tries`);
}

/** One signed post, no retries (heartbeats: the next one is the retry). */
async function deliverOnce(payload) {
  const body = JSON.stringify(payload);
  try {
    const response = await fetch(PM_INBOUND_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signatureHeader(PM_RELAY_SECRET, body) },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 401) console.error('[relay] the app refused the signature: check PM_RELAY_SECRET and PM_INBOUND_URL (make a new secret in the app if it was lost)');
    else if (!response.ok) console.error(`[relay] the app answered ${response.status} for ${payload.t}`);
  } catch {
    console.error(`[relay] could not reach the app for ${payload.t}`);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  // DMs arrive for channels the cache has not seen yet.
  partials: [Partials.Channel],
});

const hello = () => deliver({ v: 1, t: 'RELAY_READY', d: { bot_id: client.user?.id ?? null, guilds: client.guilds.cache.size } });

client.once(Events.ClientReady, () => {
  console.info(`[relay] connected as ${client.user?.tag} in ${client.guilds.cache.size} server(s)`);
  void hello();
});
client.on(Events.ShardResume, () => { void hello(); });

// Checks in while the Gateway is up, so the app's "Not receiving" catches a
// relay that stopped or lost Discord. One try: the next beat is the retry.
setInterval(() => {
  if (!client.isReady()) return;
  void deliverOnce({ v: 1, t: 'RELAY_HEARTBEAT', d: { interval_seconds: HEARTBEAT_SECONDS } });
}, HEARTBEAT_SECONDS * 1000).unref();

// Join new threads so their messages reach the bot.
client.on(Events.ThreadCreate, (thread) => {
  if (thread.joinable && !thread.joined) thread.join().catch(() => undefined);
});

// The raw Gateway packet: Discord's own message shape, exactly as the app reads it.
client.on(Events.Raw, (packet) => {
  if (packet?.t !== 'MESSAGE_CREATE') return;
  const message = packet.d;
  // Bots and webhooks (the agents' own replies) never go to the app.
  if (!message || message.author?.bot || message.webhook_id) return;
  void (async () => {
    let channel = { id: message.channel_id, type: message.guild_id ? null : 1, parent_id: null };
    if (message.guild_id) {
      const known = client.channels.cache.get(message.channel_id) ?? await client.channels.fetch(message.channel_id).catch(() => null);
      if (known) channel = { id: known.id, type: known.type, parent_id: known.parentId ?? null };
    }
    await deliver({ v: 1, t: 'MESSAGE_CREATE', d: message, channel });
  })().catch((error) => console.error('[relay] could not forward a message', error?.code ?? error?.message ?? 'unknown'));
});

client.on(Events.Error, (error) => console.error('[relay] gateway error', error?.code ?? error?.message ?? 'unknown'));
process.on('unhandledRejection', (error) => console.error('[relay] unhandled', error?.code ?? error?.message ?? 'unknown'));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void client.destroy().finally(() => process.exit(0));
  });
}

// discord.js reconnects and resumes on its own; a login that fails (a bad
// token, Message Content Intent off) exits so the reason is plain.
client.login(DISCORD_BOT_TOKEN).catch((error) => {
  const reason = /disallowed intents/i.test(String(error?.message))
    ? 'Turn on Message Content Intent on the Bot page of your app in the Discord Developer Portal.'
    : /token/i.test(String(error?.message ?? error?.code)) ? 'Discord refused DISCORD_BOT_TOKEN. Reset it on the Bot page and use the new one here and in the app.' : (error?.code ?? error?.message ?? 'unknown');
  console.error(`[relay] could not connect to Discord: ${reason}`);
  process.exit(1);
});
