/**
 * Notifications clear when what they are about is finished, and come back
 * when it is not: reminders, drafted invoices, a failed retainer draft, Greg's
 * review nudge. Runs on PGlite over the whole real schema, with the migration
 * applied on top twice; nothing touches a live database.
 *
 *   npm run -s test:notification-clearing
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFullSchemaDatabase } from './full-schema-db';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

async function main() {
  const db = await createFullSchemaDatabase();
  const migration = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '20261105202601_notifications_clear_when_done.sql'), 'utf8');
  await db.exec(migration);
  await db.exec(migration);
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const one = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params))[0].id;

  const owner = await one("INSERT INTO public.team_members (name, email, role) VALUES ('Ciaran', 'ciaran@example.com', 'owner') RETURNING id");
  const project = await one("INSERT INTO public.projects (name) VALUES ('Happy Innovations') RETURNING id");
  const shown = async (type: string, entity: string) => q<{ title: string; is_read: boolean }>(
    'SELECT title, is_read FROM public.team_member_notifications WHERE entity_type = $1 AND entity_id = $2 AND cleared_at IS NULL ORDER BY created_at', [type, entity]);
  const raise = (title: string, type: string, entity: string) => q(
    "SELECT public.upsert_notification($1, $2, 'message', NULL, $3, $4)", [owner, title, type, entity]);

  // --- Reminders ---------------------------------------------------------------------------
  const reminder = await one(`INSERT INTO public.reminders (owner_id, title, project_id, remind_on, created_by)
    VALUES ($1, 'Reply to Mark', $2, '2026-11-01', $1) RETURNING id`, [owner, project]);
  await q("SELECT public.send_due_reminders('2026-11-02 12:00:00+00')");
  check('reminder: its bell rings', (await shown('reminder', reminder)).length === 1, await shown('reminder', reminder));

  await q("UPDATE public.reminders SET status = 'done' WHERE id = $1", [reminder]);
  check('reminder: closed, its bell clears, still unread underneath',
    (await shown('reminder', reminder)).length === 0
      && (await q<{ is_read: boolean }>("SELECT is_read FROM public.team_member_notifications WHERE entity_id = $1", [reminder]))[0].is_read === false);

  await q("UPDATE public.reminders SET status = 'open' WHERE id = $1", [reminder]);
  const reopened = await shown('reminder', reminder);
  check('reminder: reopened, its bell is back as it was', reopened.length === 1 && reopened[0].is_read === false, reopened);

  await q("UPDATE public.reminders SET deleted_at = now() WHERE id = $1", [reminder]);
  check('reminder: deleted, its bell clears', (await shown('reminder', reminder)).length === 0);
  await q('UPDATE public.reminders SET deleted_at = NULL WHERE id = $1', [reminder]);
  check('reminder: restored, its bell is back', (await shown('reminder', reminder)).length === 1);

  await q("UPDATE public.reminders SET remind_on = '2026-11-10' WHERE id = $1", [reminder]);
  check('reminder: moved to a later day, the old bell clears', (await shown('reminder', reminder)).length === 0);
  await q("SELECT public.send_due_reminders('2026-11-11 12:00:00+00')");
  check('reminder: the new day rings once', (await shown('reminder', reminder)).length === 1, await shown('reminder', reminder));

  await q("UPDATE public.team_member_notifications SET is_read = true WHERE entity_id = $1", [reminder]);
  await q("UPDATE public.reminders SET remind_on = '2026-11-20' WHERE id = $1", [reminder]);
  await q("SELECT public.send_due_reminders('2026-11-21 12:00:00+00')");
  check('reminder: a read bell stays cleared when the next one rings', (await shown('reminder', reminder)).filter((row) => !row.is_read).length === 1
    && (await shown('reminder', reminder)).length === 1, await shown('reminder', reminder));

  // --- A task finishing closes its reminder, so its bell goes too ----------------------------
  const task = await one("INSERT INTO public.tasks (project_id, title) VALUES ($1, 'Build it') RETURNING id", [project]);
  const onTask = await one(`INSERT INTO public.reminders (owner_id, title, task_id, remind_on, created_by)
    VALUES ($1, 'Chase it', $2, '2026-11-01', $1) RETURNING id`, [owner, task]);
  await q("SELECT public.send_due_reminders('2026-11-22 12:00:00+00')");
  await q("UPDATE public.tasks SET status = 'done' WHERE id = $1", [task]);
  check('reminder: its task done clears the bell', (await shown('reminder', onTask)).length === 0);

  // --- Drafted invoices --------------------------------------------------------------------
  const invoice = await one(`INSERT INTO public.project_invoices (project_id, invoice_number, date, due_date, status)
    VALUES ($1, 'INV-021', '2026-11-01', '2026-11-15', 'draft') RETURNING id`, [project]);
  await raise('Hours added to a drafted invoice', 'invoice', invoice);
  await q("UPDATE public.project_invoices SET description = 'edited' WHERE id = $1", [invoice]);
  check('invoice: edited, still a draft, nothing clears', (await shown('invoice', invoice)).length === 1);
  await q("UPDATE public.project_invoices SET status = 'sent' WHERE id = $1", [invoice]);
  check('invoice: sent, the draft notice clears', (await shown('invoice', invoice)).length === 0);
  await q("UPDATE public.project_invoices SET status = 'draft' WHERE id = $1", [invoice]);
  check('invoice: back to a draft, it returns', (await shown('invoice', invoice)).length === 1);

  // --- Notices filed on the project: only their own title clears ------------------------------
  await raise('Retainer draft failed', 'project', project);
  await q("INSERT INTO public.project_invoices (project_id, invoice_number, date, due_date, status) VALUES ($1, 'INV-022', '2026-11-01', '2026-11-15', 'draft')", [project]);
  check('retainer: a hand-made invoice answers nothing', (await shown('project', project)).length === 1);
  await q(`INSERT INTO public.project_invoices (project_id, invoice_number, date, due_date, status, auto_generated)
    VALUES ($1, 'INV-023', '2026-11-01', '2026-11-15', 'draft', true)`, [project]);
  check('retainer: a retainer draft that worked clears the failure', (await shown('project', project)).length === 0);

  const goal = await one("INSERT INTO public.project_goals (project_id, title) VALUES ($1, 'Find money') RETURNING id", [project]);
  const finding = (title: string) => one(`INSERT INTO public.task_suggestions (project_id, goal_id, proposed_by, title, description, reasoning)
    VALUES ($1, $2, $3, $4, 'd', 'r') RETURNING id`, [project, goal, owner, title]);
  const first = await finding('One');
  const second = await finding('Two');
  await raise("Greg's findings are waiting on you", 'project', project);
  await q(`INSERT INTO public.team_member_notifications (user_id, title, entity_type, entity_id, is_read)
    VALUES ($1, 'Plan4TheFuture was updated', 'project', $2, true)`, [owner, project]);
  await q("UPDATE public.task_suggestions SET status = 'rejected' WHERE id = $1", [first]);
  check('findings: one still waits, the nudge stays', (await shown('project', project)).length === 2);
  await q("UPDATE public.task_suggestions SET status = 'needs_info' WHERE id = $1", [second]);
  check('findings: a question back still waits', (await shown('project', project)).length === 2);
  await q("UPDATE public.task_suggestions SET status = 'rejected' WHERE id = $1", [second]);
  const left = await shown('project', project);
  check("findings: none left, the nudge clears and the project's other notices stay", left.length === 1 && left[0].title === 'Plan4TheFuture was updated', left);

  // --- Raising again -----------------------------------------------------------------------
  await raise('Hours added to a drafted invoice', 'invoice', invoice);
  await q("UPDATE public.project_invoices SET status = 'sent' WHERE id = $1", [invoice]);
  await raise('Hours added to a drafted invoice', 'invoice', invoice);
  check('raising a cleared unread notice shows it again, once', (await shown('invoice', invoice)).length === 1, await shown('invoice', invoice));

  // --- Who may call it -----------------------------------------------------------------------
  const granted = (await q<{ allowed: boolean }>("SELECT has_function_privilege('authenticated', 'public.set_notifications_cleared(text, text, boolean, text)', 'EXECUTE') AS allowed"))[0].allowed;
  check('clearing is not callable by signed-in people', granted === false);

  await db.close();
  if (failures.length) {
    console.error(`notification clearing: ${passed} checks passed, ${failures.length} failed:`);
    for (const failure of failures) console.error(` - ${failure}`);
    process.exit(1);
  }
  console.log(`notification clearing: ${passed} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
