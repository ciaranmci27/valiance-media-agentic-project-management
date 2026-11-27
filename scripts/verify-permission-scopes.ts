/**
 * Every permission works as described, end to end.
 *
 * Map (static, plus the role defaults and live SQL read from schema.sql on
 * PGlite):
 * - Every route's withApi permission, every MCP tool's permission, every
 *   server check (hasPermission, accessAllows, apiKeyAllows, callerHolds and
 *   the other helpers that take a key) and every has_permission() in the
 *   database's functions and policies names a key in PERMISSIONS.
 * - Every key in PERMISSIONS is checked somewhere on the server or in SQL,
 *   or is in DEAD_ALLOWED with the reason.
 * - Every key has a module (PERMISSION_MODULE, and pm.permission_modules for
 *   the ones not in core) and one entry in PERMISSION_GROUPS (its plain words).
 * - Every route permission can be carried by a key (an API scope), and every
 *   API scope is checked on the API channel somewhere.
 * - Every scope the agent pickers offer (hire flow, agent keys) is one the
 *   agent role holds, or one the hire gives that agent alone (an Owner's
 *   per-member allow, lib/api/agent-scope-grants.ts).
 * - A key-only permission (checked on the API channel only) is not offered
 *   on the app channel of Roles & permissions.
 * - What a description says about who holds it by default is what the
 *   database seeds.
 *
 * Exercise (the real routes over a fake PostgREST on the full schema, keys
 * and a signed-in Owner): agents.act_for (hired with it, its key mints a
 * delegation and acts for the person; without it, 403), approvals.decide,
 * questions.ask, chat.notify, context.memory, assistants.provision,
 * tasks.manage_all and audit.export, each allowed with the scope and refused
 * without it.
 *
 *   npm run -s test:permission-scopes
 *   npm run -s test:permission-scopes -- --report   (prints the per-permission table)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { createFullSchemaDatabase } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import * as ac from '../src/lib/access-control';
import {
  API_ENDPOINT_PERMISSIONS, PERMISSION_GROUPS, PERMISSIONS, type PermissionKey,
} from '../src/lib/access-control';
import { PERMISSION_MODULE } from '../src/lib/modules/registry';
import { NEVER_AGENT_SCOPES, scopeGroups } from '../src/lib/agents-ui';
import { CONNECT_MEMORY_SCOPE, CONNECT_SCOPES } from '../src/lib/connect-ai';
import { chatHttp } from '../src/lib/chat/providers/adapter';

const APP = join(__dirname, '..');
const SRC = join(APP, 'src');
const REPORT = process.argv.includes('--report');

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose };
type Channel = 'app' | 'api' | 'both';
type Site = { at: string; kind: 'route' | 'mcp' | 'check' | 'sql'; channel: Channel; ui: boolean };

const REGISTRY = new Set<string>(PERMISSIONS);
const API_SCOPES = new Set<string>(API_ENDPOINT_PERMISSIONS);
/** Looks like a permission key: two or three dotted lowercase words. */
const KEY_SHAPE = /^[a-z_]+\.[a-z_]+(\.[a-z_]+)?$/;

// ── Intentional exceptions, each with its reason ──────────────────────────

/** Keys nothing checks yet, on purpose. Empty: a dead permission is a bug to fix, not to list. */
const DEAD_ALLOWED: Partial<Record<PermissionKey, string>> = {};

/** API scopes with no API-channel check, on purpose (a key may carry them but nothing reads them from a key). */
const API_SCOPE_UNCHECKED_ALLOWED: Partial<Record<PermissionKey, string>> = {};

/**
 * Key-only permissions Roles & permissions may still show on the app
 * channel, with why. Empty: a grant on the app channel that nothing reads
 * only misleads whoever sets it.
 */
const KEY_ONLY_ON_APP_ALLOWED: Partial<Record<PermissionKey, string>> = {};

/** Scopes the agent pickers offer that an agent cannot use, on purpose. Empty: never offer what fails. */
const AGENT_OFFER_ALLOWED: Partial<Record<PermissionKey, string>> = {};

// ── Static map: routes, checks, MCP ───────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** Functions that check a permission: which argument is the key, and which channel they check. */
const CHECKS: Record<string, { arg: number; channelArg?: number; channel?: Channel }> = {
  hasPermission: { arg: 1, channelArg: 2 },
  accessAllows: { arg: 1, channelArg: 2 },
  apiKeyAllows: { arg: 2, channel: 'api' },
  // A signed-in caller (scopes null) on the app channel, a key on the API channel.
  callerHolds: { arg: 1, channel: 'both' },
  keyHolds: { arg: 1, channel: 'api' },
  // lib/api/event-feed.ts: the key's scopes and its member (a task comment's notify: true).
  keyHoldsAny: { arg: 2, channel: 'api' },
  held: { arg: 0, channel: 'api' },
  holdsIgnoringModules: { arg: 1, channel: 'app' },
  // lib/task-files/service.ts and lib/api/task-move.ts: the caller's channel.
  can: { arg: 1, channel: 'both' },
  requirePermission: { arg: 1, channel: 'both' },
  eligible: { arg: 1, channel: 'app' },
};
/** Functions that take keys without checking them: the names must still be real. */
const NAMES_ONLY = new Set(['permissionAlternatives', 'deniedResponse', 'moduleOffFor']);
/** Skipped: documentation pages that only quote keys. */
const SKIP_FILES = new Set([join(SRC, 'app', 'api', 'docs', 'docs-data.ts')]);

const sites = new Map<string, Site[]>();
const unknownNames: string[] = [];
/** Each withApi route's options, for "a key can carry it". */
const routeOptions: { at: string; options: string[] }[] = [];

function addSite(key: string, site: Site, at: string) {
  if (!REGISTRY.has(key)) {
    if (KEY_SHAPE.test(key)) unknownNames.push(`${at} names ${key}`);
    return;
  }
  const list = sites.get(key) ?? [];
  list.push(site);
  sites.set(key, list);
}

/** Named constants that hold keys (const APPROVALS_DECIDE = 'approvals.decide', const RUN_PERMISSIONS = [...]), by name across src. */
const NAMED = new Map<string, ts.Expression>();

function collectNamed(sf: ts.SourceFile) {
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && node.parent && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const)) {
      let init: ts.Expression = node.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isStringLiteralLike(init) || ts.isArrayLiteralExpression(init)) NAMED.set(node.name.text, init);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** The string keys an expression names: a literal, an array of them, a conditional of either. `any` for a spread of every API scope. */
