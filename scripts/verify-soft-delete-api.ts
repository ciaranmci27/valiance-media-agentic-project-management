/**
 * Soft delete through the public API: the real v1 route handlers (withApi,
 * real supabase-js) on the whole real schema in PGlite behind fake-postgrest,
 * so they run as the service role, the way production runs them.
 *
 * DELETE moves a record to Trash (the row stays, stamped with the key's
 * member), it then reads as missing everywhere, a trashed project takes what
 * it owns out of reach, archive is its own action, team members are
 * suspended rather than deleted, and time on an invoice is refused.
 *
 *   npm run -s test:soft-delete-api
 */
import { createHash, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { startFakePostgrest } from './fake-postgrest';
import { actAs, createFullSchemaDatabase } from './full-schema-db';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail).slice(0, 800)}`);
}

const OWNER_USER = '00000000-0000-0000-0000-0000000000b1';
const MEMBER_USER = '00000000-0000-0000-0000-0000000000b2';
const hash = (key: string) => createHash('sha256').update(key).digest('hex');

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are read loosely in checks
type Json = { success: boolean; data: any; error?: { code: string; message: string; details?: { reason?: string } } };

async function main() {
  const db = await createFullSchemaDatabase();
  await db.exec('RESET ROLE');
  // Rate limiting is not under test here (the other API suites stub it the same way).
  await db.exec(`DROP FUNCTION public.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION public.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)',
    [OWNER_USER, 'owner@example.com', MEMBER_USER, 'member@example.com']);
  const members = (await db.query<{ id: string; auth_user_id: string }>('SELECT id, auth_user_id FROM public.team_members')).rows;
  const owner = members.find((m) => m.auth_user_id === OWNER_USER)!.id;
  const member = members.find((m) => m.auth_user_id === MEMBER_USER)!.id;
  const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
  await db.query(`INSERT INTO public.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
    VALUES ('Owner key', 'pk_live', $1, $2, $3, 'scoped')`, [hash(secret), owner,
    ['projects.read', 'projects.read_all', 'projects.manage', 'tasks.read', 'tasks.manage_all', 'leads.read', 'leads.read_all',
      'leads.manage', 'team.read', 'team.manage', 'time.manage_own', 'time.manage_all', 'time.read_all']]);

  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key' });
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  const call = async (handler: Handler, method: string, path: string, params: Record<string, string> = {}, body?: unknown) => {
    const response = await handler(new NextRequest(`http://localhost${path}`, {
      method,
      headers: { 'x-api-key': secret, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), { params: Promise.resolve(params) });
    return { status: response.status, json: (await response.json()) as Json };
  };

  try {
    const tasks = await import('../src/app/api/v1/tasks/route');
    const task = await import('../src/app/api/v1/tasks/[id]/route');
    const projects = await import('../src/app/api/v1/projects/route');
    const project = await import('../src/app/api/v1/projects/[id]/route');
    const archive = await import('../src/app/api/v1/projects/[id]/archive/route');
    const timeEntries = await import('../src/app/api/v1/projects/[id]/time-entries/route');
    const timeEntry = await import('../src/app/api/v1/projects/[id]/time-entries/[entryId]/route');
    const lead = await import('../src/app/api/v1/leads/[id]/route');
    const leadArchive = await import('../src/app/api/v1/leads/[id]/archive/route');
    const teamMember = await import('../src/app/api/v1/team-members/[id]/route');

    // -- Seed ---------------------------------------------------------------
    const P = (await q<{ id: string }>("INSERT INTO public.projects (name) VALUES ('Plan4TheFuture.com') RETURNING id"))[0].id;
    const T1 = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title) VALUES ($1, 'Capture plan domicile state') RETURNING id", [P]))[0].id;
    const T2 = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title) VALUES ($1, 'Update local delivery wording') RETURNING id", [P]))[0].id;
    const taskIds = async (projectId: string) =>
      ((await call(tasks.GET, 'GET', `/api/v1/tasks?project_id=${projectId}`)).json.data ?? []).map((row: { id: string }) => row.id);

    // -- A task ---------------------------------------------------------------
    // (GET /tasks/:id nests two embeds deep, which fake-postgrest does not serve; the list shows the live task.)
    check('a live task is listed', (await taskIds(P)).includes(T1));
    const deleted = await call(task.DELETE, 'DELETE', `/api/v1/tasks/${T1}`, { id: T1 });
    check('DELETE answers { deleted: true }', deleted.status === 200 && deleted.json.data?.deleted === true, deleted.json);
    const row = (await q<{ deleted_at: string | null; deleted_by: string | null }>('SELECT deleted_at, deleted_by FROM public.tasks WHERE id = $1', [T1]))[0];
    check('the task is still there, in Trash, stamped with the key\'s member', !!row?.deleted_at && row.deleted_by === owner, row);
    const gone = await call(task.GET, 'GET', `/api/v1/tasks/${T1}`, { id: T1 });
    check('it then reads as missing', gone.status === 403 && gone.json.error?.details?.reason === 'not_found_or_forbidden', gone);
    check('and the task list leaves it out', JSON.stringify(await taskIds(P)) === JSON.stringify([T2]), await taskIds(P));
    const twice = await call(task.DELETE, 'DELETE', `/api/v1/tasks/${T1}`, { id: T1 });
    check('deleting it again is not found, not an error', twice.status === 403 || twice.status === 404, twice);

    // -- Time on an invoice stays -----------------------------------------------
    const entry = (await q<{ id: string }>(`INSERT INTO public.project_time_entries
      (project_id, member_id, start_time, end_time, segments, hourly_rate, approval_status, work_type)
      VALUES ($1, $2, '2026-10-01T16:00:00Z', '2026-10-01T18:00:00Z',
        '[{"start": "2026-10-01T16:00:00Z", "end": "2026-10-01T18:00:00Z"}]', 100, 'approved', 'client') RETURNING id`, [P, owner]))[0].id;
    const invoice = (await q<{ id: string }>(`INSERT INTO public.project_invoices (project_id, invoice_number, amount, status, date, line_items)
      VALUES ($1, 'INV-001', 200, 'draft', '2026-10-05', '[{"id": "l1", "item_type": "hourly", "amount": 200}]') RETURNING id`, [P]))[0].id;
    await q(`INSERT INTO public.invoice_time_entry_allocations (invoice_id, line_item_id, time_entry_id, start_offset_hours, allocated_hours, allocated_amount)
      VALUES ($1, 'l1', $2, 0, 2, 200)`, [invoice, entry]);
    const invoiced = await call(timeEntry.DELETE, 'DELETE', `/api/v1/projects/${P}/time-entries/${entry}`, { id: P, entryId: entry });
    check('time on an invoice cannot be deleted (409, with the reason)',
      invoiced.status === 409 && /on invoice INV-001/.test(invoiced.json.error?.message ?? ''), invoiced.json);

    // -- A whole project ----------------------------------------------------------
    const projectIds = async () => ((await call(projects.GET, 'GET', '/api/v1/projects?include_archived=true')).json.data ?? [])
      .map((row: { id: string }) => row.id);
    check('the project is listed', (await projectIds()).includes(P));
    const trashedProject = await call(project.DELETE, 'DELETE', `/api/v1/projects/${P}`, { id: P });
    check('DELETE moves the project to Trash', trashedProject.status === 200 && trashedProject.json.data?.deleted === true, trashedProject.json);
    check('it reads as missing', (await call(project.GET, 'GET', `/api/v1/projects/${P}`, { id: P })).status === 404);
    check('it is not listed, archived or not', !(await projectIds()).includes(P));
    check('what it owns is out of reach', (await call(timeEntries.GET, 'GET', `/api/v1/projects/${P}/time-entries`, { id: P })).status === 404);
    check('its tasks too', (await call(task.GET, 'GET', `/api/v1/tasks/${T2}`, { id: T2 })).status === 403);
    const untouched = (await q<{ n: number }>('SELECT count(*)::int AS n FROM public.tasks WHERE project_id = $1 AND deleted_at IS NULL', [P]))[0].n;
    check('its tasks are untouched underneath', untouched === 1, untouched);

    await actAs(db, null);
    await db.query("SELECT public.restore_record('projects', $1)", [P]);
    await db.exec('RESET ROLE');
    check('restored, it reads again with its task', (await call(project.GET, 'GET', `/api/v1/projects/${P}`, { id: P })).status === 200
      && JSON.stringify(await taskIds(P)) === JSON.stringify([T2]));

    // -- The client portal goes with its project -----------------------------------
    const portal = await import('../src/app/api/portal/[token]/route');
    const token = `p${randomUUID().replace(/-/g, '')}`;
    await q('INSERT INTO public.portal_settings (project_id, token, enabled) VALUES ($1, $2, true)', [P, token]);
    const openPortal = async () => (await portal.GET(new NextRequest(`http://localhost/api/portal/${token}`),
      { params: Promise.resolve({ token }) })).status;
    check('the client portal opens', await openPortal() === 200);
    await call(project.DELETE, 'DELETE', `/api/v1/projects/${P}`, { id: P });
    check('a project in Trash has no portal', await openPortal() === 404);
    await actAs(db, null);
    await db.query("SELECT public.restore_record('projects', $1)", [P]);
    await db.exec('RESET ROLE');
    check('restored, the portal opens again', await openPortal() === 200);

    // -- Archive is its own action -------------------------------------------------
    const archived = await call(archive.POST, 'POST', `/api/v1/projects/${P}/archive`, { id: P });
    check('archiving sets archived_at', archived.status === 200 && archived.json.data?.archived === true && !!archived.json.data?.archived_at, archived.json);
    check('an archived project still reads', (await call(project.GET, 'GET', `/api/v1/projects/${P}`, { id: P })).status === 200);
    const unarchived = await call(archive.DELETE, 'DELETE', `/api/v1/projects/${P}/archive`, { id: P });
    const archivedAt = (await q<{ archived_at: string | null }>('SELECT archived_at FROM public.projects WHERE id = $1', [P]))[0].archived_at;
    check('unarchiving clears it', unarchived.json.data?.archived === false && archivedAt === null, unarchived.json);

    // -- A lead ------------------------------------------------------------------------
    const L = (await q<{ id: string }>("INSERT INTO public.leads (name) VALUES ('Mike''s Bikes') RETURNING id"))[0].id;
    const leadArchived = await call(leadArchive.POST, 'POST', `/api/v1/leads/${L}/archive`, { id: L });
    check('a lead archives on its own action', leadArchived.json.data?.archived === true, leadArchived.json);
    const leadDeleted = await call(lead.DELETE, 'DELETE', `/api/v1/leads/${L}`, { id: L });
    check('DELETE moves the lead to Trash', leadDeleted.json.data?.deleted === true, leadDeleted.json);
    check('it then reads as missing', (await call(lead.GET, 'GET', `/api/v1/leads/${L}`, { id: L })).status === 404);

    // -- Team members are suspended, never deleted ------------------------------------------
    const removed = await call(teamMember.DELETE, 'DELETE', `/api/v1/team-members/${member}`, { id: member });
    const memberRow = (await q<{ status: string }>('SELECT status FROM public.team_members WHERE id = $1', [member]))[0];
    check('removing a team member suspends them and keeps the row',
      removed.json.data?.suspended === true && memberRow?.status === 'suspended', { removed: removed.json, memberRow });
  } finally {
    // Audit and last-used writes run just after each response; let the last ones land.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await server.close();
  }

  console.log(`soft delete API: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.log(`  FAIL ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
