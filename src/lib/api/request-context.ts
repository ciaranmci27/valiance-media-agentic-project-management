import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request facts withApi knows and deeper helpers need without threading
 * them through every handler: which door a request came through (the MCP
 * server runs the same v1 handlers inside { via: 'mcp' }, and the audit log
 * records it) and which API key made it, so a task it creates can say so.
 * Both are set in process, never from a request header, so a REST caller
 * cannot claim them. Neither grants anything. principalId is the person a
 * valid delegation token (X-Act-For) lets the key's agent act for; withApi
 * sets it only after checking the token, and writes stamp it as principal_id.
 */
export interface ApiRequestContext {
  via: 'rest' | 'mcp';
  keyId?: string | null;
  principalId?: string | null;
  /** The raw X-Act-For token, so the MCP server's in-process calls carry it on. */
  actFor?: string | null;
  /** For an agent's key: the projects it is paused on (project_agents.status paused). */
  pausedProjectIds?: string[];
  /**
   * A Connect AI connection made the request (an OAuth access token on the
   * MCP server). Set only by the MCP route after it checked the token, so the
   * in-process calls accept it and the audit log records via mcp_oauth.
   */
  connection?: boolean;
}

export const apiRequestContext = new AsyncLocalStorage<ApiRequestContext>();

export function currentApiVia(): ApiRequestContext['via'] {
  return apiRequestContext.getStore()?.via ?? 'rest';
}

/**
 * What the audit log records as via: mcp_oauth for a Connect AI connection,
 * else the door (rest, mcp).
 */
export function currentAuditVia(): 'rest' | 'mcp' | 'mcp_oauth' {
  const store = apiRequestContext.getStore();
  if (store?.connection) return 'mcp_oauth';
  return store?.via ?? 'rest';
}

/** A Connect AI connection made the current request. */
export function currentConnection(): boolean {
  return apiRequestContext.getStore()?.connection === true;
}

/** The API key behind the current request, or null outside one. */
export function currentApiKeyId(): string | null {
  return apiRequestContext.getStore()?.keyId ?? null;
}

/** The person the current request acts for (a checked X-Act-For), or null. */
export function currentPrincipalId(): string | null {
  return apiRequestContext.getStore()?.principalId ?? null;
}

/** Where a write made on someone's behalf came from, for the team activity log. */
export function currentActorVia(): 'app' | 'api' | 'mcp' {
  const via = apiRequestContext.getStore()?.via;
  return via === 'mcp' ? 'mcp' : via === 'rest' ? 'api' : 'app';
}

/** The projects the current request's agent is paused on ([] outside one, or for a person). */
export function currentPausedProjectIds(): string[] {
  return apiRequestContext.getStore()?.pausedProjectIds ?? [];
}