function literals(expr: ts.Expression | undefined, depth = 0): { keys: string[]; any: boolean } {
  if (!expr) return { keys: [], any: false };
  if (ts.isStringLiteralLike(expr)) return { keys: [expr.text], any: false };
  if (ts.isIdentifier(expr) && depth < 3) {
    if (expr.text === 'API_ENDPOINT_PERMISSIONS') return { keys: [], any: true };
    const named = NAMED.get(expr.text);
    return named ? literals(named, depth + 1) : { keys: [], any: false };
  }
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) return literals(expr.expression);
  if (ts.isConditionalExpression(expr)) {
    const a = literals(expr.whenTrue);
    const b = literals(expr.whenFalse);
    return { keys: [...a.keys, ...b.keys], any: a.any || b.any };
  }
  if (ts.isArrayLiteralExpression(expr)) {
    const out = { keys: [] as string[], any: false };
    for (const element of expr.elements) {
      if (ts.isSpreadElement(element)) {
        if (/API_ENDPOINT_PERMISSIONS/.test(element.expression.getText())) out.any = true;
        else { const inner = literals(element.expression); out.keys.push(...inner.keys); out.any ||= inner.any; }
      } else {
        const inner = literals(element);
        out.keys.push(...inner.keys);
        out.any ||= inner.any;
      }
    }
    return out;
  }
  return { keys: [], any: false };
}

function channelOf(call: ts.CallExpression, spec: { channelArg?: number; channel?: Channel }): Channel {
  if (spec.channel) return spec.channel;
  const arg = call.arguments[spec.channelArg!];
  if (!arg) return 'app';
  if (ts.isStringLiteralLike(arg)) return arg.text === 'api' ? 'api' : 'app';
  return 'both';
}

/** Server functions only a v1 route (a key) ever calls, so their callerHolds is the API channel. */
const API_ONLY_FUNCTIONS = new Set([
  // POST /api/v1/assistants/{id}/key is its only caller.
  'claimAssistantKey',
]);

/** Inside `scopes !== null && ...` or `scopes === null || ...`: the check runs only for a key. */
function keyGuarded(node: ts.Node, sf: ts.SourceFile): boolean {
  let at: ts.Node = node;
  while (at.parent && !ts.isStatement(at.parent) && !ts.isVariableDeclaration(at.parent)) at = at.parent;
  return /scopes\s*(!==\s*null\s*&&|===\s*null\s*\|\|)/.test(at.getText(sf));
}

function enclosingFunction(node: ts.Node): string | null {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name && ts.isIdentifier(at.name)) return at.name.text;
  }
  return null;
}

