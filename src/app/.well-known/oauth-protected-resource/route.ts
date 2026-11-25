import type { NextRequest } from 'next/server';
import { metadataJson, protectedResourceMetadata } from '@/lib/api/connect-ai';
import { getBrand } from '@/lib/brand/server';

export const dynamic = 'force-dynamic';

/**
 * OAuth protected resource metadata (RFC 9728) for the MCP server: which
 * authorization server issues its tokens (this app) and the one scope. An AI
 * tool reads it after the MCP server's 401 challenge, or here at the root
 * when it tries the well-known address first. The path form
 * (/.well-known/oauth-protected-resource/api/mcp) answers the same.
 */
export async function GET(request: NextRequest) {
  const brand = await getBrand();
  return metadataJson(protectedResourceMetadata(request.nextUrl.origin, brand.name));
}
