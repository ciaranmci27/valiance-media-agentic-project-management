/**
 * Agent work blocks through the real v1 API (withApi, supabase-js, a fake
 * PostgREST over PGlite):
 * - Claims: claim, someone else refused with who and until when, a claim that
 *   ran out frees the task, extend, release, a manager releases a stuck claim,
 *   claims are not edits (no updated_at move), done ends a claim.
 * - next_task: assigned work first, then unassigned AI Ready work; leaves out
 *   backlog, review, done, blocked, Trash, inactive projects and other
 *   members' claims; priority, due date, age.
 * - Per-agent rules: self-assign off blocks pick-up, close policy review
 *   sends done to In Review with a comment, create policy approval makes a
 *   suggestion, the defaults change nothing, set through the team route.
 * - Incident keys: a repeat returns the open task and counts it, two racing
 *   creates end as one task, a repeat after done makes a new task.
 *
 *   npm run -s test:agent-work-blocks
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { createFullSchemaDatabase } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

const TASK_SCOPES = ['tasks.read', 'tasks.create', 'tasks.manage_assigned', 'projects.read'];

async function seed(db: PGlite) {
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  const member = async (name: string, role = 'agent') =>
    (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id', [name, `${name.toLowerCase()}@example.com`, role]))[0].id;
  const owner = await member('Olivia', 'owner');
  const builder = await member('Builder');
  const helper = await member('Helper');
  const planner = await member('Planner');
  const steady = await member('Steady');
  const manager = await member('Morgan', 'member');
  const pat = await member('Pat', 'member');
  // Agents whose keys may manage every task: Boss with self-assign off, Chief with the defaults.
  const boss = await member('Boss');
  const chief = await member('Chief');
  await q('UPDATE pm.team_members SET agent_self_assign = false WHERE id = $1', [boss]);
  const project = async (name: string, members: string[], status = 'active') => {
    const id = (await q<{ id: string }>('INSERT INTO pm.projects (name, status) VALUES ($1, $2) RETURNING id', [name, status]))[0].id;
    for (const m of members) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  const apex = await project('Apex', [builder, helper, steady, manager, boss, chief]);
  const pool = await project('Pool', [steady, chief]);
  const queue = await project('Queue', [planner, helper, pat]);
  const shelved = await project('Shelved', [planner], 'archived');
  const key = async (memberId: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
      VALUES ('Key', 'pk_live', $1, $2, $3, 'scoped')`, [createHash('sha256').update(secret).digest('hex'), memberId, scopes]);
    await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
      SELECT $1, key, 'api', 'allow' FROM unnest($2::text[]) AS key ON CONFLICT DO NOTHING`, [memberId, scopes]);
    return secret;
  };
  const keys = {
    builder: await key(builder, TASK_SCOPES),
    helper: await key(helper, TASK_SCOPES),
    planner: await key(planner, TASK_SCOPES),
    steady: await key(steady, TASK_SCOPES),
    pat: await key(pat, TASK_SCOPES),
    manager: await key(manager, [...TASK_SCOPES, 'tasks.manage_all', 'projects.read_all', 'team.read', 'team.manage']),
    boss: await key(boss, [...TASK_SCOPES, 'tasks.manage_all']),
    chief: await key(chief, [...TASK_SCOPES, 'tasks.manage_all']),
  };
  const task = async (projectId: string, title: string, fields: Record<string, unknown> = {}, assignees: string[] = []) => {
    const columns = ['project_id', 'title', ...Object.keys(fields)];
    const values = [projectId, title, ...Object.values(fields)];
    const id = (await q<{ id: string }>(
      `INSERT INTO pm.tasks (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, values))[0].id;
    for (const m of assignees) await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  return { q, owner, builder, helper, planner, steady, manager, pat, boss, chief, apex, queue, shelved, pool, keys, task };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the answers are untyped JSON read field by field
type Loose = any;
type Body = { data?: Record<string, Loose> | null; error?: { code?: string; message?: string; details?: Record<string, Loose> } };
type Answer = { status: number; body: Body };

async function main() {
  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key' });
  try {
    const tasksRoute = await import('../src/app/api/v1/tasks/route');
    const taskRoute = await import('../src/app/api/v1/tasks/[id]/route');
    const claimRoute = await import('../src/app/api/v1/tasks/[id]/claim/route');
    const extendRoute = await import('../src/app/api/v1/tasks/[id]/claim/extend/route');
    const nextRoute = await import('../src/app/api/v1/tasks/next/route');
    const memberRoute = await import('../src/app/api/v1/team-members/[id]/route');
    const subtaskRoute = await import('../src/app/api/v1/tasks/[id]/subtasks/[subtaskId]/route');
    const { escalationTarget } = await import('../src/lib/api/agent-rules');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');

    const call = async (handler: (request: NextRequest, context: never) => Promise<Response>,
      method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown): Promise<Answer> => {
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never);
      return { status: response.status, body: await response.json() };
    };
    const claim = (id: string, apiKey: string, body?: unknown) => call(claimRoute.POST, 'POST', `/api/v1/tasks/${id}/claim`, { id }, apiKey, body);
    const extend = (id: string, apiKey: string, body?: unknown) => call(extendRoute.POST, 'POST', `/api/v1/tasks/${id}/claim/extend`, { id }, apiKey, body);
    const release = (id: string, apiKey: string) => call(claimRoute.DELETE, 'DELETE', `/api/v1/tasks/${id}/claim`, { id }, apiKey);
    const next = (apiKey: string, projectId?: string) =>
      call(nextRoute.GET, 'GET', `/api/v1/tasks/next${projectId ? `?project_id=${projectId}` : ''}`, {}, apiKey);
    const create = (apiKey: string, body: unknown) => call(tasksRoute.POST, 'POST', '/api/v1/tasks', {}, apiKey, body);
    const patch = (id: string, apiKey: string, body: unknown) => call(taskRoute.PATCH, 'PATCH', `/api/v1/tasks/${id}`, { id }, apiKey, body);
    const setRules = (id: string, body: unknown, apiKey = s.keys.manager) =>
      call(memberRoute.PATCH, 'PATCH', `/api/v1/team-members/${id}`, { id }, apiKey, body);
    const row = async (id: string) => (await s.q<Record<string, Loose>>('SELECT * FROM pm.tasks WHERE id = $1', [id]))[0];
    const minutesFromNow = (iso: unknown) => (new Date(String(iso)).getTime() - Date.now()) / 60_000;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

    // --- Defaults ----------------------------------------------------------------------
    const defaults = (await s.q<Record<string, unknown>>(
      'SELECT agent_self_assign, agent_close_policy, agent_create_policy, agent_escalate_to FROM pm.team_members WHERE id = $1', [s.steady]))[0];
    check('a new agent starts with the rules that match the behaviour before them',
      defaults.agent_self_assign === true && defaults.agent_close_policy === 'close' && defaults.agent_create_policy === 'live' && defaults.agent_escalate_to === null, defaults);

    // --- Claims ------------------------------------------------------------------------
    const shared = await s.task(s.apex, 'Fix the checkout total', {}, [s.builder, s.helper]);
    const stamp = async (id: string) => (await s.q<{ at: string }>('SELECT updated_at::text AS at FROM pm.tasks WHERE id = $1', [id]))[0].at;
    const updatedBefore = await stamp(shared);
    const first = await claim(shared, s.keys.builder);
    check('an assignee claims a task for 30 minutes by default',
      first.status === 200 && first.body.data?.claimed_by === s.builder && first.body.data?.claim?.member_id === s.builder
        && Math.abs(minutesFromNow(first.body.data?.claim_expires_at) - 30) < 1 && first.body.data?.renewed === false, first);
    await settle();
    const claimedEvent = await s.q<{ title: string; reference_id: string }>(
      "SELECT title, reference_id FROM pm.agent_activities WHERE agent_id = $1 AND activity_type = 'work.claimed'", [s.builder]);
    check('an agent claiming logs the typed work.claimed event', claimedEvent.length === 1 && claimedEvent[0].reference_id === shared
      && claimedEvent[0].title === 'Claimed: Fix the checkout total', claimedEvent);
    const updatedAfter = await stamp(shared);
    check('a claim is bookkeeping: updated_at does not move', updatedAfter === updatedBefore, [updatedBefore, updatedAfter]);
    const edits = await s.q("SELECT 1 FROM pm.task_events WHERE task_id = $1 AND kind = 'edit'", [shared]);
    check('a claim is bookkeeping: it does not mark the task unread as an edit', edits.length === 0, edits);

    const again = await claim(shared, s.keys.builder, { lease_minutes: 60 });
    check('claiming a task you hold renews it and keeps when you started',
      again.status === 200 && again.body.data?.renewed === true && again.body.data?.claimed_at === first.body.data?.claimed_at
        && Math.abs(minutesFromNow(again.body.data?.claim_expires_at) - 60) < 1, again);
    await settle();
    const events = await s.q("SELECT 1 FROM pm.agent_activities WHERE agent_id = $1 AND activity_type = 'work.claimed'", [s.builder]);
    check('a renewal logs no second work.claimed', events.length === 1, events.length);

    const refused = await claim(shared, s.keys.helper);
    check('someone else is refused with 409, naming who holds it and until when',
      refused.status === 409 && refused.body.error?.details?.reason === 'claimed_by_other'
        && refused.body.error?.details?.claimed_by === s.builder && refused.body.error?.details?.claimed_by_name === 'Builder'
        && !!refused.body.error?.details?.expires_at && /Builder is working on this task until/.test(refused.body.error?.message ?? ''), refused);
    const badLease = await claim(shared, s.keys.helper, { lease_minutes: 241 });
    check('a lease over 240 minutes is refused', badLease.status === 422, badLease.status);

    await s.q("UPDATE pm.tasks SET claim_expires_at = now() - interval '1 minute' WHERE id = $1", [shared]);
    const takeover = await claim(shared, s.keys.helper);
    check('a claim that ran out frees the task with no job', takeover.status === 200 && takeover.body.data?.claimed_by === s.helper
      && takeover.body.data?.renewed === false, takeover);

    const extended = await extend(shared, s.keys.helper, { lease_minutes: 90 });
    check('the holder extends its claim', extended.status === 200 && Math.abs(minutesFromNow(extended.body.data?.claim_expires_at) - 90) < 1, extended);
    const notYours = await extend(shared, s.keys.builder);
    check('someone else cannot extend it (409 with who holds it)', notYours.status === 409 && notYours.body.error?.details?.claimed_by === s.helper, notYours);

    const released = await release(shared, s.keys.helper);
    check('the holder releases it', released.status === 200 && released.body.data?.released === true && (await row(shared)).claimed_by === null, released);
    const releasedAgain = await release(shared, s.keys.helper);
    check('releasing a task nobody holds says released: false', releasedAgain.status === 200 && releasedAgain.body.data?.released === false, releasedAgain);
    const extendFree = await extend(shared, s.keys.helper);
    check('extending a claim you do not hold is a 409 that says claim it first', extendFree.status === 409 && extendFree.body.error?.details?.reason === 'not_claimed', extendFree);

    await claim(shared, s.keys.builder);
    const helperRelease = await release(shared, s.keys.helper);
    check('another assignee cannot release your claim', helperRelease.status === 403 && helperRelease.body.error?.details?.reason === 'claim_not_yours', helperRelease);
    const managerRelease = await release(shared, s.keys.manager);
    check('a manager (tasks.manage_all) releases a stuck claim', managerRelease.status === 200 && managerRelease.body.data?.released === true
      && managerRelease.body.data?.released_from?.member_id === s.builder, managerRelease);

    await claim(shared, s.keys.builder);
    const personEdit = await patch(shared, s.keys.manager, { title: 'Fix the checkout total (EU)' });
    check('a claimed task can still be edited by others who may', personEdit.status === 200 && personEdit.body.data?.title === 'Fix the checkout total (EU)', personEdit);
    await patch(shared, s.keys.builder, { status: 'done' });
    const finished = await row(shared);
    check('finishing a task ends its claim', finished.status === 'done' && finished.claimed_by === null && finished.claim_expires_at === null, finished);
    const doneClaim = await claim(shared, s.keys.builder);
    check('a done task cannot be claimed', doneClaim.status === 409 && doneClaim.body.error?.details?.reason === 'task_done', doneClaim);

    const others = await s.task(s.apex, 'Someone else\'s task', { ai_readiness: 'ai_ready' }, [s.steady]);
    const othersClaim = await claim(others, s.keys.builder);
    check('a task assigned to someone else is not yours to claim', othersClaim.status === 403 && othersClaim.body.error?.details?.reason === 'assigned_to_others', othersClaim);

    // --- Picking up unassigned work -------------------------------------------------------
    const open = await s.task(s.apex, 'Rotate the API key', { ai_readiness: 'ai_ready' });
    const pickup = await claim(open, s.keys.builder);
    const pickedAssignees = await s.q<{ member_id: string }>('SELECT member_id FROM pm.task_assignees WHERE task_id = $1', [open]);
    check('an agent picks up unassigned AI Ready work by claiming it, which assigns it',
      pickup.status === 200 && pickup.body.data?.assigned_to_you === true && pickedAssignees.map((a) => a.member_id).join() === s.builder, { pickup, pickedAssignees });
    const notReady = await s.task(s.apex, 'Call the client');
    const notReadyClaim = await claim(notReady, s.keys.builder);
    check('agents pick up unassigned work only when it is AI Ready', notReadyClaim.status === 403 && notReadyClaim.body.error?.details?.reason === 'not_ai_ready', notReadyClaim);

    const selfOff = await setRules(s.helper, { agent_self_assign: false });
    check('the team route sets an agent\'s rules', selfOff.status === 200 && selfOff.body.data?.agent_self_assign === false, selfOff);
    const open2 = await s.task(s.apex, 'Prune old logs', { ai_readiness: 'ai_ready' });
    const blocked = await claim(open2, s.keys.helper);
    check('self-assign off: the agent cannot pick up unassigned work', blocked.status === 403 && blocked.body.error?.details?.reason === 'self_assign_off'
      && (await s.q('SELECT 1 FROM pm.task_assignees WHERE task_id = $1', [open2])).length === 0, blocked);
    const helperShared = await s.task(s.apex, 'Assigned to Helper', {}, [s.helper]);
    const stillAssigned = await claim(helperShared, s.keys.helper);
    check('self-assign off: it still claims work assigned to it', stillAssigned.status === 200, stillAssigned);
    const assignSelf = await patch(open2, s.keys.helper, { title: 'x' });
    check('self-assign off: it cannot change unassigned work either (assigned-only, as before)', assignSelf.status === 403, assignSelf.status);

    // --- next_task -------------------------------------------------------------------------
    const blocker = await s.task(s.queue, 'Open blocker');
    const doneBlocker = await s.task(s.queue, 'Done blocker', { status: 'done' });
    const P = s.planner;
    const h1 = await s.task(s.queue, 'High, due Dec 1', { priority: 'high', due_date: '2026-12-01' }, [P]);
    const h2 = await s.task(s.queue, 'High, due Nov 25', { priority: 'high', due_date: '2026-11-25' }, [P]);
    const h3 = await s.task(s.queue, 'High, blocker done, no date', { priority: 'high' }, [P]);
    await s.q('INSERT INTO pm.task_dependencies (task_id, blocked_by_task_id) VALUES ($1, $2)', [h3, doneBlocker]);
    const m1 = await s.task(s.queue, 'Medium, older', { priority: 'medium', created_at: '2026-11-01T00:00:00Z' }, [P]);
    const m2 = await s.task(s.queue, 'Medium, newer', { priority: 'medium', created_at: '2026-11-02T00:00:00Z' }, [P]);
    const l1 = await s.task(s.queue, 'Low', { priority: 'low' }, [P]);
    const u1 = await s.task(s.queue, 'Unassigned, AI Ready', { priority: 'urgent', ai_readiness: 'ai_ready' });
    const u2 = await s.task(s.queue, 'Unassigned, for a person', { priority: 'urgent' });
    await s.task(s.queue, 'Urgent backlog', { priority: 'urgent', status: 'backlog' }, [P]);
    await s.task(s.queue, 'Urgent done', { priority: 'urgent', status: 'done' }, [P]);
    await s.task(s.queue, 'Urgent in review', { priority: 'urgent', status: 'in_review' }, [P]);
    const blockedTask = await s.task(s.queue, 'Urgent but blocked', { priority: 'urgent' }, [P]);
    await s.q('INSERT INTO pm.task_dependencies (task_id, blocked_by_task_id) VALUES ($1, $2)', [blockedTask, blocker]);
    await s.task(s.queue, 'Urgent in Trash', { priority: 'urgent', deleted_at: new Date().toISOString() }, [P]);
    await s.task(s.shelved, 'Urgent in an archived project', { priority: 'urgent' }, [P]);
    const heldByHelper = await s.task(s.queue, 'Urgent, Helper has it', { priority: 'urgent' }, [P, s.helper]);
    const heldClaim = await claim(heldByHelper, s.keys.helper);
    check('(setup) Helper holds a claim', heldClaim.status === 200, heldClaim);
    const trashedParent = await s.task(s.queue, 'Parent in Trash');
    await s.task(s.queue, 'Urgent subtask of a trashed parent', { priority: 'urgent', parent_task_id: trashedParent }, [P]);
    await s.q('UPDATE pm.tasks SET deleted_at = now() WHERE id = $1', [trashedParent]);

    const order: string[] = [];
    for (let i = 0; i < 10; i++) {
      const pick = await next(s.keys.planner);
      if (pick.status !== 200 || !pick.body.data) {
        check('next_task answers 200', pick.status === 200, pick);
        break;
      }
      order.push(pick.body.data.id);
      if (pick.body.data.id === u1) {
        check('an unassigned pick says so', pick.body.data.pickup === 'unassigned', pick.body.data.pickup);
        break;
      }
      check(`an assigned pick says so (${pick.body.data.title})`, pick.body.data.pickup === 'assigned' && Array.isArray(pick.body.data.assignee_ids), pick.body.data.pickup);
      await s.q("UPDATE pm.tasks SET status = 'done' WHERE id = $1", [pick.body.data.id]);
    }
    const titles = async (ids: string[]) => (await s.q<{ id: string; title: string }>('SELECT id, title FROM pm.tasks WHERE id = ANY($1)', [ids]))
      .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)).map((t) => t.title);
    check('next_task: assigned first by priority, then due date (none last), then age; then unassigned AI Ready work; leaves out backlog, review, done, blocked, Trash, archived projects and claimed tasks',
      JSON.stringify(order) === JSON.stringify([h2, h1, h3, m1, m2, l1, u1]), await titles(order));
    const scoped = await next(s.keys.planner, s.apex);
    check('next_task: a project outside your reach is refused', scoped.status === 403, scoped.status);
    const inShelved = await next(s.keys.planner, s.shelved);
    check('next_task: project_id narrows it (nothing in an archived project)', inShelved.status === 200 && inShelved.body.data === null, inShelved);
    await setRules(s.planner, { agent_self_assign: false });
    const noPickup = await next(s.keys.planner);
    check('next_task: with self-assign off an agent gets no unassigned work', noPickup.status === 200 && noPickup.body.data === null, noPickup);
    await setRules(s.planner, { agent_self_assign: true });
    const forPat = await next(s.keys.pat);
    check('next_task: a person picks up unassigned work meant for a person, not AI Ready work', forPat.body.data?.id === u2, forPat.body.data?.title);
    await s.q("UPDATE pm.tasks SET claim_expires_at = now() - interval '1 minute' WHERE id = $1", [heldByHelper]);
    const freed = await next(s.keys.planner);
    check('next_task: a claim that ran out no longer hides the task', freed.body.data?.id === heldByHelper, freed.body.data?.title);

    // --- Incident keys -----------------------------------------------------------------------
    const incident = { project_id: s.apex, title: 'Checkout returns 500', dedupe_key: 'checkout-500', ai_readiness: 'ai_ready' };
    const firstReport = await create(s.keys.builder, incident);
    check('the first report makes a task with one occurrence', firstReport.status === 201 && firstReport.body.data?.dedupe_key === 'checkout-500'
      && (await row(firstReport.body.data!.id)).occurrences === 1, firstReport);
    const firstId = firstReport.body.data!.id as string;
    const repeat = await create(s.keys.helper, { ...incident, occurrence_note: 'Again at 10:02, cart of 3 items' });
    const repeatRow = await row(firstId);
    const note = await s.q<{ text: string; user_id: string }>('SELECT text, user_id FROM pm.task_comments WHERE task_id = $1', [firstId]);
    check('a repeat answers 200 with the open task, deduplicated, and counts it',
      repeat.status === 200 && repeat.body.data?.id === firstId && repeat.body.data?.deduplicated === true && repeat.body.data?.occurrences === 2
        && repeatRow.occurrences === 2 && !!repeatRow.last_occurred_at, repeat);
    check('the repeat\'s note is a comment by whoever reported it', note.length === 1 && note[0].text === 'Again at 10:02, cart of 3 items' && note[0].user_id === s.helper, note);
    const keyed = await s.q('SELECT 1 FROM pm.tasks WHERE dedupe_key = $1', ['checkout-500']);
    check('still one task for the key', keyed.length === 1, keyed.length);
    const elsewhere = await create(s.keys.helper, { ...incident, project_id: s.queue });
    check('the same key in another project is another incident', elsewhere.status === 201, elsewhere.status);

    const race = { project_id: s.apex, title: 'Disk almost full', dedupe_key: 'disk-full' };
    const [a, b] = await Promise.all([create(s.keys.builder, race), create(s.keys.helper, race)]);
    const raced = await s.q<{ id: string; occurrences: number }>('SELECT id, occurrences FROM pm.tasks WHERE dedupe_key = $1', ['disk-full']);
    check('two creates racing for one key end as one task counted twice',
      [a.status, b.status].sort().join() === '200,201' && raced.length === 1 && raced[0].occurrences === 2 && a.body.data?.id === b.body.data?.id, { a: a.status, b: b.status, raced });
    let duplicate = '';
    try {
      await s.q("INSERT INTO pm.tasks (project_id, title, dedupe_key) VALUES ($1, 'Disk almost full', 'disk-full')", [s.apex]);
    } catch (error) {
      duplicate = (error as Error).message;
    }
    check('the database refuses a second open task for a key', /tasks_open_dedupe_key/.test(duplicate), duplicate);

    await s.q("UPDATE pm.tasks SET status = 'done' WHERE id = $1", [firstId]);
    const afterDone = await create(s.keys.builder, incident);
    check('a repeat after the task is done makes a new task', afterDone.status === 201 && afterDone.body.data?.id !== firstId
      && (await row(firstId)).occurrences === 2, afterDone);
    const tooLong = await create(s.keys.builder, { ...incident, dedupe_key: 'x'.repeat(201) });
    check('a dedupe_key over 200 characters is refused', tooLong.status === 422, tooLong.status);

    // --- Close policy ------------------------------------------------------------------------
    const review = await setRules(s.builder, { agent_close_policy: 'review' });
    check('the close policy is set through the team route', review.status === 200 && review.body.data?.agent_close_policy === 'review', review);
    const work = await s.task(s.apex, 'Ship the receipt email', {}, [s.builder]);
    const closed = await patch(work, s.keys.builder, { status: 'done' });
    const why = await s.q<{ text: string; user_id: string }>('SELECT text, user_id FROM pm.task_comments WHERE task_id = $1', [work]);
    check('close policy review: done moves the task to In Review and the answer says so',
      closed.status === 200 && closed.body.data?.status === 'in_review' && closed.body.data?.sent_to_review === true && (await row(work)).status === 'in_review', closed);
    check('close policy review: a comment says why, under the agent\'s name', why.length === 1 && /Sent to review instead of done/.test(why[0].text) && why[0].user_id === s.builder, why);
    const otherChange = await patch(work, s.keys.builder, { priority: 'high' });
    check('close policy review: other changes pass untouched', otherChange.status === 200 && otherChange.body.data?.priority === 'high' && !otherChange.body.data?.sent_to_review, otherChange);
    const managerDone = await patch(work, s.keys.manager, { status: 'done' });
    check('a person can still finish it', managerDone.status === 200 && managerDone.body.data?.status === 'done', managerDone);
    const sub = await s.task(s.apex, 'Check the copy', { parent_task_id: work }, [s.builder]);
    const subDone = await call(subtaskRoute.PATCH, 'PATCH', `/api/v1/tasks/${work}/subtasks/${sub}`, { id: work, subtaskId: sub }, s.keys.builder, { completed: true });
    check('close policy review: ticking off a subtask sends it to review too', subDone.status === 200 && subDone.body.data?.status === 'in_review'
      && subDone.body.data?.sent_to_review === true, subDone);
    const createdDone = await create(s.keys.builder, { project_id: s.apex, title: 'Already fixed', status: 'done' });
    check('close policy review: a task created done starts In Review', createdDone.status === 201 && createdDone.body.data?.status === 'in_review'
      && createdDone.body.data?.sent_to_review === true, createdDone);

    // --- Create policy -----------------------------------------------------------------------
    const approval = await setRules(s.helper, { agent_create_policy: 'approval' });
    check('the create policy is set through the team route', approval.status === 200 && approval.body.data?.agent_create_policy === 'approval', approval);
    const tasksBefore = (await s.q('SELECT 1 FROM pm.tasks')).length;
    const suggested = await create(s.keys.helper, {
      project_id: s.apex, title: 'Add a retry to the webhook sender', description: 'It drops events on a timeout.',
      acceptance_criteria: ['Retries three times'], ai_readiness: 'ai_ready', priority: 'high', dedupe_key: 'webhook-timeouts',
    });
    const suggestionRows = await s.q<Record<string, Loose>>('SELECT * FROM pm.task_suggestions WHERE proposed_by = $1', [s.helper]);
    check('create policy approval: the answer is 202 with a suggestion, and says so',
      suggested.status === 202 && suggested.body.data?.needs_approval === true && suggested.body.data?.status === 'pending' && /approve/i.test(suggested.body.data?.note ?? ''), suggested);
    check('create policy approval: no live task, one pending suggestion carrying the spec',
      (await s.q('SELECT 1 FROM pm.tasks')).length === tasksBefore && suggestionRows.length === 1 && suggestionRows[0].goal_id === null
        && suggestionRows[0].assigned_to === s.helper && suggestionRows[0].priority === 'high'
        && suggestionRows[0].metadata?.acceptance_criteria?.[0] === 'Retries three times' && suggestionRows[0].metadata?.ai_readiness_recommendation === 'ai_ready'
        && suggestionRows[0].metadata?.dedupe_key === 'webhook-timeouts', suggestionRows);
    const suggestedAgain = await create(s.keys.helper, { project_id: s.apex, title: 'Add a retry to the webhook sender', dedupe_key: 'webhook-timeouts' });
    check('create policy approval: the same incident while it waits counts on that suggestion',
      suggestedAgain.status === 202 && suggestedAgain.body.data?.id === suggestionRows[0].id && suggestedAgain.body.data?.deduplicated === true
        && suggestedAgain.body.data?.metadata?.occurrences === 2 && (await s.q('SELECT 1 FROM pm.task_suggestions WHERE proposed_by = $1', [s.helper])).length === 1, suggestedAgain);
    const { approveTaskSuggestion } = await import('../src/lib/supabase/queries');
    const approved = (await approveTaskSuggestion(getServiceClient(), suggestionRows[0].id, {}, s.manager)).task;
    const approvedRow = await row(approved.id);
    const approvedCriteria = await s.q<{ criterion: string }>('SELECT criterion FROM pm.task_acceptance_criteria WHERE task_id = $1', [approved.id]);
    check('approving it makes the task the agent asked for, incident key included',
      approvedRow.title === 'Add a retry to the webhook sender' && approvedRow.dedupe_key === 'webhook-timeouts' && approvedRow.ai_readiness === 'ai_ready'
        && approvedRow.project_goal_id === null && approvedCriteria.map((c) => c.criterion).join() === 'Retries three times', { approvedRow, approvedCriteria });
    const afterApproval = await create(s.keys.helper, { project_id: s.apex, title: 'Add a retry to the webhook sender', dedupe_key: 'webhook-timeouts' });
    check('once approved, the next repeat counts on the live task', afterApproval.status === 200 && afterApproval.body.data?.id === approved.id, afterApproval);
    const blockerForSuggestion = await s.task(s.apex, 'Set up the retry queue');
    const rich = await create(s.keys.helper, {
      parent_task_id: helperShared, title: 'Retry with backoff', due_date: '2026-12-15', tags: ['webhooks', 'reliability'],
      blocked_by_ids: [blockerForSuggestion],
    });
    check('(setup) the rich request became a suggestion', rich.status === 202, rich);
    const richTask = (await approveTaskSuggestion(getServiceClient(), rich.body.data!.id, {}, s.manager)).task as unknown as { id: string };
    const richRow = await row(richTask.id);
    const richBlockers = await s.q<{ blocked_by_task_id: string }>('SELECT blocked_by_task_id FROM pm.task_dependencies WHERE task_id = $1', [richTask.id]);
    check('approving applies what the agent asked for: parent, due date, tags and blockers',
      richRow.parent_task_id === helperShared && richRow.due_date === '2026-12-15' && JSON.stringify(richRow.tags) === JSON.stringify(['webhooks', 'reliability'])
        && richBlockers.map((b) => b.blocked_by_task_id).join() === blockerForSuggestion, { richRow, richBlockers });
    const goneParent = await s.task(s.apex, 'A parent that will go', {}, [s.helper]);
    const orphan = await create(s.keys.helper, { parent_task_id: goneParent, title: 'Child of a parent in Trash' });
    await s.q('UPDATE pm.tasks SET deleted_at = now() WHERE id = $1', [goneParent]);
    let orphanError = '';
    let orphanRow: Record<string, Loose> | undefined;
    try {
      const orphanTask = (await approveTaskSuggestion(getServiceClient(), orphan.body.data!.id, {}, s.manager)).task as unknown as { id: string };
      orphanRow = await row(orphanTask.id);
    } catch (error) {
      orphanError = (error as Error).message;
    }
    check('a parent gone by approval time leaves the task top-level, with no error', orphanError === '' && orphanRow?.parent_task_id === null, { orphanError, orphanRow });
    const repeatOnLive = await create(s.keys.helper, { project_id: s.apex, title: 'Disk almost full', dedupe_key: 'disk-full' });
    check('create policy approval: a repeat on an open task is still counted there', repeatOnLive.status === 200 && repeatOnLive.body.data?.deduplicated === true, repeatOnLive);

    // --- Defaults change nothing ---------------------------------------------------------------
    const plain = await create(s.keys.steady, { project_id: s.apex, title: 'Update the sitemap' });
    check('defaults: a new task goes live', plain.status === 201 && !plain.body.data?.needs_approval, plain.status);
    const plainDone = await patch(plain.body.data!.id, s.keys.steady, { status: 'done' });
    check('defaults: done is done', plainDone.status === 200 && plainDone.body.data?.status === 'done' && !plainDone.body.data?.sent_to_review, plainDone);
    const plainPickup = await claim(await s.task(s.apex, 'Compress images', { ai_readiness: 'ai_ready' }), s.keys.steady);
    check('defaults: it picks up unassigned AI Ready work', plainPickup.status === 200, plainPickup);

    // --- Rules validation and escalation --------------------------------------------------------
    const onPerson = await setRules(s.pat, { agent_close_policy: 'review' });
    check('rules apply only to agent members', onPerson.status === 422, onPerson);
    const toSelf = await setRules(s.builder, { agent_escalate_to: s.builder });
    check('an agent cannot escalate to itself', toSelf.status === 422, toSelf);
    const badPolicy = await setRules(s.builder, { agent_close_policy: 'maybe' });
    check('an unknown policy is refused', badPolicy.status === 422, badPolicy.status);
    const noManage = await setRules(s.builder, { agent_self_assign: true }, s.keys.builder);
    check('setting rules needs team.manage', noManage.status === 403, noManage.status);
    const service = getServiceClient();
    check('escalation: the Owner by default', (await escalationTarget(service, s.builder)) === s.owner);
    await setRules(s.builder, { agent_escalate_to: s.manager });
    check('escalation: the member the rules name', (await escalationTarget(service, s.builder)) === s.manager);
    await s.q("UPDATE pm.team_members SET status = 'suspended' WHERE id = $1", [s.manager]);
    check('escalation: back to the Owner when that member is suspended', (await escalationTarget(service, s.builder)) === s.owner);

    await s.q("UPDATE pm.team_members SET status = 'active' WHERE id = $1", [s.manager]);

    // --- An open task again gives up a key someone else holds now ----------------------------
    const reopenA = await create(s.keys.builder, { project_id: s.apex, title: 'Queue stalls', dedupe_key: 'queue-stall' });
    await s.q("UPDATE pm.tasks SET status = 'done' WHERE id = $1", [reopenA.body.data!.id]);
    const reopenB = await create(s.keys.builder, { project_id: s.apex, title: 'Queue stalls', dedupe_key: 'queue-stall' });
    const reopened = await patch(reopenA.body.data!.id, s.keys.manager, { status: 'todo' });
    check('reopening a done task whose key another open task holds now works; the reopened one gives up the key',
      reopenB.status === 201 && reopened.status === 200 && (await row(reopenA.body.data!.id)).dedupe_key === null
        && (await row(reopenB.body.data!.id)).dedupe_key === 'queue-stall', { reopenB: reopenB.status, reopened });
    const counted = await create(s.keys.builder, { project_id: s.apex, title: 'Queue stalls', dedupe_key: 'queue-stall' });
    check('the open task that held the key keeps counting', counted.status === 200 && counted.body.data?.id === reopenB.body.data?.id, counted.status);
    const trashedA = await create(s.keys.builder, { project_id: s.apex, title: 'Cron missed', dedupe_key: 'cron-missed' });
    await s.q('UPDATE pm.tasks SET deleted_at = now() WHERE id = $1', [trashedA.body.data!.id]);
    const trashedB = await create(s.keys.builder, { project_id: s.apex, title: 'Cron missed', dedupe_key: 'cron-missed' });
    let restoreError = '';
    try {
      await s.q('UPDATE pm.tasks SET deleted_at = NULL WHERE id = $1', [trashedA.body.data!.id]);
    } catch (error) {
      restoreError = (error as Error).message;
    }
    check('restoring a task from Trash whose key another open task holds works; it gives up the key',
      trashedB.status === 201 && restoreError === '' && (await row(trashedA.body.data!.id)).dedupe_key === null
        && (await row(trashedB.body.data!.id)).dedupe_key === 'cron-missed', restoreError);
    const movingA = await create(s.keys.manager, { project_id: s.queue, title: 'Cache cold', dedupe_key: 'cache-cold' });
    const stayingB = await create(s.keys.manager, { project_id: s.apex, title: 'Cache cold', dedupe_key: 'cache-cold' });
    const moved = await patch(movingA.body.data!.id, s.keys.manager, { project_id: s.apex });
    check('moving a task into a project where its key is open works; it gives up the key',
      stayingB.status === 201 && moved.status === 200 && (await row(movingA.body.data!.id)).dedupe_key === null
        && (await row(stayingB.body.data!.id)).dedupe_key === 'cache-cold', moved);
    const keepsKey = await create(s.keys.builder, { project_id: s.apex, title: 'Lone incident', dedupe_key: 'lone' });
    await s.q("UPDATE pm.tasks SET status = 'done' WHERE id = $1", [keepsKey.body.data!.id]);
    await patch(keepsKey.body.data!.id, s.keys.manager, { status: 'todo' });
    check('a reopened task keeps its key when no other open task holds it', (await row(keepsKey.body.data!.id)).dedupe_key === 'lone');

    // --- Self-assign off covers assigning yourself by PATCH -----------------------------------
    const bossOpen = await s.task(s.apex, 'Unassigned for Boss', { ai_readiness: 'ai_ready' });
    const bossSelf = await patch(bossOpen, s.keys.boss, { assignee_ids: [s.boss] });
    check('self-assign off: a manage_all agent cannot assign itself by PATCH', bossSelf.status === 403 && bossSelf.body.error?.details?.reason === 'self_assign_off'
      && (await s.q('SELECT 1 FROM pm.task_assignees WHERE task_id = $1', [bossOpen])).length === 0, bossSelf);
    const othersTask = await s.task(s.apex, 'Steady has it', {}, [s.steady]);
    const bossJoin = await patch(othersTask, s.keys.boss, { assignee_ids: [s.steady, s.boss] });
    check('self-assign off: nor add itself beside someone else', bossJoin.status === 403 && bossJoin.body.error?.details?.reason === 'self_assign_off', bossJoin.status);
    const bossOwn = await s.task(s.apex, 'Already Boss\'s', {}, [s.boss]);
    const bossAddsOther = await patch(bossOwn, s.keys.boss, { assignee_ids: [s.boss, s.steady] });
    check('self-assign off: it can still assign others on a task it is already on', bossAddsOther.status === 200, bossAddsOther);
    const bossAssignsOther = await patch(bossOpen, s.keys.boss, { assignee_ids: [s.steady] });
    check('self-assign off: and assign others to unassigned work', bossAssignsOther.status === 200, bossAssignsOther.status);
    const chiefOpen = await s.task(s.apex, 'Unassigned for Chief');
    const chiefSelf = await patch(chiefOpen, s.keys.chief, { assignee_ids: [s.chief] });
    check('defaults: a manage_all agent still assigns itself by PATCH', chiefSelf.status === 200, chiefSelf);

    // --- Claim-made assignments go back to the pool ---------------------------------------------
    const pooled = await s.task(s.pool, 'Reindex search', { priority: 'urgent', ai_readiness: 'ai_ready' });
    const steadyPick = await next(s.keys.steady, s.pool);
    const steadyClaim = await claim(pooled, s.keys.steady);
    check('(setup) Steady picks the unassigned task and claims it', steadyPick.body.data?.id === pooled && steadyClaim.status === 200
      && steadyClaim.body.data?.assigned_to_you === true, steadyClaim);
    await s.q("UPDATE pm.tasks SET claim_expires_at = now() - interval '1 minute' WHERE id = $1", [pooled]);
    const chiefPick = await next(s.keys.chief, s.pool);
    check('a crashed agent\'s claim ran out: the task is back in the pool for the next agent', chiefPick.body.data?.id === pooled
      && chiefPick.body.data?.pickup === 'unassigned', chiefPick.body.data);
    const chiefClaim = await claim(pooled, s.keys.chief);
    const pooledAssignees = (await s.q<{ member_id: string }>('SELECT member_id FROM pm.task_assignees WHERE task_id = $1', [pooled])).map((a) => a.member_id);
    check('the next agent claims it and the assignment moves to it', chiefClaim.status === 200 && chiefClaim.body.data?.claimed_by === s.chief
      && pooledAssignees.join() === s.chief, { chiefClaim: chiefClaim.status, pooledAssignees });
    const chiefRelease = await release(pooled, s.keys.chief);
    check('releasing a claim that assigned the task gives it back unassigned', chiefRelease.status === 200 && chiefRelease.body.data?.unassigned === true
      && (await s.q('SELECT 1 FROM pm.task_assignees WHERE task_id = $1', [pooled])).length === 0, chiefRelease);
    const personMade = await s.task(s.pool, 'Rotate certificates', {}, [s.chief]);
    await claim(personMade, s.keys.chief);
    const keptRelease = await release(personMade, s.keys.chief);
    check('releasing a claim on work a person assigned keeps the assignment', keptRelease.status === 200 && keptRelease.body.data?.unassigned === false
      && (await s.q('SELECT 1 FROM pm.task_assignees WHERE task_id = $1 AND member_id = $2', [personMade, s.chief])).length === 1, keptRelease);
    const personMadeSteady = await s.task(s.pool, 'Steady was given this', { ai_readiness: 'ai_ready' }, [s.steady]);
    await claim(personMadeSteady, s.keys.steady);
    await s.q("UPDATE pm.tasks SET claim_expires_at = now() - interval '1 minute' WHERE id = $1", [personMadeSteady]);
    const notPooled = await claim(personMadeSteady, s.keys.chief);
    const chiefNext = await next(s.keys.chief, s.pool);
    check('a person\'s assignment is never undone by a claim running out', notPooled.status === 403 && chiefNext.body.data?.id !== personMadeSteady
      && (await s.q('SELECT 1 FROM pm.task_assignees WHERE task_id = $1 AND member_id = $2', [personMadeSteady, s.steady])).length === 1, { notPooled: notPooled.status, next: chiefNext.body.data?.title });
    const steadyBack = await claim(personMadeSteady, s.keys.steady);
    check('and its assignee can claim it again', steadyBack.status === 200, steadyBack.status);
    const reassigned = await s.task(s.pool, 'Picked, then assigned by a person', { ai_readiness: 'ai_ready' });
    await claim(reassigned, s.keys.steady);
    await patch(reassigned, s.keys.chief, { assignee_ids: [] });
    await patch(reassigned, s.keys.chief, { assignee_ids: [s.steady] });
    await s.q("UPDATE pm.tasks SET claim_expires_at = now() - interval '1 minute' WHERE id = $1", [reassigned]);
    const afterPatch = await claim(reassigned, s.keys.chief);
    check('once a PATCH assigns the claimer, the assignment is a person\'s and stays', afterPatch.status === 403
      && (await s.q('SELECT 1 FROM pm.task_assignees WHERE task_id = $1 AND member_id = $2', [reassigned, s.steady])).length === 1, afterPatch.status);
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`agent work blocks: ${passed} checks passed, ${failures.length} failed:`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log(`agent work blocks: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
