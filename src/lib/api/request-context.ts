import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request facts withApi knows and deeper helpers need without threading
 * them through every handler: which door a request came through (the MCP
 * server runs the same v1 handlers inside { via: 'mcp' }, and the audit log
 * records it) and which API key made it, so a task it creates can say so.
 * Both are set in process, never from a request header, so a REST caller
 * cannot claim them. Neither grants anything.
 */
export interface ApiRequestContext {
  via: 'rest' | 'mcp';
  keyId?: string | null;
}

export const apiRequestContext = new AsyncLocalStorage<ApiRequestContext>();

export function currentApiVia(): ApiRequestContext['via'] {
  return apiRequestContext.getStore()?.via ?? 'rest';
}

/** The API key behind the current request, or null outside one. */
export function currentApiKeyId(): string | null {
  return apiRequestContext.getStore()?.keyId ?? null;
}

/** Where a write made on someone's behalf came from, for the team activity log. */
export function currentActorVia(): 'app' | 'api' | 'mcp' {
  const via = apiRequestContext.getStore()?.via;
  return via === 'mcp' ? 'mcp' : via === 'rest' ? 'api' : 'app';
}
