import { getServiceClient } from '@/lib/api/supabase-service';
import { handleChatAction } from '@/lib/chat/inbound';
import { privateHeaders } from '@/lib/webhooks/internal-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** A press is a small form; anything bigger is not one. */
const MAX_BODY_BYTES = 65_536;

/**
 * Slack's interactivity address for a connection (public: Slack has no
 * session): a press of an answer button on the app's message. Verified with
 * the connection's signing secret and Slack's timestamp window before
 * anything is read (handleChatAction), then answered as its person
 * (lib/chat/answers.ts). 200 tells Slack it is done.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const env = process.env;
  if (env.NEXT_PUBLIC_DEMO_MODE === 'true' || env.DEMO_MODE === 'true') return Response.json({ error: 'Chat is disabled' }, { status: 404, headers: privateHeaders });
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.NEXT_PUBLIC_SUPABASE_URL) return Response.json({ error: 'Chat is not configured' }, { status: 503, headers: privateHeaders });
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return Response.json({ error: 'Send Slack\'s form body' }, { status: 400, headers: privateHeaders });
  }
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) return Response.json({ error: 'Request is too large' }, { status: 413, headers: privateHeaders });
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return Response.json({ error: 'Request is too large' }, { status: 413, headers: privateHeaders });
  const { id } = await params;
  try {
    const result = await handleChatAction(getServiceClient(), id, { headers: request.headers, body });
    return Response.json(result.body, { status: result.status, headers: privateHeaders });
  } catch (error) {
    console.error(`[chat] action on connection ${id} failed`, (error as Error)?.message);
    return Response.json({ error: 'Could not take the press. Try again.' }, { status: 500, headers: privateHeaders });
  }
}
