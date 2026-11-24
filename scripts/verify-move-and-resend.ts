/**
 * Moving a task to another project, and sending a message back to the agent,
 * on the full schema through the real routes and services (v1 routes with
 * keys, MCP tools over them, the app's move and inbox services, a fake
 * PostgREST and Storage over PGlite):
 * - a move keeps comments, files, subtasks (they follow the parent),
 *   reminders, links, activity and claims; uploads are copied to the new
 *   project's folder and still open, a linked project file stays as a link,
 *   the goal is cleared, the conversation it came from is filed on the new
 *   project and the agent's plan item names it;
 * - everyone on the task is checked against the new project: nobody is
 *   given access silently; the move is refused by name until they are taken
 *   off or added to the project, and only someone who may do that can;
 * - the API and MCP refuse a move without the right to create tasks in the
 *   target, to a project out of reach, and of a subtask, with the same words
 *   as before where they existed;
 * - moving a conversation moves the tasks the agent made from it, when asked;
 * - send back, after the agent's task was deleted and the conversation's
 *   project changed: the message is planned again under the new project
 *   (the queue and the signal show it), the old plan's waiting items are
 *   settled as superseded (so a new question can be asked), the context says
 *   it was sent back, and the new plan is the one the thread shows.
 *
 *   npm run -s test:move-and-resend
 */
import { createHash, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';
import { createFullSchemaDatabase } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';
import { FakeStorage } from './inbound-email-fixtures';
import { BUCKETS } from '../src/lib/supabase/schema';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 900)}`);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- answers are untyped JSON read field by field
type Loose = any;
type Row = Record<string, unknown>;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ids = {
  owner: id(1), planner: id(2), pat: id(3), mia: id(4), scout: id(5),
  hi: id(10), p4tf: id(11), other: id(12), third: id(13),
  inbox: id(20),
};
let next = 100;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function seed(db: PGlite) {
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  await db.exec(`
    INSERT INTO pm.team_members (id, name, email, role) VALUES
      ('${ids.owner}', 'Morgan Lee', 'owner@agency.example', 'owner'),
      ('${ids.planner}', 'Ashley A.', 'ashley-bot@agency.example', 'agent'),
      ('${ids.pat}', 'Pat Rivera', 'pat@agency.example', 'member'),
      ('${ids.mia}', 'Mia Chen', 'mia@agency.example', 'member'),
      ('${ids.scout}', 'Scout', 'scout-bot@agency.example', 'agent');
    INSERT INTO pm.projects (id, name, status) VALUES
      ('${ids.hi}', 'Happy Innovations', 'active'), ('${ids.p4tf}', 'Plan4TheFuture', 'active'), ('${ids.other}', 'Other', 'active'), ('${ids.third}', 'Third', 'active');
    -- Pat works on Happy Innovations only; Mia on both; Scout reaches Happy Innovations through the API.
    INSERT INTO pm.project_members (project_id, member_id) VALUES
      ('${ids.hi}', '${ids.pat}'), ('${ids.hi}', '${ids.mia}'), ('${ids.p4tf}', '${ids.mia}'), ('${ids.third}', '${ids.mia}'), ('${ids.hi}', '${ids.scout}');
    UPDATE pm.business_settings SET inbound_email_domain = 'relay.example.test';
    INSERT INTO pm.inboxes (id, name, address, handler_member_id, triage_mode)
      VALUES ('${ids.inbox}', 'Happy Innovations', 'hi@agency.example', '${ids.planner}', 'plans');
  `);
  const permissions = ['inbound_email.read', 'inbound_email.triage', 'inbound_email.signal', 'tasks.read', 'tasks.create', 'tasks.manage_all',
    'projects.read', 'projects.read_all', 'reminders.manage_own', 'files.read', 'files.upload', 'project_context.manage', 'project_members.manage'];
  await db.query(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
    SELECT $1, key, 'api', 'allow' FROM unnest($2::text[]) AS key ON CONFLICT DO NOTHING`, [ids.planner, permissions]);
  await db.query(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
    SELECT $1, key, 'api', 'allow' FROM unnest(ARRAY['projects.read', 'tasks.read', 'tasks.create', 'tasks.manage_assigned']) AS key ON CONFLICT DO NOTHING`, [ids.scout]);
  const key = async (member: string, scopes: string[]) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await db.query(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
      VALUES ('Key', 'pk_live', $1, $2, $3, 'scoped')`, [sha(secret), member, scopes]);
    return secret;
  };
  return {
    planner: await key(ids.planner, permissions),
    // Every task, but no right to create one.
    noCreate: await key(ids.planner, permissions.filter((p) => p !== 'tasks.create')),
    // Reaches only the projects it belongs to.
    scoped: await key(ids.scout, ['projects.read', 'tasks.read', 'tasks.create', 'tasks.manage_assigned']),
  };
}

