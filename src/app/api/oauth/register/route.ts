import type { NextRequest } from 'next/server';
import { getServiceClient } from '@/lib/api/supabase-service';
import { assertConnectAiOn, clientAddress, OAuthError, oauthErrorResponse, oauthJson, oauthRateLimit, registerClient } from '@/lib/api/connect-ai';

export const dynamic = 'force-dynamic';

/** Registrations an address may make an hour. */
const REGISTER_PER_HOUR = 20;

/**
 * Dynamic client registration (RFC 7591) for AI tools: JSON client metadata
 * in, the client (and its secret, once, when it asked for one) out with 201.
 * Open to anyone, as MCP tools need, but a client does nothing until a
 * signed-in person allows it. Redirect addresses are checked: https, http
 * only on this computer, an app's own scheme, never javascript: and the
 * like. 20 an hour per address. 403 access_denied while the workspace has
 * Connect AI off.
 */
export async function POST(request: NextRequest) {
  const service = getServiceClient();
  try {
    await assertConnectAiOn(service);
    await oauthRateLimit(service, `register:${clientAddress(request.headers)}`, REGISTER_PER_HOUR, 3600);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new OAuthError(400, 'invalid_client_metadata', 'Send the client metadata as JSON.');
    }
    return oauthJson(await registerClient(service, body), 201);
  } catch (caught) {
    return oauthErrorResponse(caught);
  }
}
