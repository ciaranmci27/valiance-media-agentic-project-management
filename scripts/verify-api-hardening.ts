/**
 * API hardening through the real v1 routes (withApi, supabase-js, a fake
 * PostgREST over PGlite that answers a page past an exact count with 416
 * PGRST103, as PostgREST does), and over MCP:
 * - Paging past the end answers an empty page with the real total, on every
 *   kind of list (REST and MCP), never a 500.
 * - Paging a list sorted by a column with ties (due_date, priority, name)
 *   returns every row exactly once.
 * - Dates the API stores are real calendar dates in a sensible year (422
 *   naming the field), and a repeat on a task whose stored due date is not
 *   one answers 422, not 500.
 * - Text: NUL and lone surrogates are 422 by field; titles are trimmed and
 *   never blank; titles, descriptions and tags are capped.
 * - Every 429 carries Retry-After (and MCP's refusal retry_after_seconds).
 *
 *   npm run -s test:api-hardening
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
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 600)}`);
}

const OWNER_SCOPES = [
  'tasks.read', 'tasks.create', 'tasks.manage_all', 'tasks.manage_assigned', 'projects.read', 'projects.read_all', 'questions.ask',
  'templates.manage', 'team.read', 'team.manage', 'reminders.manage_own', 'notifications.manage_own', 'audit.read',
];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const DUE_DATES = ['2026-12-01', '2026-12-02', '2026-12-03', null];
const TIED_TASKS = 156;

async function seed(db: PGlite) {
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  // The limited key's every request is over its window: 42 seconds left.
  const limitedKeyId = randomUUID();
  await db.exec(`DROP FUNCTION pm.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION pm.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', p_api_key_id <> '${limitedKeyId}'::uuid,
      'remaining', CASE WHEN p_api_key_id = '${limitedKeyId}'::uuid THEN 0 ELSE p_limit - 1 END,
      'reset_at', now() + interval '42 seconds') $$;`);
  const member = async (name: string, role: string) =>
    (await q<{ id: string }>('INSERT INTO pm.team_members (name, email, role) VALUES ($1, $2, $3) RETURNING id', [name, `${name.toLowerCase()}@example.com`, role]))[0].id;
  const owner = await member('Olivia', 'owner');
  const atlas = await member('Atlas', 'agent');
  const project = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Lab') RETURNING id"))[0].id;
  for (const m of [owner, atlas]) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [project, m]);
  // Projects with the same name: a name sort ties on every one.
  for (let i = 0; i < 60; i++) await q('INSERT INTO pm.projects (name) VALUES ($1)', [i % 2 ? 'Same name' : 'Other name']);
  // Tasks whose due dates and priorities repeat.
  for (let i = 0; i < TIED_TASKS; i++) {
    await q('INSERT INTO pm.tasks (project_id, title, priority, due_date) VALUES ($1, $2, $3, $4)',
      [project, `Tied ${i % 3}`, PRIORITIES[i % PRIORITIES.length], DUE_DATES[i % DUE_DATES.length]]);
  }
  const key = async (memberId: string, scopes: string[], id: string = randomUUID()) => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (id, name, key_prefix, key_hash, team_member_id, scopes, permissions)
      VALUES ($1, 'Key', 'pk_live', $2, $3, $4, 'scoped')`, [id, createHash('sha256').update(secret).digest('hex'), memberId, scopes]);
    await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
      SELECT $1, key, 'api', 'allow' FROM unnest($2::text[]) AS key ON CONFLICT DO NOTHING`, [memberId, scopes]);
    return secret;
  };
  const keys = {
    owner: await key(owner, OWNER_SCOPES),
    limited: await key(owner, OWNER_SCOPES, limitedKeyId),
    atlas: await key(atlas, ['agent_activity.write', 'tasks.read', 'projects.read']),
  };
  return { q, owner, atlas, project, keys };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the answers are untyped JSON read field by field
type Loose = any;
type Answer = { status: number; body: Loose; headers: Headers };
type Handler = (request: NextRequest, context: never) => Promise<Response>;

async function main() {
  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key' });
  try {
    const call = async (handler: Handler, method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown, raw?: string): Promise<Answer> => {
      const response = await handler(new NextRequest(`http://localhost${path}`, {
        method,
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve(params) } as never);
      return { status: response.status, body: await response.json(), headers: response.headers };
    };
    const route = async (path: string) => (await import(`../src/app/api/v1/${path}/route`)) as Record<string, Handler>;
    const tasksRoute = await route('tasks');
    const taskRoute = await route('tasks/[id]');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const { outcomeResult, routeCaller } = await import('../src/lib/mcp/server');
    const mcpRun = async (apiKey: string, name: string, args: Record<string, unknown>) => {
      const tool = PM_TOOLS.find((t) => t.name === name);
      if (!tool) throw new Error(`no tool ${name}`);
      const caller = routeCaller({ key: apiKey, origin: 'http://localhost' });
      return outcomeResult(await tool.run(tool.input.parse(args) as Record<string, unknown>, caller, { memberId: s.owner }), tool.write).structuredContent as Loose;
    };

    // --- Paging past the end ---------------------------------------------------------------
    const lists = ['tasks', 'projects', 'questions', 'approvals', 'schedules', 'task-templates', 'task-templates/drafts', 'groups',
      'team-members', 'reminders', 'notifications', 'audit-log', 'agents'];
    for (const path of lists) {
      const handler = (await route(path)).GET;
      for (const page of ['20', '50', '99999999']) {
        const answer = await call(handler, 'GET', `/api/v1/${path}?page=${page}`, {}, s.keys.owner);
        const total = answer.body?.meta?.total;
        check(`GET /api/v1/${path}?page=${page} past the end answers 200 with an empty page and the real total`,
          answer.status === 200 && Array.isArray(answer.body?.data) && answer.body.data.length === 0 && typeof total === 'number', { status: answer.status, body: answer.body });
      }
    }
    const tasksTotal = (await call(tasksRoute.GET, 'GET', '/api/v1/tasks?limit=1', {}, s.keys.owner)).body?.meta?.total;
    const pastTasks = await call(tasksRoute.GET, 'GET', '/api/v1/tasks?limit=100&page=3', {}, s.keys.owner);
    check('a task page past the end keeps the real total', pastTasks.status === 200 && pastTasks.body.meta?.total === tasksTotal && tasksTotal === TIED_TASKS, [tasksTotal, pastTasks.body?.meta]);
    const mcpProjects = await mcpRun(s.keys.owner, 'list_projects', { page: 50 });
    check('MCP list_projects past the end is an empty page, not a 500', mcpProjects?.ok === true && mcpProjects.data?.length === 0 && mcpProjects.meta?.total === 61, mcpProjects);
    const mcpTasks = await mcpRun(s.keys.owner, 'search_tasks', { page: 50 });
    check('MCP search_tasks past the end is an empty page, not a 500', mcpTasks?.ok === true && mcpTasks.data?.length === 0 && mcpTasks.meta?.total === TIED_TASKS, mcpTasks);

    // --- Stable order across pages -------------------------------------------------------------
    const pageThrough = async (path: string, handler: Handler, query: string, limit: number) => {
      const ids: string[] = [];
      for (let page = 1; page <= 40; page++) {
        const answer = await call(handler, 'GET', `/api/v1/${path}?${query}&limit=${limit}&page=${page}`, {}, s.keys.owner);
        if (answer.status !== 200) return { ids, error: answer.body };
        const rows = (answer.body.data ?? []) as { id: string }[];
        if (!rows.length) break;
        ids.push(...rows.map((row) => row.id));
      }
      return { ids, error: null };
    };
    for (const [sort, order] of [['due_date', 'asc'], ['priority', 'desc'], ['title', 'asc'], ['status', 'asc']]) {
      const { ids, error } = await pageThrough('tasks', tasksRoute.GET, `project_id=${s.project}&sort=${sort}&order=${order}`, 20);
      check(`paging ${TIED_TASKS} tasks sorted by ${sort} (ties) returns every task exactly once`,
        !error && ids.length === TIED_TASKS && new Set(ids).size === TIED_TASKS, { error, rows: ids.length, distinct: new Set(ids).size });
    }
    const projectsRoute = await route('projects');
    const projects = await pageThrough('projects', projectsRoute.GET, 'sort=name&order=asc', 7);
    check('paging projects sorted by a tied name returns every project exactly once', !projects.error && projects.ids.length === 61
      && new Set(projects.ids).size === 61, { rows: projects.ids.length, distinct: new Set(projects.ids).size });

    // --- Dates ---------------------------------------------------------------------------------
    const create = (body: Loose, apiKey = s.keys.owner) => call(tasksRoute.POST, 'POST', '/api/v1/tasks', {}, apiKey, { project_id: s.project, title: 'Dated', ...body });
    const fieldOf = (answer: Answer) => (answer.body?.error?.details ?? []).map?.((issue: { path?: unknown[] }) => (issue.path ?? []).join('.')) ?? [];
    for (const bad of ['2026-02-30', '2026-99-99', '2026-13-01', '2026-00-10', '2025-02-29', '9999-12-31', '0001-01-01', '26-1-1', 'tomorrow']) {
      const made = await create({ due_date: bad });
      check(`POST /tasks due_date ${bad} is 422 naming due_date`, made.status === 422 && fieldOf(made).includes('due_date'), made.body);
    }
    const leap = await create({ due_date: '2028-02-29' });
    check('a real date (2028-02-29) is accepted', leap.status === 201 && leap.body.data?.due_date === '2028-02-29', leap.body);
    const leapId = leap.body.data?.id as string;
    // What the old schemas took (any string) and agents send: ISO 8601 date-times, read as the date they are written with.
    const ISO_FORMS: [string, string][] = [
      ['2026-11-30T17:00:00Z', '2026-11-30'], ['2026-11-30T17:00:00.000Z', '2026-11-30'], ['2026-11-30T23:30:00-07:00', '2026-11-30'],
      ['2026-12-01T00:15:00+05:30', '2026-12-01'], ['2026-11-30T09:00', '2026-11-30'], ['2026-11-30 09:00:00', '2026-11-30'],
      ['2026-11-30T09:00:00.123456+0200', '2026-11-30'], [' 2026-11-30 ', '2026-11-30'],
    ];
    for (const [sent, stored] of ISO_FORMS) {
      const made = await create({ due_date: sent });
      check(`POST /tasks due_date ${JSON.stringify(sent)} is accepted and stored as ${stored}`, made.status === 201 && made.body.data?.due_date === stored, made.body);
    }
    for (const bad of ['2026-11-30T25:00:00Z', '2026-11-30T10:60Z', '2026-02-30T10:00:00Z', '2026-11-30T10:00:00+15:00', '2026-11-30Tnoon', '11/30/2026']) {
      const made = await create({ due_date: bad });
      check(`POST /tasks due_date ${bad} is 422 naming due_date`, made.status === 422 && fieldOf(made).includes('due_date'), made.body);
    }
    const isoPatch = await call(taskRoute.PATCH, 'PATCH', `/api/v1/tasks/${leapId}`, { id: leapId }, s.keys.owner, { due_date: '2028-03-01T08:00:00Z' });
    check('PATCH due_date with an ISO date-time stores its date', isoPatch.status === 200 && isoPatch.body.data?.due_date === '2028-03-01', isoPatch.body);
    const cleared = await call(taskRoute.PATCH, 'PATCH', `/api/v1/tasks/${leapId}`, { id: leapId }, s.keys.owner, { due_date: '' });
    check('PATCH due_date "" still clears it (null), as the old schema allowed', cleared.status === 200 && cleared.body.data?.due_date === null, cleared.body);
    // The other fields that took any string before: projects, goals, invoices, suggestions.
    const schemas = await import('../src/lib/schemas');
    const project = schemas.createProjectSchema.safeParse({ name: 'P', start_date: '2026-11-01T00:00:00Z', due_date: '2026-12-31' });
    check('projects: start_date and due_date take an ISO date-time and store the date', project.success && project.data.start_date === '2026-11-01' && project.data.due_date === '2026-12-31', project);
    const projectClear = schemas.updateProjectSchema.safeParse({ due_date: '' });
    check('projects: due_date "" clears it', projectClear.success && projectClear.data.due_date === null, projectClear);
    const goal = schemas.createGoalSchema.safeParse({ title: 'G', target_date: '2027-01-15T12:00:00-08:00' });
    check('goals: target_date takes an ISO date-time', goal.success && goal.data.target_date === '2027-01-15', goal);
    const invoiceFields = schemas.updateInvoiceSchema.safeParse({ date: '2026-11-12T10:00:00Z', due_date: '2026-12-12', paid_date: '' });
    check('invoices: date takes an ISO date-time, due_date a date, paid_date "" clears', invoiceFields.success && invoiceFields.data.date === '2026-11-12'
      && invoiceFields.data.due_date === '2026-12-12' && invoiceFields.data.paid_date === null, invoiceFields);
    const badInvoice = schemas.updateInvoiceSchema.safeParse({ date: '2026-02-30' });
    check('invoices: an impossible date is refused', !badInvoice.success, badInvoice);
    const suggestion = schemas.approveSuggestionSchema.safeParse({ due_date: '2026-11-30T17:00:00Z' });
    check('suggestions: approving with an ISO date-time stores the date', suggestion.success && suggestion.data.due_date === '2026-11-30', suggestion);
    const patched = await call(taskRoute.PATCH, 'PATCH', `/api/v1/tasks/${leapId}`, { id: leapId }, s.keys.owner, { due_date: '2026-02-30' });
    check('PATCH /tasks/:id due_date 2026-02-30 is 422 naming due_date', patched.status === 422 && fieldOf(patched).includes('due_date'), patched.body);
    const delegateRoute = await route('tasks/[id]/delegate');
    const delegated = await call(delegateRoute.POST, 'POST', `/api/v1/tasks/${leapId}/delegate`, { id: leapId }, s.keys.owner, { agent_id: s.atlas, title: 'Half', due_date: '2026-99-99' });
    check('POST /tasks/:id/delegate due_date 2026-99-99 is 422 naming due_date', delegated.status === 422 && fieldOf(delegated).includes('due_date'), delegated.body);
    const remindersRoute = await route('reminders');
    const reminder = await call(remindersRoute.POST, 'POST', '/api/v1/reminders', {}, s.keys.owner, { title: 'Call back', remind_on: '2026-02-30' });
    check('POST /reminders remind_on 2026-02-30 is 422 naming remind_on (was a 500)', reminder.status === 422 && fieldOf(reminder).includes('remind_on'), reminder.body);
    const initiativesRoute = await route('projects/[id]/initiatives');
    const initiative = await call(initiativesRoute.POST, 'POST', `/api/v1/projects/${s.project}/initiatives`, { id: s.project }, s.keys.owner, { name: 'Launch', target_date: '2026-13-01' });
    check('POST /projects/:id/initiatives target_date 2026-13-01 is 422 naming target_date (was a 500)', initiative.status === 422 && fieldOf(initiative).includes('target_date'), initiative.body);
    // A due date stored before dates were checked (the column is text).
    await s.q("UPDATE pm.tasks SET due_date = '2026-02-30' WHERE id = $1", [leapId]);
    const repeatRoute = await route('tasks/[id]/repeat');
    const repeat = await call(repeatRoute.PUT, 'PUT', `/api/v1/tasks/${leapId}/repeat`, { id: leapId }, s.keys.owner, { recurrence: { freq: 'daily' } });
    check('a repeat on a task whose stored due date is not real answers 422 invalid_due_date, not 500', repeat.status === 422
      && repeat.body.error?.details?.reason === 'invalid_due_date', repeat.body);
    // One stored as an ISO date-time (the old schema took it) repeats from its date.
    await s.q("UPDATE pm.tasks SET due_date = '2028-03-01T08:00:00Z' WHERE id = $1", [leapId]);
    const isoRepeat = await call(repeatRoute.PUT, 'PUT', `/api/v1/tasks/${leapId}/repeat`, { id: leapId }, s.keys.owner, { recurrence: { freq: 'daily' } });
    check('a repeat on a task whose stored due date is an ISO date-time starts from its date', isoRepeat.status === 200
      && isoRepeat.body.data?.due_date === '2028-03-01', isoRepeat.body);

    // --- Text ----------------------------------------------------------------------------------
    const nul = await create({ title: 'Bad\u0000title' });
    check('a NUL in the title is 422 naming title (was a 500)', nul.status === 422 && nul.body.error?.details?.field === 'title'
      && nul.body.error?.details?.reason === 'invalid_text', nul.body);
    const surrogate = await create({ title: 'Half \uD800 pair' });
    check('a lone surrogate in the title is 422 naming title (was a 500)', surrogate.status === 422 && surrogate.body.error?.details?.field === 'title', surrogate.body);
    const nestedNul = await create({ tags: ['ok', 'b\u0000d'] });
    check('a NUL deep in the body names its path (tags[1])', nestedNul.status === 422 && nestedNul.body.error?.details?.field === 'tags[1]', nestedNul.body);
    const pair = await create({ title: 'Ship it 🚀' });
    check('a whole surrogate pair (an emoji) is fine', pair.status === 201 && pair.body.data?.title === 'Ship it 🚀', pair.body);
    const blank = await create({ title: '   ' });
    check('a whitespace-only title is 422 naming title', blank.status === 422 && fieldOf(blank).includes('title'), blank.body);
    const trimmed = await create({ title: '  Fix the total  ', tags: [' billing ', '', 'ops'] });
    check('a title is stored trimmed; tags are trimmed and blanks dropped', trimmed.status === 201 && trimmed.body.data?.title === 'Fix the total'
      && JSON.stringify(trimmed.body.data?.tags) === '["billing","ops"]', trimmed.body?.data);
    const longTitle = await create({ title: 'x'.repeat(10_000) });
    check('a 10,000 character title is 422 naming title', longTitle.status === 422 && fieldOf(longTitle).includes('title'), longTitle.status);
    // Over the description cap (100,000) but under the request size limit (1 MB), so the field check answers.
    const bigDescription = await create({ description: 'x'.repeat(150_000) });
    check('a description over 100,000 characters is 422 naming description', bigDescription.status === 422 && fieldOf(bigDescription).includes('description'), bigDescription.status);
    const hugeBody = await create({ description: 'x'.repeat(3_000_000) });
    check('a 3 MB body is refused before parsing (413)', hugeBody.status === 413, hugeBody.status);
    const manyTags = await create({ tags: Array.from({ length: 5000 }, (_, i) => `t${i}`) });
    check('5,000 tags is 422 naming tags', manyTags.status === 422 && fieldOf(manyTags).includes('tags'), manyTags.status);
    const blankPatch = await call(taskRoute.PATCH, 'PATCH', `/api/v1/tasks/${leapId}`, { id: leapId }, s.keys.owner, { title: ' ' });
    check('PATCH a blank title is 422 too', blankPatch.status === 422 && fieldOf(blankPatch).includes('title'), blankPatch.body);

    // A body nested past any real one is a 422, never a stack overflow (500).
    const nested = (depth: number) => `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;
    const tooDeep = await call(tasksRoute.POST, 'POST', '/api/v1/tasks', {}, s.keys.owner, undefined,
      `{"project_id":"${s.project}","title":"Deep","extra":${nested(20_000)}}`);
    check('a body nested 20,000 deep is 422 too_deep, not a 500', tooDeep.status === 422 && tooDeep.body.error?.details?.reason === 'too_deep', tooDeep.body);
    const fineDepth = await call(tasksRoute.POST, 'POST', '/api/v1/tasks', {}, s.keys.owner, undefined,
      `{"project_id":"${s.project}","title":"Nested a little","extra":${nested(40)}}`);
    check('a body nested 40 deep is fine', fineDepth.status === 201, fineDepth.body);
    // The text check reads what the schema kept: a key it drops, or a field it cleans, passes as before.
    const droppedKey = await create({ title: 'Unknown key', junk: 'a\u0000b' });
    check('a NUL in a key the schema drops does not refuse the request', droppedKey.status === 201, droppedKey.body);
    const activitiesRoute = await route('agent-activities');
    const note = await call(activitiesRoute.POST, 'POST', '/api/v1/agent-activities', {}, s.keys.atlas,
      { activity_type: 'note', project_id: s.project, payload: { title: 'Checked\u0000the backups' } });
    check('an agent note whose title schema cleans control characters still records, cleaned', note.status === 201
      && note.body.data?.title === 'Checked the backups', note.body);
    const { meetingPackageSchema } = await import('../src/lib/communications/meeting/ingest');
    const meeting = meetingPackageSchema.safeParse({ inbox_id: randomUUID(), meeting_key: 'k1', kind: 'summary', title: 'Weekly\u0000 sync',
      date: '2026-11-26', text: 'Notes\u0000here' });
    check('a meeting package drops a NUL in its title and text', meeting.success && meeting.data.title === 'Weekly sync' && meeting.data.text === 'Noteshere', meeting);
    // Comments and criteria keep what was written: an indented first line (code, a list) stays.
    const commentsRoute = await route('tasks/[id]/comments');
    const indented = '    const total = sum(lines);\n    return total;';
    const comment = await call(commentsRoute.POST, 'POST', `/api/v1/tasks/${leapId}/comments`, { id: leapId }, s.keys.owner, { user_id: s.owner, text: indented });
    check('a comment keeps its indented first line', comment.status === 201 && comment.body.data?.text === indented, comment.body);
    const blankComment = await call(commentsRoute.POST, 'POST', `/api/v1/tasks/${leapId}/comments`, { id: leapId }, s.keys.owner, { user_id: s.owner, text: ' \n ' });
    check('a blank comment is 422', blankComment.status === 422, blankComment.body);
    const withCriteria = await create({ title: 'Criteria', acceptance_criteria: ['  - totals match', 'Docs updated'] });
    const criteria = withCriteria.status === 201
      ? await s.q<{ criterion: string }>('SELECT criterion FROM pm.task_acceptance_criteria WHERE task_id = $1 ORDER BY sort_order', [withCriteria.body.data?.id])
      : [];
    check('an acceptance criterion keeps its leading spaces', criteria[0]?.criterion === '  - totals match', { status: withCriteria.status, criteria });
    const blankCriterion = await create({ title: 'Criteria', acceptance_criteria: ['   '] });
    check('a blank acceptance criterion is 422', blankCriterion.status === 422, blankCriterion.body);

    // --- 429 says when ----------------------------------------------------------------------------
    const limited = await call(tasksRoute.GET, 'GET', '/api/v1/tasks', {}, s.keys.limited);
    const retryAfter = Number(limited.headers.get('Retry-After'));
    check('a rate-limited request answers 429 with Retry-After in seconds until the window resets', limited.status === 429
      && retryAfter >= 40 && retryAfter <= 43, { status: limited.status, retryAfter: limited.headers.get('Retry-After') });
    const limitedMcp = await mcpRun(s.keys.limited, 'search_tasks', {});
    check('MCP: a rate-limited tool call carries retry_after_seconds', limitedMcp?.ok === false && limitedMcp.status === 429
      && limitedMcp.error?.retry_after_seconds >= 40 && limitedMcp.error?.retry_after_seconds <= 43, limitedMcp);
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`api hardening: ${passed} checks passed, ${failures.length} failed:`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log(`api hardening: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
