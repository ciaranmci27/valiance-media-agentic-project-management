import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';
import {
  CONNECT_ACCESS_TOKEN_SECONDS,
  CONNECT_CODE_SECONDS,
  CONNECT_OAUTH_SCOPE,
  CONNECT_PREFIXES,
  CONNECT_REFRESH_TOKEN_SECONDS,
  connectMcpUrl,
  redirectHost,
  redirectUriProblem,
  type ConnectionView,
} from '@/lib/connect-ai';
import { appUrlFor } from '@/lib/team/invite';
import { resolveMemberAccess } from './access';
import { insertAuditRows } from './audit';
import { hashApiKey } from './crypto';
import { ApiError, forbidden, unauthorized } from './errors';

/**
 * Connect AI on the server: this app as the OAuth 2.1 authorization server
 * for its own MCP server (the resource). What it implements:
 * - RFC 9728 protected resource metadata and RFC 8414 server metadata;
 * - RFC 7591 dynamic client registration (open, rate limited, redirect
 *   addresses checked);
 * - the authorization code grant with PKCE S256 only, RFC 8707 resource
 *   indicators (one resource: the MCP URL), RFC 9207 iss on the redirect;
 * - refresh tokens, rotated on every use, a reused one revoking its family;
 * - opaque tokens, hashed at rest, bound to the client, person and scopes.
 * Not implemented: client ID metadata documents (the server would fetch a
 * URL a stranger names), token revocation and introspection endpoints, and
 * scopes beyond `connect`.
 *
 * Each connection (pm.oauth_grants) is backed by an API key nobody holds
 * (permissions 'connection', the connect scopes only), so every MCP call a
 * connection makes runs through withApi exactly as a key's does.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

/** An OAuth error answer: { error, error_description } with its status (RFC 6749 5.2, RFC 7591 3.2.2). */
export class OAuthError extends Error {
  constructor(public status: number, public error: string, description: string) {
    super(description);
  }
}

const sha256Base64Url = (value: string) => createHash('sha256').update(value).digest('base64url');
const random = (prefix: string) => `${prefix}${randomBytes(32).toString('hex')}`;

// ── Addresses and metadata ──────────────────────────────────────────────

/** This app as the issuer: NEXT_PUBLIC_APP_URL, else the request's origin, without a trailing slash. */
export function oauthIssuer(origin: string): string {
  return appUrlFor(origin).replace(/\/+$/, '');
}

/** The one resource tokens are issued for. */
export function mcpResource(origin: string): string {
  return connectMcpUrl(oauthIssuer(origin));
}

export function resourceMetadataUrl(origin: string): string {
  return `${oauthIssuer(origin)}/.well-known/oauth-protected-resource/api/mcp`;
}

/** The WWW-Authenticate challenge the MCP server answers a 401 with (RFC 6750 3, RFC 9728 5.1). */
export function bearerChallenge(origin: string, error?: { code: string; description: string }): string {
  const parts = [`resource_metadata="${resourceMetadataUrl(origin)}"`, `scope="${CONNECT_OAUTH_SCOPE}"`];
  if (error) parts.unshift(`error="${error.code}"`, `error_description="${error.description.replace(/"/g, "'")}"`);
  return `Bearer ${parts.join(', ')}`;
}

export function protectedResourceMetadata(origin: string, name: string) {
  const issuer = oauthIssuer(origin);
  return {
    resource: mcpResource(origin),
    authorization_servers: [issuer],
    scopes_supported: [CONNECT_OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: name,
    resource_documentation: `${issuer}/api/docs#connect-ai`,
  };
}

export function authorizationServerMetadata(origin: string) {
  const issuer = oauthIssuer(origin);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    registration_endpoint: `${issuer}/api/oauth/register`,
    scopes_supported: [CONNECT_OAUTH_SCOPE],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${issuer}/api/docs#connect-ai`,
  };
}

// ── The workspace switch ────────────────────────────────────────────────

export interface ConnectAiState {
  /** Let people connect AI tools (business_settings.connect_ai_enabled). */
  enabled: boolean;
  apiEnabled: boolean;
  /** The migration has run (the column is there). */
  ready: boolean;
}

