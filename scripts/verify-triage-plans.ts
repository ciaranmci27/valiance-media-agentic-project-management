/**
 * Triage plans end to end, on the full schema through the real routes:
 * - a live plan applies what it may (task, comment, reminder, reply owed),
 *   records the triage and sets the message's status;
 * - a project outside the message's scope is proposed, the people who can act
 *   are notified, and accepting it applies it as theirs;
 * - one bad item rejects the whole plan with nothing written;
 * - the same key and body replays without a second task; another body is 409;
 * - a failed item leaves the plan partial and a retry adds nothing twice;
 * - a shadow plan records decisions only: no task, no triage, no status, no
 *   notification; the shadow context leaves out what the message caused;
 * - undo puts back what applied items did, or reports a change since;
 * - one open question per conversation; mute is Ciaran's alone;
 * - the queue waits for a quiet conversation and skips muted ones; the
 *   signal counts plan inboxes apart;
 * - nobody signed in writes plans.
 *
 * Run: npx tsx --tsconfig tsconfig.mcp-test.json scripts/verify-triage-plans.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import type { PGlite } from '@electric-sql/pglite';
import { createFullSchemaDatabase } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 900)}`);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are read loosely in checks
type Body = { success?: boolean; data?: Record<string, any>; error?: { code?: string; message?: string; details?: Record<string, any> } };
type Row = Record<string, unknown>;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ids = {
  owner: id(1), ashley: id(2), tom: id(3),
  acme: id(10), birch: id(11), old: id(12),
  inbox: id(20),
  agentTask: id(30), personTask: id(31),
};
let next = 100;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

async function seed(db: PGlite) {
  await db.exec(`DROP FUNCTION public.consume_api_rate_limit(uuid, integer, integer);
    CREATE FUNCTION public.consume_api_rate_limit(p_api_key_id uuid, p_limit integer, p_window_seconds integer)
    RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('allowed', true, 'remaining', p_limit - 1,
      'reset_at', now() + make_interval(secs => p_window_seconds)) $$;`);
  await db.exec(`
    INSERT INTO public.team_members (id, name, email, role) VALUES
      ('${ids.owner}', 'Ciaran Mcintyre', 'owner@agency.example', 'owner'),
      ('${ids.ashley}', 'Ashley P.', 'ashley-bot@agency.example', 'agent'),
      ('${ids.tom}', 'Tom', 'tom@agency.example', 'member');
    INSERT INTO public.projects (id, name, status) VALUES
      ('${ids.acme}', 'Acme', 'active'), ('${ids.birch}', 'Birch', 'active'), ('${ids.old}', 'Old site', 'completed');
    INSERT INTO public.tasks (id, project_id, title, created_by, due_date) VALUES
      ('${ids.agentTask}', '${ids.acme}', 'Swap the hero image', '${ids.ashley}', '2026-11-10'),
      ('${ids.personTask}', '${ids.acme}', 'Footer links', '${ids.owner}', '2026-11-20');
    UPDATE public.business_settings SET inbound_email_domain = 'relay.example.test';
    INSERT INTO communications.inboxes (id, name, address, handler_member_id, triage_mode)
      VALUES ('${ids.inbox}', 'Ashley', 'ashley@agency.example', '${ids.ashley}', 'plans');
  `);
  const permissions = ['inbound_email.read', 'inbound_email.triage', 'inbound_email.signal', 'tasks.read', 'tasks.create', 'tasks.manage_all',
    'projects.read', 'projects.read_all', 'reminders.manage_own', 'files.read', 'files.upload', 'project_context.manage', 'leads.manage'];
  await db.query(`INSERT INTO public.team_member_permissions (member_id, permission_key, access_channel, effect)
    SELECT $1, key, 'api', 'allow' FROM unnest($2::text[]) AS key ON CONFLICT DO NOTHING`, [ids.ashley, permissions]);
  const secret = `pk_live_${randomUUID().replace(/-/g, '')}`;
  await db.query(`INSERT INTO public.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
    VALUES ('Ashley', 'pk_live', $1, $2, $3, 'scoped')`, [sha(secret), ids.ashley, permissions]);
  return secret;
}

/** A conversation with one message from `from`; returns both ids. */
async function message(db: PGlite, fields: {
  conversation?: string; from?: string; to?: string[]; trust?: string; candidates?: string[]; teammate?: string; delivery?: string;
  subject?: string; minutesAgo?: number; status?: string;
} = {}) {
  const conversation = fields.conversation ?? id(next++);
  const received = new Date(Date.now() - (fields.minutesAgo ?? 30) * 60_000).toISOString();
  if (!fields.conversation) {
    await db.query('INSERT INTO communications.conversations (id, inbox_id, last_message_at) VALUES ($1, $2, $3)', [conversation, ids.inbox, received]);
  } else {
    await db.query('UPDATE communications.conversations SET last_message_at = $2 WHERE id = $1', [conversation, received]);
  }
  const messageId = id(next++);
  await db.query(`INSERT INTO communications.messages (id, inbox_id, thread_id, status, provider, provider_email_id, internet_message_id,
      received_at, subject, kind, auth, sender_member_id, sender_verified, delivery, text_body, new_text)
    VALUES ($1, $2, $3, $4, 'test', $11, $11, $5, $6, 'person', $7, $8, $9, $10, 'Hi Ashley, please swap the hero image.', 'Hi Ashley, please swap the hero image.')`, [
    messageId, ids.inbox, conversation, fields.status ?? 'new', received, fields.subject ?? 'Hero image',
    JSON.stringify({ trust: fields.trust ?? 'trusted' }), fields.teammate ?? null, (fields.trust ?? 'trusted') === 'trusted', fields.delivery ?? 'direct', `m-${messageId}`,
  ]);
  await db.query("INSERT INTO communications.participants (message_id, kind, address) VALUES ($1, 'from', $2)", [messageId, fields.from ?? 'dana@acme.example']);
  for (const to of fields.to ?? ['ashley@agency.example']) {
    await db.query("INSERT INTO communications.participants (message_id, kind, address) VALUES ($1, 'to', $2)", [messageId, to]);
  }
  for (const project of fields.candidates ?? [ids.acme]) {
    await db.query("INSERT INTO communications.message_candidates (message_id, project_id, reason) VALUES ($1, $2, 'sender')", [messageId, project]);
  }
  return { conversation, message: messageId };
}

