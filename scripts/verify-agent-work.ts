/**
 * Undo all and Restore all on the agent's work (src/lib/communications/agent-work.ts),
 * on the full schema behind fake-postgrest:
 * - an older email (triaged before plans): the tasks the agent created go to
 *   Trash (one already done stays), its reminders go to Trash (one done
 *   stays, a person's own is left alone), its links to existing tasks are
 *   removed (an "updated" one reports its edits stay), a person's link stays;
 * - one task's links only, when a row asks for that;
 * - an email with a plan: its applied items are undone through the plan;
 * - Restore all puts back exactly that: tasks, reminders, links (still the
 *   agent's), plan items (accepted again);
 * - one plan item: an undo or a skip is taken back;
 * - another conversation's emails or records are refused (422) and nothing changes.
 *
 * Run: npx tsx --tsconfig tsconfig.mcp-test.json scripts/verify-agent-work.ts
 */
import { createFullSchemaDatabase } from './full-schema-db';
import { startFakePostgrest } from './fake-postgrest';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 900)}`);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are checked field by field
type Row = Record<string, any>;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ids = {
  owner: id(1), ashley: id(2), acme: id(10), inbox: id(20),
  legacy: id(30), legacyMessage: id(31), triage: id(32),
  madeTask: id(40), doneTask: id(41), aboutTask: id(42), editedTask: id(43), personTask: id(44),
  reminder: id(50), doneReminder: id(51), ownReminder: id(52),
  planned: id(60), plannedMessage: id(61), plan: id(62), planTask: id(63), planReminder: id(64), planSkip: id(65),
  other: id(70), otherMessage: id(71), otherTask: id(72),
};

async function main() {
  const db = await createFullSchemaDatabase();
  await db.exec('RESET ROLE');
  await db.exec(`
    INSERT INTO public.team_members (id, name, email, role) VALUES
      ('${ids.owner}', 'Ciaran Mcintyre', 'owner@agency.example', 'owner'),
      ('${ids.ashley}', 'Ashley P.', 'ashley-bot@agency.example', 'agent');
    INSERT INTO public.projects (id, name, status) VALUES ('${ids.acme}', 'Acme', 'active');
    INSERT INTO communications.inboxes (id, name, address, handler_member_id) VALUES ('${ids.inbox}', 'Ashley', 'ashley@agency.example', '${ids.ashley}');
  `);
  for (const [conversation, message, subject] of [[ids.legacy, ids.legacyMessage, 'Logo files'], [ids.planned, ids.plannedMessage, 'Hero image'], [ids.other, ids.otherMessage, 'Other']]) {
    await db.query(`INSERT INTO communications.conversations (id, inbox_id, subject_normalized, channel, project_id, project_source, last_message_at)
      VALUES ($1, $2, $3, 'email', $4, 'mapped', now())`, [conversation, ids.inbox, subject.toLowerCase(), ids.acme]);
    await db.query("INSERT INTO communications.conversation_projects (conversation_id, project_id, source) VALUES ($1, $2, 'mapped')", [conversation, ids.acme]);
    await db.query(`INSERT INTO communications.messages (id, inbox_id, thread_id, channel, status, provider, provider_email_id, internet_message_id,
        received_at, subject, kind, auth, text_body, new_text)
      VALUES ($1, $2, $3, 'email', 'handled', 'test', $4, $4, now(), $5, 'person', '{"trust":"trusted"}', 'Body', 'Body')`,
    [message, ids.inbox, conversation, `m-${message}`, subject]);
  }
  await db.query(`INSERT INTO communications.triage (id, message_id, member_id, outcome, summary) VALUES ($1, $2, $3, 'task', 'Dana sent the logo files.')`,
    [ids.triage, ids.legacyMessage, ids.ashley]);
  const task = (taskId: string, title: string, by: string, status = 'todo') => db.query(
    'INSERT INTO public.tasks (id, project_id, title, created_by, status) VALUES ($1, $2, $3, $4, $5)', [taskId, ids.acme, title, by, status]);
  await task(ids.madeTask, 'Upload the logo', ids.ashley);
  await task(ids.doneTask, 'Reply to Dana', ids.ashley, 'done');
  await task(ids.aboutTask, 'Brand guide', ids.owner);
  await task(ids.editedTask, 'Homepage', ids.owner);
  await task(ids.personTask, 'Invoice', ids.owner);
  await task(ids.otherTask, 'Somewhere else', ids.ashley);
  const link = (message: string, taskId: string, relation: string, triage: string | null) => db.query(
    'INSERT INTO communications.task_links (message_id, task_id, relation, triage_id, linked_by) VALUES ($1, $2, $3, $4, $5)',
    [message, taskId, relation, triage, triage ? ids.ashley : ids.owner]);
  await link(ids.legacyMessage, ids.madeTask, 'created', ids.triage);
  await link(ids.legacyMessage, ids.doneTask, 'created', ids.triage);
  await link(ids.legacyMessage, ids.aboutTask, 'related', ids.triage);
  await link(ids.legacyMessage, ids.editedTask, 'updated', ids.triage);
  await link(ids.legacyMessage, ids.personTask, 'related', null);
  const reminder = (reminderId: string, title: string, by: string, status = 'open') => db.query(
    'INSERT INTO public.reminders (id, title, source_message_id, owner_id, created_by, status) VALUES ($1, $2, $3, $4, $5, $6)',
    [reminderId, title, ids.legacyMessage, ids.owner, by, status]);
  await reminder(ids.reminder, 'Chase the vector logo', ids.ashley);
  await reminder(ids.doneReminder, 'Check the favicon', ids.ashley, 'done');
  await reminder(ids.ownReminder, 'My own note', ids.owner);
  // An email with a plan: a task and a reminder to accept, one to skip.
  await db.query(`INSERT INTO communications.plans (id, message_id, conversation_id, member_id, mode, status, summary) VALUES ($1, $2, $3, $4, 'live', 'partial', 'Plan')`,
    [ids.plan, ids.plannedMessage, ids.planned, ids.ashley]);
  for (const [itemId, position, payload] of [
    [ids.planTask, 0, { type: 'create_task', intent: 'new_work', project_id: ids.acme, title: 'Swap the hero' }],
    [ids.planReminder, 1, { type: 'add_reminder', intent: 'waiting_on', project_id: ids.acme, title: 'Chase the hero photo', remind_on: '2026-12-01' }],
    [ids.planSkip, 2, { type: 'create_task', intent: 'new_work', project_id: ids.acme, title: 'Not wanted' }],
  ] as const) {
    await db.query(`INSERT INTO communications.plan_items (id, plan_id, position, conversation_id, mode, type, intent, project_id, payload, decision, state)
      VALUES ($1, $2, $3, $4, 'live', $5, $6, $7, $8, 'propose', 'pending')`,
    [itemId, ids.plan, position, ids.planned, payload.type, payload.intent, ids.acme, JSON.stringify(payload)]);
  }

  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key' });
  const q = async <T = Row>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  const live = async (table: 'tasks' | 'reminders', rowId: string) => (await q(`SELECT deleted_at FROM public.${table} WHERE id = $1`, [rowId]))[0]?.deleted_at === null;
  const links = async (message: string) => (await q<{ task_id: string; relation: string; triage_id: string | null }>(
    'SELECT task_id, relation, triage_id FROM communications.task_links WHERE message_id = $1 ORDER BY task_id, relation', [message]));
  const state = async (itemId: string) => (await q('SELECT state FROM communications.plan_items WHERE id = $1', [itemId]))[0]?.state;

  try {
    const { undoAgentWork, restoreAgentWork } = await import('../src/lib/communications/agent-work');
    const inboxPlans = await import('../src/lib/communications/inbox-plans');
    const inbox = await import('../src/lib/communications/inbox-service');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const service = getServiceClient();
    const owner = { service, access: (await resolveMemberAccess(service, ids.owner))!, memberId: ids.owner };
    const refused = async (work: () => Promise<unknown>) => {
      try { await work(); return 0; } catch (error) { return (error as { status?: number }).status ?? -1; }
    };
    const linksBefore = await links(ids.legacyMessage);

    // ---- Another conversation's emails are refused ------------------------------------------------
    const foreign = await refused(() => undoAgentWork(owner, ids.legacy, { message_ids: [ids.otherMessage], task_id: null }));
    check('undo: an email from another conversation is refused (422)', foreign === 422 && await live('tasks', ids.otherTask), foreign);

    // ---- One task's links only --------------------------------------------------------------------
    const one = await undoAgentWork(owner, ids.legacy, { message_ids: [ids.legacyMessage], task_id: ids.aboutTask });
    check('one task: only the agent\'s link to it is removed', one.links.length === 1 && one.links[0].task_id === ids.aboutTask
      && one.tasks.length === 0 && one.reminders.length === 0 && (await links(ids.legacyMessage)).length === linksBefore.length - 1, one);
    const putBack = await restoreAgentWork(owner, ids.legacy, one);
    check('one task: restoring ties it again, still the agent\'s', putBack.restored === 1
      && JSON.stringify(await links(ids.legacyMessage)) === JSON.stringify(linksBefore), await links(ids.legacyMessage));

    // ---- Undo all on an older email ---------------------------------------------------------------
    const undo = await undoAgentWork(owner, ids.legacy, { message_ids: [ids.legacyMessage], task_id: null });
    check('older email: the task the agent created goes to Trash', JSON.stringify(undo.tasks) === JSON.stringify([ids.madeTask]) && !(await live('tasks', ids.madeTask)), undo);
    check('older email: a task it created that is done stays', await live('tasks', ids.doneTask)
      && undo.kept.some((k) => k.label === 'Reply to Dana' && /done/.test(k.reason)), undo.kept);
    check('older email: its reminder goes to Trash, a done one and a person\'s own stay',
      JSON.stringify(undo.reminders) === JSON.stringify([ids.reminder]) && !(await live('reminders', ids.reminder))
        && await live('reminders', ids.doneReminder) && await live('reminders', ids.ownReminder), undo.reminders);
    const after = await links(ids.legacyMessage);
    check('older email: the agent\'s links to existing tasks go, a person\'s link and the created ones stay',
      JSON.stringify(after.map((l) => l.task_id)) === JSON.stringify([ids.madeTask, ids.doneTask, ids.personTask].sort()), after);
    check('older email: an updated task says its edits stay', undo.kept.some((k) => k.label === 'Homepage' && /edits stay/.test(k.reason)), undo.kept);
    const detail = await inbox.threadDetail(owner, ids.legacy);
    const agentLinks = detail.messages[0].linked_tasks.filter((t) => t.by === 'agent').map((t) => t.task_id);
    check('older email: the thread now lists only the done task as the agent\'s', JSON.stringify(agentLinks) === JSON.stringify([ids.doneTask]), agentLinks);

    // ---- Restore refuses what is not this conversation's ------------------------------------------
    const stranger = await refused(() => restoreAgentWork(owner, ids.legacy, { ...undo, tasks: [...undo.tasks, ids.otherTask] }));
    check('restore: a task from another conversation is refused (422) and nothing comes back', stranger === 422 && !(await live('tasks', ids.madeTask)), stranger);

    // A person's own reminder, binned by hand, is not Restore all's to bring back.
    await q('UPDATE public.reminders SET deleted_at = now() WHERE id = $1', [ids.ownReminder]);
    const ownBack = await refused(() => restoreAgentWork(owner, ids.legacy, { plan_items: [], tasks: [], reminders: [ids.ownReminder], links: [] }));
    check('restore: a person\'s own reminder is refused (422) and stays in Trash', ownBack === 422 && !(await live('reminders', ids.ownReminder)), ownBack);
    await q('UPDATE public.reminders SET deleted_at = NULL WHERE id = $1', [ids.ownReminder]);

    // ---- Restore all ------------------------------------------------------------------------------
    const restored = await restoreAgentWork(owner, ids.legacy, undo);
    const again = await restoreAgentWork(owner, ids.legacy, undo);
    check('restore: a second Restore all finds everything back and changes nothing', again.restored === 0 && again.kept.length === 0, again);
    check('restore: the task and reminder come back and the links are tied again as the agent\'s',
      restored.restored === 4 && await live('tasks', ids.madeTask) && await live('reminders', ids.reminder)
        && JSON.stringify(await links(ids.legacyMessage)) === JSON.stringify(linksBefore), { restored, links: await links(ids.legacyMessage) });

    // ---- An email with a plan ---------------------------------------------------------------------
    await inboxPlans.acceptPlanItem(owner, ids.planTask);
    await inboxPlans.acceptPlanItem(owner, ids.planReminder);
    await inboxPlans.dismissPlanItem(owner, ids.planSkip);
    const madePlanTask = (await q("SELECT id FROM public.tasks WHERE title = 'Swap the hero'"))[0].id as string;
    const planUndo = await undoAgentWork(owner, ids.planned, { message_ids: null, task_id: null });
    check('plan: Undo all undoes its applied items through the plan', JSON.stringify([...planUndo.plan_items].sort()) === JSON.stringify([ids.planTask, ids.planReminder].sort())
      && await state(ids.planTask) === 'undone' && await state(ids.planReminder) === 'undone' && !(await live('tasks', madePlanTask))
      && await state(ids.planSkip) === 'dismissed' && planUndo.tasks.length === 0, planUndo);
    // One put back on its own first: Restore all leaves it and brings the rest.
    await inboxPlans.restorePlanItem(owner, ids.planReminder);
    const planBack = await restoreAgentWork(owner, ids.planned, planUndo);
    const [planRow] = await q('SELECT status FROM communications.plans WHERE id = $1', [ids.plan]);
    check('plan: Restore all brings the rest back, skips the one already back, and the items read accepted again', planBack.restored === 1 && planBack.kept.length === 0
      && await state(ids.planTask) === 'accepted' && await state(ids.planReminder) === 'accepted' && await live('tasks', madePlanTask)
      && planRow.status === 'applied', { planBack, planRow });

    // ---- A finished task reads as done on its plan row ---------------------------------------------
    const openRow = (await inbox.threadDetail(owner, ids.planned)).messages[0].plan?.items.find((i) => i.id === ids.planTask);
    await q("UPDATE public.tasks SET status = 'done' WHERE id = $1", [madePlanTask]);
    const doneRow = (await inbox.threadDetail(owner, ids.planned)).messages[0].plan?.items.find((i) => i.id === ids.planTask);
    check('plan row: an open task is not done, the same task once finished is', openRow?.target_done === false && doneRow?.target_done === true, { openRow, doneRow });
    await q("UPDATE public.tasks SET status = 'todo' WHERE id = $1", [madePlanTask]);

    // ---- One plan item: an undo, and a skip, taken back -------------------------------------------
    await inboxPlans.undoPlanItem(owner, ids.planTask);
    await inboxPlans.restorePlanItem(owner, ids.planTask);
    check('item: an undone task comes back accepted', await state(ids.planTask) === 'accepted' && await live('tasks', madePlanTask));
    await inboxPlans.restorePlanItem(owner, ids.planSkip);
    check('item: a skipped suggestion waits again', await state(ids.planSkip) === 'pending');
    const twice = await refused(() => inboxPlans.restorePlanItem(owner, ids.planSkip));
    check('item: one that is not undone or skipped is refused (409)', twice === 409, twice);
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`agent work: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join('\n - ')}`);
    process.exitCode = 1;
  } else {
    console.log(`agent work: ${passed} checks passed.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