const missingColumn = (error: { code?: string; message?: string } | null) =>
  !!error && (['42703', 'PGRST204', '42P01', 'PGRST205', 'PGRST202', '42883'].includes(error.code ?? '') || /does not exist|schema cache/i.test(error.message ?? ''));

export async function connectAiState(service: SupabaseClient): Promise<ConnectAiState> {
  const { data, error } = await service.from('business_settings').select('api_enabled, connect_ai_enabled').limit(1).maybeSingle();
  if (error) {
    if (missingColumn(error)) return { enabled: false, apiEnabled: true, ready: false };
    throw error;
  }
  return { enabled: data?.connect_ai_enabled !== false, apiEnabled: data?.api_enabled !== false, ready: true };
}

/** 403 access_denied unless people may connect AI tools here now. */
export async function assertConnectAiOn(service: SupabaseClient): Promise<void> {
  const state = await connectAiState(service);
  if (!state.ready) throw new OAuthError(503, 'temporarily_unavailable', 'This workspace needs its latest database update before AI tools can connect.');
  if (!state.enabled) throw new OAuthError(403, 'access_denied', 'Connecting AI tools is turned off for this workspace. An Owner can turn it on in Settings > Security.');
  if (!state.apiEnabled) throw new OAuthError(403, 'access_denied', 'API access is turned off for this workspace, so AI tools cannot connect.');
}

/** Owner only: turn Connect AI on or off. Written as the Owner, so the audit log says who. */
export async function setConnectAiEnabled(service: SupabaseClient, enabled: boolean): Promise<ConnectAiState> {
  const { data: row, error: readError } = await service.from('business_settings').select('id').limit(1).maybeSingle();
  if (readError) throw readError;
  if (!row) throw new ApiError(409, 'CONFLICT', 'The workspace settings row is missing. Finish setup first.');
  const { error } = await service.from('business_settings').update({ connect_ai_enabled: enabled }).eq('id', row.id);
  if (error) {
    if (missingColumn(error)) throw new ApiError(409, 'MIGRATION_REQUIRED', 'Run the latest database migration first.', { reason: 'migration_required' });
    throw error;
  }
  return connectAiState(service);
}

// ── Rate limits ─────────────────────────────────────────────────────────

/** The caller's address for rate limits: the first X-Forwarded-For hop (set by the host), else X-Real-IP. */
export function clientAddress(headers: Headers): string {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip')?.trim() || 'unknown';
}

/** 429 slow_down once a bucket passes its limit for the window. */
export async function oauthRateLimit(service: SupabaseClient, bucket: string, limit: number, windowSeconds: number): Promise<void> {
  const { data, error } = await service.rpc('oauth_rate_limit', { p_bucket: bucket, p_limit: limit, p_window_seconds: windowSeconds });
  if (error) throw error;
  if ((data as Row | null)?.allowed !== true) {
    throw new OAuthError(429, 'slow_down', 'Too many requests. Wait a minute and try again.');
  }
}

// ── Registration (RFC 7591) ─────────────────────────────────────────────

const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;
type AuthMethod = typeof AUTH_METHODS[number];

const shortText = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

/**
 * Registers a tool. redirect_uris (1 to 10) is required and each address is
 * checked (redirectUriProblem). token_endpoint_auth_method none (what MCP
 * tools send) makes a public client; client_secret_post or _basic (the
 * RFC's default when it is left out) gets a secret, shown once. Only the
 * authorization_code and refresh_token grants and the code response type.
 */