/** A conversation with one message in the inbox; returns both ids. */
async function message(db: PGlite, fields: { conversation?: string; minutesAgo?: number; status?: string; candidates?: string[]; subject?: string } = {}) {
  const conversation = fields.conversation ?? id(next++);
  const received = new Date(Date.now() - (fields.minutesAgo ?? 30) * 60_000).toISOString();
  if (!fields.conversation) await db.query('INSERT INTO pm.conversations (id, inbox_id, last_message_at) VALUES ($1, $2, $3)', [conversation, ids.inbox, received]);
  else await db.query('UPDATE pm.conversations SET last_message_at = $2 WHERE id = $1', [conversation, received]);
  const messageId = id(next++);
  await db.query(`INSERT INTO pm.messages (id, inbox_id, thread_id, status, provider, provider_email_id, internet_message_id,
      received_at, subject, kind, auth, sender_verified, delivery, text_body, new_text)
    VALUES ($1, $2, $3, $4, 'test', $7, $7, $5, $6, 'person', '{"trust":"trusted"}', true, 'direct', 'Please set up the retirement plan review.', 'Please set up the retirement plan review.')`, [
    messageId, ids.inbox, conversation, fields.status ?? 'new', received, fields.subject ?? 'Plan review', `m-${messageId}`,
  ]);
  await db.query("INSERT INTO pm.participants (message_id, kind, address) VALUES ($1, 'from', 'jo@plan4thefuture.example')", [messageId]);
  await db.query("INSERT INTO pm.participants (message_id, kind, address) VALUES ($1, 'to', 'hi@agency.example')", [messageId]);
  for (const project of fields.candidates ?? [ids.hi]) {
    await db.query("INSERT INTO pm.message_candidates (message_id, project_id, reason) VALUES ($1, $2, 'sender')", [messageId, project]);
  }
  return { conversation, message: messageId };
}

