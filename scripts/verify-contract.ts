/**
 * The public contract's promises (20261125001200_contract_cleanup.sql,
 * docs/agents/README.md "Compatibility"):
 * - Every deprecated docs-data route or field names a replacement and when it
 *   goes; the legacy pieces are labelled (every /api/v1/inbound-emails route
 *   file, the older triage, its summary, shadow mode, draft-notice relaying).
 * - Every legacy activity type has a typed replacement, and the legacy schema
 *   accepts exactly those types, unchanged.
 * - The tool catalog leaves the deprecated tools out and carries api_version;
 *   the tools stay callable by name (test:inbox-mcp calls them over MCP).
 * - Every /api/v1 answer carries X-PM-API-Version.
 * - Webhook envelopes carry api_version and are otherwise byte for byte what
 *   the schema before the migration wrote; one that names its own keeps it.
 * - A new inbox runs plans; an existing one keeps legacy. The migration runs
 *   twice, and a fresh install matches an upgraded one.
 *
 *   npm run -s test:contract
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { createFullSchemaDatabase, schemaAt, schemaBeforeMigration } from './full-schema-db';
import { endpoints } from '../src/app/api/docs/docs-data';
import { LEGACY_ACTIVITY_REPLACEMENTS, LEGACY_ACTIVITY_TYPES } from '../src/lib/agent-events';
import { legacyAgentActivitySchema } from '../src/lib/schemas/agent-activity';
import { API_ENDPOINT_PERMISSIONS, type AccessContext } from '../src/lib/access-control';
import { API_VERSION, API_VERSION_HEADER, PLANS_CUTOVER_REMOVAL } from '../src/lib/api/version';
import { toolCatalog } from '../src/lib/mcp/catalog';
import { callableToolsFor } from '../src/lib/mcp/visibility';
import { PM_TOOLS } from '../src/lib/mcp/tools';

const MIGRATION = '20261125001200_contract_cleanup.sql';
const APP = join(__dirname, '..');
const MIGRATION_SQL = readFileSync(join(APP, 'supabase', 'migrations', MIGRATION), 'utf8');

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1500)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- payloads are untyped JSON
type Loose = any;

// ---------------------------------------------------------------------------
// Deprecation labels
// ---------------------------------------------------------------------------
function labels() {
  const named = (d: { replacement?: string; removal?: string }) => typeof d.replacement === 'string' && d.replacement.trim().length > 3
    && typeof d.removal === 'string' && d.removal.trim().length > 3;
  const deprecated = endpoints.filter((e) => e.deprecated);
  check('docs: every deprecated route names its replacement and removal', deprecated.length > 0 && deprecated.every((e) => named(e.deprecated!)),
    deprecated.filter((e) => !named(e.deprecated!)).map((e) => `${e.method} ${e.path}`));
  const fields = endpoints.flatMap((e) => (e.deprecatedFields ?? []).map((f) => ({ route: `${e.method} ${e.path}`, ...f })));
  check('docs: every deprecated field names its replacement and removal', fields.length > 0 && fields.every((f) => f.name && named(f)),
    fields.filter((f) => !f.name || !named(f)));
  // The triage and email pieces wait for the plans cutover; other deprecations (the assistant chat alias) carry their own removal.
  const legacy = deprecated.filter((e) => !e.path.startsWith('/api/v1/assistant/'));
  check('docs: the legacy pieces go after the triage plans cutover', legacy.length > 0 && [...legacy.map((e) => e.deprecated!.removal), ...fields.map((f) => f.removal)].every((r) => r === PLANS_CUTOVER_REMOVAL));

  const doc = (method: string, path: string) => endpoints.find((e) => e.method === method && e.path === path);
  for (const [method, path] of [
    ['POST', '/api/v1/inbox/messages/:id/triage'],
    ['GET', '/api/v1/inbox/triage/unsummarized'],
    ['POST', '/api/v1/inbox/triage/mark-summarized'],
    ['POST', '/api/v1/billing/draft-notices/relayed'],
    ['GET', '/api/v1/inbox/plans'],
  ]) check(`docs: ${method} ${path} is deprecated`, !!doc(method, path)?.deprecated);
  check('docs: the record_email_triage route points at plans', /\/inbox\/messages\/:id\/plan/.test(doc('POST', '/api/v1/inbox/messages/:id/triage')?.deprecated?.replacement ?? ''));
  check('docs: GET /billing/draft-notices itself stays current', !!doc('GET', '/api/v1/billing/draft-notices') && !doc('GET', '/api/v1/billing/draft-notices')?.deprecated);
  check('docs: GET /inbox/messages itself stays current', !!doc('GET', '/api/v1/inbox/messages') && !doc('GET', '/api/v1/inbox/messages')?.deprecated);
  const fieldOf = (method: string, path: string, name: string) => (doc(method, path)?.deprecatedFields ?? []).some((f) => f.name.includes(name));
  check('docs: the shadow fields are deprecated', fieldOf('GET', '/api/v1/inbox/signal', 'shadow_pending_count') && fieldOf('GET', '/api/v1/inbox/queue', 'shadow')
    && fieldOf('GET', '/api/v1/inbox/messages/:id/context', 'shadow') && fieldOf('POST', '/api/v1/inbox/messages/:id/plan', 'shadow'));

  // Every older route file is documented, deprecated, and points at a twin that is documented and current.
  const routeFiles: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}/${entry.name.replace(/^\[(\w+)\]$/, ':$1')}`);
      else if (entry.name === 'route.ts') {
        const source = readFileSync(join(dir, entry.name), 'utf8');
        for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) if (new RegExp(`export const ${method}\\b`).test(source)) routeFiles.push(`${method} ${prefix}`);
      }
    }
  };
  walk(join(APP, 'src', 'app', 'api', 'v1', 'inbound-emails'), '/api/v1/inbound-emails');
  routeFiles.push('GET /api/v1/tasks/:id/emails');
  const undocumented = routeFiles.filter((route) => { const [m, p] = route.split(' '); return !doc(m, p)?.deprecated; });
  check('docs: every older inbound-emails route is listed and deprecated', routeFiles.length >= 15 && undocumented.length === 0, { routeFiles, undocumented });
  const twins = routeFiles.map((route) => { const [m, p] = route.split(' '); return doc(m, p)?.deprecated?.replacement ?? ''; })
    .map((replacement) => /^(GET|POST|PUT|PATCH|DELETE) (\S+)/.exec(replacement)).filter((m): m is RegExpExecArray => !!m);
  check('docs: each older route\'s replacement is a documented route', twins.length >= 13 && twins.every((m) => !!doc(m[1], m[2])), twins.filter((m) => !doc(m[1], m[2])).map((m) => m[0]));

  // Legacy activity types.
  const schemaTypes = legacyAgentActivitySchema.shape.activity_type.options;
  check('legacy types: the schema accepts exactly the mapped types', JSON.stringify([...schemaTypes].sort()) === JSON.stringify(Object.keys(LEGACY_ACTIVITY_REPLACEMENTS).sort()) && schemaTypes.length === 15, schemaTypes);
  check('legacy types: each names a replacement', LEGACY_ACTIVITY_TYPES.every((t) => LEGACY_ACTIVITY_REPLACEMENTS[t].length > 3));
  check('legacy types: a legacy write still parses, unchanged', legacyAgentActivitySchema.safeParse({ activity_type: 'task_started', title: 'Started the footer' }).success
    && !legacyAgentActivitySchema.safeParse({ activity_type: 'task_begun', title: 'x' }).success);
  const activityDoc = doc('POST', '/api/v1/agent-activities');
  check('docs: every legacy activity type is listed on POST /agent-activities', LEGACY_ACTIVITY_TYPES.every((t) => (activityDoc?.deprecatedFields ?? []).some((f) => f.name.includes(` ${t} `))));
}

// ---------------------------------------------------------------------------
// The tool catalog and the header
// ---------------------------------------------------------------------------
async function catalogAndHeader() {
  const access: AccessContext = {
    member_id: '00000000-0000-4000-8000-0000000000aa', role: 'agent', status: 'active',
    app_permissions: ['*'], api_permissions: ['*'], project_ids: [],
  };
  const viewer = { access, scopes: [...API_ENDPOINT_PERMISSIONS], readOnly: false, profile: 'generic' };
  const catalog = toolCatalog(viewer);
  const listed = catalog.tools.map((t) => t.name);
  const deprecated = PM_TOOLS.filter((t) => t.deprecated).map((t) => t.name);
  check('catalog: the deprecated tools are record_email_triage and the summary pair', JSON.stringify([...deprecated].sort()) === JSON.stringify(['list_unsummarized_triage', 'mark_triage_summarized', 'record_email_triage']), deprecated);
  check('catalog: no deprecated tool is listed, the plans tools are', !deprecated.some((name) => listed.includes(name)) && listed.includes('submit_triage_plan') && listed.includes('get_inbox_signal'), listed);
  check('catalog: carries api_version beside its content version', catalog.api_version === API_VERSION && /^[0-9a-f]{16}$/.test(catalog.version));
  const callable = callableToolsFor(viewer).map((t) => t.name);
  check('catalog: the deprecated tools stay callable by name', deprecated.every((name) => callable.includes(name)) && callable.length === listed.length + deprecated.length);
  check('api_version: date style', /^\d{4}-\d{2}-\d{2}$/.test(API_VERSION));

  const route = await import('../src/app/api/v1/mcp/tools/route');
  const answer = await route.GET(new NextRequest('http://pm.test/api/v1/mcp/tools'), { params: Promise.resolve({}) } as never);
  check('header: an /api/v1 answer carries X-PM-API-Version, a refusal included', answer.status === 401 && answer.headers.get(API_VERSION_HEADER) === API_VERSION,
    { status: answer.status, header: answer.headers.get(API_VERSION_HEADER) });
}

// ---------------------------------------------------------------------------
// The database: inbox default, envelopes, twice, fresh equals upgraded
// ---------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
function normalize(value: Loose): Loose {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'id' && k !== 'sequence').map(([k, v]) => [k, normalize(v)]));
  if (typeof value === 'string' && UUID.test(value)) return '<uuid>';
  if (typeof value === 'string' && TIMESTAMP.test(value)) return '<time>';
  return value;
}

async function setup(db: PGlite) {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claims', '', false)");
  await db.exec("UPDATE pm.business_settings SET inbound_email_domain = 'relay.example.test'");
}

/** One work event and one invoice event, as their writers store them. */
async function envelopes(db: PGlite): Promise<Loose[]> {
  await db.exec(`
    INSERT INTO pm.webhook_endpoints (name, url, secret, events) VALUES
      ('all', 'https://hooks.example.test/all', 'whsec_test', ARRAY['task.updated', 'invoice.paid']);
    INSERT INTO pm.projects (id, name) VALUES ('00000000-0000-4000-8000-0000000000a1', 'Acme Website');
    INSERT INTO pm.project_invoices (id, project_id, invoice_number, amount, status, invoice_type, date, due_date)
      VALUES ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'INV-1', 100, 'paid', 'recurring', '2026-07-01', '2999-07-15');
  `);
  await db.query(`SELECT pm.emit_webhook_event('task.updated', 'task', '00000000-0000-4000-8000-0000000000c1',
    ARRAY['00000000-0000-4000-8000-0000000000a1']::uuid[], '{}'::uuid[], '{"task": {"title": "Fix the footer"}, "changes": ["title"]}'::jsonb)`);
  await db.query("SELECT pm.emit_invoice_webhook_event(i, 'invoice.paid') FROM pm.project_invoices i WHERE i.id = '00000000-0000-4000-8000-0000000000b1'");
  return (await db.query<{ payload: Loose }>('SELECT payload FROM pm.webhook_events ORDER BY sequence')).rows.map((r) => r.payload);
}

