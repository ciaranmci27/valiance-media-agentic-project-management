/**
 * Limits, pause switches and the compliance-grade audit log, end to end over
 * the real routes (v1 routes with keys, session routes with a signed-in
 * member, a fake PostgREST over PGlite with the full schema):
 * - The migration (20261124001500_limits_audit.sql), run twice on the schema
 *   before it, matches schema.sql; rows from before keep working and get an
 *   export position; the previous release's writes still work; the new
 *   functions are the server's only.
 * - Limits: unset changes nothing; max_concurrent_runs refuses a second run
 *   (409 limit_concurrent_runs) and a second claim (409
 *   limit_concurrent_claims) but never a renewal; the budget soft stop
 *   records usage, tells the owners once and refuses new runs (402
 *   budget_exceeded); only an Owner sets limits; a template's limits land at
 *   hire.
 * - The rate limiter: 120 a minute per key by default, an agent's own
 *   rate_per_minute across its keys, in the database.
 * - Pause: one agent, the kill switch (Owner only) and a paused project
 *   assignment refuse agents' writes with 423 while reads, heartbeats and
 *   telemetry go on; people's keys and sessions are unaffected.
 * - Audit: anon and authenticated cannot write it (nor pm.activities); rows
 *   never change; retention removes old rows only through the job (keeping
 *   rows the app reads as state); secrets are redacted at any depth (with
 *   the workspace's own list); signed-in changes to access, members, keys,
 *   agents and settings write rows (via app); principal_id is stamped; the
 *   export pages by cursor (JSON and NDJSON) and needs audit.export; the
 *   Settings audit log filters and pages (Owner only).
 * - Live-fleet-shaped traffic (a fleet agent and the admin app's webhook
 *   key, no limits set) is unaffected throughout.
 *
 *   npm run -s test:limits-audit
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { actAs, applyMigrationsFrom, createFullSchemaDatabase, SCHEMA_PATH } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { diffSnapshots, pmSnapshot } from './lib/pm-catalog';
import { isSensitiveKey, redactAuditRow, redactForAudit, REDACTED, urlOrigin } from '../src/lib/api/audit-redact';
import { missingLimitsSchema } from '../src/lib/api/agent-limits';
import { limitsInWords, agentLimitsOf } from '../src/lib/agent-limits';
import { pauseExempt } from '../src/lib/api/request-gate';
import { auditActionLabel, auditDetails } from '../src/lib/audit-log';

const MIGRATION = '20261124001500_limits_audit.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8').replace(/\r\n/g, '\n');
const SCHEMA_SQL = readFileSync(SCHEMA_PATH, 'utf8').replace(/\r\n/g, '\n');
const SECTION = '-- LIMITS, PAUSE SWITCHES AND AUDIT LOG (20261124001500_limits_audit.sql)';
const NEW_FUNCTIONS = ['api_request_gate', 'agent_limit_state', 'purge_audit_log', 'audit_sensitive_key', 'audit_redact', 'audit_log_export'];

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1200)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose; text: string; headers: Headers };

const LOGINS = {
  owner: { id: '00000000-0000-4000-8000-00000000d001', email: 'olivia@example.com' },
  ana: { id: '00000000-0000-4000-8000-00000000d002', email: 'ana@example.com' },
};
let signedIn = LOGINS.owner;

function authStandIn() {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname === '/auth/v1/user' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ id: signedIn.id, aud: 'authenticated', role: 'authenticated', email: signedIn.email, user_metadata: {}, app_metadata: {}, created_at: '2026-11-24T00:00:00Z' }));
      return true;
    }
    return false;
  };
}

function installSession(supabaseUrl: string) {
  const name = `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const store = {
    getAll: () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const user = { id: signedIn.id, email: signedIn.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-11-24T00:00:00Z' };
      const session = {
        access_token: `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: signedIn.id, email: signedIn.email, role: 'authenticated', aud: 'authenticated', exp })}.sig`,
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

// ── Pure ─────────────────────────────────────────────────────────────────

function pureChecks() {
  for (const name of ['secret', 'token', 'password', 'key', 'authorization', 'bot_token', 'signing_secret', 'api_key', 'apiKey', 'key_hash', 'client_secret', 'refresh_token', 'x-api-key', 'privateKey']) {
    check(`redaction: ${name} is sensitive`, isSensitiveKey(name), name);
  }
  for (const name of ['tokens_in', 'tokens_out', 'token_id', 'key_prefix', 'dedupe_key', 'template_key', 'idempotency_key', 'permission_key', 'title', 'scopes', 'secret_name']) {
    check(`redaction: ${name} is kept`, !isSensitiveKey(name), name);
  }
  check('redaction: the workspace list adds names', isSensitiveKey('ssn', ['SSN']) && !isSensitiveKey('ssn'));
  check('redaction: a rotation\'s new_key keeps its fields (a field named key would not)', !isSensitiveKey('new_key') && isSensitiveKey('key'));
  const hookRow = redactAuditRow({ entity_type: 'webhook_endpoint', endpoint: '/api/v1/webhook-endpoints', request_body: { url: 'https://hooks.slack.com/services/T0/B0/XYZ' },
    after_snapshot: { url: 'https://discord.com/api/webhooks/1/tok?wait=1', webhook_url: 'https://hooks.zapier.com/hooks/catch/1/abc/' } }, []) as Loose;
  check('redaction: a webhook row\'s url and webhook_url keep only scheme://host', hookRow.request_body.url === 'https://hooks.slack.com' && hookRow.after_snapshot.url === 'https://discord.com'
    && hookRow.after_snapshot.webhook_url === 'https://hooks.zapier.com' && urlOrigin('not a url') === REDACTED, hookRow);
  const otherRow = redactAuditRow({ entity_type: 'task', endpoint: '/api/v1/tasks', request_body: { url: 'https://example.com/docs/page' } }, []) as Loose;
  check('redaction: other rows keep their urls', otherRow.request_body.url === 'https://example.com/docs/page');
  check('limits: only missing-schema codes read as no limits', missingLimitsSchema({ code: '42P01' }) && missingLimitsSchema({ code: '42703' }) && missingLimitsSchema({ code: 'PGRST205' })
    && missingLimitsSchema({ code: 'PGRST204' }) && missingLimitsSchema({ code: 'PGRST202' })
    && !missingLimitsSchema({ code: 'P0001', message: 'agent_limits does not exist' }) && !missingLimitsSchema({ code: '57014', message: 'schema cache' }) && !missingLimitsSchema(null));
  const out = redactForAudit({
    title: 'Rotate',
    config: { secret: 'shh', nested: [{ password: 'p', note: 'ok' }, { bot_token: 'b' }], tokens_in: 5, cleared_token: null },
    authorization: 'Bearer x',
    body: 'x'.repeat(5000),
    other: 'y'.repeat(3000),
  }) as Loose;
  check('redaction: nested secrets at any depth, null stays null', out.config.secret === REDACTED && out.config.nested[0].password === REDACTED && out.config.nested[0].note === 'ok'
    && out.config.nested[1].bot_token === REDACTED && out.config.tokens_in === 5 && out.config.cleared_token === null && out.authorization === REDACTED, out);
  check('redaction: free text cut short, other long strings capped', out.body.length < 400 && /truncated, 5000 characters/.test(out.body) && out.other.length < 2100 && /truncated, 3000/.test(out.other));
  check('limits in words: none set says so, 120 per key', limitsInWords(null, null).join(' ').includes('No limit on runs') && limitsInWords(null, null).join(' ').includes('120 API requests a minute per key'));
  check('limits in words: a budget names the 402', /402 budget_exceeded/.test(limitsInWords(agentLimitsOf({ budget_usd: 5 }), null).join(' ')));
  check('pause: heartbeat, telemetry, run finish and claim release go on', pauseExempt('/api/v1/agents/heartbeat', 'POST') && pauseExempt('/api/v1/agent-activities', 'POST')
    && pauseExempt('/api/v1/agents/runs/abc/finish', 'POST') && pauseExempt('/api/v1/agents/runs/abc', 'PATCH') && pauseExempt('/api/v1/tasks/t/claim', 'DELETE'));
  check('pause: starting a run, claiming and creating are not exempt', !pauseExempt('/api/v1/agents/runs', 'POST') && !pauseExempt('/api/v1/tasks/t/claim', 'POST') && !pauseExempt('/api/v1/tasks', 'POST'));
}

// ── The migration ────────────────────────────────────────────────────────

async function migrationChecks() {
  const at = SCHEMA_SQL.indexOf(SECTION);
  const banner = SCHEMA_SQL.lastIndexOf('\n-- ====', at);
  check('schema.sql: the limits and audit section is there', at > 0 && banner > 0);
  const body = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('-- ---------------------------------------------------------------------------\n-- Audit log: order for the export')).trim();
  check('schema.sql: the section mirrors the migration body', SCHEMA_SQL.slice(at).includes(body));
  // The audit backfill first, in one pass; what locks team_members and business_settings last.
  const backfillAt = MIGRATION_SQL.indexOf('UPDATE pm.api_audit_log l');
  const hotAt = Math.min(...['ALTER TABLE pm.team_members', 'ALTER TABLE pm.business_settings', 'REFERENCES pm.team_members', 'ON pm.team_members', 'ON pm.business_settings']
    .map((text) => MIGRATION_SQL.indexOf(text)).filter((i) => i >= 0));
  const auditLast = Math.max(...['ON pm.api_audit_log', 'FUNCTION pm.audit_log_export', 'FUNCTION pm.purge_audit_log'].map((text) => MIGRATION_SQL.lastIndexOf(text)));
  check('migration: the audit backfill runs before anything locks team_members or business_settings', backfillAt > 0 && backfillAt < hotAt && auditLast < hotAt, { backfillAt, hotAt, auditLast });
  check('migration: the backfill is one pass (row_number) with setval, no batch loop', /row_number\(\) OVER \(ORDER BY timestamp, id\)/.test(MIGRATION_SQL)
    && /setval\('pm\.api_audit_log_seq'/.test(MIGRATION_SQL) && !/LIMIT 5000/.test(MIGRATION_SQL));

  const old = await createFullSchemaDatabase({ schemaSql: SCHEMA_SQL.slice(0, banner) });
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => (await old.query<T>(sql, params)).rows;
  const fail = (sql: string, params: unknown[] = []) => old.query(sql, params).then(() => null, (e: Error) => e.message);
  await old.exec('RESET ROLE');
  const fleet = (await q<{ id: string }>("INSERT INTO pm.team_members (name, email, role) VALUES ('Fleet', 'fleet@example.com', 'agent') RETURNING id"))[0].id;
  const key = (await q<{ id: string }>(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
    VALUES ('Fleet key', 'pk_live', 'hash-old', $1, $1, '{tasks.read}', 'scoped') RETURNING id`, [fleet]))[0].id;
  for (let i = 0; i < 3; i++) {
    await q("INSERT INTO pm.api_audit_log (method, endpoint, api_key_id, team_member_id, status_code, timestamp) VALUES ('POST', '/api/v1/tasks', $1, $2, 201, now() - make_interval(mins => $3))", [key, fleet, 10 - i]);
  }

  await applyMigrationsFrom(old, MIGRATION);
  const fresh = await createFullSchemaDatabase();
  const diff = diffSnapshots(await pmSnapshot(fresh), await pmSnapshot(old));
  check('upgrade: the migration, run twice on the schema before it, matches schema.sql', diff.length === 0, diff.slice(0, 10));

  const numbered = await q<Loose>('SELECT seq, change_txid FROM pm.api_audit_log ORDER BY timestamp');
  check('upgrade: rows from before are numbered in time order with change_txid 0', numbered.length === 3 && numbered.every((r: Loose) => r.change_txid === '0' || r.change_txid === 0)
    && Number(numbered[0].seq) < Number(numbered[1].seq) && Number(numbered[1].seq) < Number(numbered[2].seq), numbered);
  check('upgrade: nothing is paused or limited', (await q<Loose>('SELECT agents_paused_at, audit_retention_days FROM pm.business_settings LIMIT 1')).every((r: Loose) => r.agents_paused_at === null && r.audit_retention_days === null)
    && (await q<Loose>('SELECT count(*)::int AS n FROM pm.agent_limits'))[0].n === 0
    && (await q<Loose>('SELECT agent_paused_at FROM pm.team_members WHERE id = $1', [fleet]))[0].agent_paused_at === null);
  // What 2.0.26 writes: its rate limit call, an audit row without the new columns.
  await actAs(old, null);
  const oldRate = await q<Loose>('SELECT * FROM pm.consume_api_rate_limit($1, 120, 60)', [key]);
  check('upgrade: the previous release\'s rate limit call still answers', oldRate[0]?.allowed === true, oldRate);
  check('upgrade: a 2.0.26-shaped audit insert still works as the service role', (await fail("INSERT INTO pm.api_audit_log (method, endpoint, api_key_id, team_member_id, request_body, status_code) VALUES ('PATCH', '/api/v1/tasks/x', $1, $2, '{}', 200)", [key, fleet])) === null);
  const stamped = (await q<Loose>("SELECT seq, change_txid FROM pm.api_audit_log WHERE endpoint = '/api/v1/tasks/x'"))[0];
  check('upgrade: a new row gets its export position, after every backfilled one', stamped.seq !== null && Number(stamped.change_txid) > 0
    && Number(stamped.seq) > Math.max(...numbered.map((r: Loose) => Number(r.seq))), { stamped, numbered });
  await old.exec('RESET ROLE');

  // Grants.
  const fnGrants = await q<Loose>(`SELECT p.proname AS name, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth, has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
    FROM pg_proc p WHERE p.pronamespace = 'pm'::regnamespace AND p.proname = ANY ($1)`, [NEW_FUNCTIONS]);
  check('grants: the new functions are the server\'s only', fnGrants.length === NEW_FUNCTIONS.length && fnGrants.every((g: Loose) => !g.anon && !g.auth && g.svc), fnGrants);
  const tableGrants = await q<Loose>(`SELECT t, has_table_privilege('anon', ('pm.' || t)::regclass, 'SELECT') AS anon_select,
      has_table_privilege('authenticated', ('pm.' || t)::regclass, 'SELECT') AS auth_select,
      bool_or(has_table_privilege(r, ('pm.' || t)::regclass, p)) AS writes
    FROM unnest(ARRAY['api_audit_log', 'activities']) t, unnest(ARRAY['anon', 'authenticated']) r, unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
    GROUP BY t`);
  check('grants: anon and authenticated cannot write the audit log or the activity log; authenticated reads them through row policy', tableGrants.length === 2
    && tableGrants.every((g: Loose) => !g.writes && !g.anon_select && g.auth_select), tableGrants);
  const limitGrants = await q<Loose>("SELECT has_table_privilege('authenticated', 'pm.agent_limits', 'SELECT') AS a, has_table_privilege('anon', 'pm.agent_rate_limit_windows', 'SELECT') AS b");
  check('grants: limits and their rate windows are the server\'s only', !limitGrants[0].a && !limitGrants[0].b);

  // As a signed-in Owner the audit log reads (row policy) but never takes a write.
  const ownerLogin = '00000000-0000-4000-8000-00000000e001';
  await q("INSERT INTO auth.users (id, email) VALUES ($1, 'o@example.com')", [ownerLogin]);
  await q("INSERT INTO pm.team_members (name, email, role, auth_user_id) VALUES ('Owner', 'o@example.com', 'owner', $1)", [ownerLogin]);
  await actAs(old, ownerLogin);
  check('grants: a signed-in Owner reads the audit log', (await q<Loose>('SELECT count(*)::int AS n FROM pm.api_audit_log'))[0].n >= 4);
  check('grants: a signed-in Owner cannot insert an audit row', /permission denied/.test(await fail("INSERT INTO pm.api_audit_log (method, endpoint, status_code) VALUES ('POST', '/x', 200)") ?? ''));
  check('grants: nor delete one', /permission denied/.test(await fail('DELETE FROM pm.api_audit_log') ?? ''));
  check('grants: nor write the activity log', /permission denied/.test(await fail("INSERT INTO pm.activities (type, entity_type, entity_id, description) VALUES ('x', 'task', gen_random_uuid(), 'x')") ?? ''));
  // Signed-in changes that matter are audited by the database (via app).
  await q("UPDATE pm.business_settings SET business_name = 'Acme Ltd'");
  await old.exec('RESET ROLE');
  const appRow = (await q<Loose>("SELECT * FROM pm.api_audit_log WHERE endpoint LIKE '/app/business_settings%' ORDER BY seq DESC LIMIT 1"))[0];
  check('coverage: a signed-in settings change writes an app audit row with what changed', appRow?.via === 'app' && appRow.entity_type === 'business_settings'
    && JSON.stringify(appRow.request_body?.changed ?? []).includes('business_name') && appRow.after_snapshot?.business_name === 'Acme Ltd' && !!appRow.team_member_id, appRow);
  await actAs(old, null);
  await q("UPDATE pm.business_settings SET business_name = 'Acme Inc'");
  await old.exec('RESET ROLE');
  check('coverage: a server write with no person behind it is not logged twice', (await q<Loose>("SELECT count(*)::int AS n FROM pm.api_audit_log WHERE endpoint LIKE '/app/business_settings%'"))[0].n === 1);

  // Append-only.
  check('append-only: an update is refused, even for the service role', /append-only/.test(await fail("UPDATE pm.api_audit_log SET status_code = 500") ?? ''));
  check('append-only: a delete without the retention job is refused', /append-only/.test(await fail('DELETE FROM pm.api_audit_log') ?? ''));
  check('append-only: a truncate is refused', /append-only/.test(await fail('TRUNCATE pm.api_audit_log') ?? ''));
  check('append-only: a direct update that nulls a reference is refused, even for the service role', /append-only/.test(await fail('UPDATE pm.api_audit_log SET api_key_id = NULL WHERE api_key_id = $1', [key]) ?? '')
    && /append-only/.test(await fail('UPDATE pm.api_audit_log SET team_member_id = NULL WHERE team_member_id = $1', [fleet]) ?? ''));
  check('append-only: nor anything forged with it', /append-only/.test(await fail("UPDATE pm.api_audit_log SET team_member_id = NULL, endpoint = '/forged' WHERE team_member_id = $1", [fleet]) ?? ''));
  const doomed = (await q<{ id: string }>(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
    VALUES ('Doomed key', 'pk_live', 'hash-doomed', $1, $1, '{tasks.read}', 'scoped') RETURNING id`, [fleet]))[0].id;
  await q("INSERT INTO pm.api_audit_log (method, endpoint, api_key_id, status_code) VALUES ('POST', '/doomed/1', $1, 201), ('POST', '/doomed/2', $1, 201)", [doomed]);
  const deleted = await fail('DELETE FROM pm.api_keys WHERE id = $1', [doomed]);
  const nulled = (await q<Loose>("SELECT count(*)::int AS n FROM pm.api_audit_log WHERE api_key_id IS NULL AND endpoint LIKE '/doomed/%'"))[0].n;
  check('append-only: deleting a key the rows name nulls the reference through the foreign key, the rows kept', deleted === null && nulled === 2, { deleted, nulled });

  // Retention.
  await q("INSERT INTO pm.api_audit_log (method, endpoint, status_code, timestamp) VALUES ('POST', '/old/plain', 200, now() - interval '400 days')");
  await q("INSERT INTO pm.api_audit_log (method, endpoint, entity_type, entity_id, request_body, status_code, timestamp) VALUES ('POST', '/api/workspace/agents', 'team_member', $1, '{\"template\": \"builder\"}', 201, now() - interval '400 days')", [fleet]);
  await q(`INSERT INTO pm.api_audit_log (method, endpoint, request_body, status_code, timestamp) VALUES ('POST', '/app/team-members/${fleet}/deprovision', '{"step": "owner_removed", "agent_ids": []}', 200, now() - interval '400 days')`);
  await actAs(old, null);
  check('retention: nothing goes while it is unset (keep forever)', (await q<Loose>('SELECT pm.purge_audit_log() AS n'))[0].n === 0);
  await old.exec('RESET ROLE');
  check('retention: under 30 days is refused', /audit_retention_days_check/.test(await fail('UPDATE pm.business_settings SET audit_retention_days = 7') ?? ''));
  await q('UPDATE pm.business_settings SET audit_retention_days = 365');
  await actAs(old, null);
  const purged = (await q<Loose>('SELECT pm.purge_audit_log() AS n'))[0].n;
  await old.exec('RESET ROLE');
  const left = (await q<Loose>("SELECT endpoint FROM pm.api_audit_log WHERE timestamp < now() - interval '365 days' ORDER BY endpoint")).map((r: Loose) => r.endpoint);
  // Template rows go too since 20261125000600: the template lives on the agent.
  check('retention: the job removes old rows, keeping what the app reads as state', purged === 2 && left.length === 1 && left[0].endsWith('/deprovision'), { purged, left });
  const record = (await q<Loose>("SELECT request_body FROM pm.api_audit_log WHERE endpoint = '/app/audit/retention'"))[0];
  check('retention: the job records what it removed', record?.request_body?.deleted === 2 && record.request_body.retention_days === 365, record);
  check('retention: the flag does not outlive the job', /append-only/.test(await fail("DELETE FROM pm.api_audit_log WHERE endpoint = '/app/audit/retention'") ?? ''));

  // SQL redaction matches the server's rule.
  const redacted = (await q<Loose>(`SELECT pm.audit_redact('{"a":{"secret":"s","tokens_in":3,"list":[{"bot_token":"b","x":1}]},"key_hash":"h","ssn":"1"}'::jsonb, ARRAY['ssn']) AS r`))[0].r;
  check('redaction (database): nested secrets and the workspace list', redacted.a.secret === REDACTED && redacted.a.tokens_in === 3 && redacted.a.list[0].bot_token === REDACTED
    && redacted.a.list[0].x === 1 && redacted.key_hash === REDACTED && redacted.ssn === REDACTED, redacted);

  // The default rate limit, in the database: 120 a minute per key.
  await actAs(old, null);
  let allowed = 0;
  let last: Loose = null;
  for (let i = 0; i < 121; i++) {
    last = (await q<Loose>('SELECT pm.api_request_gate($1, $2) AS g', [key, fleet]))[0].g;
    if (last.allowed) allowed++;
  }
  check('rate limit: 120 a minute per key by default (the call before this one counted too)', allowed === 119 && last.allowed === false && last.limit === 120 && last.scope === 'key', { allowed, last });
  await old.exec('RESET ROLE');
  await fresh.close();
  await old.close();
}

// ── Seed ─────────────────────────────────────────────────────────────────

async function seed(db: PGlite) {
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  await db.exec('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  await q('UPDATE pm.workspace_modules SET enabled = true');
  const member = async (name: string, role: string, login?: { id: string; email: string }) => {
    const id = (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id', [name, login?.email ?? `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`, role]))[0].id;
    if (login) {
      await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [login.id, login.email]);
      await q('UPDATE pm.team_members SET auth_user_id = $1 WHERE id = $2', [login.id, id]);
    }
    return id;
  };
  const owner = await member('Olivia', 'owner', LOGINS.owner);
  const ana = await member('Ana Lopez', 'member', LOGINS.ana);
  const jeff = await member('Jeff', 'agent');
  const bolt = await member('Bolt', 'agent');
  await q('INSERT INTO pm.agent_owners (agent_id, member_id) VALUES ($1, $2), ($3, $2)', [bolt, ana, jeff]);
  const project = async (name: string, members: string[]) => {
    const id = (await q<{ id: string }>('INSERT INTO pm.projects (name) VALUES ($1) RETURNING id', [name]))[0].id;
    for (const m of members) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  const site = await project('Site', [ana, jeff, bolt]);
  const app = await project('App', [ana, jeff, bolt]);
  const task = async (projectId: string, title: string, assignees: string[] = []) => {
    const id = (await q<{ id: string }>("INSERT INTO pm.tasks (project_id, title, status, ai_readiness) VALUES ($1, $2, 'todo', 'ai_ready') RETURNING id", [projectId, title]))[0].id;
    for (const a of assignees) await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [id, a]);
    return id;
  };
  const key = async (memberId: string, scopes: string[]) => {
    const secretKey = `pk_live_${randomUUID().replace(/-/g, '')}`;
    const id = (await q<{ id: string }>(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions)
      VALUES ('Seed key', 'pk_live', $1, $2, $2, $3, 'scoped') RETURNING id`, [createHash('sha256').update(secretKey).digest('hex'), memberId, scopes]))[0].id;
    return { secret: secretKey, id };
  };
  const AGENT = ['tasks.read', 'tasks.create', 'tasks.manage_assigned', 'projects.read', 'agent_activity.write'];
  const keys = {
    owner: await key(owner, ['audit.export', 'audit.read', 'team.read', 'tasks.read', 'tasks.create', 'projects.read', 'webhooks.manage']),
    ownerNoExport: await key(owner, ['audit.read']),
    // The admin app's webhook key: a person's key, never paused.
    adminApp: await key(owner, ['tasks.read', 'tasks.create', 'projects.read']),
    anaOwn: await key(ana, ['tasks.read', 'tasks.create', 'projects.read', 'audit.export']),
    jeff: await key(jeff, AGENT),
    bolt: await key(bolt, AGENT),
    bolt2: await key(bolt, AGENT),
  };
  return { q, owner, ana, jeff, bolt, site, app, task, keys };
}

async function main() {
  pureChecks();
  await migrationChecks();

  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db, { handle: authStandIn() });
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-anon-key',
    NEXT_PUBLIC_APP_URL: 'https://pm.example.com',
  });
  installSession(server.url);
  try {
    const v1Tasks = await import('../src/app/api/v1/tasks/route');
    const v1Task = await import('../src/app/api/v1/tasks/[id]/route');
    const v1Claim = await import('../src/app/api/v1/tasks/[id]/claim/route');
    const v1Runs = await import('../src/app/api/v1/agents/runs/route');
    const v1Finish = await import('../src/app/api/v1/agents/runs/[id]/finish/route');
    const v1Heartbeat = await import('../src/app/api/v1/agents/heartbeat/route');
    const v1Activities = await import('../src/app/api/v1/agent-activities/route');
    const v1Projects = await import('../src/app/api/v1/projects/route');
    const v1Export = await import('../src/app/api/v1/audit/export/route');
    const v1MyContext = await import('../src/app/api/v1/agents/me/context/route');
    const v1Webhooks = await import('../src/app/api/v1/webhook-endpoints/route');
    const rotateRoute = await import('../src/app/api/workspace/api-keys/[id]/rotate/route');
    const agentRoute = await import('../src/app/api/workspace/agents/[id]/route');
    const pauseRoute = await import('../src/app/api/workspace/agents-pause/route');
    const auditSettingsRoute = await import('../src/app/api/workspace/audit-settings/route');
    const auditLogRoute = await import('../src/app/api/workspace/audit-log/route');
    const accessRoute = await import('../src/app/api/workspace/access/route');
    const memberRoute = await import('../src/app/api/workspace/team-members/[id]/route');
    const apiKeysRoute = await import('../src/app/api/workspace/api-keys/route');
    const { insertAuditRows } = await import('../src/lib/api/audit');
    const { apiRequestContext } = await import('../src/lib/api/request-context');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const service = getServiceClient();

    const read = async (response: Response): Promise<Answer> => {
      const text = await response.text();
      let body: Loose = null;
      try { body = JSON.parse(text); } catch { body = null; }
      return { status: response.status, body, text, headers: response.headers };
    };
    const as = (login: typeof signedIn) => { signedIn = login; };
    const session = async (handler: (request: Request, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string> = {}, body?: unknown) =>
      read(await handler(new Request(`http://localhost${path}`, {
        method, headers: { 'content-type': 'application/json', origin: 'http://localhost' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const v1 = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown) =>
      read(await handler(new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never));
    const reason = (answer: Answer) => answer.body?.error?.details?.reason;
    const count = async (sql: string, params: unknown[] = []) => (await s.q<{ n: number }>(sql, params))[0].n;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
    const createTask = (apiKey: string, projectId: string, title: string) => v1(v1Tasks.POST, 'POST', '/api/v1/tasks', {}, apiKey, { project_id: projectId, title });
    const startRun = (apiKey: string, body: Loose = {}) => v1(v1Runs.POST, 'POST', '/api/v1/agents/runs', {}, apiKey, body);
    const finishRun = (apiKey: string, id: string) => v1(v1Finish.POST, 'POST', `/api/v1/agents/runs/${id}/finish`, { id }, apiKey, {});
    const claim = (apiKey: string, id: string) => v1(v1Claim.POST, 'POST', `/api/v1/tasks/${id}/claim`, { id }, apiKey, {});
    const release = (apiKey: string, id: string) => v1(v1Claim.DELETE, 'DELETE', `/api/v1/tasks/${id}/claim`, { id }, apiKey);
    const beat = (apiKey: string) => v1(v1Heartbeat.POST, 'POST', '/api/v1/agents/heartbeat', {}, apiKey, { working: false });
    const usage = (apiKey: string, id: string, cost: number, tokens = 1000) => v1(v1Activities.POST, 'POST', '/api/v1/agent-activities', {}, apiKey, {
      activity_type: 'usage.recorded', payload: { source_usage_id: id, model: 'claude-opus', input_tokens: tokens, output_tokens: 0, cost_usd: cost, recorded_at: new Date().toISOString() },
    });
    const turnPayload = (prefix: string) => {
      const finished = new Date();
      return { source_turn_id: `${prefix}-${randomUUID()}`, origin: 'scheduled', started_at: new Date(finished.getTime() - 1000).toISOString(), finished_at: finished.toISOString(), duration_ms: 1000, outcome: 'work' };
    };
    const patchAgent = (agentId: string, body: unknown) => session(agentRoute.PATCH, 'PATCH', `/api/workspace/agents/${agentId}`, { id: agentId }, body);

    // The live fleet, before anything: no limits, nothing paused.
    const fleetWorks = async (label: string) => {
      const reads = await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, s.keys.jeff.secret);
      const hb = await beat(s.keys.jeff.secret);
      const turn = await v1(v1Activities.POST, 'POST', '/api/v1/agent-activities', {}, s.keys.jeff.secret, { activity_type: 'turn.completed', payload: turnPayload(`fleet-${label}`) });
      const hook = await createTask(s.keys.adminApp.secret, s.site, `Paid invoice ${label}`);
      check(`live fleet: reads, heartbeat, telemetry and the admin app's webhook key work (${label})`, reads.status === 200 && hb.status === 200 && turn.status === 201 && hook.status === 201
        && reads.headers.get('X-RateLimit-Limit') === '120', { reads: reads.status, hb: hb.status, turn: [turn.status, turn.body], hook: [hook.status, hook.body] });
    };
    await fleetWorks('before');

    // ── Limits: defaults ──────────────────────────────────────────────
    const runs: string[] = [];
    for (let i = 0; i < 3; i++) runs.push((await startRun(s.keys.bolt.secret, { title: `Unlimited ${i}` })).body?.data?.id);
    check('limits: unset, an agent starts as many runs as it likes', runs.every(Boolean), runs);
    for (const id of runs) await finishRun(s.keys.bolt.secret, id);
    const t1 = await s.task(s.site, 'Rotate keys');
    const t2 = await s.task(s.site, 'Prune logs');
    const t3 = await s.task(s.site, 'Fix CI');
    check('limits: unset, an agent claims as many tasks as it likes', (await claim(s.keys.bolt.secret, t1)).status === 200 && (await claim(s.keys.bolt.secret, t2)).status === 200);
    await release(s.keys.bolt.secret, t1);
    await release(s.keys.bolt.secret, t2);

    // ── Limits: who sets them ─────────────────────────────────────────
    as(LOGINS.ana);
    const anaSets = await patchAgent(s.bolt, { limits: { max_concurrent_runs: 1 } });
    check('limits: an owner of the agent who is not a workspace Owner cannot set limits', anaSets.status === 403 && anaSets.body?.error?.details?.reason === 'owner_only', anaSets.body);
    as(LOGINS.owner);
    const set = await patchAgent(s.bolt, { limits: { max_concurrent_runs: 1, rate_per_minute: null } });
    check('limits: an Owner sets them', set.status === 200 && set.body?.data?.limits?.max_concurrent_runs === 1, set.body);
    const audited = await count("SELECT count(*)::int AS n FROM pm.api_audit_log WHERE entity_type = 'agent_limits' AND entity_id = $1 AND via = 'app' AND team_member_id = $2", [s.bolt, s.owner]);
    check('coverage: the limits change is audited as the Owner', audited === 1, audited);

    // ── max_concurrent_runs ───────────────────────────────────────────
    const first = await startRun(s.keys.bolt.secret, { title: 'One at a time', external_id: 'once-1' });
    const second = await startRun(s.keys.bolt2.secret, { title: 'Another' });
    check('limits: a second running run is refused, from any of its keys (409 limit_concurrent_runs)', first.status === 201 && second.status === 409 && reason(second) === 'limit_concurrent_runs'
      && second.body.error.details.max_concurrent_runs === 1, [first.status, second.body]);
    const retried = await startRun(s.keys.bolt.secret, { title: 'One at a time', external_id: 'once-1' });
    check('limits: retrying the start of the run it has is not a second run', retried.status === 200 && retried.body?.data?.id === first.body.data.id, [retried.status, retried.body]);
    await finishRun(s.keys.bolt.secret, first.body.data.id);
    const third = await startRun(s.keys.bolt.secret, { title: 'Next' });
    check('limits: once it finishes, the next starts', third.status === 201, third.body);
    await finishRun(s.keys.bolt.secret, third.body.data.id);
    const c1 = await claim(s.keys.bolt.secret, t1);
    const c2 = await claim(s.keys.bolt.secret, t2);
    const renew = await claim(s.keys.bolt.secret, t1);
    check('limits: a second claim is refused (409 limit_concurrent_claims), a renewal is not', c1.status === 200 && c2.status === 409 && reason(c2) === 'limit_concurrent_claims' && renew.status === 200, [c1.status, c2.body, renew.status]);
    await release(s.keys.bolt.secret, t1);
    check('limits: released, the next claim goes', (await claim(s.keys.bolt.secret, t3)).status === 200);
    await release(s.keys.bolt.secret, t3);

    // ── Budget soft stop ──────────────────────────────────────────────
    await patchAgent(s.bolt, { limits: { max_concurrent_runs: null, budget_usd: 1, budget_period: 'month' } });
    const under = await startRun(s.keys.bolt.secret, { title: 'Under budget' });
    check('budget: under it, runs start', under.status === 201, under.body);
    await finishRun(s.keys.bolt.secret, under.body.data.id);
    const before = await count("SELECT count(*)::int AS n FROM pm.team_member_notifications WHERE entity_id = $1 AND title LIKE '%spent its budget%'", [s.bolt]);
    const over = await usage(s.keys.bolt.secret, 'u-over-1', 1.5);
    await settle();
    const recorded = await count("SELECT count(*)::int AS n FROM pm.agent_activities WHERE agent_id = $1 AND metadata->>'source_usage_id' = 'u-over-1'", [s.bolt]);
    const told = (await s.q<Loose>("SELECT user_id FROM pm.team_member_notifications WHERE entity_id = $1 AND title LIKE '%spent its budget%'", [s.bolt])).map((r: Loose) => r.user_id);
    check('budget: usage over it is still recorded (telemetry never dropped)', over.status === 201 && recorded === 1, over.body);
    check('budget: the agent\'s owners are told', before === 0 && told.length === 1 && told[0] === s.ana, told);
    const refused = await startRun(s.keys.bolt.secret, { title: 'Over budget' });
    check('budget: a new run is refused with 402 budget_exceeded', refused.status === 402 && reason(refused) === 'budget_exceeded' && refused.body.error.details.spent_usd >= 1.5, refused.body);
    await usage(s.keys.bolt.secret, 'u-over-2', 0.5);
    await settle();
    check('budget: told once a period, not on every report', await count("SELECT count(*)::int AS n FROM pm.team_member_notifications WHERE entity_id = $1 AND title LIKE '%spent its budget%'", [s.bolt]) === 1);
    const telemetryOver = await beat(s.keys.bolt.secret);
    check('budget: heartbeats and reads go on over budget', telemetryOver.status === 200 && (await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, s.keys.bolt.secret)).status === 200);
    const pack = await v1(v1MyContext.GET, 'GET', '/api/v1/agents/me/context?format=json', {}, s.keys.bolt.secret);
    const packLimits = pack.body?.data?.pack?.limits;
    check('context pack: the agent knows its limits and spend', packLimits?.budget_usd === 1 && packLimits.usage?.spent_usd >= 2 && packLimits.says.some((line: string) => /402 budget_exceeded/.test(line)), packLimits ?? pack.text.slice(0, 400));
    const packText = await v1(v1MyContext.GET, 'GET', '/api/v1/agents/me/context', {}, s.keys.bolt.secret);
    check('context pack: its AGENTS.md has a Your limits section', /## Your limits/.test(packText.text) && /Budget: \$1\.00/.test(packText.text), packText.text.slice(0, 300));
    await patchAgent(s.bolt, { limits: { budget_usd: null } });
    check('budget: an Owner clearing it lets runs start again (and an empty limits row goes)', (await startRun(s.keys.bolt.secret, { title: 'Cleared' })).status === 201
      && await count('SELECT count(*)::int AS n FROM pm.agent_limits WHERE agent_id = $1', [s.bolt]) === 0);
    await s.q("UPDATE pm.agent_runs SET status = 'succeeded', finished_at = now() WHERE agent_id = $1 AND status = 'running'", [s.bolt]);

    // ── Limits fail closed on a real error ────────────────────────────
    const fnStart = MIGRATION_SQL.indexOf('CREATE OR REPLACE FUNCTION pm.agent_limit_state');
    const stateFn = MIGRATION_SQL.slice(fnStart, MIGRATION_SQL.indexOf('$$;', fnStart) + 3);
    await s.q(`CREATE OR REPLACE FUNCTION pm.agent_limit_state(p_agent_id uuid, p_with_usage boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql AS $fn$
      BEGIN RAISE EXCEPTION 'agent_limits does not exist in this schema cache (a real failure)'; END $fn$`);
    const brokenRun = await startRun(s.keys.bolt.secret, { title: 'While limits cannot be read' });
    const brokenClaim = await claim(s.keys.bolt.secret, t3);
    await s.q(stateFn);
    check('limits: a real error reading them fails the run start and the claim (never reads as no limits)', brokenRun.status === 500 && brokenClaim.status === 500, [brokenRun.status, brokenClaim.status]);
    check('limits: once they read again, runs start', (await startRun(s.keys.bolt.secret, { title: 'Readable again' })).status === 201);
    await s.q("UPDATE pm.agent_runs SET status = 'succeeded', finished_at = now() WHERE agent_id = $1 AND status = 'running'", [s.bolt]);

    // ── Rate per agent ────────────────────────────────────────────────
    await patchAgent(s.bolt, { limits: { rate_per_minute: 3 } });
    const answers: Answer[] = [];
    for (const k of [s.keys.bolt, s.keys.bolt2, s.keys.bolt, s.keys.bolt2]) answers.push(await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, k.secret));
    check('rate limit: an agent\'s rate_per_minute counts all its keys together', answers.slice(0, 3).every((a) => a.status === 200) && answers[3].status === 429
      && answers[0].headers.get('X-RateLimit-Limit') === '3' && answers[2].headers.get('X-RateLimit-Remaining') === '0', answers.map((a) => [a.status, a.headers.get('X-RateLimit-Limit')]));
    check('rate limit: other agents keep 120 per key', (await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, s.keys.jeff.secret)).headers.get('X-RateLimit-Limit') === '120');
    await patchAgent(s.bolt, { limits: { rate_per_minute: null } });
    await s.q('DELETE FROM pm.agent_rate_limit_windows');

    // ── One agent paused ──────────────────────────────────────────────
    as(LOGINS.ana);
    const pausedByOwner = await patchAgent(s.bolt, { paused: true });
    check('pause: an owner of the agent pauses it', pausedByOwner.status === 200 && !!pausedByOwner.body?.data?.agent?.paused_at, pausedByOwner.body);
    as(LOGINS.owner);
    const write = await createTask(s.keys.bolt.secret, s.site, 'While paused');
    check('pause: its writes are refused with 423 agent_paused', write.status === 423 && reason(write) === 'agent_paused', write.body);
    const paused = {
      read: await v1(v1Tasks.GET, 'GET', '/api/v1/tasks', {}, s.keys.bolt.secret),
      beat: await beat(s.keys.bolt.secret),
      telemetry: await usage(s.keys.bolt.secret, 'u-paused', 0.01),
      start: await startRun(s.keys.bolt.secret, { title: 'No' }),
    };
    check('pause: reads, heartbeat and telemetry still work; a new run does not', paused.read.status === 200 && paused.beat.status === 200 && paused.telemetry.status === 201 && paused.start.status === 423,
      Object.fromEntries(Object.entries(paused).map(([k, a]) => [k, a.status])));
    check('pause: other agents and people are unaffected', (await createTask(s.keys.jeff.secret, s.site, 'Jeff works')).status === 201 && (await createTask(s.keys.anaOwn.secret, s.site, 'Ana works')).status === 201);
    check('pause: the roster sees it paused', !!(await s.q<Loose>('SELECT agent_paused_at FROM pm.team_members WHERE id = $1', [s.bolt]))[0].agent_paused_at);
    await patchAgent(s.bolt, { paused: false });
    check('pause: resumed, it writes again', (await createTask(s.keys.bolt.secret, s.site, 'Back to work')).status === 201);

    // ── The kill switch ───────────────────────────────────────────────
    as(LOGINS.ana);
    const anaPause = await session(pauseRoute.PUT, 'PUT', '/api/workspace/agents-pause', {}, { paused: true });
    const anaReads = await session(pauseRoute.GET, 'GET', '/api/workspace/agents-pause');
    check('kill switch: only an Owner flips it; members read it', anaPause.status === 403 && anaReads.status === 200 && anaReads.body.data.paused_at === null, [anaPause.status, anaReads.body]);
    check('kill switch: an admin (settings.manage) cannot flip it in the database either', /Only an Owner/.test(await (async () => {
      await s.q("UPDATE pm.team_members SET role = 'admin' WHERE id = $1", [s.ana]);
      // Signed in as them with row security set aside, so the column guard itself is what is tested.
      await actAs(db, LOGINS.ana.id);
      await db.exec('RESET ROLE');
      const e = await db.query('UPDATE pm.business_settings SET agents_paused_at = now()').then(() => '', (error: Error) => error.message);
      await actAs(db, null);
      await db.exec('RESET ROLE');
      await s.q("UPDATE pm.team_members SET role = 'member' WHERE id = $1", [s.ana]);
      return e;
    })()));
    as(LOGINS.owner);
    const on = await session(pauseRoute.PUT, 'PUT', '/api/workspace/agents-pause', {}, { paused: true });
    check('kill switch: an Owner pauses every agent', on.status === 200 && !!on.body.data.paused_at && on.body.data.paused_by?.id === s.owner, on.body);
    const kill = {
      jeffWrite: await createTask(s.keys.jeff.secret, s.site, 'Killed'),
      jeffRead: await v1(v1Projects.GET, 'GET', '/api/v1/projects', {}, s.keys.jeff.secret),
      jeffBeat: await beat(s.keys.jeff.secret),
      jeffTurn: await v1(v1Activities.POST, 'POST', '/api/v1/agent-activities', {}, s.keys.jeff.secret, { activity_type: 'turn.completed', payload: turnPayload('kill') }),
      boltClaim: await claim(s.keys.bolt.secret, t3),
      anaKey: await createTask(s.keys.anaOwn.secret, s.site, 'People go on'),
      adminApp: await createTask(s.keys.adminApp.secret, s.site, 'Webhook goes on'),
    };
    check('kill switch: agents\' writes are 423 agents_paused', kill.jeffWrite.status === 423 && reason(kill.jeffWrite) === 'agents_paused' && kill.boltClaim.status === 423, [kill.jeffWrite.body, kill.boltClaim.status]);
    check('kill switch: agents still read, beat and report telemetry', kill.jeffRead.status === 200 && kill.jeffBeat.status === 200 && kill.jeffTurn.status === 201);
    check('kill switch: people\'s keys (and the admin app\'s) are unaffected', kill.anaKey.status === 201 && kill.adminApp.status === 201);
    const sessionWhilePaused = await patchAgent(s.jeff, { title: 'Builder' });
    check('kill switch: people\'s sessions are unaffected', sessionWhilePaused.status === 200, sessionWhilePaused.body);
    const pausedRow = (await s.q<Loose>("SELECT * FROM pm.api_audit_log WHERE entity_type = 'business_settings' AND via = 'app' AND after_snapshot ? 'agents_paused_at' ORDER BY seq DESC LIMIT 1"))[0];
    check('coverage: flipping the kill switch is audited as the Owner', pausedRow?.team_member_id === s.owner && !!pausedRow.after_snapshot.agents_paused_at, pausedRow);
    const off = await session(pauseRoute.PUT, 'PUT', '/api/workspace/agents-pause', {}, { paused: false });
    check('kill switch: resumed, agents write again', off.status === 200 && off.body.data.paused_at === null && (await createTask(s.keys.jeff.secret, s.site, 'Alive')).status === 201);

    // ── A paused project assignment ───────────────────────────────────
    await s.q("INSERT INTO pm.project_agents (project_id, agent_id, status) VALUES ($1, $2, 'paused'), ($3, $2, 'active')", [s.site, s.jeff, s.app]);
    const onSite = await s.task(s.site, 'On a paused project', [s.jeff]);
    const pausedCreate = await createTask(s.keys.jeff.secret, s.site, 'Paused here');
    const pausedPatch = await v1(v1Task.PATCH, 'PATCH', `/api/v1/tasks/${onSite}`, { id: onSite }, s.keys.jeff.secret, { title: 'Renamed' });
    const pausedRun = await startRun(s.keys.jeff.secret, { project_id: s.site, title: 'Here' });
    const elsewhere = await createTask(s.keys.jeff.secret, s.app, 'Active here');
    const readHere = await v1(v1Task.GET, 'GET', `/api/v1/tasks/${onSite}`, { id: onSite }, s.keys.jeff.secret);
    check('project pause: no writes to the paused project (423 project_paused)', [pausedCreate, pausedPatch, pausedRun].every((a) => a.status === 423 && reason(a) === 'project_paused'),
      [pausedCreate.body, pausedPatch.body, pausedRun.body].map((b) => b?.error?.details?.reason ?? b));
    check('project pause: its other projects and reads are open', elsewhere.status === 201 && readHere.status === 200);
    check('project pause: people on that project are unaffected', (await createTask(s.keys.anaOwn.secret, s.site, 'Ana here')).status === 201);
    await s.q('DELETE FROM pm.project_agents WHERE agent_id = $1', [s.jeff]);

    // ── Session coverage ──────────────────────────────────────────────
    const accessChange = await session(accessRoute.PUT, 'PUT', '/api/workspace/access', {}, { target: 'role', role: 'member', permission_key: 'goals.manage', access_channel: 'app', enabled: true });
    // An agent only uses the API: an app-channel grant for it is refused, the API one works, removing an old app one is allowed.
    const agentApp = await session(accessRoute.PUT, 'PUT', '/api/workspace/access', {}, { target: 'member', member_id: s.jeff, permission_key: 'agents.act_for', access_channel: 'app', effect: 'allow' });
    const agentApi = await session(accessRoute.PUT, 'PUT', '/api/workspace/access', {}, { target: 'member', member_id: s.jeff, permission_key: 'agents.act_for', access_channel: 'api', effect: 'allow' });
    const agentAppClear = await session(accessRoute.PUT, 'PUT', '/api/workspace/access', {}, { target: 'member', member_id: s.jeff, permission_key: 'agents.act_for', access_channel: 'app', effect: null });
    const agentRoleApp = await session(accessRoute.PUT, 'PUT', '/api/workspace/access', {}, { target: 'role', role: 'agent', permission_key: 'goals.manage', access_channel: 'app', enabled: true });
    check('access: an agent’s grant is refused on the app channel, works on the API, an old app one can be removed', agentApp.status === 422 && agentApp.body?.reason === 'agent_api_only'
      && agentApi.status === 200 && agentAppClear.status === 200 && agentRoleApp.status === 422, [agentApp.body, agentApi.body, agentAppClear.body, agentRoleApp.body]);
    const memberChange = await session(memberRoute.PATCH, 'PATCH', `/api/workspace/team-members/${s.ana}`, { id: s.ana }, { role: 'admin' });
    const keyMade = await session(apiKeysRoute.POST, 'POST', '/api/workspace/api-keys', {}, { name: 'Laptop', scopes: ['tasks.read'] });
    const rows = await s.q<Loose>("SELECT entity_type, method, team_member_id, after_snapshot FROM pm.api_audit_log WHERE via = 'app' AND team_member_id = $1 AND endpoint LIKE '/app/%' ORDER BY seq", [s.owner]);
    const has = (type: string, method: string, key?: string) => rows.filter((r: Loose) => r.entity_type === type && r.method === method && (!key || r.after_snapshot?.[key] !== undefined)).pop();
    check('coverage: an access change is audited (via app, as the Owner)', accessChange.status === 200 && !!has('role_permission', 'POST'), [accessChange.status, rows.map((r: Loose) => r.entity_type)]);
    check('coverage: a member\'s role change is audited with before and after', memberChange.status === 200 && has('team_member', 'PATCH', 'role')?.after_snapshot?.role === 'admin',
      await s.q('SELECT method, team_member_id, after_snapshot, endpoint FROM pm.api_audit_log WHERE entity_type = $1 ORDER BY seq DESC LIMIT 3', ['team_member']));
    const keyRow = has('api_key', 'POST');
    check('coverage: a new key is audited, its hash never stored', keyMade.status < 300 && keyRow?.after_snapshot?.key_hash === REDACTED && keyRow.after_snapshot.name === 'Laptop', [keyMade.status, keyRow?.after_snapshot]);

    // ── Manage access (access.manage): enforced, never self-escalating ──────
    const anaTries = async () => {
      as(LOGINS.ana);
      const answers = {
        read: (await session(accessRoute.GET, 'GET', '/api/workspace/access')).status,
        other: (await session(accessRoute.PUT, 'PUT', '/api/workspace/access', {}, { target: 'member', member_id: s.jeff, permission_key: 'goals.read', access_channel: 'api', effect: 'allow' })).status,
        self: (await session(accessRoute.PUT, 'PUT', '/api/workspace/access', {}, { target: 'member', member_id: s.ana, permission_key: 'settings.manage', access_channel: 'app', effect: 'allow' })).status,
        ownRole: (await session(accessRoute.PUT, 'PUT', '/api/workspace/access', {}, { target: 'role', role: 'admin', permission_key: 'settings.manage', access_channel: 'app', enabled: true })).status,
        spread: (await session(accessRoute.PUT, 'PUT', '/api/workspace/access', {}, { target: 'member', member_id: s.jeff, permission_key: 'access.manage', access_channel: 'app', effect: 'allow' })).status,
      };
      as(LOGINS.owner);
      return answers;
    };
    const without = await anaTries();
    check('access.manage: an admin without it cannot read or change access (403)', without.read === 403 && without.other === 403, without);
    const granted = await session(accessRoute.PUT, 'PUT', '/api/workspace/access', {}, { target: 'member', member_id: s.ana, permission_key: 'access.manage', access_channel: 'app', effect: 'allow' });
    const withIt = await anaTries();
    check('access.manage: an Owner gives it; then she reads and changes someone else\'s access', granted.status === 200 && withIt.read === 200 && withIt.other === 200, [granted.status, withIt]);
    check('access.manage: never her own access, her own role\'s defaults, or Manage access itself (403)', withIt.self === 403 && withIt.ownRole === 403 && withIt.spread === 403, withIt);
    await session(accessRoute.PUT, 'PUT', '/api/workspace/access', {}, { target: 'member', member_id: s.ana, permission_key: 'access.manage', access_channel: 'app', effect: null });
    await session(accessRoute.PUT, 'PUT', '/api/workspace/access', {}, { target: 'member', member_id: s.jeff, permission_key: 'goals.read', access_channel: 'api', effect: null });
    await s.q("UPDATE pm.team_members SET role = 'member' WHERE id = $1", [s.ana]);
    await actAs(db, LOGINS.owner.id);
    await db.query("INSERT INTO pm.webhook_endpoints (name, url, secret, events) VALUES ('CRM', 'https://hooks.slack.com/services/T000/B000/tokentoken', 'whsec_live', '{task.created}')");
    await actAs(db, null);
    await db.exec('RESET ROLE');
    const hookRow = (await s.q<Loose>("SELECT after_snapshot FROM pm.api_audit_log WHERE entity_type = 'webhook_endpoint' AND via = 'app' ORDER BY seq DESC LIMIT 1"))[0];
    check('coverage: a browser-direct webhook change is audited, its secret redacted and its url only scheme://host', hookRow?.after_snapshot?.secret === REDACTED
      && hookRow.after_snapshot.url === 'https://hooks.slack.com' && !JSON.stringify(hookRow).includes('tokentoken'), hookRow);
    await actAs(db, LOGINS.owner.id);
    await db.query("INSERT INTO pm.webhook_endpoints (name, url, secret, events) VALUES ('Basic', 'https://bob:p4ssw0rd@hooks.example.com/in', 'whsec_live2', '{task.created}')");
    await actAs(db, null);
    await db.exec('RESET ROLE');
    const userinfoRow = (await s.q<Loose>("SELECT after_snapshot FROM pm.api_audit_log WHERE entity_type = 'webhook_endpoint' AND via = 'app' ORDER BY seq DESC LIMIT 1"))[0];
    check('coverage: a url with user:password@ keeps only scheme://host, never the password', userinfoRow?.after_snapshot?.url === 'https://hooks.example.com'
      && !JSON.stringify(userinfoRow).includes('p4ssw0rd'), userinfoRow);
    const apiHook = await v1(v1Webhooks.POST, 'POST', '/api/v1/webhook-endpoints', {}, s.keys.owner.secret, { name: 'Discord', url: 'https://discord.com/api/webhooks/123/sekrit-token', events: ['task.created'] });
    await settle();
    const apiHookRow = (await s.q<Loose>("SELECT request_body, after_snapshot FROM pm.api_audit_log WHERE endpoint = '/api/v1/webhook-endpoints' ORDER BY seq DESC LIMIT 1"))[0];
    check('redaction: an API webhook write stores only scheme://host of its url', apiHook.status === 201 && apiHookRow?.request_body?.url === 'https://discord.com'
      && apiHookRow.after_snapshot?.url === 'https://discord.com' && !JSON.stringify(apiHookRow).includes('sekrit-token'), [apiHook.status, apiHook.body, apiHookRow]);
    const rotated = await session(rotateRoute.POST, 'POST', `/api/workspace/api-keys/${s.keys.ownerNoExport.id}/rotate`, { id: s.keys.ownerNoExport.id }, { overlap_hours: 1 });
    const rotationRow = (await s.q<Loose>('SELECT after_snapshot FROM pm.api_audit_log WHERE endpoint = $1', [`/api/workspace/api-keys/${s.keys.ownerNoExport.id}/rotate`]))[0];
    check('redaction: a rotation row keeps the new key\'s prefix, name and scopes, never its secret', rotated.status === 201 && typeof rotationRow?.after_snapshot?.new_key?.key_prefix === 'string'
      && rotationRow.after_snapshot.new_key.key_prefix.length > 0 && rotationRow.after_snapshot.new_key.name === 'Seed key' && Array.isArray(rotationRow.after_snapshot.new_key.scopes)
      && !JSON.stringify(rotationRow).includes(rotated.body?.data?.secret ?? 'no-secret'), [rotated.status, rotationRow]);
    // A person's capped key keeps a lifetime when rotated: never no expiry, never past the cap.
    await s.q('UPDATE pm.business_settings SET personal_key_lifetime_days = 30');
    const cappedKey = (await s.q<Loose>(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, created_by, scopes, permissions, expires_at)
      VALUES ('Ana for a day', 'pk_live', 'hash-capped-ana', $1, $1, '{tasks.read}', 'scoped', now() + interval '1 day') RETURNING id`, [s.ana]))[0].id as string;
    as(LOGINS.ana);
    const anaRotated = await session(rotateRoute.POST, 'POST', `/api/workspace/api-keys/${cappedKey}/rotate`, { id: cappedKey }, { overlap_hours: 1 });
    as(LOGINS.owner);
    const anaNewEnds = Date.parse(anaRotated.body?.data?.key?.expires_at ?? '');
    check('rotation: a person\'s 1-day key rotated under a 30-day cap lasts a day again, never no expiry', anaRotated.status === 201
      && Math.abs(anaNewEnds - (Date.now() + 86_400_000)) < 600_000, [anaRotated.status, anaRotated.body?.data?.key?.expires_at ?? anaRotated.body]);
    await s.q('UPDATE pm.business_settings SET personal_key_lifetime_days = NULL');
    check('coverage: ordinary task edits are not audited as app rows (the activity log covers them)', await count("SELECT count(*)::int AS n FROM pm.api_audit_log WHERE endpoint LIKE '/app/tasks%'") === 0);

    // ── principal_id and redaction at write time ──────────────────────
    await apiRequestContext.run({ via: 'rest', keyId: s.keys.jeff.id, principalId: s.ana }, async () => {
      await insertAuditRows(service, { method: 'POST', endpoint: '/probe/principal', status_code: 200, request_body: { nested: { client_secret: 'abc' } } });
    });
    const probe = (await s.q<Loose>("SELECT principal_id, request_body FROM pm.api_audit_log WHERE endpoint = '/probe/principal'"))[0];
    check('principal_id: stamped on every server audit row written while acting for someone', probe?.principal_id === s.ana && probe.request_body.nested.client_secret === REDACTED, probe);
    const custom = await v1(v1Activities.POST, 'POST', '/api/v1/agent-activities', {}, s.keys.jeff.secret, {
      activity_type: 'custom.acme.deploy', payload: { title: 'Deployed', config: { signing_secret: 'whsec_123', items: [{ password: 'p' }] }, ssn: '123-45-6789' },
    });
    await settle();
    const customRow = (await s.q<Loose>("SELECT request_body FROM pm.api_audit_log WHERE endpoint = '/api/v1/agent-activities' AND request_body->>'activity_type' = 'custom.acme.deploy'"))[0];
    check('redaction: an API write\'s nested secrets are never stored', custom.status === 201 && customRow?.request_body?.payload?.config?.signing_secret === REDACTED
      && customRow.request_body.payload.config.items[0].password === REDACTED && customRow.request_body.payload.title === 'Deployed', customRow);

    // ── Audit settings (Owner) ────────────────────────────────────────
    as(LOGINS.ana);
    check('audit settings: Owner only', (await session(auditSettingsRoute.GET, 'GET', '/api/workspace/audit-settings')).status === 403
      && (await session(auditLogRoute.GET, 'GET', '/api/workspace/audit-log')).status === 403);
    as(LOGINS.owner);
    const tooShort = await session(auditSettingsRoute.PUT, 'PUT', '/api/workspace/audit-settings', {}, { retention_days: 7 });
    const saved = await session(auditSettingsRoute.PUT, 'PUT', '/api/workspace/audit-settings', {}, { retention_days: 365, redact_keys: ['ssn'] });
    check('audit settings: 30 days at least; an Owner saves retention and extra fields', tooShort.status === 422 && saved.status === 200 && saved.body.data.retention_days === 365
      && saved.body.data.redact_keys.join() === 'ssn', [tooShort.status, saved.body]);
    await v1(v1Activities.POST, 'POST', '/api/v1/agent-activities', {}, s.keys.jeff.secret, { activity_type: 'custom.acme.hr', payload: { title: 'HR sync', ssn: '123-45-6789' } });
    await settle();
    const hrRow = (await s.q<Loose>("SELECT request_body FROM pm.api_audit_log WHERE request_body->>'activity_type' = 'custom.acme.hr'"))[0];
    check('redaction: the workspace\'s own list applies from then on', hrRow?.request_body?.payload?.ssn === REDACTED, hrRow);

    // ── The Settings audit log ────────────────────────────────────────
    const page = await session(auditLogRoute.GET, 'GET', `/api/workspace/audit-log?member=${s.owner}&action=api_key`);
    check('audit log: filters by who and action, names who', page.status === 200 && page.body.data.entries.length >= 1
      && page.body.data.entries.every((e: Loose) => e.team_member_id === s.owner && /api_key/.test(`${e.endpoint} ${e.entity_type}`)) && page.body.data.names[s.owner] === 'Olivia', page.body?.data?.entries?.length);
    // Plain labels: the page names every person, group and project a row mentions, so no id shows.
    const design = (await s.q<Loose>("INSERT INTO pm.groups (name, slug) VALUES ('Design', 'design') RETURNING id"))[0].id as string;
    const boltName = (await s.q<Loose>('SELECT name FROM pm.team_members WHERE id = $1', [s.bolt]))[0].name as string;
    await s.q(`INSERT INTO pm.api_audit_log (method, endpoint, entity_type, entity_id, team_member_id, after_snapshot, status_code, via) VALUES
      ('DELETE', $1, 'group', $2, $3, $4::jsonb, 200, 'app'),
      ('PUT', $5, 'project_agent', $6, $3, $7::jsonb, 200, 'app')`, [
      `/api/v1/groups/${design}/members/${s.ana}`, design, s.owner, JSON.stringify({ removed: s.ana }),
      `/api/v1/projects/${s.site}/agents/${s.bolt}`, s.bolt, JSON.stringify({ agent_id: s.bolt, project_id: s.site }),
    ]);
    const labelled = await session(auditLogRoute.GET, 'GET', '/api/workspace/audit-log?action=members');
    const removal = (labelled.body?.data?.entries ?? []).find((e: Loose) => e.entity_id === design);
    const removalLabel = removal ? auditActionLabel(removal, labelled.body.data.names) : null;
    const removalDetails = removal ? auditDetails(removal, labelled.body.data.names) : [];
    check('audit log: a member taken out of a group reads "Removed Ana Lopez from Design", its details name her',
      removalLabel === 'Removed Ana Lopez from Design' && removalDetails.some((d) => d.label === 'Removed' && d.value === 'Ana Lopez'), [removalLabel, removalDetails]);
    const access = await session(auditLogRoute.GET, 'GET', '/api/workspace/audit-log?action=project_agent');
    const grant = (access.body?.data?.entries ?? []).find((e: Loose) => e.entity_id === s.bolt);
    const grantLabel = grant ? auditActionLabel(grant, access.body.data.names) : null;
    check('audit log: giving an agent a project reads "Gave <agent> access to Site"', grantLabel === `Gave ${boltName} access to Site`, grantLabel);
    const actingFor = await session(auditLogRoute.GET, 'GET', `/api/workspace/audit-log?acting_for=${s.ana}`);
    check('audit log: filters by who it was done for', actingFor.body?.data?.entries?.length === 1 && actingFor.body.data.entries[0].endpoint === '/probe/principal');
    const total = await count('SELECT count(*)::int AS n FROM pm.api_audit_log');
    const page2 = await session(auditLogRoute.GET, 'GET', '/api/workspace/audit-log?page=1');
    check('audit log: pages of 50, newest first', page2.status === 200 && page2.body.data.total === total && page2.body.data.entries.length === Math.min(50, Math.max(0, total - 50)), [total, page2.body?.data?.entries?.length]);
    const future = await session(auditLogRoute.GET, 'GET', '/api/workspace/audit-log?from=2099-01-01');
    check('audit log: filters by date', future.body?.data?.total === 0);

    // ── Export ────────────────────────────────────────────────────────
    const noScope = await v1(v1Export.GET, 'GET', '/api/v1/audit/export', {}, s.keys.ownerNoExport.secret);
    const notOwner = await v1(v1Export.GET, 'GET', '/api/v1/audit/export', {}, s.keys.anaOwn.secret);
    const agentTry = await v1(v1Export.GET, 'GET', '/api/v1/audit/export', {}, s.keys.jeff.secret);
    check('export: needs audit.export on the key and the member (Owners hold it)', noScope.status === 403 && notOwner.status === 403 && agentTry.status === 403, [noScope.status, notOwner.status, agentTry.status]);
    const p1 = await v1(v1Export.GET, 'GET', '/api/v1/audit/export?limit=5', {}, s.keys.owner.secret);
    const p2 = await v1(v1Export.GET, 'GET', `/api/v1/audit/export?limit=5&cursor=${encodeURIComponent(p1.body?.meta?.next_cursor ?? '')}`, {}, s.keys.owner.secret);
    const ids1 = (p1.body?.data ?? []).map((r: Loose) => r.id);
    const ids2 = (p2.body?.data ?? []).map((r: Loose) => r.id);
    check('export: pages in order from a cursor, never repeating', p1.status === 200 && ids1.length === 5 && p1.body.meta.has_more === true && ids2.length === 5
      && !ids2.some((id: string) => ids1.includes(id)) && Number(p2.body.data[0].seq) > Number(p1.body.data[4].seq), [p1.status, p1.body?.meta, ids2.length]);
    const all: string[] = [];
    let cursor = '';
    for (let i = 0; i < 100; i++) {
      const pageN = await v1(v1Export.GET, 'GET', `/api/v1/audit/export?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {}, s.keys.owner.secret);
      all.push(...pageN.body.data.map((r: Loose) => r.id));
      cursor = pageN.body.meta.next_cursor;
      if (!pageN.body.meta.has_more) break;
    }
    const exportable = await count('SELECT count(*)::int AS n FROM pm.api_audit_log');
    check('export: walking every page sees every row once', new Set(all).size === all.length && all.length >= exportable - 2, { all: all.length, exportable });
    const nd = await v1(v1Export.GET, 'GET', `/api/v1/audit/export?format=ndjson&limit=3&since=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}`, {}, s.keys.owner.secret);
    const lines = nd.text.trim().split('\n').map((line) => JSON.parse(line));
    check('export: NDJSON one row per line, cursor in headers, since narrows', nd.status === 200 && /ndjson/.test(nd.headers.get('content-type') ?? '') && lines.length === 3
      && !!nd.headers.get('X-Next-Cursor') && nd.headers.get('X-Has-More') === 'true' && lines.every((row: Loose) => Date.parse(row.timestamp) >= Date.now() - 3600_000 - 5000), [nd.status, nd.text.slice(0, 200)]);
    const badCursor = await v1(v1Export.GET, 'GET', '/api/v1/audit/export?cursor=nope', {}, s.keys.owner.secret);
    check('export: a cursor it did not give out is 400', badCursor.status === 400 && reason(badCursor) === 'invalid_cursor');

    await fleetWorks('after');
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`limits and audit: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.error(`  x ${f}`);
    process.exit(1);
  }
  console.log(`limits and audit: ${passed} checks passed`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
