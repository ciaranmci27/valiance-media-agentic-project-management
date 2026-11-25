import type { NextRequest } from 'next/server';
import { getServiceClient } from '@/lib/api/supabase-service';
import {
  assertConnectAiOn,
  authenticateClient,
  clientAddress,
  exchangeCode,
  OAuthError,
  oauthErrorResponse,
  oauthJson,
  oauthRateLimit,
  refreshTokens,
} from '@/lib/api/connect-ai';

export const dynamic = 'force-dynamic';

/** Token requests a minute: per address, and per client. */
const PER_ADDRESS_PER_MINUTE = 60;
const PER_CLIENT_PER_MINUTE = 30;

/** The form (application/x-www-form-urlencoded, as OAuth sends it); a JSON body is read too, for lenient clients. */
async function readForm(request: NextRequest): Promise<URLSearchParams> {
  const type = request.headers.get('content-type') ?? '';
  const text = await request.text();
  if (type.includes('application/json')) {
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      return new URLSearchParams(Object.entries(json).filter(([, v]) => typeof v === 'string') as [string, string][]);
    } catch {
      throw new OAuthError(400, 'invalid_request', 'The body is not valid JSON.');
    }
  }
  return new URLSearchParams(text);
}

/**
 * The token endpoint: grant_type authorization_code (code, redirect_uri,
 * code_verifier, client_id) or refresh_token (refresh_token, client_id).
 * Answers { access_token, token_type Bearer, expires_in 3600,
 * refresh_token, scope }, never cached. Every refresh hands out a new
 * refresh token; using an old one again revokes the connection. Rate
 * limited per address and per client (429 slow_down). 403 access_denied
 * while the workspace has Connect AI off.
 */
export async function POST(request: NextRequest) {
  const service = getServiceClient();
  try {
    await oauthRateLimit(service, `token-ip:${clientAddress(request.headers)}`, PER_ADDRESS_PER_MINUTE, 60);
    const form = await readForm(request);
    await assertConnectAiOn(service);
    const client = await authenticateClient(service, form, request.headers.get('authorization'));
    await oauthRateLimit(service, `token:${client.client_id}`, PER_CLIENT_PER_MINUTE, 60);
    const grantType = form.get('grant_type');
    const origin = request.nextUrl.origin;
    if (grantType === 'authorization_code') return oauthJson(await exchangeCode(service, client, form, origin));
    if (grantType === 'refresh_token') return oauthJson(await refreshTokens(service, client, form, origin));
    throw new OAuthError(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token.');
  } catch (caught) {
    return oauthErrorResponse(caught);
  }
}
