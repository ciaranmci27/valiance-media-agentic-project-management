/**
 * /api/v1/reminders end to end: the real routes through withApi with real
 * keys (resolveApiKey, scopes, role permissions), the real supabase-js client
 * against PGlite behind the PostgREST stand-in, and the real reminders
 * migration. Checks who sees, writes, ticks off and deletes what.
 *
 *   npm run -s test:reminders-api
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { PGlite } from '@electric-sql/pglite';
import { startFakePostgrest } from './fake-postgrest';

const MIGRATION = join(__dirname, '..', 'supabase', 'migrations', '20261021215512_create_reminders.sql');
const PERMISSION_MIGRATION = join(__dirname, '..', 'supabase', 'migrations', '20261021223505_reminders_api_permission.sql');

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 700)}`);
}

const OWNER = randomUUID();
const AGENT = randomUUID();
const MATE = randomUUID();
const OUTSIDER = randomUUID();
const P1 = randomUUID();
const P2 = randomUUID();
const T1 = randomUUID();
const T2 = randomUUID();
const hash = (key: string) => createHash('sha256').update(key).digest('hex');

async function seed(db: PGlite) {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO service_role;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    CREATE TABLE public.team_members (id uuid PRIMARY KEY, name text NOT NULL, role text NOT NULL, status text NOT NULL DEFAULT 'active',
      agent_profile text NOT NULL DEFAULT 'generic', auth_user_id uuid);
    CREATE TABLE public.api_keys (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key_hash text NOT NULL, permissions text NOT NULL DEFAULT 'scoped',
      team_member_id uuid, scopes text[] NOT NULL DEFAULT '{}', expires_at timestamptz, disabled_at timestamptz, revoked_at timestamptz,
      last_used_at timestamptz);
    CREATE TABLE public.business_settings (id serial PRIMARY KEY, api_enabled boolean NOT NULL DEFAULT true);
    CREATE TABLE public.role_permissions (role text, permission_key text, access_channel text, PRIMARY KEY (role, permission_key, access_channel));
    CREATE TABLE public.team_member_permissions (member_id uuid, permission_key text, access_channel text, effect text);
    CREATE TABLE public.project_members (member_id uuid, project_id uuid);
    CREATE TABLE public.api_audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), method text, endpoint text, entity_type text,
      entity_id uuid, api_key_id uuid, team_member_id uuid, request_body jsonb, before_snapshot jsonb, after_snapshot jsonb,
      status_code integer, error text, via text NOT NULL DEFAULT 'rest');
    CREATE FUNCTION public.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer) RETURNS jsonb
      LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1, 'reset_at', now() + make_interval(secs => p_window_seconds)) $$;
    CREATE TABLE public.projects (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.tasks (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES public.projects(id), title text NOT NULL,
      status text NOT NULL DEFAULT 'todo');
    CREATE TABLE public.team_member_notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, title text NOT NULL,
      message text, link text, is_read boolean NOT NULL DEFAULT false, entity_type text, entity_id text, created_at timestamptz NOT NULL DEFAULT now());
    -- What the reminders migration leans on (RLS helpers the service role bypasses anyway).
    CREATE FUNCTION public.current_team_member_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    CREATE FUNCTION public.can_access_project(p uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.can_access_task(t uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.has_permission(k text, c text DEFAULT 'app') RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE FUNCTION public.workspace_timezone() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'America/Phoenix' $$;
    CREATE FUNCTION public.upsert_notification(uuid, text, text, text, text, text) RETURNS void LANGUAGE sql AS $$ SELECT $$;
    INSERT INTO public.business_settings DEFAULT VALUES;
  `);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  await db.exec(readFileSync(PERMISSION_MIGRATION, 'utf8'));
  await db.exec(readFileSync(PERMISSION_MIGRATION, 'utf8'));
  await db.exec('GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;');
  await db.query(
    "INSERT INTO team_members(id,name,role) VALUES ($1,'Ciaran','owner'),($2,'Ashley','agent'),($3,'Mate','member'),($4,'Outsider','member')",
    [OWNER, AGENT, MATE, OUTSIDER],
  );
  for (const role of ['agent', 'member'])
    await db.query("INSERT INTO role_permissions VALUES ($1,'projects.read','api')", [role]);
  await db.query("INSERT INTO projects VALUES ($1,'Plan4TheFuture'),($2,'Happy Innovations')", [P1, P2]);
  await db.query("INSERT INTO tasks VALUES ($1,$2,'Update local delivery wording'),($3,$4,'Launch subscriptions')", [T1, P1, T2, P2]);
  await db.query('INSERT INTO project_members VALUES ($1,$3),($2,$3)', [AGENT, MATE, P1]);
}

type Payload = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- checked field by field

async function main() {
  const db = new PGlite();
  await seed(db);
  const keys = {
    owner: `pk_live_${randomUUID()}`, agent: `pk_live_${randomUUID()}`, mate: `pk_live_${randomUUID()}`,
    outsider: `pk_live_${randomUUID()}`, noScope: `pk_live_${randomUUID()}`,
  };
  const scopes = ['reminders.manage_own', 'projects.read'];
  await db.query('INSERT INTO api_keys(key_hash,team_member_id,scopes) VALUES ($1,$2,$3)', [hash(keys.owner), OWNER, [...scopes, 'tasks.manage_all']]);
  await db.query('INSERT INTO api_keys(key_hash,team_member_id,scopes) VALUES ($1,$2,$3)', [hash(keys.agent), AGENT, scopes]);
  await db.query('INSERT INTO api_keys(key_hash,team_member_id,scopes) VALUES ($1,$2,$3)', [hash(keys.mate), MATE, scopes]);
  await db.query('INSERT INTO api_keys(key_hash,team_member_id,scopes) VALUES ($1,$2,$3)', [hash(keys.outsider), OUTSIDER, scopes]);
  await db.query('INSERT INTO api_keys(key_hash,team_member_id,scopes) VALUES ($1,$2,$3)', [hash(keys.noScope), MATE, ['projects.read']]);
  const server = await startFakePostgrest(db);
  process.env.NEXT_PUBLIC_SUPABASE_URL = server.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-key';

  try {
    const collection = await import('../src/app/api/v1/reminders/route');
    const single = await import('../src/app/api/v1/reminders/[id]/route');
    const call = async (key: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => {
      const url = new URL(`http://localhost${path}`);
      const request = new NextRequest(url, {
        method,
        headers: { 'x-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const id = url.pathname.split('/')[4];
      const handler = id ? (single as Payload)[method] : (collection as Payload)[method];
      const response: Response = await handler(request, { params: Promise.resolve(id ? { id } : {}) });
      const json = await response.json().catch(() => null);
      return { status: response.status, json: json as Payload };
    };
    const titles = (r: { json: Payload }) => ((r.json?.data ?? []) as Payload[]).map((x) => x.title).sort();

    const noScope = await call(keys.noScope, 'GET', '/api/v1/reminders');
    check('a key without the reminders scope is refused', noScope.status === 403, noScope);

    const forOwnerOnTask = await call(keys.agent, 'POST', '/api/v1/reminders', {
      title: 'Ask Stephanie the 3 delivery questions', task_id: T1, owner_id: OWNER, remind_on: '2026-11-02', remind_at: '10:30',
    });
    const r1 = forOwnerOnTask.json?.data ?? {};
    check('an agent writes a task reminder for the owner: project from the task, writer and source recorded',
      forOwnerOnTask.status === 201 && r1.project_id === P1 && r1.owner_id === OWNER && r1.created_by === AGENT
        && r1.source === 'agent' && r1.remind_at === '10:30:00', forOwnerOnTask);

    const standalone = await call(keys.agent, 'POST', '/api/v1/reminders', { title: 'Renew the domain', owner_id: OWNER });
    check('an agent can write a standalone reminder for the owner (an email turned into a reminder)', standalone.status === 201, standalone);
    const mateForOwner = await call(keys.mate, 'POST', '/api/v1/reminders', { title: 'Sneaky', owner_id: OWNER });
    check('a member cannot write one for someone else', mateForOwner.status === 403, mateForOwner);
    const noAccessTask = await call(keys.agent, 'POST', '/api/v1/reminders', { title: 'Out of reach', task_id: T2 });
    check('no reminder on a task the key cannot open (reads as not found)', noAccessTask.status === 404, noAccessTask);
    const mismatch = await call(keys.agent, 'POST', '/api/v1/reminders', { title: 'Mixed', task_id: T1, project_id: P2 });
    check('a task and a different project together are refused', mismatch.status === 400, mismatch);
    const timeOnly = await call(keys.mate, 'POST', '/api/v1/reminders', { title: 'When?', remind_at: '09:00' });
    check('a time without a date is refused', timeOnly.status === 422, timeOnly);
    const mine = await call(keys.mate, 'POST', '/api/v1/reminders', { title: 'Mate private', remind_on: '2026-11-05' });
    check('a member writes their own; source manual', mine.status === 201 && mine.json.data.owner_id === MATE && mine.json.data.source === 'manual', mine);

    const ownerSees = await call(keys.owner, 'GET', '/api/v1/reminders');
    check('the owner sees reminders written for them (and, with every project, the shared ones)',
      JSON.stringify(titles(ownerSees)) === JSON.stringify(['Ask Stephanie the 3 delivery questions', 'Renew the domain']), titles(ownerSees));
    const agentSees = await call(keys.agent, 'GET', '/api/v1/reminders');
    check('the agent sees what it wrote', titles(agentSees).length === 2, titles(agentSees));
    const agentMine = await call(keys.agent, 'GET', '/api/v1/reminders?owner=me');
    check('owner=me leaves out the ones it wrote for someone else', titles(agentMine).length === 0, titles(agentMine));
    const mateSees = await call(keys.mate, 'GET', '/api/v1/reminders');
    check('a teammate sees the shared task reminder and their own, never a private one of someone else',
      JSON.stringify(titles(mateSees)) === JSON.stringify(['Ask Stephanie the 3 delivery questions', 'Mate private']), titles(mateSees));
    const outsiderSees = await call(keys.outsider, 'GET', '/api/v1/reminders');
    check('someone with no projects sees none of it', titles(outsiderSees).length === 0, outsiderSees);
    const byTask = await call(keys.mate, 'GET', `/api/v1/reminders?task_id=${T1}`);
    check('task_id narrows to a task\'s next steps; rows name their task', titles(byTask).length === 1
      && (byTask.json.data as Payload[])[0].task?.title === 'Update local delivery wording', byTask.json);
    const dueBy = await call(keys.mate, 'GET', '/api/v1/reminders?due_by=2026-11-03');
    check('due_by keeps what is dated on or before that day', JSON.stringify(titles(dueBy)) === JSON.stringify(['Ask Stephanie the 3 delivery questions']), titles(dueBy));
    const badStatus = await call(keys.mate, 'GET', '/api/v1/reminders?status=later');
    check('a bad filter is a readable refusal', badStatus.status === 400, badStatus);

    const peek = await call(keys.mate, 'GET', `/api/v1/reminders/${standalone.json.data.id}`);
    check('a private reminder of someone else reads as not found', peek.status === 404, peek);
    const touch = await call(keys.mate, 'PATCH', `/api/v1/reminders/${standalone.json.data.id}`, { status: 'done' });
    check('...and cannot be ticked off', touch.status === 404, touch);

    const tick = await call(keys.mate, 'PATCH', `/api/v1/reminders/${r1.id}`, { status: 'done' });
    check('a teammate ticks off a shared one; who and when are recorded',
      tick.status === 200 && tick.json.data.status === 'done' && tick.json.data.completed_by === MATE && !!tick.json.data.completed_at, tick);
    const doneList = await call(keys.owner, 'GET', '/api/v1/reminders?status=done');
    check('status=done lists it', JSON.stringify(titles(doneList)) === JSON.stringify(['Ask Stephanie the 3 delivery questions']), titles(doneList));
    const reopen = await call(keys.owner, 'PATCH', `/api/v1/reminders/${r1.id}`, { status: 'open', remind_on: null });
    check('reopening clears the stamps; removing the date removes its time',
      reopen.json?.data?.status === 'open' && reopen.json.data.completed_by === null && reopen.json.data.remind_on === null && reopen.json.data.remind_at === null, reopen);
    const empty = await call(keys.owner, 'PATCH', `/api/v1/reminders/${r1.id}`, {});
    check('an empty change is refused', empty.status === 422, empty);

    const mateDelete = await call(keys.mate, 'DELETE', `/api/v1/reminders/${r1.id}`);
    check('a teammate who neither owns nor wrote it cannot delete it', mateDelete.status === 403, mateDelete);
    const agentDelete = await call(keys.agent, 'DELETE', `/api/v1/reminders/${standalone.json.data.id}`);
    check('the writer can delete it', agentDelete.status === 200 && agentDelete.json.data.deleted === true, agentDelete);

    await db.query("UPDATE tasks SET status = 'done' WHERE id = $1", [T1]);
    const closed = await call(keys.owner, 'GET', `/api/v1/reminders/${r1.id}`);
    check('a task moved to done closes its reminder, as the API reports', closed.json?.data?.status === 'done' && closed.json.data.closed_by_task === true, closed);

    const audit = await db.query<{ n: number }>("SELECT count(*)::int n FROM api_audit_log WHERE entity_type = 'reminder'");
    check('writes are audited', audit.rows[0].n >= 5, audit.rows);
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`reminders API: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log(`reminders API: all ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
