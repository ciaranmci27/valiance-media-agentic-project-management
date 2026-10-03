import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request facts withApi knows and deeper helpers need without threading
 * them through every handler. Today only which door a request came through:
 * the MCP server runs the same v1 handlers inside { via: 'mcp' }, and the
 * audit log records it. It is set in process, never from a request header,
 * so a REST caller cannot claim it. The label grants nothing.
 */
export interface ApiRequestContext {
  via: 'rest' | 'mcp';
}

export const apiRequestContext = new AsyncLocalStorage<ApiRequestContext>();

export function currentApiVia(): ApiRequestContext['via'] {
  return apiRequestContext.getStore()?.via ?? 'rest';
}
