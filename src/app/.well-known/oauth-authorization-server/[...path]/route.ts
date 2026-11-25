import type { NextRequest } from 'next/server';
import { authorizationServerMetadata, metadataJson } from '@/lib/api/connect-ai';

export const dynamic = 'force-dynamic';

/**
 * The same metadata at the path form some tools try for the MCP address
 * (/.well-known/oauth-authorization-server/api/mcp). Other paths are 404.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (path.join('/') !== 'api/mcp') return Response.json({ error: 'not_found' }, { status: 404 });
  return metadataJson(authorizationServerMetadata(request.nextUrl.origin));
}