async function shape(db: PGlite) {
  const read = async (sql: string) => JSON.stringify((await db.query(sql)).rows);
  return {
    column: await read("SELECT column_default FROM information_schema.columns WHERE table_schema = 'pm' AND table_name = 'inboxes' AND column_name = 'triage_mode'"),
    trigger: await read("SELECT tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t WHERE tgrelid = 'pm.webhook_events'::regclass AND NOT tgisinternal ORDER BY tgname"),
    // Line endings follow the checkout (CRLF on Windows with core.autocrlf), not the function, so compare them as LF.
    fn: (await read("SELECT prosrc, proconfig, proacl::text FROM pg_proc WHERE oid = 'pm.webhook_envelope_api_version()'::regprocedure")).replace(/\\r\\n/g, '\\n'),
  };
}

async function database() {
  let before: string;
  try {
    before = schemaBeforeMigration(MIGRATION);
  } catch {
    // Not committed yet (while it is being written): the last commit is the schema before it.
    before = schemaAt('HEAD');
  }
  const sqlVersion = /'api_version', '([^']+)'/.exec(MIGRATION_SQL)?.[1];
  check('api_version: the database writes the same value as lib/api/version.ts', sqlVersion === API_VERSION, sqlVersion);

  const old = await createFullSchemaDatabase({ schemaSql: before });
  await setup(old);
  const reference = await envelopes(old);
  await old.close();

  const upgraded = await createFullSchemaDatabase({ schemaSql: before });
  await setup(upgraded);
  await upgraded.exec("INSERT INTO pm.inboxes (id, name, address) VALUES ('00000000-0000-4000-8000-0000000000d1', 'Existing', 'hello@agency.example')");
  await upgraded.exec(MIGRATION_SQL);
  await upgraded.exec(MIGRATION_SQL);
  await upgraded.exec("INSERT INTO pm.inboxes (id, name, address) VALUES ('00000000-0000-4000-8000-0000000000d2', 'New', 'new@agency.example')");
  const modes = Object.fromEntries((await upgraded.query<{ name: string; triage_mode: string }>('SELECT name, triage_mode FROM pm.inboxes')).rows.map((r) => [r.name, r.triage_mode]));
  check('inbox: an existing inbox keeps legacy after the upgrade (twice)', modes.Existing === 'legacy', modes);
  check('inbox: a new inbox defaults to plans after the upgrade', modes.New === 'plans', modes);
  await upgraded.exec("INSERT INTO pm.inboxes (name, address, triage_mode) VALUES ('Named', 'named@agency.example', 'legacy')");
  check('inbox: a write that names legacy still gets it', (await upgraded.query<{ triage_mode: string }>("SELECT triage_mode FROM pm.inboxes WHERE name = 'Named'")).rows[0]?.triage_mode === 'legacy');
  const afterUpgrade = await envelopes(upgraded);

  // An envelope that already names its version keeps it.
  await upgraded.query(`INSERT INTO pm.webhook_events (event_id, sequence, event_type, resource_type, resource_id, payload)
    VALUES ('evt_own', nextval('pm.webhook_event_seq'), 'task.updated', 'task', gen_random_uuid(), '{"id": "evt_own", "api_version": "1999-01-01"}'::jsonb)`);
  check('envelope: one that names its own api_version keeps it', (await upgraded.query<{ v: string }>("SELECT payload->>'api_version' AS v FROM pm.webhook_events WHERE event_id = 'evt_own'")).rows[0]?.v === '1999-01-01');
  const upgradedShape = await shape(upgraded);
  await upgraded.close();

  const fresh = await createFullSchemaDatabase();
  await setup(fresh);
  await fresh.exec("INSERT INTO pm.inboxes (name, address) VALUES ('Fresh', 'fresh@agency.example')");
  check('inbox: a fresh install\'s new inbox defaults to plans', (await fresh.query<{ triage_mode: string }>("SELECT triage_mode FROM pm.inboxes WHERE name = 'Fresh'")).rows[0]?.triage_mode === 'plans');
  const fromSchema = await envelopes(fresh);
  const freshShape = await shape(fresh);
  await fresh.close();

  check('envelope: the old schema wrote no api_version (the reference)', reference.length >= 2 && reference.every((p) => !('api_version' in p)), reference.map((p) => Object.keys(p)));
  for (const [label, events] of [['upgraded', afterUpgrade], ['fresh', fromSchema]] as const) {
    check(`envelope (${label}): every event carries api_version`, events.length === reference.length && events.every((p) => p.api_version === API_VERSION), events.map((p) => p.api_version));
    const rest = events.map((p) => { const { api_version: _v, ...others } = p; void _v; return JSON.stringify(normalize(others)); });
    check(`envelope (${label}): otherwise byte for byte the same as before`, JSON.stringify(rest) === JSON.stringify(reference.map((p) => JSON.stringify(normalize(p)))),
      { rest, reference: reference.map((p) => normalize(p)) });
  }
  check('fresh equals upgraded: column default, trigger and function', JSON.stringify(freshShape) === JSON.stringify(upgradedShape) && freshShape.column.includes('plans') && freshShape.trigger.includes('webhook_events_api_version'),
    { freshShape, upgradedShape });
}

async function main() {
  labels();
  await catalogAndHeader();
  await database();
  if (failures.length) {
    console.error(`contract: ${passed} passed, ${failures.length} failed`);
    for (const failure of failures) console.error(`  x ${failure}`);
    process.exit(1);
  }
  console.log(`contract: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