function scanSource() {
  const files = walk(SRC).filter((file) => !SKIP_FILES.has(file));
  for (const file of files) collectNamed(ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true));
  for (const file of files) {
    const rel = relative(APP, file).split(sep).join('/');
    const isRoute = rel.startsWith('src/app/api/') && rel.endsWith('/route.ts');
    const isMcp = rel.startsWith('src/lib/mcp/');
    const isCustom = rel.startsWith('src/custom/');
    // Screens and client state: they hide or show, the server decides.
    const ui = rel.startsWith('src/components/') || (rel.startsWith('src/app/') && !rel.startsWith('src/app/api/'))
      || rel === 'src/lib/store.tsx' || rel.endsWith('.tsx');
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const lineOf = (node: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : null;
        if (name && CHECKS[name]) {
          const spec = CHECKS[name];
          const { keys } = literals(node.arguments[spec.arg]);
          let channel = channelOf(node, spec);
          // callerHolds is the API channel when the code around it already knows the caller is a key.
          if (name === 'callerHolds' && (keyGuarded(node, sf) || API_ONLY_FUNCTIONS.has(enclosingFunction(node) ?? ''))) channel = 'api';
          for (const key of keys) addSite(key, { at: lineOf(node), kind: 'check', channel, ui }, lineOf(node));
        } else if (name && NAMES_ONLY.has(name)) {
          for (const arg of node.arguments) for (const key of literals(arg).keys) if (!REGISTRY.has(key) && KEY_SHAPE.test(key)) unknownNames.push(`${lineOf(node)} names ${key}`);
        } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'includes' && node.arguments.length === 1) {
          // scopes.includes('agents.act_for'), access.api_permissions.includes(...)
          const receiver = callee.expression.getText(sf);
          const channel: Channel | null = /app_permissions/.test(receiver) ? 'app' : /scopes|api_permissions/i.test(receiver) ? 'api' : null;
          const { keys } = literals(node.arguments[0]);
          if (channel) for (const key of keys) addSite(key, { at: lineOf(node), kind: 'check', channel, ui }, lineOf(node));
        } else if (ts.isPropertyAccessExpression(callee) && ['some', 'every', 'find', 'filter'].includes(callee.name.text)) {
          // (['tasks.read', 'tasks.manage_all'] as const).some((p) => accessAllows(access, p, ...))
          const { keys } = literals(callee.expression);
          const body = node.arguments[0]?.getText(sf) ?? '';
          if (keys.length && Object.keys(CHECKS).some((fn) => body.includes(`${fn}(`))) {
            const channel: Channel = /'api'/.test(body) ? 'api' : /'app'/.test(body) ? 'app' : 'both';
            for (const key of keys) addSite(key, { at: lineOf(node), kind: 'check', channel, ui }, lineOf(node));
          }
        }
      }
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'permission' && ts.isObjectLiteralExpression(node.parent)) {
        // Whose option it is: withApi (a key, the API channel), requireSessionAccess (signed in, the app channel), an MCP tool, a custom route.
        const owner = node.parent.parent;
        const callee = owner && ts.isCallExpression(owner) && ts.isIdentifier(owner.expression) ? owner.expression.text : null;
        const { keys, any } = literals(node.initializer);
        if (callee === 'withApi') {
          for (const key of keys) addSite(key, { at: lineOf(node), kind: 'route', channel: 'api', ui: false }, lineOf(node));
          if (!any) routeOptions.push({ at: lineOf(node), options: keys });
        } else if (callee === 'requireSessionAccess') {
          for (const key of keys) addSite(key, { at: lineOf(node), kind: 'check', channel: 'app', ui }, lineOf(node));
        } else if (isMcp) {
          for (const key of keys) addSite(key, { at: lineOf(node), kind: 'mcp', channel: 'api', ui: false }, lineOf(node));
        } else if (isCustom || isRoute) {
          for (const key of keys) addSite(key, { at: lineOf(node), kind: 'route', channel: 'both', ui: false }, lineOf(node));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

/** The withApi alternatives (a broader permission that implies one), copied from middleware so a key holding either reaches the route. */
function alternativesFrom(): Record<string, string[]> {
  const text = readFileSync(join(SRC, 'lib', 'api', 'middleware.ts'), 'utf8');
  const body = text.slice(text.indexOf('const implications'), text.indexOf('return [permission'));
  const out: Record<string, string[]> = {};
  for (const m of body.matchAll(/'([a-z_.]+)':\s*\[([^\]]*)\]/g)) out[m[1]] = [...m[2].matchAll(/'([a-z_.]+)'/g)].map((x) => x[1]);
  return out;
}

/**
 * Whether Roles & permissions offers a key on the app channel (for a
 * member): access-control's permissionOffered where it exists, else the
 * inline list AccessControlModal hides.
 */
function appChannelOffer(): ((key: string) => boolean) | null {
  const offered = (ac as Loose).permissionOffered as ((key: string, channel: string, role: string) => boolean) | undefined;
  if (typeof offered === 'function') return (key) => offered(key, 'app', 'member');
  const hidden = accessModalAppHidden();
  return hidden ? (key) => !hidden.includes(key) : null;
}

/** The keys Roles & permissions leaves off the app channel (an inline list in AccessControlModal). */
function accessModalAppHidden(): string[] | null {
  const file = join(SRC, 'components', 'team', 'AccessControlModal.tsx');
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let found: string[] | null = null;
  const visit = (node: ts.Node) => {
    if (!found && ts.isArrayLiteralExpression(node) && node.elements.length > 2 && node.elements.every(ts.isStringLiteralLike)
      && ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === 'includes') {
      found = node.elements.map((e) => (e as ts.StringLiteralLike).text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

// ── The database: role defaults, modules, SQL checks ──────────────────────

interface Catalog {
  holders: Map<string, Set<string>>; // key -> {"admin:api", ...}
  modules: Map<string, string>;
  roleKeys: string[];
}

async function readCatalog(db: PGlite): Promise<Catalog> {
  const roles = (await db.query<{ role: string; permission_key: string; access_channel: string }>('SELECT role, permission_key, access_channel FROM pm.role_permissions')).rows;
  const holders = new Map<string, Set<string>>();
  for (const row of roles) {
    const set = holders.get(row.permission_key) ?? new Set<string>();
    set.add(`${row.role}:${row.access_channel}`);
    holders.set(row.permission_key, set);
  }
  const modules = new Map((await db.query<{ permission_key: string; module_id: string }>('SELECT permission_key, module_id FROM pm.permission_modules')).rows
    .map((row) => [row.permission_key, row.module_id] as const));
  // The live database's own checks: function bodies and row policies (not the history schema.sql replays).
  const bodies = [
    ...(await db.query<{ name: string; src: string }>(`SELECT n.nspname || '.' || p.proname AS name, p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('pm', 'public', 'communications') AND p.prosrc IS NOT NULL`)).rows,
    ...(await db.query<{ name: string; src: string }>(`SELECT 'policy ' || pol.polname || ' on ' || c.relname AS name,
      coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') AS src
      FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid`)).rows,
  ];
  const sqlPattern = /(?:member_)?has_permission\(\s*(?:[^,()']+,\s*)?'([^']+)'(?:::text)?(?:\s*,\s*'(app|api)'(?:::text)?)?/g;
  for (const { name, src } of bodies) {
    for (const m of src.matchAll(sqlPattern)) {
      addSite(m[1], { at: `sql ${name}`, kind: 'sql', channel: m[2] === 'api' ? 'api' : 'app', ui: false }, `sql ${name}`);
    }
  }
  return { holders, modules, roleKeys: [...new Set(roles.map((r) => r.permission_key))] };
}

// ── Static and catalog checks ─────────────────────────────────────────────

interface Row {
  key: PermissionKey;
  holders: string;
  enforced: string;
  offered: string;
  status: string[];
}

async function mapChecks(catalog: Catalog, mcpTools: { name: string; permission: string | string[] }[]): Promise<Row[]> {
  // MCP tools: the live list (core and an install's own), not their source.
  for (const tool of mcpTools) {
    const keys = Array.isArray(tool.permission) ? tool.permission : [tool.permission];
    // A tool open to every scope (pm_guide, the catalog) names them all: no one key is its check.
    if (keys.length >= API_ENDPOINT_PERMISSIONS.length) continue;
    for (const key of keys) addSite(key, { at: `mcp ${tool.name}`, kind: 'mcp', channel: 'api', ui: false }, `mcp tool ${tool.name}`);
  }

  check('found withApi route permissions to map', routeOptions.length > 250, routeOptions.length);
  check('found MCP tools to map', mcpTools.length > 50, mcpTools.length);
  check('every route, MCP tool, check and SQL policy names a permission in the registry', unknownNames.length === 0, unknownNames);

  // Modules and plain words.
  const moduleKeys = Object.keys(PERMISSION_MODULE);
  check('every permission has a module, and the module map names only real permissions',
    PERMISSIONS.every((key) => key in PERMISSION_MODULE) && moduleKeys.every((key) => REGISTRY.has(key)), moduleKeys.filter((key) => !REGISTRY.has(key)));
  const moduleMismatch = PERMISSIONS.filter((key) => (PERMISSION_MODULE[key] === 'core' ? catalog.modules.has(key) : catalog.modules.get(key) !== PERMISSION_MODULE[key]));
  check('pm.permission_modules matches PERMISSION_MODULE (a row for each non-core key, none for core)', moduleMismatch.length === 0,
    moduleMismatch.map((key) => `${key}: code ${PERMISSION_MODULE[key]}, db ${catalog.modules.get(key) ?? 'none'}`));
  const strayModuleRows = [...catalog.modules.keys()].filter((key) => !REGISTRY.has(key));
  check('pm.permission_modules names only real permissions', strayModuleRows.length === 0, strayModuleRows);
  const strayRoleRows = catalog.roleKeys.filter((key) => !REGISTRY.has(key));
  check('pm.role_permissions seeds only real permissions', strayRoleRows.length === 0, strayRoleRows);
  const grouped = PERMISSION_GROUPS.flatMap((group) => group.permissions.map((p) => p.key));
  const missingWords = PERMISSIONS.filter((key) => grouped.filter((k) => k === key).length !== 1);
  check('every permission has exactly one entry in PERMISSION_GROUPS (its label and description)', missingWords.length === 0, missingWords);

  // Enforcement.
  const server = (key: string) => (sites.get(key) ?? []).filter((site) => !site.ui);
  const dead = PERMISSIONS.filter((key) => server(key).length === 0 && !DEAD_ALLOWED[key]);
  check('every permission is checked somewhere on the server or in SQL (dead permissions)', dead.length === 0,
    dead.map((key) => `${key}${(sites.get(key) ?? []).length ? ` (screens only: ${sites.get(key)!.map((s) => s.at).slice(0, 3).join(', ')})` : ''}`));
  const staleDeadAllow = Object.keys(DEAD_ALLOWED).filter((key) => server(key).length > 0);
  check('DEAD_ALLOWED lists only keys still unchecked', staleDeadAllow.length === 0, staleDeadAllow);

  const apiChecked = (key: string) => server(key).some((site) => site.channel !== 'app');
  const appChecked = (key: string) => server(key).some((site) => site.channel !== 'api');
  const uncheckedScopes = API_ENDPOINT_PERMISSIONS.filter((key) => !apiChecked(key) && !API_SCOPE_UNCHECKED_ALLOWED[key]);
  check('every API scope is checked on the API channel somewhere (a key scope that does nothing)', uncheckedScopes.length === 0,
    uncheckedScopes.map((key) => `${key}: only ${server(key).map((s) => s.at).slice(0, 3).join(', ') || 'nothing'}`));

  const alternatives = alternativesFrom();
  const unreachable = routeOptions.filter(({ options }) => !options
    .flatMap((key) => [key, ...(alternatives[key] ?? [])]).some((key) => API_SCOPES.has(key)));
  check('every route permission can be carried by a key (one of its options is an API scope)', unreachable.length === 0, unreachable);

  // Roles & permissions: key-only permissions stay off the app channel.
  const appOffered = appChannelOffer();
  check('Roles & permissions: found what the app channel offers', !!appOffered);
  const offeredOnApp = (key: string) => !!appOffered?.(key);
  const keyOnly = PERMISSIONS.filter((key) => server(key).length > 0 && !appChecked(key));
  const keyOnlyOnApp = keyOnly.filter((key) => offeredOnApp(key) && !KEY_ONLY_ON_APP_ALLOWED[key]);
  check('a key-only permission is not offered on the app channel of Roles & permissions', keyOnlyOnApp.length === 0, keyOnlyOnApp);
  const hiddenButApp = PERMISSIONS.filter((key) => !offeredOnApp(key) && appChecked(key));
  check('the app channel offers every permission the app checks', hiddenButApp.length === 0,
    hiddenButApp.map((key) => `${key}: ${server(key).filter((s) => s.channel !== 'api').map((s) => s.at).slice(0, 2).join(', ')}`));
  const declaredKeyOnly = (ac as Loose).KEY_ONLY_PERMISSIONS as ReadonlySet<string> | undefined;
  if (declaredKeyOnly) {
    const missing = keyOnly.filter((key) => !declaredKeyOnly.has(key));
    const wrong = [...declaredKeyOnly].filter((key) => appChecked(key));
    check('KEY_ONLY_PERMISSIONS is exactly the permissions checked on the API channel only', missing.length === 0 && wrong.length === 0, { missing, checkedOnApp: wrong });
  }
  const appDefaultsForKeyOnly = keyOnly.filter((key) => [...(catalog.holders.get(key) ?? [])].some((h) => h.endsWith(':app')));
  check('no role holds a key-only permission on the app channel by default', appDefaultsForKeyOnly.length === 0,
    appDefaultsForKeyOnly.map((key) => `${key}: ${[...catalog.holders.get(key)!].join(' ')}`));

  // Agent pickers: what they offer, an agent can hold.
  const agentOffered = scopeGroups([...API_ENDPOINT_PERMISSIONS]).flatMap((group) => group.scopes.map((scope) => scope.key));
  const agentDefault = (key: string) => catalog.holders.get(key)?.has('agent:api') ?? false;
  const hireSource = readFileSync(join(SRC, 'lib', 'api', 'agent-workspace.ts'), 'utf8');
  const hireBody = hireSource.slice(hireSource.indexOf('export async function hireAgent'));
  const hireGrantsBeyondRole = /agentScopesBeyondRole\(/.test(hireBody) && /addAgentScopeGrants\(/.test(hireBody) && /assertMayGiveAgentScopes\(/.test(hireBody);
  check('hire: a power the agent role lacks is given to the new agent alone (agent-scope-grants is wired into hireAgent)', hireGrantsBeyondRole);
  // New key on an existing agent: the same rule, and undone if the key is then refused.
  const mintBody = hireSource.slice(hireSource.indexOf('export async function mintAgentKey'), hireSource.indexOf('export async function revokeAgentKey'));
  check('new key: a power the agent lacks is given to it alone, and taken back when the key is refused (agent-scope-grants is wired into mintAgentKey)',
    /agentScopesBeyondRole\(/.test(mintBody) && /assertMayGiveAgentScopes\(/.test(mintBody) && /addAgentScopeGrants\(/.test(mintBody) && /removeAgentScopeGrants\(/.test(mintBody));
  const uncovered = agentOffered.filter((key) => !agentDefault(key) && !hireGrantsBeyondRole && !AGENT_OFFER_ALLOWED[key]);
  check('every scope the hire flow offers is one the agent role holds or the hire can give it', uncovered.length === 0, uncovered);
  const neverButOffered = agentOffered.filter((key) => (NEVER_AGENT_SCOPES as readonly string[]).includes(key));
  check('the hire flow never offers a scope no agent key carries', neverButOffered.length === 0, neverButOffered);
  const neverButHeld = NEVER_AGENT_SCOPES.filter((key) => agentDefault(key));
  check('no agent holds a never-for-agents scope by default', neverButHeld.length === 0, neverButHeld);

  // Descriptions: what they say about default holders is what the database seeds.
  const claims: string[] = [];
  for (const group of PERMISSION_GROUPS) {
    for (const { key, description } of group.permissions) {
      const held = [...(catalog.holders.get(key) ?? [])];
      const api = held.filter((h) => h.endsWith(':api')).map((h) => h.split(':')[0]).sort().join(',');
      const say = (claim: string, ok: boolean) => { if (!ok) claims.push(`${key}: says "${claim}", seeds ${held.join(' ') || 'nothing'}`); };
      if (/no role holds it by default|no other role does by default|Owner-only in practice/i.test(description)) say('no role holds it', held.length === 0);
      if (/Admins and members hold it on the API/.test(description)) say('admins and members on the API', api === 'admin,member');
      if (/Admins, members and agents hold it on the API/.test(description)) say('admins, members and agents on the API', api === 'admin,agent,member');
      if (/no agent (holds it|does)/i.test(description)) say('no agent holds it', !held.some((h) => h.startsWith('agent:')));
      if (/\bApp only\b/.test(description)) say('app only', !API_SCOPES.has(key));
      if (/through the API/.test(description)) say('used through the API', API_SCOPES.has(key));
      if (/Never an agent's key/.test(description)) say('never an agent key', (NEVER_AGENT_SCOPES as readonly string[]).includes(key) && !agentDefault(key));
    }
  }
  check('descriptions say who holds each permission by default as the database seeds it', claims.length === 0, claims);

  // The table.
  const connect = new Set<string>([...CONNECT_SCOPES, CONNECT_MEMORY_SCOPE]);
  return PERMISSIONS.map((key) => {
    const held = [...(catalog.holders.get(key) ?? [])].sort();
    const offered = [
      agentOffered.includes(key) ? (agentDefault(key) ? 'hire' : 'hire(beyond role)') : null,
      API_SCOPES.has(key) ? 'new key' : null,
      'roles:' + [offeredOnApp(key) ? 'app' : null, API_SCOPES.has(key) ? 'api' : null].filter(Boolean).join('+'),
      connect.has(key) ? 'connect' : null,
    ].filter(Boolean).join(', ');
    const own = server(key);
    const kinds = ['route', 'mcp', 'check', 'sql'].map((kind) => [kind, own.filter((s) => s.kind === kind).length] as const).filter(([, n]) => n > 0);
    const status: string[] = [];
    if (own.length === 0) status.push('dead');
    if (API_SCOPES.has(key) && !apiChecked(key)) status.push('unusable(api)');
    if (keyOnlyOnApp.includes(key as PermissionKey)) status.push('mismatch(app channel)');
    if (claims.some((c) => c.startsWith(`${key}:`))) status.push('mismatch(description)');
    return {
      key, holders: ['owner:*', ...held].join(' '),
      enforced: kinds.map(([kind, n]) => `${kind} ${n}`).join(', ') + (own.length ? '' : ' -'),
      offered, status,
    };
  });
}

// ── Routes, end to end ────────────────────────────────────────────────────

const OWNER_LOGIN = { id: '00000000-0000-4000-8000-00000000c001', email: 'olivia@example.com' };
const APP_KEY = 'e'.repeat(64);
const COMPANY_TOKEN = 'xoxb-5555-6666-permissionscopes';
const COMPANY_SECRET = '1a2b3c4d5e6f708192a3b4c5d6e7f809';

function authStandIn(db: PGlite) {
  const emails = new Set<string>();
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    const json = (status: number, payload: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
      return true;
    };
    if (url.pathname === '/auth/v1/user' && request.method === 'GET') {
      return json(200, { id: OWNER_LOGIN.id, aud: 'authenticated', role: 'authenticated', email: OWNER_LOGIN.email, user_metadata: {}, app_metadata: {}, created_at: '2026-11-26T00:00:00Z' });
    }
    if (url.pathname === '/auth/v1/admin/users' && request.method === 'POST') {
      const text = await new Promise<string>((resolve) => {
        let raw = '';
        request.on('data', (chunk) => (raw += chunk));
        request.on('end', () => resolve(raw));
      });
      const body = JSON.parse(text || '{}');
      const email = String(body.email).toLowerCase();
      if (emails.has(email)) return json(422, { code: 'email_exists', message: 'A user with this email address has already been registered' });
      emails.add(email);
      const id = randomUUID();
      await db.exec('RESET ROLE');
      await db.query('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [id, email]);
      return json(200, { id, aud: 'authenticated', role: 'authenticated', email, user_metadata: body.user_metadata ?? {}, app_metadata: {}, created_at: '2026-11-26T00:00:00Z' });
    }
    return false;
  };
}

/** Session routes read the signed-in user from cookies: always the Owner here. */
function installSession(supabaseUrl: string) {
  const name = `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const store = {
    getAll: () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const user = { id: OWNER_LOGIN.id, email: OWNER_LOGIN.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-11-26T00:00:00Z' };
      const session = {
        access_token: `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: OWNER_LOGIN.id, email: OWNER_LOGIN.email, role: 'authenticated', aud: 'authenticated', exp })}.sig`,
        refresh_token: 'fake-refresh', token_type: 'bearer', expires_in: 3600, expires_at: exp, user,
      };
      return [{ name, value: `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}` }];
    },
    get: (key: string) => store.getAll().find((cookie) => cookie.name === key),
    set: () => undefined,
  };
  const nextHeaders = createRequire(__filename)('next/headers') as { cookies: () => Promise<typeof store> };
  nextHeaders.cookies = async () => store;
}

/** Slack, answered in place: who the bot is, opening a DM and posting to it. */
function installSlack() {
  let seq = 0;
  chatHttp.fetch = async (input) => {
    const url = String(input);
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/auth.test')) return json({ ok: true, team_id: 'T1', team: 'Acme', user: 'acme-ai', user_id: 'UBOT001' });
    if (url.endsWith('/conversations.open')) return json({ ok: true, channel: { id: 'D_PRIVATE' } });
    if (url.endsWith('/chat.postMessage')) return json({ ok: true, ts: `1800000000.${String(++seq).padStart(6, '0')}` });
    return json({ ok: true });
  };
}

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  await db.exec('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  await q('UPDATE pm.workspace_modules SET enabled = true');
  await q("INSERT INTO pm.business_settings (business_name) SELECT 'Acme' WHERE NOT EXISTS (SELECT 1 FROM pm.business_settings)");
  await q('UPDATE pm.business_settings SET assistants_enabled = true');
  const member = async (name: string, role: string, extra: { delegateOf?: string } = {}) =>
    (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role, delegate_of, assistant_template) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [name, `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`, role, extra.delegateOf ?? null, extra.delegateOf ? 'personal-assistant' : null]))[0].id;
  const owner = await member('Olivia', 'owner');
  await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [OWNER_LOGIN.id, OWNER_LOGIN.email]);
  await q('UPDATE pm.team_members SET auth_user_id = $1, email = $2 WHERE id = $3', [OWNER_LOGIN.id, OWNER_LOGIN.email, owner]);
  const ada = await member('Ada Admin', 'admin');
  const mia = await member('Mia Member', 'member');
  const ben = await member('Ben Member', 'member');
  const scout = await member('Scout', 'agent');
  const herald = await member('Herald', 'agent');
  const courier = await member('Courier', 'agent');
  const nova = await member('Nova', 'agent', { delegateOf: mia });
  const apex = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Apex') RETURNING id"))[0].id;
  for (const m of [ada, mia, ben, scout, herald, courier]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [apex, m]);
  // A company chat lists only agents that act for people. Herald may also message people unasked: chat.notify given to it alone.
  for (const m of [herald, courier]) {
    await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'agents.act_for', 'api', 'allow')", [m]);
  }
  await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'chat.notify', 'api', 'allow')", [herald]);
  await q(`INSERT INTO pm.member_identities (member_id, provider, external_id, workspace_id, verified_at, verified_method) VALUES
    ($1, 'slack', 'U_MIA', 'T1', now(), 'admin'), ($2, 'slack', 'U_BEN', 'T1', now(), 'admin')`, [mia, ben]);
  // A key exactly as a person or the hire would make it: scopes only (the member's role or overrides decide the rest).
  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped')`, [createHash('sha256').update(secret).digest('hex'), memberId, scopes]);
    return secret;
  };
  const task = async (title: string, assignees: string[]) => {
    const id = (await q<{ id: string }>('INSERT INTO pm.tasks (project_id, title) VALUES ($1, $2) RETURNING id', [apex, title]))[0].id;
    for (const m of assignees) await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  const keys = {
    ownerAll: await key(owner, ['team.read', 'team.manage', 'tasks.read', 'projects.read', 'audit.export', 'assistants.provision', 'tasks.manage_all']),
    ownerPlain: await key(owner, ['team.read', 'tasks.read', 'projects.read', 'audit.read']),
    adaExport: await key(ada, ['audit.export', 'tasks.read']),
    adaAssigned: await key(ada, ['tasks.read', 'tasks.manage_assigned']),
    adaAll: await key(ada, ['tasks.read', 'tasks.manage_assigned', 'tasks.manage_all']),
    miaManageAll: await key(mia, ['tasks.read', 'tasks.manage_assigned', 'tasks.manage_all']),
    miaPlain: await key(mia, ['tasks.read', 'projects.read']),
    miaDecide: await key(mia, ['tasks.read', 'projects.read', 'approvals.decide']),
    miaMemory: await key(mia, ['tasks.read', 'context.memory']),
    miaProvision: await key(mia, ['assistants.provision']),
    scoutAsk: await key(scout, ['questions.ask']),
    scoutNoAsk: await key(scout, ['agent_activity.write']),
    scoutWork: await key(scout, ['tasks.read', 'projects.read', 'agent_activity.write']),
    scoutActFor: await key(scout, ['tasks.read', 'projects.read', 'agents.act_for']),
    heraldNotify: await key(herald, ['notifications.manage_own', 'chat.notify']),
    heraldPlain: await key(herald, ['notifications.manage_own']),
    courierNotify: await key(courier, ['notifications.manage_own', 'chat.notify']),
  };
  return { q, owner, ada, mia, ben, scout, herald, courier, nova, apex, keys, task };
}

async function routeChecks(db: PGlite) {
  const s = await seed(db);
  const server = await startFakePostgrest(db, { handle: authStandIn(db) });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    NEXT_PUBLIC_APP_URL: 'https://pm.example.com', APP_ENCRYPTION_KEY: APP_KEY,
  });
  installSession(server.url);
  installSlack();
  try {
    const hireRoute = await import('../src/app/api/workspace/agents/route');
    const hireScopesRoute = await import('../src/app/api/workspace/agents/scopes/route');
    const connectionsRoute = await import('../src/app/api/workspace/chat-connections/route');
    const connectionAgentsRoute = await import('../src/app/api/workspace/chat-connections/[id]/agents/route');
    const delegationsRoute = await import('../src/app/api/v1/delegations/route');
    const tasksRoute = await import('../src/app/api/v1/tasks/route');
    const taskRoute = await import('../src/app/api/v1/tasks/[id]/route');
    const approvalsRoute = await import('../src/app/api/v1/approvals/route');
    const answerRoute = await import('../src/app/api/v1/questions/[id]/answer/route');
    const questionsRoute = await import('../src/app/api/v1/questions/route');
    const chatRoute = await import('../src/app/api/v1/chat/messages/route');
    const contextRoute = await import('../src/app/api/v1/context/route');
    const assistantsRoute = await import('../src/app/api/v1/assistants/route');
    const assistantKeyRoute = await import('../src/app/api/v1/assistants/[id]/key/route');
    const auditExportRoute = await import('../src/app/api/v1/audit/export/route');

    const read = async (response: Response): Promise<Answer> => {
      const text = await response.text();
      let body: Loose = null;
      try { body = JSON.parse(text); } catch { body = text; }
      return { status: response.status, body };
    };
    const session = async (handler: (request: Request, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string> = {}, body?: unknown) =>
      read(await handler(new Request(`http://localhost${path}`, {
        method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const v1 = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string>,
      apiKey: string, body?: unknown, actFor?: string) =>
      read(await handler(new NextRequest(`http://localhost${path}`, {
        method, headers: { 'x-api-key': apiKey, 'content-type': 'application/json', ...(actFor ? { 'x-act-for': actFor } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;
    const brief = (answer: Answer) => ({ status: answer.status, reason: reason(answer), message: answer.body?.error?.message ?? answer.body?.error });
    const mint = (apiKey: string, externalId: string) =>
      v1(delegationsRoute.POST, 'POST', '/api/v1/delegations', {}, apiKey, { provider: 'slack', external_id: externalId, workspace_id: 'T1' });

    // ── agents.act_for ──────────────────────────────────────────────────
    // The owner's report: giving a new agent Act for a person in the hire flow.
    const offered = await session(hireScopesRoute.GET, 'GET', '/api/workspace/agents/scopes');
    check('act_for: the hire flow reads what a new agent holds', offered.status === 200 && Array.isArray(offered.body?.data?.scopes ?? offered.body?.scopes), brief(offered));
    const hired = await session(hireRoute.POST, 'POST', '/api/workspace/agents', {}, {
      name: 'Relay', create_key: true, scopes: ['tasks.read', 'projects.read', 'agents.act_for'],
    });
    const relayId = hired.body?.data?.agent?.id as string | undefined;
    const relayKey = hired.body?.data?.key?.secret as string | undefined;
    check('act_for: an Owner hires an agent with Act for a person (a power the agent role lacks)', hired.status === 201 && !!relayKey
      && JSON.stringify([...(hired.body?.data?.key?.scopes ?? [])].sort()) === JSON.stringify(['agents.act_for', 'projects.read', 'tasks.read']), brief(hired));
    if (relayId) {
      const grant = await s.q("SELECT effect FROM pm.team_member_permissions WHERE member_id = $1 AND permission_key = 'agents.act_for' AND access_channel = 'api'", [relayId]);
      check('act_for: the hire gave that agent alone the power (a per-member allow on the API channel)', grant[0]?.effect === 'allow', grant);
      check('act_for: the agent role itself is unchanged', (await s.q("SELECT 1 FROM pm.role_permissions WHERE role = 'agent' AND permission_key = 'agents.act_for'")).length === 0);
    }
    if (relayKey) {
      // A pass needs a fresh chat message from that account to this agent (security review finding 6).
      const connection = (await s.q<{ id: string }>("INSERT INTO pm.chat_connections (provider, display_name, credentials, kind) VALUES ('telegram', 'Proof', 'pm1:x', 'personal') RETURNING id"))[0].id;
      await s.q(`INSERT INTO pm.chat_messages (connection_id, direction, status, conversation_id, external_user_id, identity_id, member_id, agent_id, text)
        SELECT $1, 'inbound', 'pending', 'D1', i.external_id, i.id, i.member_id, $2, 'hi' FROM pm.member_identities i WHERE i.external_id = 'U_MIA'`, [connection, relayId]);
      const pass = await mint(relayKey, 'U_MIA');
      check('act_for: the hired agent\'s key mints a delegation for a verified person', pass.status === 201 && typeof pass.body?.data?.token === 'string', brief(pass));
      if (pass.body?.data?.token) {
        const acting = await v1(tasksRoute.GET, 'GET', '/api/v1/tasks', {}, relayKey, undefined, pass.body.data.token);
        check('act_for: and acts for that person with it', acting.status === 200, brief(acting));
      }
    }
    // Without it: the same agent shape with no act_for anywhere.
    const noScope = await mint(s.keys.scoutWork, 'U_MIA');
    check('act_for: a key without agents.act_for cannot mint a delegation (403)', noScope.status === 403, brief(noScope));
    const keyOnly = await mint(s.keys.scoutActFor, 'U_MIA');
    check('act_for: the scope on the key alone, not held by the agent, is refused (403)', keyOnly.status === 403 && reason(keyOnly) === 'missing_member_permission', brief(keyOnly));

    // ── approvals.decide ────────────────────────────────────────────────
    const deploy = await s.task('Ship the release', [s.scout]);
    const approval = await v1(approvalsRoute.POST, 'POST', '/api/v1/approvals', {}, s.keys.scoutWork, {
      task_id: deploy, asked_to: s.mia, action: { type: 'deploy', summary: 'Deploy v2 to production' },
    });
    const approvalId = approval.body?.data?.id as string | undefined;
    check('approvals.decide: an agent asks Mia to approve', approval.status === 201 && !!approvalId, brief(approval));
    if (approvalId) {
      const plain = await v1(answerRoute.POST, 'POST', `/api/v1/questions/${approvalId}/answer`, { id: approvalId }, s.keys.miaPlain, { choice: 'approve' });
      check('approvals.decide: Mia\'s key without it is refused (403)', plain.status === 403 && reason(plain) === 'approval_needs_person', brief(plain));
      const decided = await v1(answerRoute.POST, 'POST', `/api/v1/questions/${approvalId}/answer`, { id: approvalId }, s.keys.miaDecide, { choice: 'approve' });
      check('approvals.decide: with it her key decides', decided.status === 200 && decided.body?.data?.decision === 'approved', brief(decided));
    }

    // ── questions.ask ───────────────────────────────────────────────────
    const asked = await v1(questionsRoute.POST, 'POST', '/api/v1/questions', {}, s.keys.scoutAsk, { question: 'Is vendor Acme the same as Acme Ltd?', asked_to: s.owner });
    check('questions.ask: with it (and no tasks.read) an agent asks a question on nothing', asked.status === 201, brief(asked));
    const notAsked = await v1(questionsRoute.POST, 'POST', '/api/v1/questions', {}, s.keys.scoutNoAsk, { question: 'Is vendor Acme the same as Acme Ltd?', asked_to: s.owner });
    check('questions.ask: without it the same question is refused (403)', notAsked.status === 403, brief(notAsked));

    // ── chat.notify ─────────────────────────────────────────────────────
    const connection = await session(connectionsRoute.POST, 'POST', '/api/workspace/chat-connections', {}, {
      provider: 'slack', kind: 'company', bot_token: COMPANY_TOKEN, signing_secret: COMPANY_SECRET,
    });
    const connectionId = connection.body?.data?.id as string | undefined;
    check('chat.notify: an Owner connects a company Slack', connection.status === 201 && !!connectionId, brief(connection));
    if (connectionId) {
      const listed = await session(connectionAgentsRoute.PUT, 'PUT', `/api/workspace/chat-connections/${connectionId}/agents`, { id: connectionId },
        { agent_ids: [s.herald, s.courier], default_agent_id: s.herald });
      check('chat.notify: and lists two agents on it', listed.status === 200, brief(listed));
      const notify = await v1(chatRoute.POST, 'POST', '/api/v1/chat/messages', {}, s.keys.heraldNotify, { text: 'Payroll runs tomorrow.', person_id: s.ben });
      check('chat.notify: held by the agent and on its key, an unprompted DM goes', notify.status === 201, brief(notify));
      const unasked = await v1(chatRoute.POST, 'POST', '/api/v1/chat/messages', {}, s.keys.heraldPlain, { text: 'Payroll runs tomorrow.', person_id: s.ben });
      check('chat.notify: the same agent\'s key without it is refused (403)', unasked.status === 403 && reason(unasked) === 'chat_notify_required', brief(unasked));
      const notHeld = await v1(chatRoute.POST, 'POST', '/api/v1/chat/messages', {}, s.keys.courierNotify, { text: 'hi', person_id: s.ben });
      check('chat.notify: on the key of an agent that does not hold it, refused (403)', notHeld.status === 403 && reason(notHeld) === 'chat_notify_required', brief(notHeld));
    }

    // ── context.memory ──────────────────────────────────────────────────
    const memory = await v1(contextRoute.GET, 'GET', `/api/v1/context?scope_type=member&scope_id=${s.mia}`, {}, s.keys.miaMemory);
    check('context.memory: a person\'s own key with it reads their memory', memory.status === 200, brief(memory));
    const noMemory = await v1(contextRoute.GET, 'GET', `/api/v1/context?scope_type=member&scope_id=${s.mia}`, {}, s.keys.miaPlain);
    check('context.memory: without it the same key is refused (403)', noMemory.status === 403, brief(noMemory));
    const wrote = await v1(contextRoute.POST, 'POST', '/api/v1/context', {}, s.keys.miaMemory, { scope_type: 'member', scope_id: s.mia, content: 'Prefers short replies.' });
    check('context.memory: and adds to it', wrote.status === 201, brief(wrote));

    // ── assistants.provision ────────────────────────────────────────────
    const provisionList = await v1(assistantsRoute.GET, 'GET', '/api/v1/assistants', {}, s.keys.ownerAll);
    check('assistants.provision: an Owner\'s key with it lists personal agents', provisionList.status === 200
      && (provisionList.body?.data ?? []).some((row: Loose) => row.id === s.nova), brief(provisionList));
    const provisionPlain = await v1(assistantsRoute.GET, 'GET', '/api/v1/assistants', {}, s.keys.ownerPlain);
    check('assistants.provision: an Owner\'s key without it is refused (403)', provisionPlain.status === 403 && reason(provisionPlain) === 'missing_key_scope', brief(provisionPlain));
    const provisionMember = await v1(assistantsRoute.GET, 'GET', '/api/v1/assistants', {}, s.keys.miaProvision);
    check('assistants.provision: on a member\'s key (no role holds it) refused (403)', provisionMember.status === 403 && reason(provisionMember) === 'missing_member_permission', brief(provisionMember));
    const collected = await v1(assistantKeyRoute.POST, 'POST', `/api/v1/assistants/${s.nova}/key`, { id: s.nova }, s.keys.ownerAll, {});
    check('assistants.provision: the Owner\'s harness key collects a personal agent\'s key once', collected.status === 201 && /^pk_live_/.test(collected.body?.data?.secret ?? ''), brief(collected));

    // Collecting keys is an Owner's key's job (agent-setup refuses agents), so the hire flow never gives it.
    const harnessHire = await session(hireRoute.POST, 'POST', '/api/workspace/agents', {}, { name: 'Harness', create_key: true, scopes: ['assistants.provision'] });
    check('assistants.provision: the hire flow refuses it for an agent (422 scope_never_for_agents)',
      harnessHire.status === 422 && reason(harnessHire) === 'scope_never_for_agents', brief(harnessHire));

    // ── tasks.manage_all ────────────────────────────────────────────────
    const someoneElses = await s.task('Fix the footer', [s.ben]);
    const assignedOnly = await v1(taskRoute.PATCH, 'PATCH', `/api/v1/tasks/${someoneElses}`, { id: someoneElses }, s.keys.adaAssigned, { title: 'Fix the footer links' });
    check('tasks.manage_all: without it an admin\'s key cannot edit a task assigned to someone else (403)', assignedOnly.status === 403, brief(assignedOnly));
    const managed = await v1(taskRoute.PATCH, 'PATCH', `/api/v1/tasks/${someoneElses}`, { id: someoneElses }, s.keys.adaAll, { title: 'Fix the footer links' });
    check('tasks.manage_all: with it the same admin edits it', managed.status === 200 && managed.body?.data?.title === 'Fix the footer links', brief(managed));
    const memberTry = await v1(taskRoute.PATCH, 'PATCH', `/api/v1/tasks/${someoneElses}`, { id: someoneElses }, s.keys.miaManageAll, { title: 'Nope' });
    check('tasks.manage_all: on a member\'s key (the member role lacks it) refused (403)', memberTry.status === 403, brief(memberTry));
    const removed = await v1(taskRoute.DELETE, 'DELETE', `/api/v1/tasks/${someoneElses}`, { id: someoneElses }, s.keys.adaAssigned);
    check('tasks.manage_all: deleting needs it (403 without)', removed.status === 403, brief(removed));

    // ── audit.export ────────────────────────────────────────────────────
    const exported = await v1(auditExportRoute.GET, 'GET', '/api/v1/audit/export?limit=5', {}, s.keys.ownerAll);
    check('audit.export: an Owner\'s key with it reads the audit export', exported.status === 200 && Array.isArray(exported.body?.data), brief(exported));
    const notExported = await v1(auditExportRoute.GET, 'GET', '/api/v1/audit/export', {}, s.keys.ownerPlain);
    check('audit.export: an Owner\'s key without it is refused (403)', notExported.status === 403, brief(notExported));
    const adminExport = await v1(auditExportRoute.GET, 'GET', '/api/v1/audit/export', {}, s.keys.adaExport);
    check('audit.export: on an admin\'s key (no role holds it) refused (403)', adminExport.status === 403, brief(adminExport));
  } finally {
    await server.close();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  scanSource();
  const db = await createFullSchemaDatabase();
  try {
    const catalog = await readCatalog(db);
    // The live MCP tool list needs the server env only at call time; reading it is pure.
    Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'x', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'x' });
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const rows = await mapChecks(catalog, PM_TOOLS.map((tool) => ({ name: tool.name, permission: tool.permission as string | string[] })));
    if (REPORT) {
      console.log(['permission', 'holders', 'enforced', 'offered', 'status'].join(' | '));
      for (const row of rows) console.log([row.key, row.holders, row.enforced, row.offered, row.status.join(' ') || 'ok'].join(' | '));
    }
    await routeChecks(db);
  } finally {
    await db.close();
  }

  console.log(`permission scopes: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
