/**
 * Questions through the real v1 API (withApi, supabase-js, a fake PostgREST
 * over PGlite), and over MCP:
 * - Ask on a task, a project or nothing; asked_to defaults to the agent's
 *   escalation target, else the Owner; asking yourself, a non-member or an
 *   expiry in the past is refused; choices are checked.
 * - The asked member's bell rings, and answering, cancelling or expiring
 *   clears it. An agent that asks logs the typed blocked event.
 * - Answer: the member asked, a team manager; anyone else is refused, a
 *   second answer is 409, choices and allow_other are enforced.
 * - Cancel: the asker; others refused; nothing after it.
 * - Expiry needs no job: an open question past expires_at reads as expired.
 * - The task read carries open_question; list filters; an outsider sees
 *   nothing; a task in Trash takes its questions out of reach; a task moved
 *   to another project takes them along.
 *
 *   npm run -s test:questions
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

const SCOPES = ['tasks.read', 'tasks.manage_assigned', 'projects.read'];

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
  const morgan = await member('Morgan', 'member');
  const pat = await member('Pat', 'member');
  const max = await member('Max', 'member');
  // Rita reads only the tasks assigned to her (tasks.read_assigned, not tasks.read) in the app.
  const rita = await member('Rita', 'member');
  await q('UPDATE pm.team_members SET agent_escalate_to = $1 WHERE id = $2', [morgan, helper]);
  const project = async (name: string, members: string[]) => {
    const id = (await q<{ id: string }>('INSERT INTO pm.projects (name) VALUES ($1) RETURNING id', [name]))[0].id;
    for (const m of members) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  const apex = await project('Apex', [builder, helper, morgan, max, rita]);
  await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES
    ($1, 'tasks.read', 'app', 'deny'), ($1, 'tasks.manage_all', 'app', 'deny'), ($1, 'tasks.read_assigned', 'app', 'allow'),
    ($1, 'projects.read', 'app', 'allow') ON CONFLICT DO NOTHING`, [rita]);
  const queue = await project('Queue', [pat]);
  const key = async (memberId: string, scopes: string[], permissions = 'scoped') => {
    const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
    await q(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
      VALUES ('Key', 'pk_live', $1, $2, $3, $4)`, [createHash('sha256').update(secret).digest('hex'), memberId, scopes, permissions]);
    await q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
      SELECT $1, key, 'api', 'allow' FROM unnest($2::text[]) AS key ON CONFLICT DO NOTHING`, [memberId, scopes]);
    return secret;
  };
  const keys = {
    owner: await key(owner, [...SCOPES, 'projects.read_all']),
    builder: await key(builder, SCOPES),
    helper: await key(helper, SCOPES),
    morgan: await key(morgan, SCOPES),
    pat: await key(pat, SCOPES),
    max: await key(max, [...SCOPES, 'team.manage']),
    builderReadOnly: await key(builder, SCOPES, 'read_only'),
  };
  const task = async (projectId: string, title: string, assignees: string[] = []) => {
    const id = (await q<{ id: string }>('INSERT INTO pm.tasks (project_id, title) VALUES ($1, $2) RETURNING id', [projectId, title]))[0].id;
    for (const m of assignees) await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  return { q, owner, builder, helper, morgan, pat, max, rita, apex, queue, keys, task };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the answers are untyped JSON read field by field
type Loose = any;
type Body = { data?: Loose; meta?: Loose; error?: { code?: string; message?: string; details?: Record<string, Loose> } };
type Answer = { status: number; body: Body };

async function main() {
  const db = await createFullSchemaDatabase();
  const s = await seed(db);
  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key' });
  try {
    const questionsRoute = await import('../src/app/api/v1/questions/route');
    const questionRoute = await import('../src/app/api/v1/questions/[id]/route');
    const answerRoute = await import('../src/app/api/v1/questions/[id]/answer/route');
    const cancelRoute = await import('../src/app/api/v1/questions/[id]/cancel/route');
    const taskRoute = await import('../src/app/api/v1/tasks/[id]/route');
    const { PM_TOOLS } = await import('../src/lib/mcp/tools');
    const { outcomeResult, routeCaller } = await import('../src/lib/mcp/server');
    const { getQuestion, listQuestions } = await import('../src/lib/api/questions');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
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
    const ask = (apiKey: string, body: unknown) => call(questionsRoute.POST, 'POST', '/api/v1/questions', {}, apiKey, body);
    const list = (apiKey: string, query = '') => call(questionsRoute.GET, 'GET', `/api/v1/questions${query}`, {}, apiKey);
    const get = (id: string, apiKey: string) => call(questionRoute.GET, 'GET', `/api/v1/questions/${id}`, { id }, apiKey);
    const answer = (id: string, apiKey: string, body: unknown) => call(answerRoute.POST, 'POST', `/api/v1/questions/${id}/answer`, { id }, apiKey, body);
    const cancel = (id: string, apiKey: string) => call(cancelRoute.POST, 'POST', `/api/v1/questions/${id}/cancel`, { id }, apiKey);
    const readTask = (id: string, apiKey: string) => call(taskRoute.GET, 'GET', `/api/v1/tasks/${id}`, { id }, apiKey);
    const bell = async (id: string) => (await s.q<{ user_id: string; title: string; link: string; cleared_at: string | null }>(
      "SELECT user_id, title, link, cleared_at FROM pm.team_member_notifications WHERE entity_type = 'question' AND entity_id = $1", [id]));
    const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
    const ids = (answer: Answer) => ((answer.body.data ?? []) as { id: string }[]).map((row) => row.id);

    // --- Ask -----------------------------------------------------------------------------
    const checkout = await s.task(s.apex, 'Fix the checkout total', [s.builder]);
    const onTask = await ask(s.keys.builder, { task_id: checkout, question: 'Round the EU total up or down?', choices: ['Up', 'Down'] });
    const q1 = onTask.body.data?.id as string;
    check('an agent asks on a task; asked_to defaults to the Owner (no escalation set)', onTask.status === 201 && onTask.body.data?.status === 'open'
      && onTask.body.data?.asked_to === s.owner && onTask.body.data?.asked_to_name === 'Olivia' && onTask.body.data?.project_id === s.apex
      && onTask.body.data?.task_title === 'Fix the checkout total' && onTask.body.data?.allow_other === true
      && JSON.stringify(onTask.body.data?.choices) === '["Up","Down"]' && onTask.body.data?.can_cancel === true && onTask.body.data?.can_answer === false, onTask);
    const q1Bell = await bell(q1);
    check('asking rings the asked member\'s bell, linked to My Tasks where it is answered', q1Bell.length === 1 && q1Bell[0].user_id === s.owner
      && q1Bell[0].title === 'Question from Builder' && q1Bell[0].link === '/my-tasks' && q1Bell[0].cleared_at === null, q1Bell);
    await settle();
    const blocked = await s.q<{ title: string; reference_id: string }>(
      "SELECT title, reference_id FROM pm.agent_activities WHERE agent_id = $1 AND activity_type = 'blocked'", [s.builder]);
    check('an agent asking logs the typed blocked event on the task', blocked.length === 1 && blocked[0].reference_id === checkout
      && blocked[0].title === 'Blocked: Round the EU total up or down?', blocked);

    const loose = await ask(s.keys.helper, { question: 'Which staging database should I use?' });
    const q2 = loose.body.data?.id as string;
    check('an agent asks on nothing; asked_to defaults to its escalation target', loose.status === 201 && loose.body.data?.asked_to === s.morgan
      && loose.body.data?.task_id === null && loose.body.data?.project_id === null, loose);
    const q2Bell = await bell(q2);
    check('a question on nothing links to My Tasks', q2Bell.length === 1 && q2Bell[0].user_id === s.morgan && q2Bell[0].link === '/my-tasks', q2Bell);

    const person = await ask(s.keys.morgan, { project_id: s.apex, question: 'Can we move the launch to Friday?' });
    check('a person asks on a project; asked_to defaults to the Owner', person.status === 201 && person.body.data?.asked_to === s.owner
      && person.body.data?.project_id === s.apex && person.body.data?.task_id === null, person);
    const self = await ask(s.keys.owner, { question: 'Who am I asking?' });
    check('asking yourself is refused', self.status === 422 && self.body.error?.details?.reason === 'asked_self', self);
    const named = await ask(s.keys.builder, { task_id: checkout, asked_to: s.helper, question: 'Did you change the tax table?' });
    check('an agent can ask another agent by name', named.status === 201 && named.body.data?.asked_to === s.helper, named);

    const tooMany = await ask(s.keys.builder, { question: 'Pick one', choices: Array.from({ length: 11 }, (_, i) => `Option ${i}`) });
    const duplicate = await ask(s.keys.builder, { question: 'Pick one', choices: ['Yes', 'yes'] });
    const empty = await ask(s.keys.builder, { question: 'Pick one', choices: [] });
    const blank = await ask(s.keys.builder, { question: '   ' });
    check('choices are checked: at most 10, all different, not empty; the question cannot be blank',
      tooMany.status === 422 && duplicate.status === 422 && empty.status === 422 && blank.status === 422,
      [tooMany.status, duplicate.status, empty.status, blank.status]);
    const stranger = await ask(s.keys.builder, { question: 'Hello?', asked_to: randomUUID() });
    check('asked_to must be an active team member', stranger.status === 422 && stranger.body.error?.details?.reason === 'asked_to_not_member', stranger);
    const past = await ask(s.keys.builder, { question: 'Too late?', expires_at: new Date(Date.now() - 60_000).toISOString() });
    check('an expiry in the past is refused', past.status === 422 && past.body.error?.details?.reason === 'expires_in_past', past);
    const elsewhere = await s.task(s.queue, 'Queue work');
    const outOfReach = await ask(s.keys.builder, { task_id: elsewhere, question: 'May I?' });
    check('a task the asker cannot open reads as missing', outOfReach.status === 404, outOfReach.status);
    const mismatch = await ask(s.keys.builder, { task_id: checkout, project_id: s.queue, question: 'Which?' });
    check('project_id must match the task\'s project', mismatch.status === 400, mismatch.status);

    // --- The task reads as waiting ----------------------------------------------------------
    const waiting = await readTask(checkout, s.keys.builder);
    check('the task read carries its oldest open question', waiting.status === 200 && waiting.body.data?.open_question?.id === q1
      && waiting.body.data?.open_question?.question === 'Round the EU total up or down?' && waiting.body.data?.open_question?.asked_to === s.owner
      && waiting.body.data?.open_question?.asked_to_name === 'Olivia', waiting.body.data?.open_question);

    // --- Answer -----------------------------------------------------------------------------
    const outsider = await answer(q1, s.keys.pat, { choice: 'Up' });
    check('an outsider cannot see the question to answer it (404)', outsider.status === 404, outsider.status);
    const notAsked = await answer(q1, s.keys.morgan, { choice: 'Up' });
    check('a member who can see it but was not asked is refused', notAsked.status === 403 && notAsked.body.error?.details?.reason === 'not_asked', notAsked);
    const unknown = await answer(q1, s.keys.owner, { choice: 'Sideways' });
    check('a choice not on the list is refused', unknown.status === 422 && unknown.body.error?.details?.reason === 'unknown_choice', unknown);
    const nothing = await answer(q1, s.keys.owner, {});
    check('an answer needs a choice or text', nothing.status === 422, nothing.status);
    const answered = await answer(q1, s.keys.owner, { choice: 'up', text: 'Round half up, like the invoices.' });
    check('the member asked answers with a choice and a note', answered.status === 200 && answered.body.data?.status === 'answered'
      && answered.body.data?.answer_choice === 'Up' && answered.body.data?.answer_text === 'Round half up, like the invoices.'
      && answered.body.data?.answered_by === s.owner && !!answered.body.data?.answered_at, answered);
    check('answering clears the bell', (await bell(q1))[0]?.cleared_at !== null, await bell(q1));
    const twice = await answer(q1, s.keys.owner, { choice: 'Down' });
    check('answering twice is 409', twice.status === 409 && twice.body.error?.details?.reason === 'question_answered', twice);
    const polled = await get(q1, s.keys.builder);
    check('the asker reads the answer back', polled.status === 200 && polled.body.data?.status === 'answered' && polled.body.data?.answer_choice === 'Up'
      && polled.body.data?.answered_by_name === 'Olivia', polled.body.data);
    const nextOpen = await readTask(checkout, s.keys.builder);
    check('once answered, the task read moves on to the next open question', nextOpen.body.data?.open_question?.id === named.body.data?.id, nextOpen.body.data?.open_question);

    const strict = await ask(s.keys.builder, { project_id: s.apex, question: 'Deploy now?', choices: ['Yes', 'No'], allow_other: false });
    const textOnly = await answer(strict.body.data?.id, s.keys.owner, { text: 'Maybe tomorrow' });
    check('without allow_other, a choice is required', textOnly.status === 422 && textOnly.body.error?.details?.reason === 'choice_required', textOnly);
    const choiceOnFree = await answer(q2, s.keys.morgan, { choice: 'Yes' });
    check('a question without choices takes no choice', choiceOnFree.status === 422 && choiceOnFree.body.error?.details?.reason === 'no_choices', choiceOnFree);
    const managed = await answer(strict.body.data?.id, s.keys.max, { choice: 'No' });
    check('a team manager can answer a question asked to someone else', managed.status === 200 && managed.body.data?.answered_by === s.max, managed);
    const helperAnswers = await answer(named.body.data?.id, s.keys.helper, { text: 'No, the tax table is unchanged.' });
    check('an agent answers another agent\'s question', helperAnswers.status === 200 && helperAnswers.body.data?.status === 'answered', helperAnswers);
    const free = await answer(q2, s.keys.morgan, { text: 'Use staging-2.' });
    check('a free-text question takes text', free.status === 200 && free.body.data?.answer_text === 'Use staging-2.' && free.body.data?.answer_choice === null, free);

    // --- Cancel -----------------------------------------------------------------------------
    const toCancel = await ask(s.keys.builder, { task_id: checkout, question: 'Should I also fix the UK total?' });
    const qc = toCancel.body.data?.id as string;
    const otherCancels = await cancel(qc, s.keys.morgan);
    check('only the asker (or a manager) cancels', otherCancels.status === 403 && otherCancels.body.error?.details?.reason === 'not_asker', otherCancels);
    const cancelled = await cancel(qc, s.keys.builder);
    check('the asker cancels', cancelled.status === 200 && cancelled.body.data?.status === 'cancelled' && cancelled.body.data?.cancelled_by === s.builder, cancelled);
    check('cancelling clears the bell', (await bell(qc))[0]?.cleared_at !== null, await bell(qc));
    const afterCancel = await answer(qc, s.keys.owner, { text: 'Yes' });
    check('a cancelled question cannot be answered', afterCancel.status === 409 && afterCancel.body.error?.details?.reason === 'question_cancelled', afterCancel);
    const cancelTwice = await cancel(qc, s.keys.builder);
    check('cancelling twice is 409', cancelTwice.status === 409, cancelTwice.status);
    check('no open question left: the task read says null', (await readTask(checkout, s.keys.builder)).body.data?.open_question === null);

    // --- Expiry -----------------------------------------------------------------------------
    const expiring = await ask(s.keys.builder, { task_id: checkout, question: 'Ship before the freeze?', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    const qe = expiring.body.data?.id as string;
    await s.q("UPDATE pm.questions SET expires_at = now() - interval '1 minute' WHERE id = $1", [qe]);
    check('the task read leaves out an open question past its time', (await readTask(checkout, s.keys.builder)).body.data?.open_question === null);
    const expired = await get(qe, s.keys.builder);
    check('an open question past expires_at reads as expired, no job needed', expired.status === 200 && expired.body.data?.status === 'expired'
      && expired.body.data?.can_answer === false, expired.body.data);
    const stored = (await s.q<{ status: string }>('SELECT status FROM pm.questions WHERE id = $1', [qe]))[0];
    check('reading it stores expired and clears the bell', stored.status === 'expired' && (await bell(qe))[0]?.cleared_at !== null, { stored, bell: await bell(qe) });
    const lateAnswer = await answer(qe, s.keys.owner, { text: 'Yes' });
    check('an expired question cannot be answered', lateAnswer.status === 409 && lateAnswer.body.error?.details?.reason === 'question_expired', lateAnswer);

    // --- Lists and visibility ----------------------------------------------------------------
    const ownerToMe = await list(s.keys.owner, '?asked_to=me');
    check('asked_to=me lists questions asked to the caller', ownerToMe.status === 200 && ownerToMe.body.data.every((row: Loose) => row.asked_to === s.owner)
      && ids(ownerToMe).includes(q1) && ids(ownerToMe).includes(person.body.data?.id), ids(ownerToMe));
    const mine = await list(s.keys.builder, '?asked_by=me');
    check('asked_by=me lists the caller\'s own questions, newest first', mine.body.data.every((row: Loose) => row.asked_by === s.builder)
      && ids(mine)[0] === qe && ids(mine).includes(q1), ids(mine));
    const openOnes = await list(s.keys.owner, '?status=open');
    check('status=open lists only open ones', openOnes.body.data.length > 0 && openOnes.body.data.every((row: Loose) => row.status === 'open')
      && !ids(openOnes).includes(q1), ids(openOnes));
    const onCheckout = await list(s.keys.morgan, `?task_id=${checkout}`);
    check('task_id lists a task\'s questions to anyone who can read the task', ids(onCheckout).includes(q1) && ids(onCheckout).includes(qc)
      && onCheckout.body.data.every((row: Loose) => row.task_id === checkout), ids(onCheckout));
    const onApex = await list(s.keys.owner, `?project_id=${s.apex}&status=answered`);
    check('project_id and status combine', ids(onApex).includes(q1) && onApex.body.data.every((row: Loose) => row.project_id === s.apex && row.status === 'answered'), ids(onApex));
    const badStatus = await list(s.keys.owner, '?status=maybe');
    check('an unknown status is refused', badStatus.status === 400, badStatus.status);
    const patList = await list(s.keys.pat);
    const patGet = await get(q1, s.keys.pat);
    check('an outsider sees nothing: an empty list and 404 on a question', patList.status === 200 && patList.body.data.length === 0
      && patList.body.meta?.total === 0 && patGet.status === 404, { list: ids(patList), get: patGet.status });
    const helperSeesLoose = await get(q2, s.keys.morgan);
    check('the member asked sees a question on nothing', helperSeesLoose.status === 200, helperSeesLoose.status);
    const builderLoose = await get(q2, s.keys.builder);
    check('a question on nothing is hidden from everyone but its two members', builderLoose.status === 404, builderLoose.status);

    // --- Who may read a task: the database's rule (tasks.read_assigned) ----------------------
    const ritas = await s.task(s.apex, 'Rita\'s own task', [s.rita]);
    const onRitas = await ask(s.keys.builder, { task_id: ritas, question: 'Rita, which supplier?' , asked_to: s.owner });
    const ritaAccess = await resolveMemberAccess(getServiceClient(), s.rita);
    if (!ritaAccess) throw new Error('no access for Rita');
    const ritaCtx = { db: getServiceClient(), access: ritaAccess, memberId: s.rita, channel: 'app' as const };
    const ritaList = (await listQuestions(ritaCtx, { status: 'all', offset: 0, limit: 100 })).rows;
    const ritaIds = ritaList.map((row) => row.id);
    check('a member who reads only assigned tasks sees questions on their own tasks and on the project',
      ritaIds.includes(onRitas.body.data?.id) && ritaIds.includes(person.body.data?.id), ritaIds);
    check('but not questions on tasks they cannot read (in the list, by text or title)',
      !ritaIds.includes(q1) && !ritaList.some((row) => row.task_id === checkout || row.question.includes('EU total')), ritaList.map((row) => row.question));
    const ritaGet = await getQuestion({ ...ritaCtx }, q1).then(() => 200, (error: { statusCode?: number }) => error.statusCode);
    check('and reading one by id is 404', ritaGet === 404, ritaGet);

    // A long-serving member reads hundreds of tasks; only the ones with questions may reach the filter.
    await s.q(`WITH made AS (
        INSERT INTO pm.tasks (project_id, title, status) SELECT $1, 'Old work ' || n, 'done' FROM generate_series(1, 600) AS n RETURNING id)
      INSERT INTO pm.task_assignees (task_id, member_id) SELECT id, $2 FROM made`, [s.apex, s.rita]);
    const busyRita = { ...ritaCtx };
    const busyList = await listQuestions(busyRita, { status: 'all', offset: 0, limit: 100 })
      .then((answer) => answer.rows.map((row) => row.id), (error: Error) => `failed: ${error.message.slice(0, 120)}`);
    check('with 600 readable tasks the list still works and still shows the question on her task',
      Array.isArray(busyList) && busyList.includes(onRitas.body.data?.id) && !busyList.includes(q1), busyList);

    // --- Someone asked who cannot open the place ----------------------------------------------
    const priceList = await s.task(s.apex, 'Check the price list', [s.builder]);
    const offProject = await ask(s.keys.builder, { task_id: priceList, asked_to: s.pat, question: 'Pat, is the Queue price list final?' });
    const patView = await get(offProject.body.data?.id, s.keys.pat);
    check('the member asked sees the question, but not the name of a task or project they cannot open',
      patView.status === 200 && patView.body.data?.question === 'Pat, is the Queue price list final?' && patView.body.data?.task_title === null
        && patView.body.data?.project_name === null && patView.body.data?.can_answer === true, patView.body.data);
    const asker = await get(offProject.body.data?.id, s.keys.builder);
    check('the asker, who can open it, still sees the task title', asker.body.data?.task_title === 'Check the price list', asker.body.data);
    const patBell = await bell(offProject.body.data?.id);
    check('their bell links to My Tasks, never to a task they cannot open', patBell[0]?.user_id === s.pat && patBell[0]?.link === '/my-tasks', patBell);

    // --- Read-only keys -----------------------------------------------------------------------
    const roAsk = await ask(s.keys.builderReadOnly, { question: 'Read-only?' });
    const roAnswer = await answer(offProject.body.data?.id, s.keys.builderReadOnly, { text: 'No' });
    const roCancel = await cancel(offProject.body.data?.id, s.keys.builderReadOnly);
    check('a read-only key cannot ask, answer or cancel', [roAsk, roAnswer, roCancel].every((r) => r.status === 403 && r.body.error?.details?.reason === 'read_only_key'),
      [roAsk, roAnswer, roCancel].map((r) => [r.status, r.body.error?.details?.reason]));
    const roRead = await get(offProject.body.data?.id, s.keys.builderReadOnly);
    check('but it can read questions', roRead.status === 200, roRead.status);

    // --- Places change ---------------------------------------------------------------------
    const moving = await s.task(s.apex, 'Move me', [s.builder]);
    const onMoving = await ask(s.keys.builder, { task_id: moving, question: 'Is this in the right project?' });
    await s.q('UPDATE pm.tasks SET project_id = $1 WHERE id = $2', [s.queue, moving]);
    const movedRow = (await s.q<{ project_id: string }>('SELECT project_id FROM pm.questions WHERE id = $1', [onMoving.body.data?.id]))[0];
    check('a task moved to another project takes its questions along', movedRow.project_id === s.queue, movedRow);
    await s.q('UPDATE pm.tasks SET deleted_at = now() WHERE id = $1', [moving]);
    const trashed = await get(onMoving.body.data?.id, s.keys.builder);
    const trashedList = await list(s.keys.owner, `?task_id=${moving}`);
    check('a task in Trash takes its questions out of reach', trashed.status === 404 && trashedList.body.data.length === 0, { get: trashed.status, list: ids(trashedList) });
    const hardDelete = await s.q('DELETE FROM pm.questions WHERE id = $1', [q1]).then(() => 'deleted', (error: Error) => error.message);
    check('questions are never permanently deleted', /never permanently deleted/.test(hardDelete), hardDelete);

    // --- MCP round trip ---------------------------------------------------------------------
    const mcp = routeCaller({ key: s.keys.builder, origin: 'http://localhost' });
    const tool = (name: string) => {
      const found = PM_TOOLS.find((t) => t.name === name);
      if (!found) throw new Error(`no tool ${name}`);
      return found;
    };
    const run = async (name: string, args: Record<string, unknown>) => {
      const t = tool(name);
      const parsed = t.input.parse(args) as Record<string, unknown>;
      return outcomeResult(await t.run(parsed, mcp, { memberId: s.builder }), t.write).structuredContent as Loose;
    };
    const asked = await run('ask_human', { task_id: checkout, question: 'Use the new rounding helper?', choices: ['Yes', 'No'] });
    check('MCP: ask_human asks and answers with the open question', asked?.ok === true && asked.data?.status === 'open' && asked.data?.asked_to === s.owner, asked);
    const read = await run('get_question', { question_id: asked?.data?.id });
    check('MCP: get_question reads it back', read?.ok === true && read.data?.id === asked?.data?.id && read.data?.status === 'open', read);
    const mcpTask = await run('get_task', { task_id: checkout });
    check('MCP: get_task carries open_question', mcpTask?.ok === true && mcpTask.data?.open_question?.id === asked?.data?.id, mcpTask?.data?.open_question);
    const listed = await run('list_questions', { asked_by: 'me', status: 'open' });
    check('MCP: list_questions filters to your open questions', listed?.ok === true && listed.data.some((row: Loose) => row.id === asked?.data?.id)
      && listed.data.every((row: Loose) => row.asked_by === s.builder && row.status === 'open'), listed);
    const withdrawn = await run('cancel_question', { question_id: asked?.data?.id });
    check('MCP: cancel_question withdraws it', withdrawn?.ok === true && withdrawn.data?.status === 'cancelled', withdrawn);
    const refusedAnswer = await run('answer_question', { question_id: asked?.data?.id, choice: 'Yes' });
    check('MCP: answer_question by someone not asked is a refusal the agent can read', refusedAnswer?.ok === false && refusedAnswer.status === 403
      && refusedAnswer.error?.reason === 'not_asked', refusedAnswer);
    const ownerMcp = routeCaller({ key: s.keys.owner, origin: 'http://localhost' });
    const answerTool = tool('answer_question');
    const closed = outcomeResult(await answerTool.run(answerTool.input.parse({ question_id: asked?.data?.id, choice: 'Yes' }) as Record<string, unknown>,
      ownerMcp, { memberId: s.owner }), true).structuredContent as Loose;
    check('MCP: answer_question on a cancelled question is a 409 the agent can read', closed?.ok === false && closed.status === 409
      && closed.error?.reason === 'question_cancelled', closed);
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`questions: ${passed} checks passed, ${failures.length} failed:`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log(`questions: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
