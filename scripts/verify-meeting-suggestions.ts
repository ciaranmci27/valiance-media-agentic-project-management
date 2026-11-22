/**
 * A meeting's suggestions (src/lib/communications/meeting/suggestions.ts), on
 * the full schema behind fake-postgrest. From a meeting the agent only
 * suggests; a person adds them all, or says there is nothing to do:
 * - "Add all" accepts every waiting suggestion of the meeting once, as the
 *   person's (a task, a reminder, a comment), and leaves questions alone;
 * - a second "Add all" adds nothing, and two at once add each item once;
 * - Undo (each added item undone, newest first) puts the set back;
 * - "Nothing to do" skips what waits, leaves what was already applied or
 *   accepted, creates, trashes and closes nothing (not even the person's own
 *   "Reply to" reminder, as Mark handled would), marks the messages handled
 *   and records who said so; its Undo puts the suggestions and messages back
 *   and clears the mark, leaving everything else as it was;
 * - an email conversation is refused (409) by both;
 * - the Inbox list and thread carry the meeting (title, times, organizer,
 *   attendees, packages), and a task's source names the meeting.
 *
 * Run: npx tsx --tsconfig tsconfig.mcp-test.json scripts/verify-meeting-suggestions.ts
 */
import type { PGlite } from '@electric-sql/pglite';
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
  owner: id(1), ashley: id(2),
  acme: id(10), inbox: id(20),
  weekly: id(30), transcript: id(31), notes: id(32),
  catchUp: id(33), catchUpTranscript: id(34),
  email: id(40), emailMessage: id(41),
  existingTask: id(50),
  weeklyPlan: id(60), task: id(61), reminder: id(62), comment: id(63), linked: id(64), question: id(65),
  catchUpPlan: id(70), catchUpTask: id(71), catchUpAccepted: id(72), catchUpQuestion: id(73),
  catchUpReply: id(74),
  emailPlan: id(80), emailTask: id(81),
  kickoff: id(90), kickoffTranscript: id(91), kickoffPlan: id(92), kickoffTask: id(93), kickoffTask2: id(94), kickoffReminder: id(95),
  stuckAccept: id(96), freshAccept: id(97),
};