export async function registerClient(service: SupabaseClient, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OAuthError(400, 'invalid_client_metadata', 'Send the client metadata as a JSON object.');
  const input = body as Row;
  const uris = input.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) throw new OAuthError(400, 'invalid_redirect_uri', 'redirect_uris must list at least one address.');
  if (uris.length > 10) throw new OAuthError(400, 'invalid_redirect_uri', 'redirect_uris lists at most 10 addresses.');
  for (const uri of uris) {
    const problem = redirectUriProblem(uri);
    if (problem) throw new OAuthError(400, 'invalid_redirect_uri', problem);
  }
  const method = (input.token_endpoint_auth_method ?? 'client_secret_basic') as AuthMethod;
  if (!AUTH_METHODS.includes(method)) throw new OAuthError(400, 'invalid_client_metadata', `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(', ')}.`);
  const grantTypes = input.grant_types ?? ['authorization_code', 'refresh_token'];
  if (!Array.isArray(grantTypes) || grantTypes.length === 0 || grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
    throw new OAuthError(400, 'invalid_client_metadata', 'grant_types may hold only authorization_code and refresh_token.');
  }
  const responseTypes = input.response_types ?? ['code'];
  if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== 'code')) {
    throw new OAuthError(400, 'invalid_client_metadata', 'response_types may hold only code.');
  }
  const clientUri = shortText(input.client_uri, 500);
  if (clientUri && !/^https:\/\//i.test(clientUri)) throw new OAuthError(400, 'invalid_client_metadata', 'client_uri must be an https address.');

  const clientId = random(CONNECT_PREFIXES.client).slice(0, CONNECT_PREFIXES.client.length + 32);
  const secret = method === 'none' ? null : random(CONNECT_PREFIXES.clientSecret);
  const row = {
    client_id: clientId,
    client_name: shortText(input.client_name, 100) ?? 'AI tool',
    client_uri: clientUri,
    redirect_uris: [...new Set(uris as string[])],
    grant_types: [...new Set(grantTypes as string[])],
    token_endpoint_auth_method: method,
    client_secret_hash: secret ? await hashApiKey(secret) : null,
    software_id: shortText(input.software_id, 200),
    software_version: shortText(input.software_version, 100),
  };
  const { data, error } = await service.from('oauth_clients').insert(row).select('created_at').single();
  if (error) throw error;
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(new Date(data.created_at).getTime() / 1000),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_name: row.client_name,
    ...(row.client_uri ? { client_uri: row.client_uri } : {}),
    redirect_uris: row.redirect_uris,
    grant_types: row.grant_types,
    response_types: ['code'],
    token_endpoint_auth_method: method,
    scope: CONNECT_OAUTH_SCOPE,
  };
}

export interface OAuthClient {
  id: string;
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: AuthMethod;
  client_secret_hash: string | null;
}

export async function findClient(service: SupabaseClient, clientId: string | null | undefined): Promise<OAuthClient | null> {
  if (!clientId || !clientId.startsWith(CONNECT_PREFIXES.client) || clientId.length > 100) return null;
  const { data, error } = await service.from('oauth_clients')
    .select('id, client_id, client_name, redirect_uris, grant_types, token_endpoint_auth_method, client_secret_hash')
    .eq('client_id', clientId).maybeSingle();
  if (error) {
    // Before the migration nobody is registered.
    if (missingColumn(error)) return null;
    throw error;
  }
  return (data as OAuthClient | null) ?? null;
}

// ── The authorization request ───────────────────────────────────────────

export interface AuthorizeParams {
  response_type?: string | null;
  client_id?: string | null;
  redirect_uri?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
  state?: string | null;
  scope?: string | null;
  resource?: string | null;
}

/** Read from a URL's query or a POST body: the fields the authorization request carries. */
export function authorizeParamsFrom(source: URLSearchParams | Row): AuthorizeParams {
  const get = (name: string) => {
    const value = source instanceof URLSearchParams ? source.get(name) : source[name];
    return typeof value === 'string' ? value : null;
  };
  return {
    response_type: get('response_type'), client_id: get('client_id'), redirect_uri: get('redirect_uri'),
    code_challenge: get('code_challenge'), code_challenge_method: get('code_challenge_method'),
    state: get('state'), scope: get('scope'), resource: get('resource'),
  };
}

/** The resource a request names, checked: absent, or this MCP server (case of scheme and host, a trailing slash forgiven). */
function resourceMatches(resource: string | null | undefined, origin: string): boolean {
  if (!resource) return true;
  const ours = mcpResource(origin);
  try {
    const a = new URL(resource);
    const b = new URL(ours);
    return a.origin.toLowerCase() === b.origin.toLowerCase() && a.pathname.replace(/\/+$/, '') === b.pathname && !a.search && !a.hash;
  } catch {
    return false;
  }
}

