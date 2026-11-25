import { apiScopesFor, type AccessContext, type PermissionKey } from '@/lib/access-control';

/**
 * Connect AI: a person connects an AI tool (Claude, ChatGPT, Cursor, Claude
 * Code, Codex) to their own work by pasting one address and signing in. The
 * MCP server is an OAuth 2.1 resource server and this app its authorization
 * server (dynamic client registration, authorization code with PKCE S256,
 * rotating refresh tokens). Rules on their own: the connect scopes, what they
 * allow in plain words, the per-tool steps, and redirect address checks.
 * Pure and client-safe: no server code here.
 */

/** The one OAuth scope a tool asks for. What it allows is CONNECT_SCOPES, within the person's own access. */
export const CONNECT_OAUTH_SCOPE = 'connect';

/**
 * What a connection may do, as API scopes: the person's projects, tasks
 * (comments and questions ride on tasks.read) and reminders. Never admin
 * powers, keys, people, settings or agents, whatever the person's role. A
 * connection holds the ones the person holds when they allow it, and every
 * call is checked against their access again.
 */
export const CONNECT_SCOPES: readonly PermissionKey[] = [
  'projects.read',
  'projects.read_all',
  'tasks.read',
  'tasks.create',
  'tasks.manage_assigned',
  'reminders.manage_own',
];

/**
 * Asked for on the consent screen as an extra, never given by default: a
 * person's own memory (what their assistant remembers about them).
 */
export const CONNECT_MEMORY_SCOPE: PermissionKey = 'context.memory';
export const CONNECT_MEMORY_WORDS = 'Also let it read and add to what your assistant remembers about you';

/**
 * The connect scopes this person holds on the API channel: what a connection
 * of theirs gets. withMemory adds context.memory when they hold it and
 * ticked the extra on the consent screen.
 */
export function connectScopesFor(access: AccessContext | null | undefined, options: { withMemory?: boolean } = {}): PermissionKey[] {
  const held = new Set(apiScopesFor(access));
  const scopes = CONNECT_SCOPES.filter((scope) => held.has(scope));
  return options.withMemory && held.has(CONNECT_MEMORY_SCOPE) ? [...scopes, CONNECT_MEMORY_SCOPE] : scopes;
}

/** Whether the consent screen offers the memory extra: the person holds context.memory on the API. */
export function canOfferMemory(access: AccessContext | null | undefined): boolean {
  return new Set(apiScopesFor(access)).has(CONNECT_MEMORY_SCOPE);
}

/** What a connection can do, in plain words, for the consent screen and the key fallback. */
export function connectAbilities(scopes: readonly string[]): string[] {
  const has = (scope: string) => scopes.includes(scope);
  const lines: string[] = [];
  if (has('projects.read') || has('projects.read_all')) lines.push('See the projects you can open here');
  if (has('tasks.read')) lines.push('Read tasks, comments and questions', 'Comment, and ask or answer questions');
  if (has('tasks.create')) lines.push('Create tasks');
  if (has('tasks.manage_assigned')) lines.push('Update tasks assigned to you');
  if (has('reminders.manage_own')) lines.push('Add and change your reminders');
  if (has(CONNECT_MEMORY_SCOPE)) lines.push('Read and add to what your assistant remembers about you');
  return lines;
}

/** What a connection never does, said once under the list. */
export const CONNECT_NEVER = 'It cannot change settings, manage people or agents, or make keys. It acts as you, so it never sees more than you do.';

/** How long things last. */
export const CONNECT_ACCESS_TOKEN_SECONDS = 60 * 60;
export const CONNECT_REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
export const CONNECT_CODE_SECONDS = 60;

/** Every value starts with its kind, so a leaked one is recognisable. Only hashes are stored. */
export const CONNECT_PREFIXES = {
  client: 'pmc_',
  clientSecret: 'pmcs_',
  code: 'pmac_',
  access: 'pmat_',
  refresh: 'pmrt_',
} as const;

export function isConnectAccessToken(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(CONNECT_PREFIXES.access);
}

/** The MCP server's address: what a person pastes into their AI tool. */
export function connectMcpUrl(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}/api/mcp`;
}

// ── Redirect addresses ──────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Schemes a browser would run or read locally rather than hand to an app. */
const REFUSED_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file', 'about', 'blob', 'filesystem', 'ftp', 'ws', 'wss', 'mailto', 'tel', 'sms']);

/**
 * Why a redirect address cannot be registered, or null when it can:
 * - https anywhere;
 * - http only on this machine (localhost, 127.0.0.1, [::1]), for tools that
 *   run on the person's computer (Claude Code, Codex);
 * - an app's own scheme (cursor://, vscode://), for desktop apps;
 * - never javascript:, data: or the like, never a fragment, never a user or
 *   password in the address.
 */
export function redirectUriProblem(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return 'Each redirect address must be text';
  if (value.length > 2000) return 'A redirect address is at most 2000 characters';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${value} is not an absolute address`;
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (url.hash || value.includes('#')) return 'A redirect address cannot have a fragment (#)';
  if (url.username || url.password) return 'A redirect address cannot hold a user name or password';
  if (scheme === 'https') return url.hostname ? null : 'An https redirect address needs a host';
  if (scheme === 'http') {
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
      ? null
      : 'Plain http is only allowed for localhost, 127.0.0.1 or [::1]. Use https';
  }
  if (REFUSED_SCHEMES.has(scheme)) return `${scheme}: addresses are not allowed`;
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) return `${value} has an unusable scheme`;
  return null;
}