async function seed(db: PGlite) {
  await db.exec(`
    INSERT INTO pm.team_members (id, name, email, role) VALUES
      ('${ids.owner}', 'Ciaran Mcintyre', 'owner@agency.example', 'owner'),
      ('${ids.ashley}', 'Ashley P.', 'ashley-bot@agency.example', 'agent');
    INSERT INTO pm.projects (id, name, status) VALUES ('${ids.acme}', 'Acme', 'active');
    INSERT INTO pm.tasks (id, project_id, title, created_by) VALUES ('${ids.existingTask}', '${ids.acme}', 'Homepage refresh', '${ids.owner}');
    INSERT INTO pm.inboxes (id, name, address, handler_member_id, triage_mode)
      VALUES ('${ids.inbox}', 'Ashley', 'ashley@agency.example', '${ids.ashley}', 'plans');
  `);
  const conversation = async (conversationId: string, channel: 'email' | 'meeting', title: string, minutesAgo: number) => {
    await db.query(`INSERT INTO pm.conversations (id, inbox_id, subject_normalized, channel, project_id, project_source, last_message_at)
      VALUES ($1, $2, $3, $4, $5, 'mapped', now() - make_interval(mins => $6))`,
    [conversationId, ids.inbox, channel === 'meeting' ? '' : title.toLowerCase(), channel, ids.acme, minutesAgo]);
    await db.query("INSERT INTO pm.conversation_projects (conversation_id, project_id, source) VALUES ($1, $2, 'mapped') ON CONFLICT DO NOTHING",
      [conversationId, ids.acme]);
    if (channel === 'meeting') {
      await db.query(`INSERT INTO pm.meetings (conversation_id, inbox_id, meeting_key, title, starts_at, ends_at, organizer_address, doc_url)
        VALUES ($1, $2, $3, $4, '2026-11-11T22:00:00Z', '2026-11-11T23:00:00Z', 'dana@acme.example', 'https://docs.google.com/document/d/abc/edit')`,
      [conversationId, ids.inbox, `key-${conversationId}`, title]);
    }
  };
  const message = async (messageId: string, thread: string, channel: string, subject: string, minutesAgo: number, status = 'needs_human') => {
    await db.query(`INSERT INTO pm.messages (id, inbox_id, thread_id, channel, status, provider, provider_email_id, internet_message_id,
        received_at, subject, kind, auth, text_body, new_text)
      VALUES ($1, $2, $3, $4, $9, 'test', $5, $5, now() - make_interval(mins => $6), $7, $8, '{"trust":"trusted"}', 'Body', 'Body')`,
    [messageId, ids.inbox, thread, channel, `m-${messageId}`, minutesAgo, subject, channel === 'meeting' ? 'meeting_notes' : 'person', status]);
    await db.query("INSERT INTO pm.participants (message_id, kind, address, name, position) VALUES ($1, 'from', $2, $3, 0)",
      [messageId, channel === 'meeting' ? 'owner@agency.example' : 'dana@acme.example', channel === 'meeting' ? 'Ciaran Mcintyre' : 'Dana']);
  };
  await conversation(ids.weekly, 'meeting', 'Weekly review', 10);
  await message(ids.transcript, ids.weekly, 'meeting', 'Meeting transcript: Weekly review (2026-11-11)', 10);
  await message(ids.notes, ids.weekly, 'meeting', 'Meeting summary: Weekly review (2026-11-11)', 5, 'handled');
  for (const [position, address, name] of [[1, 'dana@acme.example', 'Dana'], [2, 'owner@agency.example', ''], [3, 'joe@acme.example', 'Joe']] as const) {
    await db.query("INSERT INTO pm.participants (message_id, kind, address, name, position) VALUES ($1, 'attendee', $2, $3, $4)",
      [ids.transcript, address, name, position]);
  }
  await conversation(ids.catchUp, 'meeting', 'Friday catch-up', 30);
  await message(ids.catchUpTranscript, ids.catchUp, 'meeting', 'Meeting transcript: Friday catch-up (2026-11-14)', 30);
  await conversation(ids.kickoff, 'meeting', 'Kickoff', 20);
  await message(ids.kickoffTranscript, ids.kickoff, 'meeting', 'Meeting transcript: Kickoff (2026-11-13)', 20);
  await conversation(ids.email, 'email', 'Hero image', 60);
  await message(ids.emailMessage, ids.email, 'email', 'Hero image', 60);

  const plan = async (planId: string, messageId: string, conversationId: string) => db.query(
    `INSERT INTO pm.plans (id, message_id, conversation_id, member_id, mode, status, summary) VALUES ($1, $2, $3, $4, 'live', 'partial', 'Suggestions')`,
    [planId, messageId, conversationId, ids.ashley]);
  const item = async (itemId: string, planId: string, position: number, conversationId: string, payload: Row, state = 'pending', decision = 'propose') => db.query(
    `INSERT INTO pm.plan_items (id, plan_id, position, conversation_id, mode, type, intent, project_id, task_id, payload, decision, state)
      VALUES ($1, $2, $3, $4, 'live', $5, $6, $7, $8, $9, $10, $11)`,
    [itemId, planId, position, conversationId, payload.type, payload.intent, payload.project_id ?? (payload.task_id ? ids.acme : null), payload.task_id ?? null,
      JSON.stringify(payload), decision, state]);

  // The weekly review: a task, a reminder and a comment to add; a link the policy applied; a question.
  await plan(ids.weeklyPlan, ids.transcript, ids.weekly);
  await item(ids.task, ids.weeklyPlan, 0, ids.weekly, { type: 'create_task', intent: 'new_work', project_id: ids.acme, title: 'Send the proposal' });
  await item(ids.reminder, ids.weeklyPlan, 1, ids.weekly, { type: 'add_reminder', intent: 'waiting_on', project_id: ids.acme, title: 'Chase Dana for the logo', remind_on: '2026-11-20' });
  await item(ids.comment, ids.weeklyPlan, 2, ids.weekly, { type: 'comment', intent: 'change', task_id: ids.existingTask, text: 'Dana wants the hero darker.' });
  await item(ids.linked, ids.weeklyPlan, 3, ids.weekly, { type: 'link_task', intent: 'change', task_id: ids.existingTask, relation: 'related' }, 'done', 'apply');
  await item(ids.question, ids.weeklyPlan, 4, ids.weekly, { type: 'ask', intent: 'owner_instruction', question: 'Bill the extra hours?' });
  // The catch-up: one suggestion waiting, one a person already accepted, a question.
  await plan(ids.catchUpPlan, ids.catchUpTranscript, ids.catchUp);
  await item(ids.catchUpTask, ids.catchUpPlan, 0, ids.catchUp, { type: 'create_task', intent: 'new_work', project_id: ids.acme, title: 'Swap the footer' });
  await item(ids.catchUpAccepted, ids.catchUpPlan, 1, ids.catchUp, { type: 'create_task', intent: 'new_work', project_id: ids.acme, title: 'Already accepted' }, 'accepted');
  await item(ids.catchUpQuestion, ids.catchUpPlan, 2, ids.catchUp, { type: 'ask', intent: 'owner_instruction', question: 'Anything for Joe?' });
  // A reply reminder the person adds before saying there is nothing else to do.
  await item(ids.catchUpReply, ids.catchUpPlan, 3, ids.catchUp, { type: 'add_reminder', intent: 'reply_owed', project_id: ids.acme, title: 'Reply to Dana about the footer', remind_on: '2026-11-21' });
  // The kickoff: two Add all at once.
  await plan(ids.kickoffPlan, ids.kickoffTranscript, ids.kickoff);
  await item(ids.kickoffTask, ids.kickoffPlan, 0, ids.kickoff, { type: 'create_task', intent: 'new_work', project_id: ids.acme, title: 'Draft the sitemap' });
  await item(ids.kickoffTask2, ids.kickoffPlan, 1, ids.kickoff, { type: 'create_task', intent: 'new_work', project_id: ids.acme, title: 'Collect the brand assets' });
  await item(ids.kickoffReminder, ids.kickoffPlan, 2, ids.kickoff, { type: 'add_reminder', intent: 'waiting_on', project_id: ids.acme, title: 'Chase the kickoff notes', remind_on: '2026-11-22' });
  // Two accepts that claimed an item and never finished: one ten minutes ago (stuck), one just now (still running).
  for (const [itemId, position, title, minutesAgo] of [[ids.stuckAccept, 3, 'Book the photographer', 10], [ids.freshAccept, 4, 'Order the prints', 0]] as const) {
    await db.query(`INSERT INTO pm.plan_items (id, plan_id, position, conversation_id, mode, type, intent, project_id, payload, decision, state, updated_at)
      VALUES ($1, $2, $3, $4, 'live', 'create_task', 'new_work', $5, $6, 'propose', 'accepting', now() - make_interval(mins => $7))`,
    [itemId, ids.kickoffPlan, position, ids.kickoff, ids.acme, JSON.stringify({ type: 'create_task', intent: 'new_work', project_id: ids.acme, title }), minutesAgo]);
  }
  // An email with a suggestion of its own.
  await plan(ids.emailPlan, ids.emailMessage, ids.email);
  await item(ids.emailTask, ids.emailPlan, 0, ids.email, { type: 'create_task', intent: 'new_work', project_id: ids.acme, title: 'Swap the hero image' });
}