export type AuthorizeCheck =
  /** Shown on the page, never sent back: the client or its redirect address cannot be trusted. */
  | { kind: 'page_error'; message: string }
  /** Sent back to the tool on its redirect address. */
  | { kind: 'redirect_error'; client: OAuthClient; redirectUri: string; error: string; description: string; state: string | null }
  | { kind: 'ok'; client: OAuthClient; redirectUri: string; challenge: string; state: string | null; resource: string | null };

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Checks an authorization request in the order OAuth wants: first the
 * client and its exact redirect address (else an error page, never a
 * redirect to an address nobody registered), then everything else (sent
 * back to the tool): response_type code, PKCE S256 with a well-formed
 * challenge, the resource, the scope.
 */
export async function checkAuthorizeRequest(service: SupabaseClient, params: AuthorizeParams, origin: string): Promise<AuthorizeCheck> {
  const client = await findClient(service, params.client_id);
  if (!client) return { kind: 'page_error', message: 'This sign-in link is not valid: the app that sent you here is not registered. Start connecting again from your AI tool.' };
  let redirectUri = params.redirect_uri ?? null;
  if (!redirectUri && client.redirect_uris.length === 1) redirectUri = client.redirect_uris[0];
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return { kind: 'page_error', message: 'This sign-in link is not valid: its return address does not match the one the app registered. Start connecting again from your AI tool.' };
  }
  const state = params.state ?? null;
  const fail = (error: string, description: string): AuthorizeCheck => ({ kind: 'redirect_error', client, redirectUri: redirectUri as string, error, description, state });
  if (params.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
  if (!client.grant_types.includes('authorization_code')) return fail('unauthorized_client', 'This client did not register the authorization_code grant.');
  if (!params.code_challenge || params.code_challenge_method !== 'S256') return fail('invalid_request', 'PKCE is required: send code_challenge with code_challenge_method=S256.');
  if (!CHALLENGE.test(params.code_challenge)) return fail('invalid_request', 'code_challenge must be the base64url SHA-256 of the verifier (43 characters).');
  if (!resourceMatches(params.resource, origin)) return fail('invalid_target', `resource must be this MCP server: ${mcpResource(origin)}.`);
  return { kind: 'ok', client, redirectUri, challenge: params.code_challenge, state, resource: params.resource ?? null };
}

/** The redirect back to the tool: code or error, state, and iss (RFC 9207). */
export function redirectBack(redirectUri: string, origin: string, values: Record<string, string | null | undefined>): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(values)) if (value) url.searchParams.set(name, value);
  url.searchParams.set('iss', oauthIssuer(origin));
  return url.toString();
}

/** Stores a one-time code for an allowed request: hashed, about 60 seconds, bound to the client, person, redirect and challenge. */
export async function issueCode(service: SupabaseClient, input: {
  check: Extract<AuthorizeCheck, { kind: 'ok' }>; memberId: string; scopes: string[];
}): Promise<string> {
  const code = random(CONNECT_PREFIXES.code);
  const { error } = await service.from('oauth_codes').insert({
    code_hash: await hashApiKey(code),
    client_id: input.check.client.id,
    member_id: input.memberId,
    redirect_uri: input.check.redirectUri,
    code_challenge: input.check.challenge,
    scopes: input.scopes,
    resource: input.check.resource,
    expires_at: new Date(Date.now() + CONNECT_CODE_SECONDS * 1000).toISOString(),
  });
  if (error) throw error;
  return code;
}

// ── The token endpoint ──────────────────────────────────────────────────

const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Who is calling the token endpoint: client_id (in the form or Basic auth),
 * and its secret when it registered one. A public client sends none.
 */
export async function authenticateClient(service: SupabaseClient, form: URLSearchParams, authorization: string | null): Promise<OAuthClient> {
  let clientId = form.get('client_id');
  let secret = form.get('client_secret');
  let basic = false;
  const match = /^Basic\s+(\S+)$/i.exec(authorization ?? '');
  if (match) {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon > 0) {
      clientId = decodeURIComponent(decoded.slice(0, colon));
      secret = decodeURIComponent(decoded.slice(colon + 1));
      basic = true;
    }
  }
  const client = await findClient(service, clientId);
  if (!client) throw new OAuthError(401, 'invalid_client', 'Unknown client.');
  if (client.token_endpoint_auth_method !== 'none') {
    if (!secret || !client.client_secret_hash || !safeEqual(await hashApiKey(secret), client.client_secret_hash)) {
      throw new OAuthError(401, 'invalid_client', 'The client secret is missing or wrong.');
    }
    if (client.token_endpoint_auth_method === 'client_secret_basic' && !basic) {
      throw new OAuthError(401, 'invalid_client', 'This client authenticates with HTTP Basic.');
    }
  }
  return client;
}

