import type { NextRequest } from 'next/server';
import { metadataJson, protectedResourceMetadata } from '@/lib/api/connect-ai';
import { getBrand } from '@/lib/brand/server';

export const dynamic = 'force-dynamic';

/** RFC 9728's path form for the MCP server (/.well-known/oauth-protected-resource/api/mcp); other paths are 404. */
export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (path.join('/') !== 'api/mcp') return Response.json({ error: 'not_found' }, { status: 404 });
  const brand = await getBrand();
  return metadataJson(protectedResourceMetadata(request.nextUrl.origin, brand.name));
}
