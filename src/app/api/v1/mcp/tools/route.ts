import { NextResponse } from 'next/server';
import { API_ENDPOINT_PERMISSIONS } from '@/lib/access-control';
import { withApi } from '@/lib/api/middleware';
import { mcpResource } from '@/lib/api/connect-ai';
import { toolCatalog } from '@/lib/mcp/catalog';
import { currentVersion } from '@/lib/updates/config';

export const dynamic = 'force-dynamic';

/**
 * The MCP tool catalog, as the caller sees it: every tool its key (or
 * connected AI tool's token, in Authorization: Bearer) would list on the MCP
 * server, each with its name, description, JSON input schema, annotations and
 * the v1 routes it calls, plus a version that changes with the list. With
 * X-Act-For it is the agent's and the person's tools together. For another
 * MCP server re-offering these tools: call the MCP server (tools/call) or the
 * routes with the person's token, or your agent key and a delegation pass.
 *
 * Permission: any API scope the key carries and its member holds.
 */
export const GET = withApi(async ({ supabase, access, scopes, permissions, teamMemberId, origin }) => {
  const { data: member } = await supabase.from('team_members').select('agent_profile').eq('id', teamMemberId).maybeSingle();
  const profile = access.role === 'agent' && typeof member?.agent_profile === 'string' ? member.agent_profile : 'generic';
  const catalog = toolCatalog({ access, scopes, readOnly: permissions === 'read_only', profile });
  return NextResponse.json({
    success: true,
    data: { ...catalog, mcp_url: mcpResource(origin), app_version: currentVersion() },
  }, { headers: { 'Cache-Control': 'no-store' } });
}, { permission: [...API_ENDPOINT_PERMISSIONS], acceptsConnection: true });