async function main() {
  const db = await createFullSchemaDatabase();
  await db.exec('RESET ROLE');
  const keys = await seed(db);
  const storage = new FakeStorage();
  const server = await startFakePostgrest(db, { handle: storage.handler });
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key' });
  const q = async <T = Loose>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };

  const taskRoute = await import('../src/app/api/v1/tasks/[id]/route');
  const planRoute = await import('../src/app/api/v1/inbox/messages/[id]/plan/route');
  const contextRoute = await import('../src/app/api/v1/inbox/messages/[id]/context/route');
  const queueRoute = await import('../src/app/api/v1/inbox/queue/route');
  const signalRoute = await import('../src/app/api/v1/inbox/signal/route');
  const { moveTask, planTaskMove } = await import('../src/lib/api/task-move');
  const { ApiError } = await import('../src/lib/api/errors');
  const inbox = await import('../src/lib/communications/inbox-service');
  const links = await import('../src/lib/communications/inbox-links');
  const { PM_TOOLS } = await import('../src/lib/mcp/tools');
  const { outcomeResult, routeCaller } = await import('../src/lib/mcp/server');
  const { resolveMemberAccess } = await import('../src/lib/api/access');
  const { getActorClient, getServiceClient } = await import('../src/lib/api/supabase-service');
  const { moveToTrash } = await import('../src/lib/supabase/trash');
  const service = getServiceClient();

  const call = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, key: string, params: Record<string, string> = {}, body?: unknown) => {
    const response = await handler(new NextRequest(`http://localhost${path}`, {
      method,
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { params: Promise.resolve(params) } as never);
    return { status: response.status, body: await response.json() as Loose };
  };
  const patch = (taskId: string, key: string, body: unknown) => call(taskRoute.PATCH, 'PATCH', `/api/v1/tasks/${taskId}`, key, { id: taskId }, body);
  const runTool = async (apiKey: string, memberId: string, name: string, args: Record<string, unknown>) => {
    const tool = PM_TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return outcomeResult(await tool.run(tool.input.parse(args) as Record<string, unknown>, routeCaller({ key: apiKey, origin: 'http://localhost' }), { memberId }), tool.write) as Loose;
  };
  const appActor = async (memberId: string) => ({ db: getActorClient(memberId, 'app'), access: (await resolveMemberAccess(service, memberId))!, memberId, channel: 'app' as const });
  const ownerCtx = async () => ({ service, access: (await resolveMemberAccess(service, ids.owner))!, memberId: ids.owner });
  const refusal = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return null;
    } catch (error) {
      if (error instanceof ApiError) return { status: error.statusCode, code: error.code, message: error.message, details: error.details as Loose };
      throw error;
    }
  };
  const newTask = async (project: string, title: string, fields: { parent?: string; assignees?: string[]; createdBy?: string } = {}) => {
    const [row] = await q<{ id: string }>('INSERT INTO pm.tasks (project_id, title, parent_task_id, created_by) VALUES ($1, $2, $3, $4) RETURNING id', [project, title, fields.parent ?? null, fields.createdBy ?? ids.owner]);
    for (const member of fields.assignees ?? []) await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [row.id, member]);
    return row.id;
  };

  try {
    // ---- Preconditions ------------------------------------------------------------------
    const patAccess = (await resolveMemberAccess(service, ids.pat))!;
    check('setup: Pat opens Happy Innovations and not Plan4TheFuture', patAccess.project_ids.includes(ids.hi) && !patAccess.project_ids.includes(ids.p4tf), patAccess.project_ids);

    // ---- A move keeps everything ----------------------------------------------------------
    const [goal] = await q<{ id: string }>("INSERT INTO pm.project_goals (project_id, title) VALUES ($1, 'Launch') RETURNING id", [ids.hi]);
    const task = await newTask(ids.hi, 'Retirement plan review', { assignees: [ids.pat] });
    await q('UPDATE pm.tasks SET project_goal_id = $1 WHERE id = $2', [goal.id, task]);
    const subtask = await newTask(ids.hi, 'Collect statements', { parent: task, assignees: [ids.mia] });
    await q('INSERT INTO pm.task_comments (task_id, user_id, text) VALUES ($1, $2, $3)', [task, ids.owner, 'Jo sent the forms.']);
    await q("INSERT INTO pm.reminders (title, owner_id, created_by, task_id, project_id, remind_on) VALUES ('Chase Jo', $1, $1, $2, $3, '2026-12-01')", [ids.owner, task, ids.hi]);
    await q("UPDATE pm.tasks SET claimed_by = $1, claimed_at = now(), claim_expires_at = now() + interval '1 hour' WHERE id = $2", [ids.planner, task]);
    const bytes = Buffer.from('statement scan');
    storage.objects.set(`${BUCKETS.taskFiles}/${ids.hi}/${sha(bytes)}`, { bytes, contentType: 'application/pdf' });
    await q(`INSERT INTO pm.task_files (task_id, kind, storage_path, sha256, name, mime_type, file_size, added_by)
      VALUES ($1, 'upload', $2, $3, 'statement.pdf', 'application/pdf', $4, $5)`, [task, `${ids.hi}/${sha(bytes)}`, sha(bytes), bytes.length, ids.owner]);
    const [brief] = await q<{ id: string }>(`INSERT INTO pm.entity_files (entity_type, entity_id, name, file_url, mime_type, file_size)
      VALUES ('project', $1, 'brief.pdf', 'https://files.example.com/brief.pdf', 'application/pdf', 10) RETURNING id`, [ids.hi]);
    await q("INSERT INTO pm.task_files (task_id, kind, entity_file_id, name, added_by) VALUES ($1, 'project_file', $2, 'brief.pdf', $3)", [task, brief.id, ids.owner]);
    await q("INSERT INTO pm.task_files (task_id, kind, url, name, added_by) VALUES ($1, 'link', 'https://loom.example.com/v/1', 'Walkthrough', $2)", [task, ids.owner]);
    // The email it came from, with the agent's plan item that made it.
    const source = await message(db, { status: 'handled' });
    await q("INSERT INTO pm.task_links (message_id, task_id, relation, linked_by) VALUES ($1, $2, 'created', $3)", [source.message, task, ids.planner]);
    await q("INSERT INTO pm.conversation_projects (conversation_id, project_id, source) VALUES ($1, $2, 'guessed')", [source.conversation, ids.hi]);
    const [oldPlan] = await q<{ id: string }>("INSERT INTO pm.plans (message_id, conversation_id, member_id, mode, status, summary) VALUES ($1, $2, $3, 'live', 'applied', 'Filed it') RETURNING id", [source.message, source.conversation, ids.planner]);
    const [madeItem] = await q<{ id: string }>(`INSERT INTO pm.plan_items (plan_id, position, conversation_id, mode, type, intent, project_id, task_id, payload, decision, state)
      VALUES ($1, 0, $2, 'live', 'create_task', 'new_work', $3, $4, '{}'::jsonb, 'apply', 'done') RETURNING id`, [oldPlan.id, source.conversation, ids.hi, task]);

    const owner = await appActor(ids.owner);
    const plan = await planTaskMove(owner, task, ids.p4tf);
    check('access: Pat, assigned, cannot open the new project and is named', plan.losing.length === 1 && plan.losing[0].id === ids.pat && plan.losing[0].on.includes('assigned') && plan.losing[0].can_be_added, plan.losing);
    check('access: the subtask is planned to go along', plan.subtask_ids.length === 1 && plan.subtask_ids[0] === subtask, plan.subtask_ids);
    check('access: an Owner may take people off or add them', plan.can_unassign && plan.can_add_members, plan);
    const refused = await refusal(() => moveTask(owner, task, ids.p4tf));
    check('access: without a choice the move is refused, naming who loses it', refused?.status === 409 && refused.code === 'PEOPLE_LOSE_ACCESS' && /Pat Rivera/.test(refused.message), refused);
    const [stayed] = await q('SELECT project_id FROM pm.tasks WHERE id = $1', [task]);
    check('access: a refused move changes nothing', stayed.project_id === ids.hi, stayed);
    check('access: nobody was given access by the refusal', (await q('SELECT 1 FROM pm.project_members WHERE project_id = $1 AND member_id = $2', [ids.p4tf, ids.pat])).length === 0);

    const moved = await moveTask(owner, task, ids.p4tf, 'add_to_project');
    check('move: Pat is added to the project only because it was asked', moved.added_to_project.includes(ids.pat)
      && (await q('SELECT 1 FROM pm.project_members WHERE project_id = $1 AND member_id = $2', [ids.p4tf, ids.pat])).length === 1, moved);
    const [after] = await q('SELECT project_id, project_goal_id, claimed_by FROM pm.tasks WHERE id = $1', [task]);
    check('move: the task is in the new project, its goal (the old project\'s) cleared', after.project_id === ids.p4tf && after.project_goal_id === null, after);
    check('move: the claim stays with someone who can open the new project', after.claimed_by === ids.planner, after);
    const [sub] = await q('SELECT project_id FROM pm.tasks WHERE id = $1', [subtask]);
    check('move: the subtask followed its parent', sub.project_id === ids.p4tf, sub);
    check('move: Pat and Mia stay assigned', (await q('SELECT member_id FROM pm.task_assignees WHERE task_id IN ($1, $2) ORDER BY member_id', [task, subtask])).length === 2);
    check('move: comments are still on the task', (await q('SELECT 1 FROM pm.task_comments WHERE task_id = $1', [task])).length === 1);
    const [reminder] = await q("SELECT project_id FROM pm.reminders WHERE task_id = $1", [task]);
    check('move: the task\'s reminder names the new project', reminder.project_id === ids.p4tf, reminder);
    const files = await q<Row>('SELECT kind, storage_path, url, entity_file_id FROM pm.task_files WHERE task_id = $1 ORDER BY name', [task]);
    const upload = files.find((f) => f.kind === 'upload');
    check('move: the upload is stored in the new project\'s folder', upload?.storage_path === `${ids.p4tf}/${sha(bytes)}` && storage.objects.has(`${BUCKETS.taskFiles}/${ids.p4tf}/${sha(bytes)}`), files);
    check('move: the old object stays for anything still pointing at it', storage.objects.has(`${BUCKETS.taskFiles}/${ids.hi}/${sha(bytes)}`));
    check('move: the old project\'s file stays on the task as a link to it', files.some((f) => f.kind === 'link' && f.url === 'https://files.example.com/brief.pdf' && f.entity_file_id === null)
      && files.some((f) => f.kind === 'link' && f.url === 'https://loom.example.com/v/1'), files);
    const { taskFileLink } = await import('../src/lib/task-files/service');
    const [uploadRow] = await q<{ id: string }>("SELECT id FROM pm.task_files WHERE task_id = $1 AND kind = 'upload'", [task]);
    const link = await taskFileLink({ db: service, access: owner.access, memberId: ids.owner, channel: 'app' }, task, uploadRow.id).catch((error: Error) => ({ error: error.message }));
    check('move: the upload still opens from the task', 'url' in link && typeof link.url === 'string', link);
    const filed = await q('SELECT source FROM pm.conversation_projects WHERE conversation_id = $1 AND project_id = $2', [source.conversation, ids.p4tf]);
    check('move: the conversation it came from is filed on the new project, as the person\'s', filed.length === 1 && filed[0].source === 'person', filed);
    const [item] = await q('SELECT project_id FROM pm.plan_items WHERE id = $1', [madeItem.id]);
    check('move: the agent\'s plan item names the new project', item.project_id === ids.p4tf, item);
    check('move: the link to the email stays', (await q('SELECT 1 FROM pm.task_links WHERE task_id = $1', [task])).length === 1);
    const events = await q("SELECT 1 FROM pm.task_events WHERE task_id = $1", [task]);
    check('move: its activity stays on the task', events.length > 0, events.length);

    // Remove them: taken off the task and its claim, never added.
    const second = await newTask(ids.hi, 'Quarterly summary', { assignees: [ids.pat, ids.mia] });
    await q("UPDATE pm.tasks SET claimed_by = $1, claimed_at = now(), claim_expires_at = now() + interval '1 hour' WHERE id = $2", [ids.scout, second]);
    const secondPlan = await planTaskMove(owner, second, ids.other);
    check('access: a claim counts too', secondPlan.losing.some((m) => m.id === ids.scout && m.on.includes('claimed')), secondPlan.losing);
    const removed = await moveTask(owner, second, ids.other, 'unassign');
    const [secondAfter] = await q('SELECT project_id, claimed_by FROM pm.tasks WHERE id = $1', [second]);
    const left = (await q<{ member_id: string }>('SELECT member_id FROM pm.task_assignees WHERE task_id = $1', [second])).map((r) => r.member_id);
    check('unassign: the task moves, Pat and Mia are taken off, the claim ends', secondAfter.project_id === ids.other && secondAfter.claimed_by === null && left.length === 0
      && removed.removed.includes(ids.pat), { secondAfter, left, removed });
    check('unassign: nobody was added to the project', (await q('SELECT 1 FROM pm.project_members WHERE project_id = $1', [ids.other])).length === 0);

    // Storage fails while copying: the task stays where it was, its files untouched.
    const stuckBytes = Buffer.from('a contract scan');
    const stuck = await newTask(ids.hi, 'Contract review');
    storage.objects.set(`${BUCKETS.taskFiles}/${ids.hi}/${sha(stuckBytes)}`, { bytes: stuckBytes, contentType: 'application/pdf' });
    await q(`INSERT INTO pm.task_files (task_id, kind, storage_path, sha256, name, mime_type, file_size, added_by)
      VALUES ($1, 'upload', $2, $3, 'contract.pdf', 'application/pdf', $4, $5)`, [stuck, `${ids.hi}/${sha(stuckBytes)}`, sha(stuckBytes), stuckBytes.length, ids.owner]);
    storage.failCopies = true;
    const storageDown = await refusal(() => moveTask(owner, stuck, ids.p4tf));
    const apiDown = await patch(stuck, keys.planner, { project_id: ids.p4tf });
    storage.failCopies = false;
    const [stuckAfter] = await q('SELECT project_id FROM pm.tasks WHERE id = $1', [stuck]);
    const [stuckFile] = await q("SELECT storage_path FROM pm.task_files WHERE task_id = $1", [stuck]);
    check('storage: a failed copy refuses the move, in the app and the API', storageDown?.status === 502 && apiDown.status === 502, { storageDown, api: apiDown.body });
    check('storage: the task stayed where it was, its file still pointing at its object', stuckAfter.project_id === ids.hi && stuckFile.storage_path === `${ids.hi}/${sha(stuckBytes)}`, { stuckAfter, stuckFile });
    const retried = await moveTask(owner, stuck, ids.p4tf).catch((error: Error) => ({ error: error.message }));
    check('storage: once Storage is back the move goes through', 'to' in retried && storage.objects.has(`${BUCKETS.taskFiles}/${ids.p4tf}/${sha(stuckBytes)}`), retried);

    // A subtask in Trash moves with its parent: its files and its people count.
    const parentOfTrashed = await newTask(ids.hi, 'Annual filing');
    const trashedSub = await newTask(ids.hi, 'Old checklist', { parent: parentOfTrashed, assignees: [ids.pat] });
    const trashedBytes = Buffer.from('an old checklist');
    storage.objects.set(`${BUCKETS.taskFiles}/${ids.hi}/${sha(trashedBytes)}`, { bytes: trashedBytes, contentType: 'application/pdf' });
    await q(`INSERT INTO pm.task_files (task_id, kind, storage_path, sha256, name, mime_type, file_size, added_by)
      VALUES ($1, 'upload', $2, $3, 'checklist.pdf', 'application/pdf', $4, $5)`, [trashedSub, `${ids.hi}/${sha(trashedBytes)}`, sha(trashedBytes), trashedBytes.length, ids.owner]);
    await q('UPDATE pm.tasks SET deleted_at = now(), deleted_by = $1 WHERE id = $2', [ids.owner, trashedSub]);
    const trashedPlan = await planTaskMove(owner, parentOfTrashed, ids.third);
    check('trash: the subtask in Trash is planned to go along, apart from the live ones', trashedPlan.trashed_subtask_ids.includes(trashedSub) && trashedPlan.subtask_ids.length === 0, trashedPlan);
    check('trash: its assignee who cannot open the project is named', trashedPlan.losing.some((m) => m.id === ids.pat), trashedPlan.losing);
    const trashedMove = await moveTask(owner, parentOfTrashed, ids.third, 'unassign');
    const [trashedAfter] = await q('SELECT project_id, deleted_at FROM pm.tasks WHERE id = $1', [trashedSub]);
    const [trashedFile] = await q('SELECT storage_path FROM pm.task_files WHERE task_id = $1', [trashedSub]);
    check('trash: it moved, still in Trash, and counts as no live subtask', trashedAfter.project_id === ids.third && trashedAfter.deleted_at !== null && trashedMove.subtasks_moved === 0, { trashedAfter, trashedMove });
    check('trash: its upload points at the new project object, so a restore opens it', trashedFile.storage_path === `${ids.third}/${sha(trashedBytes)}`
      && storage.objects.has(`${BUCKETS.taskFiles}/${ids.third}/${sha(trashedBytes)}`), trashedFile);
    check('trash: the assignee is taken off it too', (await q('SELECT 1 FROM pm.task_assignees WHERE task_id = $1', [trashedSub])).length === 0);

    // A member who works only their own tasks.
    const mia = await appActor(ids.mia);
    const miaOwn = await newTask(ids.hi, 'Mia\'s own', { assignees: [ids.mia] });
    const notMia = await newTask(ids.hi, 'Someone else\'s');
    const miaMove = await moveTask(mia, miaOwn, ids.p4tf).catch((error: Error) => ({ error: error.message }));
    check('member: Mia moves a task of her own to a project she can add tasks to', 'to' in miaMove && miaMove.to.id === ids.p4tf, miaMove);
    const miaOther = await refusal(() => moveTask(mia, notMia, ids.p4tf));
    check('member: a task that is not hers is refused', miaOther?.status === 403, miaOther);
    const patTask = await newTask(ids.hi, 'Pat and Mia', { assignees: [ids.mia, ids.pat] });
    const miaUnassign = await refusal(() => moveTask(mia, patTask, ids.third, 'unassign'));
    check('member: only someone who manages every task may take people off', miaUnassign?.status === 403 && miaUnassign.details?.reason === 'cannot_unassign', miaUnassign);
    const miaAdd = await refusal(() => moveTask(mia, patTask, ids.third, 'add_to_project'));
    check('member: only someone who manages members may add them', miaAdd?.status === 403 && miaAdd.details?.reason === 'cannot_add_members', miaAdd);
    const miaHidden = await refusal(() => moveTask(mia, miaOwn, ids.other));
    check('member: a project out of reach is refused', miaHidden?.status === 403 && miaHidden.details?.reason === 'project_scope', miaHidden);
    const subRefusal = await refusal(() => moveTask(owner, subtask, ids.hi));
    check('rules: a subtask moves with its parent, not alone', subRefusal?.status === 400 && /parent/.test(subRefusal.message), subRefusal);
    const blocker = await newTask(ids.hi, 'Blocker');
    const blocked = await newTask(ids.hi, 'Blocked');
    await q('INSERT INTO pm.task_dependencies (task_id, blocked_by_task_id) VALUES ($1, $2)', [blocked, blocker]);
    const blocksOthers = await refusal(() => moveTask(owner, blocker, ids.p4tf));
    check('rules: a task that blocks one staying behind is refused, so no title crosses projects', blocksOthers?.status === 400 && /blocks/.test(blocksOthers.message), blocksOthers);

    // ---- API and MCP -----------------------------------------------------------------------
    const apiTask = await newTask(ids.hi, 'Over the API', { assignees: [ids.pat] });
    const noCreate = await patch(apiTask, keys.noCreate, { project_id: ids.p4tf });
    check('api: moving without the right to create tasks there is refused', noCreate.status === 403 && noCreate.body.error?.details?.reason === 'missing_create_permission', noCreate.body);
    const scoutTask = await newTask(ids.hi, 'Scout\'s task', { assignees: [ids.scout] });
    const scoped = await patch(scoutTask, keys.scoped, { project_id: ids.p4tf });
    check('api: a project out of the key\'s reach is refused as before', scoped.status === 403 && scoped.body.error?.message === 'Project scope denied' && scoped.body.error?.details?.reason === 'project_scope', scoped.body);
    const people = await patch(apiTask, keys.planner, { project_id: ids.other });
    check('api: someone who would lose it refuses the move, with the words as before and who it is',
      people.status === 400 && people.body.error?.message === 'assignee_ids must reference members who can open this project'
        && people.body.error?.details?.reason === 'people_lose_access' && people.body.error.details.members?.[0]?.id === ids.pat, people.body);
    const unassigned = await patch(apiTask, keys.planner, { project_id: ids.other, lost_access: 'unassign' });
    check('api: lost_access unassign moves it and takes them off', unassigned.status === 200 && unassigned.body.data?.project_id === ids.other
      && unassigned.body.data?.removed?.includes(ids.pat), unassigned.body);
    const apiSub = await newTask(ids.hi, 'API parent');
    const apiChild = await newTask(ids.hi, 'API child', { parent: apiSub });
    const subApi = await patch(apiChild, keys.planner, { project_id: ids.p4tf });
    check('api: a subtask is refused with the words as before', subApi.status === 400
      && subApi.body.error?.message === "A subtask stays in its parent task's project. Move the parent, or make it top-level first (parent_task_id: null)", subApi.body);
    const plain = await patch(apiSub, keys.planner, { project_id: ids.p4tf });
    const [plainChild] = await q('SELECT project_id FROM pm.tasks WHERE id = $1', [apiChild]);
    check('api: a plain move answers the task row, its subtask along', plain.status === 200 && plain.body.data?.project_id === ids.p4tf && plain.body.data?.removed === undefined
      && plainChild.project_id === ids.p4tf, plain.body);
    const mcpTask = await newTask(ids.hi, 'Over MCP');
    const mcpRefused = await runTool(keys.noCreate, ids.planner, 'update_task', { task_id: mcpTask, project_id: ids.p4tf });
    check('mcp: update_task refuses a move without the right to create tasks there', mcpRefused.structuredContent?.ok === false && mcpRefused.structuredContent?.error?.reason === 'missing_create_permission', mcpRefused);
    const mcpMoved = await runTool(keys.planner, ids.planner, 'update_task', { task_id: mcpTask, project_id: ids.p4tf });
    const [mcpAfter] = await q('SELECT project_id FROM pm.tasks WHERE id = $1', [mcpTask]);
    check('mcp: update_task moves it by the same rules', mcpMoved.structuredContent?.ok !== false && mcpAfter.project_id === ids.p4tf, mcpMoved);

    // ---- Moving a conversation moves its tasks --------------------------------------------
    const filedMessage = await message(db, { status: 'handled' });
    const agentMade = await newTask(ids.hi, 'Set up the plan review', { createdBy: ids.planner });
    const personLinked = await newTask(ids.hi, 'Linked by a person');
    const [filedPlan] = await q<{ id: string }>("INSERT INTO pm.plans (message_id, conversation_id, member_id, mode, status, summary) VALUES ($1, $2, $3, 'live', 'applied', 'Filed') RETURNING id", [filedMessage.message, filedMessage.conversation, ids.planner]);
    await q(`INSERT INTO pm.plan_items (plan_id, position, conversation_id, mode, type, intent, project_id, task_id, payload, decision, state)
      VALUES ($1, 0, $2, 'live', 'create_task', 'new_work', $3, $4, '{}'::jsonb, 'apply', 'done')`, [filedPlan.id, filedMessage.conversation, ids.hi, agentMade]);
    await q("INSERT INTO pm.task_links (message_id, task_id, relation, linked_by) VALUES ($1, $2, 'created', $3), ($1, $4, 'related', $5)", [filedMessage.message, agentMade, ids.planner, personLinked, ids.owner]);
    const ctx = await ownerCtx();
    await inbox.setThreadProject(ctx, filedMessage.conversation, { project_id: ids.p4tf, remember_sender: null, remember_domain: null } as Loose);
    const offer = await links.moveThreadTasks(ctx, filedMessage.conversation, { project_id: ids.p4tf, dry_run: true, lost_access: 'refuse' });
    check('conversation: the dry run lists only what the agent made from it', offer.dry_run && offer.tasks.length === 1 && offer.tasks[0].task_id === agentMade, offer);
    const [untouched] = await q('SELECT project_id FROM pm.tasks WHERE id = $1', [agentMade]);
    check('conversation: nothing moves until asked', untouched.project_id === ids.hi, untouched);
    const wrong = await links.moveThreadTasks(ctx, filedMessage.conversation, { project_id: ids.p4tf, task_ids: [personLinked], dry_run: false, lost_access: 'refuse' }).catch((error: Error) => ({ error: error.message }));
    check('conversation: a task the agent did not make is refused', 'error' in wrong, wrong);
    const followed = await links.moveThreadTasks(ctx, filedMessage.conversation, { project_id: ids.p4tf, dry_run: false, lost_access: 'refuse' });
    const [agentAfter] = await q('SELECT project_id FROM pm.tasks WHERE id = $1', [agentMade]);
    const [personAfter] = await q('SELECT project_id FROM pm.tasks WHERE id = $1', [personLinked]);
    check('conversation: asked, the agent\'s task follows the conversation; the person\'s link stays', !followed.dry_run && followed.moved.length === 1
      && agentAfter.project_id === ids.p4tf && personAfter.project_id === ids.hi, { followed, agentAfter, personAfter });

    // ---- Send back after a delete and a project change -----------------------------------
    const resend = await message(db, { minutesAgo: 60 });
    const first = await call(planRoute.POST, 'POST', `/api/v1/inbox/messages/${resend.message}/plan`, keys.planner, { id: resend.message }, {
      summary: 'Jo wants a plan review set up.',
      idempotency_key: 'resend-1',
      items: [
        { type: 'create_task', intent: 'new_work', project_id: ids.hi, title: 'Plan review', evidence: 'set up the retirement plan review' },
        { type: 'ask', intent: 'new_work', question: 'Is this Happy Innovations work?', default: 'File it there.' },
      ],
    });
    const firstItems = (first.body.data?.items ?? []) as Row[];
    check('resend: the first plan applies a task and asks', first.status === 201 && firstItems.some((i) => i.type === 'create_task' && i.state === 'done') && firstItems.some((i) => i.type === 'ask' && i.state === 'pending'), first.body);
    const wrongTask = firstItems.find((i) => i.type === 'create_task')?.task_id as string;
    // The owner deletes the wrong task and changes the conversation's project.
    await moveToTrash(getActorClient(ids.owner, 'app'), 'tasks', wrongTask, ids.owner);
    await inbox.removeThreadProject(ctx, resend.conversation, ids.hi);
    await inbox.setThreadProject(ctx, resend.conversation, { project_id: ids.p4tf, remember_sender: null, remember_domain: null } as Loose);
    await new Promise((resolve) => setTimeout(resolve, 100));
    check('resend: the question rang a bell before', (await q('SELECT 1 FROM pm.team_member_notifications WHERE entity_id = $1 AND is_read = false', [resend.message])).length > 0);

    const sent = await inbox.sendBackToAgent(ctx, resend.conversation, null);
    const [status] = await q('SELECT status FROM pm.messages WHERE id = $1', [resend.message]);
    check('resend: the message is New again', sent.message_id === resend.message && status.status === 'new', status);
    const settled = await q<Row>("SELECT type, state, result FROM pm.plan_items WHERE plan_id = $1 ORDER BY position", [first.body.data.plan.id]);
    const ask = settled.find((i) => i.type === 'ask');
    check('resend: the old question is settled as superseded, not pending', ask?.state === 'expired' && !!(ask.result as Loose)?.superseded && sent.superseded >= 1, settled);
    check('resend: what applied stays as it was', settled.find((i) => i.type === 'create_task')?.state === 'done', settled);
    check('resend: the bell is read', (await q('SELECT 1 FROM pm.team_member_notifications WHERE entity_id = $1 AND is_read = false', [resend.message])).length === 0);
    const queue = await call(queueRoute.GET, 'GET', '/api/v1/inbox/queue?mode=plans', keys.planner);
    check('resend: the agent\'s queue shows it again', queue.status === 200 && (queue.body.data?.messages ?? []).some((m: Loose) => m.id === resend.message), queue.body);
    const signal = await call(signalRoute.GET, 'GET', '/api/v1/inbox/signal', keys.planner);
    check('resend: the signal counts it', signal.status === 200 && signal.body.data?.plans_new_count >= 1, signal.body);
    const context = await call(contextRoute.GET, 'GET', `/api/v1/inbox/messages/${resend.message}/context?mode=live`, keys.planner, { id: resend.message });
    const earlier = (context.body.data?.conversation?.plans ?? []).find((p: Loose) => p.id === first.body.data.plan.id);
    check('resend: the context says it was sent back and its earlier plan is superseded', context.body.data?.sent_back === true && earlier?.superseded === true, context.body.data?.conversation);
    check('resend: the deleted task reads as in Trash, not as done work', earlier?.items?.some((i: Loose) => i.type === 'create_task' && i.task_in_trash === true), earlier);
    check('resend: no question is open any more', context.body.data?.conversation?.open_question === null, context.body.data?.conversation?.open_question);
    check('resend: the new project is in scope', (context.body.data?.projects ?? []).some((p: Loose) => p.id === ids.p4tf), context.body.data?.projects);

    const second2 = await call(planRoute.POST, 'POST', `/api/v1/inbox/messages/${resend.message}/plan`, keys.planner, { id: resend.message }, {
      summary: 'Plan review for Plan4TheFuture.',
      idempotency_key: 'resend-2',
      items: [
        { type: 'create_task', intent: 'new_work', project_id: ids.p4tf, title: 'Plan review', evidence: 'set up the retirement plan review' },
        { type: 'ask', intent: 'new_work', question: 'Who at Plan4TheFuture owns it?', default: 'Jo.' },
      ],
    });
    check('resend: the new plan, with a question of its own, is accepted', second2.status === 201 && second2.body.data?.replayed !== true, second2.body);
    const newTaskId = ((second2.body.data?.items ?? []) as Row[]).find((i) => i.type === 'create_task')?.task_id as string | undefined;
    const [newTaskRow] = newTaskId ? await q('SELECT project_id FROM pm.tasks WHERE id = $1', [newTaskId]) : [null];
    check('resend: the new task is on the new project', newTaskRow?.project_id === ids.p4tf, newTaskRow);
    const detail = await inbox.threadDetail(ctx, resend.conversation);
    const shown = detail.messages.find((m) => m.id === resend.message);
    check('resend: the thread shows the new plan', shown?.plan?.id === second2.body.data?.plan?.id && shown?.status === 'needs_human', { plan: shown?.plan?.id, status: shown?.status });
    const again = await call(contextRoute.GET, 'GET', `/api/v1/inbox/messages/${resend.message}/context?mode=live`, keys.planner, { id: resend.message });
    check('resend: once planned again it is no longer sent back', again.body.data?.sent_back === undefined, again.body.data?.sent_back);

    // A plan cut off mid-apply leaves its message New: that is a retry, not a send back.
    const cut = await message(db, { minutesAgo: 60 });
    await q("INSERT INTO pm.plans (message_id, conversation_id, member_id, mode, status, summary, created_at) VALUES ($1, $2, $3, 'live', 'applying', 'Half done', now() - interval '10 minutes')", [cut.message, cut.conversation, ids.planner]);
    const cutContext = await call(contextRoute.GET, 'GET', `/api/v1/inbox/messages/${cut.message}/context?mode=live`, keys.planner, { id: cut.message });
    check('interrupted: a plan cut off mid-apply is not read as sent back', cutContext.status === 200 && cutContext.body.data?.sent_back === undefined
      && !(cutContext.body.data?.conversation?.plans ?? []).some((p: Loose) => p.superseded), cutContext.body.data?.conversation?.plans);

    // An answer re-queues too, and is not a send back.
    await inbox.answerAgentQuestion(ctx, resend.conversation, resend.message, 'Jo owns it.').catch((error: Error) => check('answer: the new question can be answered', false, error.message));
    const answered = await call(contextRoute.GET, 'GET', `/api/v1/inbox/messages/${resend.message}/context?mode=live`, keys.planner, { id: resend.message });
    check('answer: a message answered is New for the agent but not sent back', answered.body.data?.sent_back === undefined, answered.body.data?.sent_back);
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`move and resend: ${failures.length} failed, ${passed} passed`);
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
  console.log(`move and resend: all ${passed} checks passed`);
}

main().catch((error) => {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  console.error(error);
  process.exit(1);
});