async function main() {
  const db = await createFullSchemaDatabase();
  await db.exec('RESET ROLE');
  const key = await seed(db);
  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key', NEXT_PUBLIC_ENABLE_AGENTS: 'true' });
  const q = async <T = Row>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };

  const planRoute = await import('../src/app/api/v1/inbox/messages/[id]/plan/route');
  const contextRoute = await import('../src/app/api/v1/inbox/messages/[id]/context/route');
  const queueRoute = await import('../src/app/api/v1/inbox/queue/route');
  const signalRoute = await import('../src/app/api/v1/inbound-emails/signal/route');
  const plans = await import('../src/lib/communications/plans');
  const { resolveMemberAccess } = await import('../src/lib/api/access');
  const { getServiceClient } = await import('../src/lib/api/supabase-service');

  const call = async (handler: (request: NextRequest, context: never) => Promise<Response>, method: string, path: string, params: Record<string, string> = {}, body?: unknown) => {
    const response = await handler(new NextRequest(`http://localhost${path}`, {
      method,
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { params: Promise.resolve(params) } as never);
    return { status: response.status, body: await response.json() as Body };
  };
  const plan = (messageId: string, body: unknown) => call(planRoute.POST, 'POST', `/api/v1/inbox/messages/${messageId}/plan`, { id: messageId }, body);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

  try {
    // ---- A live plan --------------------------------------------------------------
    const first = await message(db);
    const live = await plan(first.message, {
      summary: 'Dana wants the hero image swapped and a size chart.',
      thread_summary: 'Hero image swap',
      idempotency_key: 'k1',
      items: [
        { type: 'create_task', intent: 'new_work', project_id: ids.acme, title: 'Add the size chart', evidence: 'add a size chart' },
        { type: 'comment', intent: 'change', task_id: ids.agentTask, text: 'Dana: use the beach photo.' },
        { type: 'add_reminder', intent: 'waiting_on', title: 'Chase Dana for the photo', remind_on: '2026-11-03', task_id: ids.agentTask },
        { type: 'reply_owed', intent: 'reply_owed', who: 'Dana', what: 'When the swap goes live', kind: 'info', project_id: ids.acme },
      ],
    });
    const items = (live.body.data?.items ?? []) as Row[];
    check('live: the plan is recorded and applied', live.status === 201 && live.body.data?.plan.status === 'applied' && items.length === 4, live.body);
    check('live: each item applied', items.every((i) => i.state === 'done' && i.decision === 'apply'), items.map((i) => [i.type, i.decision, i.state, i.error]));
    const created = items[0].task_id as string;
    const [task] = await q('SELECT title, project_id, deleted_at FROM public.tasks WHERE id = $1', [created]);
    check('live: the new task exists on its project', task?.title === 'Add the size chart' && task.project_id === ids.acme, task);
    const links = await q('SELECT task_id, relation FROM communications.task_links WHERE message_id = $1 ORDER BY relation', [first.message]);
    check('live: the message links the new task (created) and the commented one (updated)',
      links.some((l) => l.task_id === created && l.relation === 'created') && links.some((l) => l.task_id === ids.agentTask && l.relation === 'updated'), links);
    const [triage] = await q('SELECT outcome, plan_id, question_for_human FROM communications.triage WHERE message_id = $1', [first.message]);
    check('live: a triage row records the plan for the Inbox and the summary feed', triage?.plan_id === live.body.data?.plan.id && triage.outcome === 'needs_reply', triage);
    const [status] = await q('SELECT status FROM communications.messages WHERE id = $1', [first.message]);
    check('live: nothing waits on a person, so the message is handled', status.status === 'handled', status);
    const [point] = await q("SELECT who, state FROM communications.reply_points WHERE conversation_id = $1", [first.conversation]);
    check('live: the reply owed is a point on the conversation', point?.who === 'Dana' && point.state === 'open', point);
    const [reminder] = await q('SELECT owner_id, source_message_id FROM public.reminders WHERE title = $1', ['Chase Dana for the photo']);
    check('live: the reminder is Ciaran\'s, from the message', reminder?.owner_id === ids.owner && reminder.source_message_id === first.message, reminder);
    await settle();
    const [notified] = await q("SELECT count(*)::int AS n FROM public.team_member_notifications WHERE entity_id = $1 AND is_read = false", [first.message]);
    check('live: a reply owed notifies Ciaran', notified.n === 1, notified);

    // ---- Replay and conflict ----------------------------------------------------------
    const again = await plan(first.message, {
      summary: 'Dana wants the hero image swapped and a size chart.', thread_summary: 'Hero image swap', idempotency_key: 'k1',
      items: (live.body.data?.items as Row[]).map((i) => i.payload),
    });
    const [taskCount] = await q("SELECT count(*)::int AS n FROM public.tasks WHERE title = 'Add the size chart' AND deleted_at IS NULL");
    check('replay: the same key and body replays, no second task', again.status === 200 && again.body.data?.replayed === true && taskCount.n === 1, [again.status, taskCount]);
    const conflict = await plan(first.message, { summary: 'Something else', idempotency_key: 'k1', items: [] });
    check('replay: the same key with another body is 409', conflict.status === 409, conflict.body);

    // ---- Invalid items reject the plan ----------------------------------------------
    const bad = await message(db);
    const invalid = await plan(bad.message, {
      summary: 'Two things',
      items: [
        { type: 'create_task', intent: 'new_work', project_id: ids.acme, title: 'Fine one' },
        { type: 'comment', intent: 'change', task_id: id(999), text: 'On a task that does not exist' },
      ],
    });
    const [badPlans] = await q('SELECT count(*)::int AS n FROM communications.plans WHERE message_id = $1', [bad.message]);
    const [badTasks] = await q("SELECT count(*)::int AS n FROM public.tasks WHERE title = 'Fine one'");
    check('invalid: one bad item rejects the plan, naming it, and nothing is written',
      invalid.status === 422 && invalid.body.error?.details?.items?.[0]?.index === 1 && badPlans.n === 0 && badTasks.n === 0, [invalid.body, badPlans, badTasks]);

    // ---- Out of scope: proposed, notified, accepted as a person ------------------------
    const scoped = await message(db);
    const proposed = await plan(scoped.message, {
      summary: 'Dana also mentions Birch.',
      items: [{ type: 'create_task', intent: 'new_work', project_id: ids.birch, title: 'Birch landing page' }],
    });
    const proposal = (proposed.body.data?.items as Row[])?.[0];
    check('scope: another client\'s project is proposed, never applied', proposal?.decision === 'propose' && proposal.state === 'pending', proposal);
    const [birchTasks] = await q("SELECT count(*)::int AS n FROM public.tasks WHERE title = 'Birch landing page'");
    const [scopedStatus] = await q('SELECT status FROM communications.messages WHERE id = $1', [scoped.message]);
    check('scope: nothing is created and the message waits on a person', birchTasks.n === 0 && scopedStatus.status === 'needs_human', [birchTasks, scopedStatus]);
    await settle();
    const [waiting] = await q("SELECT title, link FROM public.team_member_notifications WHERE entity_type = 'question' AND entity_id = $1 AND is_read = false", [scoped.message]);
    check('scope: Ciaran is notified, with a link to the thread', !!waiting && String(waiting.link).includes(scoped.message), waiting);

    const service = getServiceClient();
    const ownerAccess = await resolveMemberAccess(service, ids.owner);
    const person = { db: service, memberId: ids.owner, access: ownerAccess!, channel: 'app' as const, asPerson: true };
    await plans.acceptItem(person, proposal.id as string, {}, 'Ashley');
    const [accepted] = await q('SELECT state, resolved_by, task_id FROM communications.plan_items WHERE id = $1', [proposal.id]);
    const [filed] = await q('SELECT source FROM communications.conversation_projects WHERE conversation_id = $1 AND project_id = $2', [scoped.conversation, ids.birch]);
    check('accept: Ciaran accepting applies it as his: task made, Birch filed as person', accepted.state === 'accepted' && accepted.resolved_by === ids.owner
      && !!accepted.task_id && filed?.source === 'person', [accepted, filed]);
    const [read] = await q("SELECT is_read FROM public.team_member_notifications WHERE entity_type = 'question' AND entity_id = $1", [scoped.message]);
    check('accept: with nothing left waiting, the notification is read', read?.is_read === true, read);

    // ---- Untrusted sender: everything proposes -------------------------------------
    const spoof = await message(db, { trust: 'untrusted' });
    const spoofed = await plan(spoof.message, { summary: 'Asks for a change', items: [{ type: 'create_task', intent: 'new_work', project_id: ids.acme, title: 'Spoofed change' }] });
    check('trust: an unverified sender\'s task is proposed', (spoofed.body.data?.items as Row[])?.[0]?.decision === 'propose', spoofed.body);

    // ---- A failed item, then a retry --------------------------------------------------
    await q('INSERT INTO public.task_dependencies (task_id, blocked_by_task_id) VALUES ($1, $2)', [ids.agentTask, ids.personTask]);
    const moving = await message(db, { candidates: [ids.acme, ids.birch] });
    const partialBody = {
      summary: 'Move the hero task and add a note', idempotency_key: 'k-partial',
      items: [
        { type: 'comment', intent: 'change', task_id: ids.personTask, text: 'Noted.' },
        { type: 'update_task', intent: 'change', task_id: ids.agentTask, changes: { project_id: ids.birch } },
      ],
    };
    const partial = await plan(moving.message, partialBody);
    const partialItems = (partial.body.data?.items ?? []) as Row[];
    check('partial: an item that cannot apply fails alone and the plan is partial',
      partial.body.data?.plan.status === 'partial' && partialItems[0]?.state === 'done' && partialItems[1]?.state === 'failed', partialItems.map((i) => [i.type, i.decision, i.state, i.error]));
    await plan(moving.message, partialBody);
    const [notes] = await q("SELECT count(*)::int AS n FROM public.task_comments WHERE task_id = $1 AND text = 'Noted.' AND deleted_at IS NULL", [ids.personTask]);
    check('partial: a retry finishes what it can and adds nothing twice', notes.n === 1, notes);

    // ---- Shadow ---------------------------------------------------------------------
    const legacy = await message(db, { status: 'handled' });
    await q("INSERT INTO communications.task_links (message_id, task_id, relation) VALUES ($1, $2, 'updated')", [legacy.message, ids.agentTask]);
    const liveContext = await call(contextRoute.GET, 'GET', `/api/v1/inbox/messages/${legacy.message}/context`, { id: legacy.message });
    const shadowContext = await call(contextRoute.GET, 'GET', `/api/v1/inbox/messages/${legacy.message}/context?mode=shadow`, { id: legacy.message });
    check('context: the live bundle shows the message\'s links; the shadow one leaves them out',
      (liveContext.body.data?.message.linked_tasks ?? []).length === 1 && (shadowContext.body.data?.message.linked_tasks ?? []).length === 0, [liveContext.body.error, shadowContext.body.error]);
    check('context: speaker, delivery and the projects in scope with their open tasks', liveContext.body.data?.speaker === 'client'
      && liveContext.body.data?.delivery === 'direct' && liveContext.body.data?.addressed_to_agent === true
      && (liveContext.body.data?.projects ?? []).some((p: Row) => p.id === ids.acme && (p.open_tasks as Row[]).length >= 2), liveContext.body.data);
    const shadow = await plan(legacy.message, {
      mode: 'shadow', summary: 'Shadow read', items: [{ type: 'create_task', intent: 'new_work', project_id: ids.acme, title: 'Shadow only task' }],
    });
    const [shadowTasks] = await q("SELECT count(*)::int AS n FROM public.tasks WHERE title = 'Shadow only task'");
    const [shadowTriage] = await q('SELECT count(*)::int AS n FROM communications.triage WHERE message_id = $1', [legacy.message]);
    const [shadowStatus] = await q('SELECT status FROM communications.messages WHERE id = $1', [legacy.message]);
    const [shadowNotes] = await q('SELECT count(*)::int AS n FROM public.team_member_notifications WHERE entity_id = $1', [legacy.message]);
    check('shadow: decisions recorded, nothing applied, no triage, no status change, no notification',
      shadow.status === 201 && (shadow.body.data?.items as Row[])?.[0]?.decision === 'apply' && (shadow.body.data?.items as Row[])?.[0]?.state === 'skipped'
      && shadowTasks.n === 0 && shadowTriage.n === 0 && shadowStatus.status === 'handled' && shadowNotes.n === 0, [shadow.body, shadowTasks, shadowTriage, shadowStatus, shadowNotes]);

    // ---- Undo -----------------------------------------------------------------------
    const agent = { db: service, memberId: ids.owner, access: ownerAccess!, channel: 'app' as const, asPerson: true };
    await plans.undoPlan(agent, live.body.data?.plan.id as string);
    const [undoneTask] = await q('SELECT deleted_at FROM public.tasks WHERE id = $1', [created]);
    const [undonePoint] = await q('SELECT state FROM communications.reply_points WHERE conversation_id = $1', [first.conversation]);
    const [undoneReminder] = await q("SELECT deleted_at FROM public.reminders WHERE title = 'Chase Dana for the photo'");
    check('undo: the created task and reminder go to Trash, the reply owed is resolved',
      !!undoneTask.deleted_at && undonePoint.state === 'resolved' && !!undoneReminder.deleted_at, [undoneTask, undonePoint, undoneReminder]);

    const dated = await message(db);
    const moved = await plan(dated.message, {
      summary: 'New date', items: [{ type: 'update_task', intent: 'change', task_id: ids.agentTask, changes: { due_date: '2026-11-14' } }],
    });
    const moveItem = (moved.body.data?.items as Row[])?.[0];
    check('fields: a date the agent set moves as unsure', moveItem?.decision === 'apply_unsure' && moveItem.state === 'done', moveItem);
    await q("UPDATE public.tasks SET due_date = '2026-11-30' WHERE id = $1", [ids.agentTask]);
    const changed = await plans.undoItem(agent, moveItem.id as string);
    check('undo: a field a person changed since is left alone and reported', (changed as Row).changed_since === true, changed);
    const personDate = await message(db);
    const personMove = await plan(personDate.message, {
      summary: 'New date', items: [{ type: 'update_task', intent: 'change', task_id: ids.personTask, changes: { due_date: '2026-12-01' } }],
    });
    check('fields: a date a person set waits for them', (personMove.body.data?.items as Row[])?.[0]?.decision === 'propose', personMove.body);

    // ---- Questions and mute -------------------------------------------------------------
    const asking = await message(db);
    const asked = await plan(asking.message, { summary: 'Which brand?', items: [{ type: 'ask', intent: 'new_work', question: 'Curves or Nuts?', default: 'Curves' }] });
    check('ask: a question waits on its conversation', (asked.body.data?.items as Row[])?.[0]?.state === 'pending', asked.body);
    const followUp = await message(db, { conversation: asking.conversation });
    const second = await plan(followUp.message, { summary: 'Asks again', items: [{ type: 'ask', intent: 'new_work', question: 'Which brand again?' }] });
    check('ask: a second open question on the conversation is refused', second.status === 422 && second.body.error?.details?.reason === 'question_already_open', second.body);
    const [askTriage] = await q('SELECT question_for_human FROM communications.triage WHERE message_id = $1', [asking.message]);
    check('ask: the question and its default reach the Inbox', askTriage?.question_for_human === 'Curves or Nuts? Default: Curves', askTriage);

    const clientMute = await plan(followUp.message, { summary: 'Client says stop', items: [{ type: 'mute_conversation', intent: 'context' }] });
    check('mute: a client cannot mute', (clientMute.body.data?.items as Row[])?.[0]?.decision === 'reject', clientMute.body);
    const fromOwner = await message(db, { teammate: ids.owner, from: 'owner@agency.example', candidates: [] });
    const ownerMute = await plan(fromOwner.message, { summary: 'Ignore this thread', items: [{ type: 'mute_conversation', intent: 'owner_instruction' }] });
    const [muted] = await q('SELECT muted_at, muted_by FROM communications.conversations WHERE id = $1', [fromOwner.conversation]);
    check('mute: Ciaran writing to Ashley mutes the conversation', (ownerMute.body.data?.items as Row[])?.[0]?.decision === 'apply' && !!muted.muted_at && muted.muted_by === ids.ashley, [ownerMute.body, muted]);

    // ---- Queue and signal -----------------------------------------------------------------
    const fresh = await message(db, { minutesAgo: 1 });
    const quiet = await message(db, { minutesAgo: 10 });
    const mutedNew = await message(db, { minutesAgo: 10 });
    await q('UPDATE communications.conversations SET muted_at = now() WHERE id = $1', [mutedNew.conversation]);
    const queue = await call(queueRoute.GET, 'GET', '/api/v1/inbox/queue?mode=plans');
    const queued = ((queue.body.data?.messages ?? []) as Row[]).map((m) => m.id);
    check('queue: a quiet conversation is ready; a busy or muted one is not',
      queued.includes(quiet.message) && !queued.includes(fresh.message) && !queued.includes(mutedNew.message), queue.body);
    const signal = await call(signalRoute.GET, 'GET', '/api/v1/inbox/signal');
    check('signal: plan inboxes count apart from the old triage\'s new mail',
      signal.body.data?.new_count === 0 && signal.body.data?.plans_new_count >= 1 && signal.body.data?.shadow_pending_count === 0, signal.body);

    // ---- A person in the Inbox --------------------------------------------------------------
    const inboxPlans = await import('../src/lib/communications/inbox-plans');
    const inboxService = await import('../src/lib/communications/inbox-service');
    const ownerCtx = { service, access: ownerAccess!, memberId: ids.owner };
    const proposing = await message(db);
    const twoProposals = await plan(proposing.message, {
      summary: 'Two proposals and a reply owed',
      items: [
        { type: 'add_context', intent: 'context', project_id: ids.acme, category: 'business_context', content: 'Acme closes Dec 20 to Jan 5.' },
        { type: 'create_task', intent: 'new_work', project_id: ids.birch, title: 'Birch audit' },
        { type: 'reply_owed', intent: 'reply_owed', who: 'Dana', what: 'Holiday hours', kind: 'schedule' },
      ],
    });
    const [contextItem, birchItem, owedItem] = (twoProposals.body.data?.items ?? []) as Row[];
    await inboxPlans.acceptPlanItem(ownerCtx, contextItem.id as string);
    const [contextRow] = await q("SELECT is_active, source FROM public.project_context WHERE content = 'Acme closes Dec 20 to Jan 5.'");
    check('inbox: accepting a fact adds it to the project\'s context', contextRow?.is_active === true && contextRow.source === 'agent', contextRow);
    await inboxPlans.dismissPlanItem(ownerCtx, birchItem.id as string);
    const [dismissed] = await q('SELECT state, resolved_by FROM communications.plan_items WHERE id = $1', [birchItem.id]);
    const [stillWaiting] = await q("SELECT is_read FROM public.team_member_notifications WHERE entity_type = 'question' AND entity_id = $1", [proposing.message]);
    check('inbox: a dismissed proposal is resolved; the reply owed still waits, so the notification stays',
      dismissed.state === 'dismissed' && dismissed.resolved_by === ids.owner && stillWaiting?.is_read === false, [dismissed, stillWaiting]);
    const owedPoint = await q('SELECT id FROM communications.reply_points WHERE plan_item_id = $1', [owedItem.id]);
    await inboxPlans.resolveReplyPoint(ownerCtx, owedPoint[0].id as string);
    const [nowRead] = await q("SELECT is_read FROM public.team_member_notifications WHERE entity_type = 'question' AND entity_id = $1", [proposing.message]);
    check('inbox: resolving the last thing waiting marks the notification read', nowRead?.is_read === true, nowRead);

    const undoing = await message(db);
    const toUndo = await plan(undoing.message, { summary: 'A task', items: [{ type: 'create_task', intent: 'new_work', project_id: ids.acme, title: 'Undo me' }] });
    await inboxPlans.undoWholePlan(ownerCtx, toUndo.body.data?.plan.id as string);
    const [undoneByInbox] = await q("SELECT deleted_at FROM public.tasks WHERE title = 'Undo me'");
    check('inbox: undoing a plan from the Inbox puts its task in Trash', !!undoneByInbox?.deleted_at, undoneByInbox);

    await inboxService.answerAgentQuestion(ownerCtx, asking.conversation, asking.message, 'Curves');
    const [answered] = await q("SELECT state, result FROM communications.plan_items WHERE conversation_id = $1 AND type = 'ask'", [asking.conversation]);
    check('inbox: answering the question resolves the plan\'s open question', answered?.state === 'accepted' && (answered.result as Row)?.answer === 'Curves', answered);

    const stale = await message(db);
    const staleProposal = await plan(stale.message, { summary: 'Old proposal', items: [{ type: 'create_task', intent: 'new_work', project_id: ids.birch, title: 'Stale Birch idea' }] });
    await q("UPDATE communications.plan_items SET created_at = now() - interval '15 days' WHERE id = $1", [(staleProposal.body.data?.items as Row[])[0].id]);
    const expired = await plans.expireWaiting(service);
    const [lapsed] = await q('SELECT state FROM communications.plan_items WHERE id = $1', [(staleProposal.body.data?.items as Row[])[0].id]);
    check('expiry: a proposal waiting over two weeks lapses quietly', expired.proposals >= 1 && lapsed.state === 'expired', [expired, lapsed]);

    // ---- Nobody signed in writes plans ------------------------------------------------------
    await db.exec(`RESET ROLE; INSERT INTO auth.users (id, email) VALUES ('${id(90)}', 'rae@agency.example')`);
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [id(90)]);
    await db.exec('SET ROLE authenticated');
    let refused = '';
    try {
      await db.query("INSERT INTO communications.plans (message_id, conversation_id, mode, summary) VALUES ($1, $2, 'live', 'x')", [first.message, first.conversation]);
    } catch (error) { refused = (error as Error).message; }
    check('grants: a signed-in member cannot write a plan', /permission denied/.test(refused), refused);
    await db.exec('RESET ROLE');
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`triage plans: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join('\n - ')}`);
    process.exitCode = 1;
  } else {
    console.log(`triage plans: ${passed} checks passed.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
