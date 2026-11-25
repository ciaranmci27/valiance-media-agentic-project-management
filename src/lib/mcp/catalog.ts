import { createHash } from 'node:crypto';
import { toolDefinition, type McpToolDefinition } from './core';
import { toolsFor, type ToolViewer } from './visibility';

/**
 * The tool catalog another MCP server reads to offer this app's tools inside
 * its own (GET /api/v1/mcp/tools): each tool as tools/list describes it, plus
 * the v1 routes it calls, for exactly the caller. `version` changes whenever
 * the list or any tool's description or schema does, so an aggregator can
 * cache by it.
 */

export const MCP_SERVER_INFO = { name: 'project-management', version: '1.0.0' } as const;

export interface CatalogTool extends McpToolDefinition {
  routes: Array<{ method: string; path: string }>;
}

export interface ToolCatalog {
  version: string;
  server: typeof MCP_SERVER_INFO;
  tools: CatalogTool[];
}

export function toolCatalog(viewer: ToolViewer): ToolCatalog {
  const tools = toolsFor(viewer).map((tool) => ({ ...toolDefinition(tool), routes: tool.routes }));
  const version = createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0, 16);
  return { version, server: MCP_SERVER_INFO, tools };
}
