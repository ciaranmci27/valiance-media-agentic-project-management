import { connectAiState, listConnections, mcpResource } from '@/lib/api/connect-ai';
import { workspaceRoute } from '@/lib/api/workspace-route';
import { getBrand } from '@/lib/brand/server';
import { connectScopesFor, type MyConnectionsView } from '@/lib/connect-ai';

export const dynamic = 'force-dynamic';

/**
 * Connect AI in Settings > Account: the MCP address to paste, whether the
 * workspace lets people connect AI tools, what a connection of theirs may do,
 * and their connected apps (never a token). Answers MyConnectionsView.
 */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, memberId, access }): Promise<MyConnectionsView> => {
    const [state, connections, brand] = await Promise.all([connectAiState(service), listConnections(service, memberId), getBrand()]);
    return {
      ready: state.ready,
      enabled: state.ready && state.enabled,
      api_enabled: state.apiEnabled,
      mcp_url: mcpResource(new URL(request.url).origin),
      workspace_name: brand.name,
      scopes: access.role === 'agent' ? [] : connectScopesFor(access),
      connections,
    };
  }, { noStore: true });
}