export interface TokenAnswer {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function newTokenPair() {
  const access = random(CONNECT_PREFIXES.access);
  const refresh = random(CONNECT_PREFIXES.refresh);
  return {
    access,
    refresh,
    accessHash: await hashApiKey(access),
    refreshHash: await hashApiKey(refresh),
    accessExpires: new Date(Date.now() + CONNECT_ACCESS_TOKEN_SECONDS * 1000).toISOString(),
    refreshExpires: new Date(Date.now() + CONNECT_REFRESH_TOKEN_SECONDS * 1000).toISOString(),
  };
}

const answer = (pair: { access: string; refresh: string }): TokenAnswer => ({
  access_token: pair.access,
  token_type: 'Bearer',
  expires_in: CONNECT_ACCESS_TOKEN_SECONDS,
  refresh_token: pair.refresh,
  scope: CONNECT_OAUTH_SCOPE,
});

const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** An audit row for a connection's life (connected, a reuse caught). Never a token, code or secret. */
async function auditConnection(service: SupabaseClient, row: {
  step: 'connected' | 'code_reused' | 'refresh_reused'; grantId: string | null; memberId: string | null; apiKeyId: string | null; client: OAuthClient; status: number;
}) {
  const { error } = await insertAuditRows(service, {
    method: 'POST',
    endpoint: '/api/oauth/token',
    entity_type: 'oauth_grant',
    entity_id: row.grantId,
    api_key_id: row.apiKeyId,
    team_member_id: row.memberId,
    request_body: { step: row.step, client_name: row.client.client_name, client_id: row.client.client_id },
    status_code: row.status,
    via: 'mcp_oauth',
  });
  if (error) console.error('[connect-ai] audit write failed:', error.message);
}

/**
 * grant_type=authorization_code: the code is taken once (a second use
 * revokes what the first issued) by the client it was issued to, then the
 * redirect_uri, when sent, must match and the PKCE verifier must hash to the
 * challenge; a wrong one spends the code.
 */
export async function exchangeCode(service: SupabaseClient, client: OAuthClient, form: URLSearchParams, origin: string): Promise<TokenAnswer> {
  const code = form.get('code');
  const verifier = form.get('code_verifier');
  if (!code || !verifier) throw new OAuthError(400, 'invalid_request', 'code and code_verifier are required.');
  if (!client.grant_types.includes('authorization_code')) throw new OAuthError(400, 'unauthorized_client', 'This client did not register the authorization_code grant.');
  const codeHash = await hashApiKey(code);
  const { data: claimed, error } = await service.rpc('oauth_claim_code', { p_code_hash: codeHash, p_client_id: client.id });
  if (error) throw error;
  const claim = (claimed ?? {}) as Row;
  if (claim.status === 'reused') {
    if (claim.grant_id) await auditConnection(service, { step: 'code_reused', grantId: claim.grant_id, memberId: claim.member_id ?? null, apiKeyId: null, client, status: 400 });
    throw new OAuthError(400, 'invalid_grant', 'This code was already used. Anything it gave out is now revoked.');
  }
  if (claim.status !== 'ok') throw new OAuthError(400, 'invalid_grant', 'The code is not valid or has expired.');
  // Optional, as in OAuth 2.1 (PKCE binds the code); sent, it must match exactly.
  const redirectUri = form.get('redirect_uri');
  if (redirectUri !== null && redirectUri !== claim.redirect_uri) throw new OAuthError(400, 'invalid_grant', 'redirect_uri does not match the authorization request.');
  if (!VERIFIER.test(verifier) || !safeEqual(sha256Base64Url(verifier), String(claim.code_challenge))) {
    throw new OAuthError(400, 'invalid_grant', 'The code_verifier does not match the code_challenge.');
  }
  const resource = form.get('resource');
  if (!resourceMatches(resource, origin)) throw new OAuthError(400, 'invalid_target', `resource must be this MCP server: ${mcpResource(origin)}.`);

  const pair = await newTokenPair();
  const { data: made, error: grantError } = await service.rpc('oauth_create_grant', {
    p_code_hash: codeHash, p_access_hash: pair.accessHash, p_refresh_hash: pair.refreshHash,
    p_access_expires: pair.accessExpires, p_refresh_expires: pair.refreshExpires,
  });
  if (grantError) throw grantError;
  const grant = (made ?? {}) as Row;
  if (grant.status !== 'ok') throw new OAuthError(400, 'invalid_grant', 'The code can no longer be used. Connect again from your AI tool.');
  await auditConnection(service, { step: 'connected', grantId: grant.grant_id, memberId: grant.member_id, apiKeyId: grant.api_key_id, client, status: 200 });
  return answer(pair);
}

/** grant_type=refresh_token: a new access and refresh token; a refresh token used twice ends the connection. */
export async function refreshTokens(service: SupabaseClient, client: OAuthClient, form: URLSearchParams, origin: string): Promise<TokenAnswer> {
  const refresh = form.get('refresh_token');
  if (!refresh) throw new OAuthError(400, 'invalid_request', 'refresh_token is required.');
  if (!client.grant_types.includes('refresh_token')) throw new OAuthError(400, 'unauthorized_client', 'This client did not register the refresh_token grant.');
  const scope = form.get('scope');
  if (scope && scope.split(/\s+/).some((s) => s && s !== CONNECT_OAUTH_SCOPE)) throw new OAuthError(400, 'invalid_scope', `Only the ${CONNECT_OAUTH_SCOPE} scope is offered.`);
  if (!resourceMatches(form.get('resource'), origin)) throw new OAuthError(400, 'invalid_target', `resource must be this MCP server: ${mcpResource(origin)}.`);
  const pair = await newTokenPair();
  const { data, error } = await service.rpc('oauth_rotate_refresh', {
    p_refresh_hash: await hashApiKey(refresh), p_client_id: client.id,
    p_access_hash: pair.accessHash, p_new_refresh_hash: pair.refreshHash,
    p_access_expires: pair.accessExpires, p_refresh_expires: pair.refreshExpires,
  });
  if (error) throw error;
  const result = (data ?? {}) as Row;
  if (result.status === 'reused') {
    await auditConnection(service, { step: 'refresh_reused', grantId: result.grant_id, memberId: result.member_id, apiKeyId: result.api_key_id, client, status: 400 });
    throw new OAuthError(400, 'invalid_grant', 'This refresh token was already used, so the connection is now revoked. Connect again from your AI tool.');
  }
  if (result.status !== 'ok') throw new OAuthError(400, 'invalid_grant', 'The refresh token is not valid, has expired, or the app was disconnected.');
  return answer(pair);
}

// ── A connection on the MCP server ──────────────────────────────────────

export interface ConnectionContext {
  grantId: string;
  clientName: string;
  clientId: string;
}

export interface ResolvedConnection {
  keyRow: { id: string; permissions: string; team_member_id: string; scopes: string[]; expires_at: null; disabled_at: null };
  access: AccessContext;
  connection: ConnectionContext;
}

/**
 * Who a live access token acts as: its person (their own access, never an
 * agent's), with its connection's key and scopes. 401 invalid_token for
 * anything not live; 403 when the workspace has Connect AI or the API off,
 * or the person is suspended.
 */
export async function resolveConnection(service: SupabaseClient, token: string): Promise<ResolvedConnection> {
  const invalid = () => unauthorized('The sign-in has expired or the app was disconnected. Sign in again from your AI tool.', { reason: 'invalid_token' });
  const { data, error } = await service.rpc('oauth_resolve_access', { p_token_hash: await hashApiKey(token) });
  if (error) {
    if (missingColumn(error)) throw invalid();
    throw error;
  }
  const row = data as Row | null;
  if (!row?.grant_id) throw invalid();
  const [state, access] = await Promise.all([connectAiState(service), resolveMemberAccess(service, row.member_id)]);
  if (!state.apiEnabled) throw forbidden('Workspace API access is disabled', { reason: 'api_disabled' });
  if (!state.enabled) {
    throw forbidden('Connecting AI tools is turned off for this workspace', {
      reason: 'connect_ai_off', hint: 'An Owner can turn it back on in Settings > Security.',
    });
  }
  if (!access || access.status !== 'active') throw forbidden('Linked team member is suspended', { reason: 'member_suspended' });
  if (access.role === 'agent') throw invalid();
  return {
    keyRow: { id: row.api_key_id, permissions: 'connection', team_member_id: row.member_id, scopes: Array.isArray(row.scopes) ? row.scopes : [], expires_at: null, disabled_at: null },
    access,
    connection: { grantId: row.grant_id, clientName: row.client_name, clientId: row.client_id },
  };
}

// ── Connected apps (Settings > Account) ─────────────────────────────────

/** The person's live connections, newest first. */
export async function listConnections(service: SupabaseClient, memberId: string): Promise<ConnectionView[]> {
  const { data, error } = await service.from('oauth_grants')
    .select('id, scopes, created_at, last_used_at, client_id, redirect_uri')
    .eq('member_id', memberId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) {
    if (missingColumn(error)) return [];
    throw error;
  }
  const grants = (data ?? []) as Row[];
  if (grants.length === 0) return [];
  const clientIds = [...new Set(grants.map((g) => g.client_id as string))];
  const { data: clients, error: clientError } = await service.from('oauth_clients').select('id, client_name').in('id', clientIds);
  if (clientError) throw clientError;
  const byId = new Map(((clients ?? []) as Row[]).map((c) => [c.id as string, c]));
  return grants.map((grant) => {
    const client = byId.get(grant.client_id);
    return {
      id: grant.id,
      client_name: client?.client_name ?? 'AI tool',
      // Where this connection's code was actually sent, not the client's first address.
      redirect_host: grant.redirect_uri ? redirectHost(grant.redirect_uri) : 'the app',
      connected_at: grant.created_at,
      last_used_at: grant.last_used_at ?? null,
      scopes: grant.scopes ?? [],
    };
  });
}

/** Disconnect: the person's own connection ends at once (the grant, every token and its key). */
export async function disconnect(service: SupabaseClient, memberId: string, grantId: string): Promise<void> {
  const { data: grant, error } = await service.from('oauth_grants').select('id, member_id, api_key_id, revoked_at, client_id').eq('id', grantId).maybeSingle();
  if (error) throw error;
  if (!grant || grant.member_id !== memberId || grant.revoked_at) {
    throw new ApiError(404, 'NOT_FOUND', 'That connected app was not found. It may already be disconnected.', { reason: 'not_found' });
  }
  const { error: revokeError } = await service.rpc('oauth_revoke_grant', { p_grant_id: grantId, p_reason: 'disconnected' });
  if (revokeError) throw revokeError;
  const { data: client } = await service.from('oauth_clients').select('client_name, client_id').eq('id', grant.client_id).maybeSingle();
  const { error: auditError } = await insertAuditRows(service, {
    method: 'DELETE',
    endpoint: `/api/workspace/me/connections/${grantId}`,
    entity_type: 'oauth_grant',
    entity_id: grantId,
    api_key_id: grant.api_key_id,
    team_member_id: memberId,
    request_body: { step: 'disconnected', client_name: client?.client_name ?? null, client_id: client?.client_id ?? null },
    status_code: 200,
    via: 'app',
  });
  if (auditError) console.error('[connect-ai] audit write failed:', auditError.message);
}

// ── Answers ─────────────────────────────────────────────────────────────

/** An OAuth endpoint's JSON answer: never cached (RFC 6749 5.1). */
export function oauthJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache', ...headers } });
}

/** An OAuthError as { error, error_description }; anything else is a 500 server_error, logged. */
export function oauthErrorResponse(caught: unknown): Response {
  if (caught instanceof OAuthError) {
    return oauthJson({ error: caught.error, error_description: caught.message }, caught.status,
      caught.status === 401 ? { 'WWW-Authenticate': 'Basic realm="oauth"' } : caught.status === 429 ? { 'Retry-After': '60' } : {});
  }
  console.error('[connect-ai] request failed:', caught);
  return oauthJson({ error: 'server_error', error_description: 'Something went wrong on the server. Try again.' }, 500);
}

/** A metadata document: public, cacheable for a few minutes. */
export function metadataJson(body: unknown): Response {
  return Response.json(body, { headers: { 'Cache-Control': 'public, max-age=300' } });
}