async function main() {
  const db = await createFullSchemaDatabase();
  await db.exec('RESET ROLE');
  await seed(db);
  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key' });
  const q = async <T = Row>(sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<T>(sql, params)).rows;
  };
  const state = async (itemId: string) => (await q('SELECT state, resolved_by FROM pm.plan_items WHERE id = $1', [itemId]))[0];
  const count = async (sql: string, params: unknown[] = []) => (await q<{ n: number }>(sql, params))[0].n;

  try {
    // ---- A linked meeting reads as a meeting on the task, an email as an email ----
    const linkedTo = id(98);
    // Created a minute ago: record_task_event skips a task created at the same
    // instant (its creation is the event), and two quick statements can share a timestamp.
    await q(`INSERT INTO pm.tasks (id, project_id, title, created_by, created_at) VALUES ($1, $2, 'Linked both ways', $3, now() - interval '1 minute')`, [linkedTo, ids.acme, ids.owner]);
    await q(`INSERT INTO pm.task_links (message_id, task_id, relation) VALUES ($1, $3, 'related'), ($2, $3, 'related')`,
      [ids.kickoffTranscript, ids.emailMessage, linkedTo]);
    const kinds = (await q<{ kind: string }>('SELECT kind FROM pm.task_events WHERE task_id = $1 ORDER BY kind', [linkedTo])).map((row) => row.kind);
    check('linking a meeting logs a meeting event and an email an email event', JSON.stringify(kinds) === JSON.stringify(['email', 'meeting']), kinds);

    const { addAllSuggestions, dismissMeeting, undoMeetingDismissal } = await import('../src/lib/communications/meeting/suggestions');
    const inbox = await import('../src/lib/communications/inbox-service');
    const inboxPlans = await import('../src/lib/communications/inbox-plans');
    const { resolveMemberAccess } = await import('../src/lib/api/access');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const service = getServiceClient();
    const owner = { service, access: (await resolveMemberAccess(service, ids.owner))!, memberId: ids.owner };
    const refused = async (work: () => Promise<unknown>) => {
      try { await work(); return 0; } catch (error) { return (error as { status?: number }).status ?? -1; }
    };

    // ---- The thread shows what waits, with what Change starts from -------------------------------
    const before = await inbox.threadDetail(owner, ids.weekly);
    const waiting = before.messages.flatMap((m) => m.plan?.items ?? []).filter((i) => i.state === 'pending');
    check('thread: the waiting suggestions are on the meeting, the question apart', waiting.length === 3
      && waiting.find((i) => i.id === ids.task)?.title === 'Send the proposal' && waiting.find((i) => i.id === ids.reminder)?.title === 'Chase Dana for the logo',
    waiting.map((i) => [i.id, i.type, i.title]));
    const listed = await inbox.listThreads(owner, { inboxId: null, projectId: null, tab: 'everything', search: '', limit: 25, offset: 0 });
    check('list: a row counts the suggestions waiting on it, not its question (a meeting checklist, an email proposal)',
      listed.threads.find((thread) => thread.id === ids.weekly)?.suggestion_count === waiting.length
        && listed.threads.find((thread) => thread.id === ids.email)?.suggestion_count === 1,
      listed.threads.map((thread) => [thread.subject, thread.suggestion_count]));

    // ---- Email is refused by both -----------------------------------------------------------------
    const emailAdd = await refused(() => addAllSuggestions(owner, ids.email));
    const emailDismiss = await refused(() => dismissMeeting(owner, ids.email));
    const emailItem = await state(ids.emailTask);
    check('email: Add all and Nothing to do refuse an email conversation (409) and leave it',
      emailAdd === 409 && emailDismiss === 409 && emailItem.state === 'pending'
        && (await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title = 'Swap the hero image'")) === 0,
      { emailAdd, emailDismiss, emailItem });

    // ---- Add all ----------------------------------------------------------------------------------
    const added = await addAllSuggestions(owner, ids.weekly);
    check('add all: every waiting suggestion is added, in order, none failing',
      JSON.stringify(added.added) === JSON.stringify([ids.task, ids.reminder, ids.comment]) && added.failed.length === 0, added);
    check('add all: exactly one task, one reminder and one comment exist',
      (await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title = 'Send the proposal' AND deleted_at IS NULL")) === 1
        && (await count("SELECT count(*)::int AS n FROM pm.reminders WHERE title = 'Chase Dana for the logo' AND deleted_at IS NULL")) === 1
        && (await count("SELECT count(*)::int AS n FROM pm.task_comments WHERE task_id = $1 AND text LIKE 'Dana wants%' AND deleted_at IS NULL", [ids.existingTask])) === 1);
    const states = await Promise.all([ids.task, ids.reminder, ids.comment].map(state));
    check('add all: each is accepted as the person\'s', states.every((s) => s.state === 'accepted' && s.resolved_by === ids.owner), states);
    check('add all: the question and the applied link are left as they were',
      (await state(ids.question)).state === 'pending' && (await state(ids.linked)).state === 'done');
    const again = await addAllSuggestions(owner, ids.weekly);
    check('add all: a second time adds nothing', again.added.length === 0 && again.failed.length === 0
      && (await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title = 'Send the proposal'")) === 1, again);

    // ---- The Inbox reads the meeting --------------------------------------------------------------
    const detail = await inbox.threadDetail(owner, ids.weekly);
    check('thread: a meeting carries its title, times and Doc', detail.channel === 'meeting' && detail.subject === 'Weekly review'
      && detail.meeting?.title === 'Weekly review' && detail.meeting.starts_at !== null && detail.meeting.doc_url?.startsWith('https://docs.google.com/') === true,
    detail.meeting);
    check('thread: the organizer leads the attendees, named where a package names them',
      detail.meeting?.organizer?.address === 'dana@acme.example' && detail.meeting.organizer.name === 'Dana'
        && JSON.stringify(detail.meeting.attendees.map((a) => a.address)) === JSON.stringify(['dana@acme.example', 'owner@agency.example', 'joe@acme.example']),
      detail.meeting);
    check('thread: each message says which package it is', detail.messages.map((m) => `${m.channel}:${m.meeting_package}`).join(',') === 'meeting:transcript,meeting:notes',
      detail.messages.map((m) => [m.channel, m.meeting_package]));
    const emailDetail = await inbox.threadDetail(owner, ids.email);
    check('thread: an email stays email', emailDetail.channel === 'email' && emailDetail.meeting === null && emailDetail.messages[0].meeting_package === null);
    const list = await inbox.listThreads(owner, { inboxId: null, projectId: null, tab: 'everything', search: '', limit: 25, offset: 0 });
    const row = list.threads.find((thread) => thread.id === ids.weekly);
    check('list: a meeting row carries its title and what it holds', row?.channel === 'meeting' && row.subject === 'Weekly review'
      && row.meeting?.title === 'Weekly review' && row.snippet === "Transcript and Gemini's notes", row);
    check('list: an email row is email', list.threads.find((thread) => thread.id === ids.email)?.channel === 'email');
    const madeTask = (await q("SELECT id FROM pm.tasks WHERE title = 'Send the proposal'"))[0].id as string;
    const madeNote = (await q("SELECT created_note FROM pm.tasks WHERE id = $1", [madeTask]))[0]?.created_note;
    check('a task added from a meeting says it came from the meeting', madeNote === 'From the meeting "Weekly review (2026-11-11)"', madeNote);
    const sources = await inbox.taskSourceEmails(owner, madeTask);
    check('task source: a task added from a meeting names the meeting and when it ran', sources.emails[0]?.channel === 'meeting' && sources.emails[0].meeting_title === 'Weekly review'
      && sources.emails[0].meeting_starts_at !== null && Date.parse(sources.emails[0].meeting_starts_at) === Date.parse('2026-11-11T22:00:00Z'), sources);

    // ---- Undo the set: newest first, through the existing undo ------------------------------------
    for (const itemId of [...added.added].reverse()) await inboxPlans.undoPlanItem(owner, itemId);
    const undone = await Promise.all(added.added.map(state));
    check('add all undo: every added suggestion is undone and the task is in Trash',
      undone.every((s) => s.state === 'undone') && (await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title = 'Send the proposal' AND deleted_at IS NULL")) === 0,
      undone);

    // ---- Two Add all at once: each item applies once ----------------------------------------------
    const [first, second] = await Promise.all([addAllSuggestions(owner, ids.kickoff), addAllSuggestions(owner, ids.kickoff)]);
    const together = [...first.added, ...second.added].sort();
    check('add all at once: each suggestion is added by exactly one call, none failing',
      JSON.stringify(together) === JSON.stringify([ids.kickoffTask, ids.kickoffTask2, ids.kickoffReminder].sort())
        && first.failed.length === 0 && second.failed.length === 0, { first, second });
    check('add all at once: exactly one task and one reminder per suggestion',
      (await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title = 'Draft the sitemap'")) === 1
        && (await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title = 'Collect the brand assets'")) === 1
        && (await count("SELECT count(*)::int AS n FROM pm.reminders WHERE title = 'Chase the kickoff notes'")) === 1
        && (await Promise.all([ids.kickoffTask, ids.kickoffTask2, ids.kickoffReminder].map(state))).every((s) => s.state === 'accepted'));

    // ---- A stuck claim is taken over; a fresh one is not ----------------------------------------
    const stuckAccepted = await refused(() => inboxPlans.acceptPlanItem(owner, ids.stuckAccept));
    check('stuck accept: an item claimed over five minutes ago and never finished is accepted, once',
      stuckAccepted === 0 && (await state(ids.stuckAccept)).state === 'accepted'
        && (await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title = 'Book the photographer'")) === 1, stuckAccepted);
    const freshAccepted = await refused(() => inboxPlans.acceptPlanItem(owner, ids.freshAccept));
    check('stuck accept: an item another accept claimed just now is refused (409) and left to it',
      freshAccepted === 409 && (await state(ids.freshAccept)).state === 'accepting'
        && (await count("SELECT count(*)::int AS n FROM pm.tasks WHERE title = 'Order the prints'")) === 0, freshAccepted);

    // ---- Nothing to do ----------------------------------------------------------------------------
    await inboxPlans.acceptPlanItem(owner, ids.catchUpReply);
    const replyReminder = async () => (await q("SELECT id, status, completed_at, deleted_at FROM pm.reminders WHERE title = 'Reply to Dana about the footer'"))[0];
    const replyBefore = await replyReminder();
    check('setup: the person added a reply reminder from a suggestion', replyBefore?.status === 'open', replyBefore);
    const tasksBefore = await count('SELECT count(*)::int AS n FROM pm.tasks');
    const trashedBefore = await count('SELECT count(*)::int AS n FROM pm.tasks WHERE deleted_at IS NOT NULL');
    const dismissed = await dismissMeeting(owner, ids.catchUp);
    check('nothing to do: the waiting suggestion and the question are skipped, by the person',
      JSON.stringify([...dismissed.skipped].sort()) === JSON.stringify([ids.catchUpTask, ids.catchUpQuestion].sort())
        && (await state(ids.catchUpTask)).state === 'dismissed' && (await state(ids.catchUpQuestion)).resolved_by === ids.owner, dismissed);
    check('nothing to do: an accepted suggestion stays accepted', (await state(ids.catchUpAccepted)).state === 'accepted');
    check('nothing to do: nothing is created or trashed',
      (await count('SELECT count(*)::int AS n FROM pm.tasks')) === tasksBefore
        && (await count('SELECT count(*)::int AS n FROM pm.tasks WHERE deleted_at IS NOT NULL')) === trashedBefore);
    const [handled] = await q('SELECT status, reviewed_by FROM pm.messages WHERE id = $1', [ids.catchUpTranscript]);
    check('nothing to do: the meeting\'s messages are handled and reviewed by the person', handled.status === 'handled' && handled.reviewed_by === ids.owner
      && dismissed.handled.length === 1 && dismissed.handled[0].status === 'needs_human' && dismissed.handled[0].unreviewed, { handled, list: dismissed.handled });
    const [mark] = await q('SELECT dismissed_at, dismissed_by FROM pm.meetings WHERE conversation_id = $1', [ids.catchUp]);
    check('nothing to do: the meeting records who said so and when', !!mark.dismissed_at && mark.dismissed_by === ids.owner
      && dismissed.dismissed.by?.name === 'Ciaran Mcintyre', { mark, dismissed: dismissed.dismissed });
    const replyAfter = await replyReminder();
    check('nothing to do: the reply reminder added from a suggestion stays open', replyAfter?.status === 'open' && replyAfter.completed_at === null
      && replyAfter.deleted_at === null, replyAfter);
    const marked = await inbox.threadDetail(owner, ids.catchUp);
    check('nothing to do: the thread and list show the mark', marked.meeting?.dismissed?.by?.id === ids.owner && marked.state === 'handled');

    // ---- Its Undo ---------------------------------------------------------------------------------
    const cleared = await undoMeetingDismissal(owner, ids.catchUp, { skipped: dismissed.skipped, handled: dismissed.handled });
    const [back] = await q('SELECT status, reviewed_at FROM pm.messages WHERE id = $1', [ids.catchUpTranscript]);
    const [unmarked] = await q('SELECT dismissed_at, dismissed_by FROM pm.meetings WHERE conversation_id = $1', [ids.catchUp]);
    check('nothing to do undo: the suggestions wait again, the message is as it was and the mark is cleared',
      cleared.cleared && (await state(ids.catchUpTask)).state === 'pending' && (await state(ids.catchUpQuestion)).state === 'pending'
        && (await state(ids.catchUpAccepted)).state === 'accepted'
        && back.status === 'needs_human' && back.reviewed_at === null && unmarked.dismissed_at === null && unmarked.dismissed_by === null,
      { cleared, back, unmarked });
    check('nothing to do undo: everything else is as it was before', JSON.stringify(await replyReminder()) === JSON.stringify(replyBefore)
      && (await state(ids.catchUpReply)).state === 'accepted');
    const stranger = await refused(() => undoMeetingDismissal(owner, ids.catchUp, { skipped: [ids.emailTask], handled: [] }));
    check('nothing to do undo: it only puts back suggestions of this meeting', stranger === 422 && (await state(ids.emailTask)).state === 'pending', stranger);
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`meeting suggestions: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join('\n - ')}`);
    process.exitCode = 1;
  } else {
    console.log(`meeting suggestions: ${passed} checks passed.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
