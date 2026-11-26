import { getServiceClient } from '@/lib/api/supabase-service';
import { appUrlFor } from '@/lib/team/invite';
import { handleChatInbound } from '@/lib/chat/inbound';
import { privateHeaders, readCappedJsonText } from '@/lib/webhooks/internal-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** A chat message is small; anything bigger is not one. */
const MAX_BODY_BYTES = 262_144;

function respond(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: privateHeaders });
}

/**
 * Where a connected chat provider sends messages (public: the provider has no
 * session). The connection's adapter verifies every request before anything
 * is read: Slack's signing secret, Telegram's secret token, the Discord
 * relay's X-PM-Relay-Signature (app/relay/discord holds Discord's Gateway
 * and posts each message here, signed with the connection's relay secret;
 * a stale or unsigned request is refused, a message id already recorded is
 * a duplicate). Slack's URL
 * verification challenge is answered here. Then the message reaches the
 * sender's own assistant (lib/chat/inbound.ts). 2xx tells the provider it is
 * done (a retry of the same delivery is a no-op); 5xx asks it to retry.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const env = process.env;
  if (env.NEXT_PUBLIC_DEMO_MODE === 'true' || env.DEMO_MODE === 'true') return respond({ error: 'Chat is disabled' }, 404);
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.NEXT_PUBLIC_SUPABASE_URL) return respond({ error: 'Chat is not configured' }, 503);
  const { id } = await params;
  let body: string;
  try {
    body = await readCappedJsonText(request, MAX_BODY_BYTES);
  } catch (error) {
    const tooLarge = (error as Error).message === 'Request is too large';
    return respond({ error: tooLarge ? 'Request is too large' : 'Send an application/json body' }, tooLarge ? 413 : 400);
  }
  try {
    const result = await handleChatInbound(getServiceClient(), id, { headers: request.headers, body }, appUrlFor(new URL(request.url).origin));
    return respond(result.body, result.status);
  } catch (error) {
    console.error(`[chat] inbound on connection ${id} failed`, (error as { code?: string })?.code ?? (error as Error)?.message);
    return respond({ error: 'Could not take the message. Retry later.' }, 500);
  }
}
