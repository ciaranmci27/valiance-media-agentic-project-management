import type { NextRequest } from 'next/server';
import { authorizationServerMetadata, metadataJson } from '@/lib/api/connect-ai';

export const dynamic = 'force-dynamic';

/**
 * OAuth authorization server metadata (RFC 8414): where an AI tool
 * registers, sends the person to sign in and swaps codes for tokens, and
 * what is supported (the code grant with PKCE S256, refresh tokens, public
 * and secret clients, iss on the redirect).
 */
export async function GET(request: NextRequest) {
  return metadataJson(authorizationServerMetadata(request.nextUrl.origin));
}