/** The host a person is sent back to, for the consent screen ("You go back to claude.ai"). */
export function redirectHost(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ? 'an app on this computer' : url.host;
    }
    return `the ${url.protocol.replace(/:$/, '')} app`;
  } catch {
    return 'the app';
  }
}

// ── The consent screen ──────────────────────────────────────────────────

/**
 * The consent screen's heading and warning. A tool names itself when it
 * registers (anyone can register as "Claude"), so where it sends the person
 * back is the one thing they can check: it sits in the heading, beside the
 * name, and the warning says so in plain words.
 */
export function consentWords(name: string, redirectUri: string): { title: string; subtitle: string; caution: string } {
  const host = redirectHost(redirectUri);
  return {
    title: `${name}, returning to ${host}`,
    subtitle: 'wants to work with your projects and tasks as you',
    caution: `Any app can call itself ${name}. Only choose Allow if you started connecting it yourself and you recognise ${host} as where it returns.`,
  };
}

// ── Per-tool steps ──────────────────────────────────────────────────────

export interface ConnectToolGuide {
  id: 'claude' | 'chatgpt' | 'cursor' | 'claude-code' | 'codex';
  label: string;
  steps: string[];
  /** Text to copy under one of the steps (`step`, from 0): a command or a config file. */
  snippet?: { label: string; text: string; step: number };
}

/** The MCP server's name in tools that ask for one. */
const SERVER_NAME = 'pm';

/** Copy-paste steps per tool, two or three each, in plain words. */
export function connectToolGuides(mcpUrl: string, workspaceName: string): ConnectToolGuide[] {
  const name = workspaceName.trim() || 'Projects';
  return [
    {
      id: 'claude',
      label: 'Claude',
      steps: [
        'In Claude (the website or the desktop app), open Settings, then Connectors, and choose Add custom connector.',
        `Name it ${name}, paste the address above and choose Add.`,
        'Choose Connect, sign in here if asked, and select Allow.',
      ],
    },
    {
      id: 'chatgpt',
      label: 'ChatGPT',
      steps: [
        'In ChatGPT, open Settings, then Apps and Connectors. Under Advanced settings, turn on Developer mode.',
        `Choose Create, name it ${name}, paste the address above and pick OAuth to sign in.`,
        'Sign in here when ChatGPT opens this app, and select Allow.',
      ],
    },
    {
      id: 'cursor',
      label: 'Cursor',
      steps: [
        'In Cursor, open Settings, then Tools and MCP, and choose New MCP server.',
        'Paste this into the file that opens and save it.',
        'Choose Connect next to it, sign in here and select Allow.',
      ],
      snippet: { label: 'Cursor settings', text: JSON.stringify({ mcpServers: { [SERVER_NAME]: { url: mcpUrl } } }, null, 2), step: 1 },
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      steps: [
        'Run this in a terminal.',
        'In Claude Code, type /mcp, pick pm and choose Authenticate.',
        'Sign in here in the browser that opens and select Allow.',
      ],
      snippet: { label: 'Command', text: `claude mcp add --transport http ${SERVER_NAME} ${mcpUrl}`, step: 0 },
    },
    {
      id: 'codex',
      label: 'Codex',
      steps: [
        'Run this in a terminal (update Codex first if it says login is unknown).',
        'Sign in here in the browser that opens and select Allow.',
      ],
      snippet: { label: 'Commands', text: `codex mcp add ${SERVER_NAME} --url ${mcpUrl}\ncodex mcp login ${SERVER_NAME}`, step: 0 },
    },
  ];
}

/** The name and scopes the "Use a personal key instead" fallback starts the New key dialog with. */
export function connectKeyPreset(access: AccessContext | null | undefined): { name: string; scopes: string[] } {
  return { name: 'AI tool', scopes: connectScopesFor(access) };
}

// ── Connected apps ──────────────────────────────────────────────────────

/** A connected app, as Settings > Account lists it. Never a token. */
export interface ConnectionView {
  id: string;
  client_name: string;
  /** Where sign-in sent the person back to (claude.ai, an app on this computer). */
  redirect_host: string;
  connected_at: string;
  last_used_at: string | null;
  scopes: string[];
}

export interface MyConnectionsView {
  /** The database has Connect AI (its migration has run). */
  ready: boolean;
  /** The workspace switch: Let people connect AI tools. */
  enabled: boolean;
  /** The API is on for the workspace (a connection is an API caller). */
  api_enabled: boolean;
  mcp_url: string;
  workspace_name: string;
  /** What a new connection of theirs would get. */
  scopes: string[];
  connections: ConnectionView[];
}

