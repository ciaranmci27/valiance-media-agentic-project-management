/**
 * Team member profiles (lib/team/profile.ts) on the full schema in PGlite,
 * with the real supabase-js client behind fake-postgrest. Activity is read
 * as the viewer, so the database's row rules apply as in the app.
 *
 * Covers: an Owner sees everything; a Member viewing a colleague gets no
 * hours, activity or usage and only tasks in shared projects; a Guest sees
 * only people on a shared project, and anyone else is not found; a person
 * sees all of their own; Time off hides hours; an agent has no usage and its
 * own log as activity; activity pages without gaps.
 *
 *   npm run -s test:team-profile
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PGlite } from '@electric-sql/pglite';
import { createClient } from '@supabase/supabase-js';
import { createFullSchemaDatabase } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail).slice(0, 1500)}`);
}

const USER_HEADER = 'x-test-user';
const NOW = new Date('2026-11-20T15:00:00Z'); // a Friday; the week starts Monday 16 November
const LAST_SIGN_IN = '2026-11-19T08:30:00.000Z';
const at = (iso: string) => new Date(iso).toISOString();

const PEOPLE = {
  owner: { role: 'owner', auth: '00000000-0000-0000-0000-0000000d0001' },
  admin: { role: 'admin', auth: '00000000-0000-0000-0000-0000000d0002' },
  viewer: { role: 'member', auth: '00000000-0000-0000-0000-0000000d0003' },
  maya: { role: 'member', auth: '00000000-0000-0000-0000-0000000d0004' },
  guest: { role: 'guest', auth: '00000000-0000-0000-0000-0000000d0005' },
  outsider: { role: 'guest', auth: '00000000-0000-0000-0000-0000000d0006' },
  agent: { role: 'agent', auth: '00000000-0000-0000-0000-0000000d0007' },
} as const;
type Who = keyof typeof PEOPLE;

async function seedPeople(db: PGlite): Promise<Record<Who, string>> {
  await db.exec('RESET ROLE');
  const ids = {} as Record<Who, string>;
  for (const who of Object.keys(PEOPLE) as Who[]) {
    const { role, auth } = PEOPLE[who];
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [auth, `${who}@example.com`]);
    const updated = await db.query<{ id: string }>(
      `UPDATE public.team_members SET role = $2, status = 'active', name = $3, timezone = 'UTC' WHERE auth_user_id = $1 RETURNING id`,
      [auth, role, who],
    );
    ids[who] = updated.rows[0]?.id ?? (await db.query<{ id: string }>(
      `INSERT INTO public.team_members (auth_user_id, name, email, role, status, timezone) VALUES ($1, $2, $3, $4, 'active', 'UTC') RETURNING id`,
      [auth, who, `${who}@example.com`, role],
    )).rows[0].id;
  }
  return ids;
}

async function main() {
  const db = await createFullSchemaDatabase();
  // The auth admin lookup a profile makes for last sign-in.
  const handle = async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    const match = /^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/.exec(url.pathname);
    if (!match) return false;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: match[1], aud: 'authenticated', last_sign_in_at: LAST_SIGN_IN }));
    return true;
  };
  const server = await startFakePostgrest(db, { userHeader: USER_HEADER, handle });
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key' });
  const q = async <T,>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };

  try {
    const { assembleTeamProfile, loadProfileActivityPage } = await import('../src/lib/team/profile');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const service = getServiceClient();
    const ids = await seedPeople(db);

    const readerFor = (who: Who) => createClient(server.url, 'fake-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { [USER_HEADER]: PEOPLE[who].auth } },
    });
    const view = async (viewer: Who, target: string) => {
      const access = await resolveMemberAccess(service, ids[viewer]);
      if (!access) throw new Error(`no access for ${viewer}`);
      return assembleTeamProfile({ service, reader: readerFor(viewer), access, targetId: target, now: NOW });
    };

    // ---- Seed ---------------------------------------------------------------
    const project = async (name: string, members: Who[], trashed = false) => {
      const id = (await q<{ id: string }>('INSERT INTO public.projects (name, deleted_at) VALUES ($1, $2) RETURNING id', [name, trashed ? at('2026-11-10T00:00:00Z') : null]))[0].id;
      for (const who of members) await q('INSERT INTO public.project_members (project_id, member_id) VALUES ($1, $2)', [id, ids[who]]);
      return id;
    };
    const shared = await project('Shared work', ['owner', 'viewer', 'maya', 'guest', 'agent']);
    const private_ = await project('Maya only', ['maya']);
    const trashed = await project('In Trash', ['maya'], true);
    await project('Elsewhere', ['outsider']);

    const task = async (projectId: string, title: string, status: string, due: string | null, assignee: Who, completedAt: string | null = null) => {
      const id = (await q<{ id: string }>('INSERT INTO public.tasks (project_id, title, status, due_date, completed_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [projectId, title, status, due, completedAt]))[0].id;
      await q('INSERT INTO public.task_assignees (task_id, member_id) VALUES ($1, $2)', [id, ids[assignee]]);
      return id;
    };
    await task(shared, 'Overdue in shared', 'in_progress', '2026-11-18', 'maya');
    await task(private_, 'Open in private', 'todo', '2026-12-01', 'maya');
    await task(shared, 'Done this month', 'done', null, 'maya', at('2026-11-15T10:00:00Z'));
    await task(shared, 'Done long ago', 'done', null, 'maya', at('2026-09-01T10:00:00Z'));
    await task(trashed, 'Open in Trash', 'todo', '2026-11-01', 'maya');
    await task(shared, 'Someone else', 'todo', null, 'viewer');
    // A subtask of Maya's whose parent is in Trash: hidden everywhere, so not hers to count.
    const trashedParent = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title, status) VALUES ($1, 'Trashed parent', 'todo') RETURNING id", [shared]))[0].id;
    const orphan = (await q<{ id: string }>("INSERT INTO public.tasks (project_id, title, status, due_date, parent_task_id) VALUES ($1, 'Subtask of a trashed parent', 'todo', '2026-11-02', $2) RETURNING id", [shared, trashedParent]))[0].id;
    await q('INSERT INTO public.task_assignees (task_id, member_id) VALUES ($1, $2)', [orphan, ids.maya]);
    // Then the parent goes to Trash; the subtask keeps deleted_at empty, as in the app.
    await q('UPDATE public.tasks SET deleted_at = $2 WHERE id = $1', [trashedParent, at('2026-11-12T00:00:00Z')]);

    const entry = async (projectId: string, start: string, end: string) => q(
      `INSERT INTO public.project_time_entries (project_id, member_id, start_time, end_time, segments) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [projectId, ids.maya, at(start), at(end), JSON.stringify([{ start: at(start), end: at(end) }])],
    );
    await entry(shared, '2026-11-17T09:00:00Z', '2026-11-17T11:00:00Z'); // 2 h this week
    await entry(private_, '2026-11-05T09:00:00Z', '2026-11-05T12:00:00Z'); // 3 h this month, last week
    await entry(shared, '2026-09-01T09:00:00Z', '2026-09-01T17:00:00Z'); // outside 30 days

    // 35 actions by Maya on three days this month, plus one 40 days ago.
    const days = ['2026-11-20', '2026-11-12', '2026-11-03'];
    for (let i = 0; i < 35; i++) {
      const created = at(`${days[i % 3]}T${String(10 + Math.floor(i / 3)).padStart(2, '0')}:00:00Z`);
      await q(`INSERT INTO public.activities (type, entity_type, entity_id, project_id, user_id, description, metadata, created_at)
               VALUES ('task_updated', 'task', $1, $2, $3, $4, '{}'::jsonb, $5)`,
      [`t${i}`, i % 2 ? shared : private_, ids.maya, `Updated task number ${i}`, created]);
    }
    await q(`INSERT INTO public.activities (type, entity_type, entity_id, project_id, user_id, description, created_at)
             VALUES ('task_updated', 'task', 'old', $1, $2, 'Updated an old task', $3)`, [shared, ids.maya, at('2026-10-11T10:00:00Z')]);

    await q(`INSERT INTO public.agent_activities (agent_id, project_id, activity_type, title, created_at) VALUES
      ($1, $2, 'work.done', 'Finished the import', $3),
      ($1, $2, 'turn.completed', 'Telemetry turn', $4)`, [ids.agent, shared, at('2026-11-19T10:00:00Z'), at('2026-11-19T11:00:00Z')]);

    // ---- An Owner sees everything ------------------------------------------
    const owner = await view('owner', ids.maya);
    check('owner: full view of a member', owner?.view === 'full' && owner.member.email === 'maya@example.com', owner?.member);
    check('owner: work counts leave out done, Trash and subtasks of a trashed parent', owner?.work?.open === 2 && owner.work.overdue === 1 && owner.work.done_last_30 === 1, owner?.work);
    check('owner: open tasks listed soonest due first', JSON.stringify(owner?.work?.tasks.map((t) => t.title)) === JSON.stringify(['Overdue in shared', 'Open in private']), owner?.work?.tasks);
    check('owner: projects without the one in Trash', JSON.stringify(owner?.projects.map((p) => p.name)) === JSON.stringify(['Maya only', 'Shared work']), owner?.projects);
    check('owner: hours this week and last 30 days', owner?.time?.week_hours === 2 && owner.time.last_30_hours === 5 && owner.time.running === false, owner?.time);
    check('owner: the first 30 actions, newest first, with a cursor', owner?.activity?.items.length === 30 && !!owner.activity.next_cursor
      && owner.activity.items[0].text === 'Updated task number 33' && owner.activity.source === 'team', owner?.activity?.items.slice(0, 2));
    check('owner: activity rows name their project and link to their project', owner?.activity?.items[0].project_name === 'Shared work'
      && owner.activity.items[0].href === `/projects/${shared}`, owner?.activity?.items[0]);
    check('owner: usage counts active days and this month', owner?.usage?.active_days === 3 && owner.usage.actions_this_month === 35
      && owner.usage.last_sign_in_at === LAST_SIGN_IN, owner?.usage);
    check('owner: last active is the newest of their last action and last sign-in', Date.parse(owner?.last_active_at ?? '') === Date.parse('2026-11-20T21:00:00Z'), owner?.last_active_at);

    // ---- Activity pages ----------------------------------------------------
    if (owner?.activity?.next_cursor) {
      const ownerAccess = (await resolveMemberAccess(service, ids.owner))!;
      const next = await loadProfileActivityPage({ service, reader: readerFor('owner'), access: ownerAccess, targetId: ids.maya, before: owner.activity.next_cursor });
      const all = [...owner.activity.items, ...(next?.items ?? [])].map((item) => item.id);
      check('activity: the next page holds the rest, with no repeats or gaps', next?.items.length === 6 && next.next_cursor === null && new Set(all).size === 36, next);
      const viewerAccess = (await resolveMemberAccess(service, ids.viewer))!;
      const blocked = await loadProfileActivityPage({ service, reader: readerFor('viewer'), access: viewerAccess, targetId: ids.maya, before: owner.activity.next_cursor });
      check('activity: a colleague cannot page someone else\'s activity', blocked === null, blocked);
    } else check('activity: a cursor to page with', false);

    // ---- A Member viewing a colleague --------------------------------------
    const colleague = await view('viewer', ids.maya);
    check('member: colleague view with email and role', colleague?.view === 'colleague' && colleague.member.email === 'maya@example.com' && colleague.member.role === 'member', colleague?.member);
    check('member: no hours, activity, usage or last active', colleague !== null && !('time' in colleague) && !('activity' in colleague) && !('usage' in colleague) && !('last_active_at' in colleague), colleague && Object.keys(colleague));
    check('member: only tasks in shared projects', colleague?.work?.open === 1 && colleague.work.tasks.length === 1 && colleague.work.tasks[0].title === 'Overdue in shared', colleague?.work);
    check('member: only shared projects', JSON.stringify(colleague?.projects.map((p) => p.name)) === JSON.stringify(['Shared work']), colleague?.projects);

    // ---- Guests ------------------------------------------------------------
    const guest = await view('guest', ids.maya);
    check('guest: name, role and shared projects only', guest?.view === 'guest' && guest.member.email === undefined && guest.member.title === undefined
      && guest.work === undefined && JSON.stringify(guest.projects.map((p) => p.name)) === JSON.stringify(['Shared work']), guest);
    check('guest: someone outside their projects is not found', (await view('outsider', ids.maya)) === null);
    check('guest: still sees their own profile', (await view('outsider', ids.outsider))?.view === 'full');

    // ---- Self ----------------------------------------------------------------
    const self = await view('maya', ids.maya);
    check('self: everything about themselves', self?.view === 'full' && self.is_self && self.time?.last_30_hours === 5 && self.usage?.active_days === 3
      && self.work?.open === 2 && self.activity?.items.length === 30, self && { view: self.view, time: self.time, usage: self.usage, work: self.work?.open });

    // ---- Not found -----------------------------------------------------------
    check('nobody: an unknown id is not found', (await view('viewer', '00000000-0000-0000-0000-00000000ffff')) === null);
    check('nobody: a malformed id is not found', (await view('owner', 'not-a-uuid')) === null);

    // ---- Agents ----------------------------------------------------------------
    const agent = await view('owner', ids.agent);
    check('agent: a profile without usage', agent?.member.role === 'agent' && agent.usage === undefined && agent.member.agent_profile === 'generic', agent && { member: agent.member, usage: agent.usage });
    check('agent: activity is its own log, without telemetry', agent?.activity?.source === 'agent' && agent.activity.items.length === 1
      && agent.activity.items[0].text === 'Finished the import', agent?.activity);

    // ---- Time switched off -----------------------------------------------------
    await q("UPDATE public.workspace_modules SET enabled = false WHERE module_id = 'time'");
    const ownerTimeOff = await view('owner', ids.maya);
    const selfTimeOff = await view('maya', ids.maya);
    check('time off: no hours for anyone', ownerTimeOff !== null && !('time' in ownerTimeOff) && selfTimeOff !== null && !('time' in selfTimeOff));
    check('time off: the rest stays', ownerTimeOff?.work?.open === 2 && ownerTimeOff.usage?.active_days === 3);
    await q("UPDATE public.workspace_modules SET enabled = true WHERE module_id = 'time'");
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`team profile: ${passed} passed, ${failures.length} failed`);
    for (const failure of failures) console.error(`FAIL ${failure}`);
    process.exit(1);
  }
  console.log(`team profile: all ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
