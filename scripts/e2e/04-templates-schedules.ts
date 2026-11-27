/**
 * 4. Templates and schedules, as the Templates screens use them: the Owner
 * makes a project template with two key dates, runs it (due dates follow the
 * key dates), changes a task's date by hand, moves the launch date (the run's
 * tasks follow, the hand-changed one stays), sets a daily schedule, and the
 * scheduler route fires it with the app's scheduler secret.
 */
import { OWNER_SETUP_SCOPES, check, dataOf, equal, http, isoDay, makeProject, personalKey, step, tag, waitFor, type Ctx, type Json } from './harness';
import type { Scenario } from './run';

const scenario: Scenario = {
  name: 'Templates and schedules: run, change dates, a schedule fires',
  async run(ctx: Ctx) {
    const { owner } = ctx.people;
    const ownerKey = (await personalKey(ctx, owner, OWNER_SETUP_SCOPES, 'owner setup')).caller;
    const project = await makeProject(ctx, ownerKey, 'Templates');

    const template = dataOf(await owner.post('/api/workspace/task-templates', {
      name: `E2E Launch plan ${tag}`, project_id: project.id,
      key_dates: [{ key: 'start', label: 'Start' }, { key: 'launch', label: 'Launch', main: true }],
      items: [
        { key: 'kickoff', title: 'Kickoff call', due_in_days: 0 },
        { key: 'copy', title: 'Write the launch copy', anchor: 'launch', due_in_days: -5, depends_on: ['kickoff'] },
        { key: 'ship', title: 'Ship it', anchor: 'launch', due_in_days: -1, depends_on: ['copy'] },
      ],
    }), 201, 'make the template');
    ctx.cleanup.add(`trash template ${template.id}`, () => ctx.db.query(`UPDATE pm.task_templates SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [template.id]));
    step(`Owner made template "${template.name}" with key dates start and launch`);

    const start = isoDay(1);
    const launch = isoDay(15);
    const ran = dataOf(await owner.post(`/api/workspace/task-templates/${template.id}/run`, { key_dates: { start, launch }, create_initiative: true }), 201, 'run the template');
    const runId = ran.run.id;
    equal(ran.tasks.length, 3, 'tasks made by the run');
    const due = (title: string) => (ran.tasks as Json[]).find((t) => t.title === title)?.due_date;
    equal(due('Kickoff call'), start, 'kickoff due on the start date');
    equal(due('Write the launch copy'), isoDay(10), 'copy due 5 days before launch');
    equal(due('Ship it'), isoDay(14), 'ship due the day before launch');
    check(ran.run.initiative_id, 'The run made an initiative to follow it', ran.run);
    step(`Ran it: 3 tasks, due ${start}, ${isoDay(10)} and ${isoDay(14)} from the key dates`);

    // A person moves one task by hand; a date change must leave it alone.
    const copyTask = (ran.tasks as Json[]).find((t) => t.title === 'Write the launch copy');
    dataOf(await ownerKey.patch(`/api/v1/tasks/${copyTask.id}`, { due_date: isoDay(8) }), 200, 'move the copy task by hand');
    const preview = dataOf(await owner.post(`/api/workspace/task-templates/runs/${runId}/reflow`, { key_dates: { launch: isoDay(22) }, dry_run: true }), 200, 'preview the date change');
    equal(preview.dry_run, true, 'preview is a dry run');
    const stillDue = (await ctx.db.query(`SELECT due_date::text AS due FROM pm.tasks WHERE id = $1`, [(ran.tasks as Json[]).find((t) => t.title === 'Ship it').id])).rows[0].due;
    equal(stillDue, isoDay(14), 'a preview changes nothing');
    const moved = dataOf(await owner.post(`/api/workspace/task-templates/runs/${runId}/reflow`, { key_dates: { launch: isoDay(22) } }), 200, 'change the launch date');
    const movedShip = (moved.moved as Json[]).find((m) => m.title === 'Ship it');
    check(movedShip && movedShip.from === isoDay(14) && movedShip.to === isoDay(21), 'Ship it follows the launch date', moved.moved);
    check((moved.kept as Json[]).some((k) => k.task_id === copyTask.id && k.reason === 'hand_changed'), 'The hand-moved task is kept', moved.kept);
    check(!(moved.moved as Json[]).some((m) => m.title === 'Kickoff call'), 'Kickoff (start date) does not move', moved.moved);
    const after = Object.fromEntries((await ctx.db.query(`SELECT title, due_date::text AS due FROM pm.tasks WHERE id = ANY($1)`, [(ran.tasks as Json[]).map((t) => t.id)])).rows.map((r) => [r.title, r.due]));
    equal(after['Ship it'], isoDay(21), 'ship due after the change');
    equal(after['Write the launch copy'], isoDay(8), 'hand-moved copy task after the change');
    equal(after['Kickoff call'], start, 'kickoff after the change');
    step(`Moved launch to ${isoDay(22)}: Ship it followed (${isoDay(14)} -> ${isoDay(21)}), the hand-moved task stayed, a preview changed nothing`);

    // ── Schedule ──
    const schedule = dataOf(await owner.post(`/api/workspace/task-templates/${template.id}/schedules`, { recurrence: { freq: 'daily' }, key_date_offsets: { launch: 14 } }), 201, 'set a daily schedule');
    ctx.cleanup.add(`end schedule ${schedule.id}`, () => owner.call(`/api/workspace/schedules/${schedule.id}`, { method: 'DELETE' }));
    check(schedule.next_run_at && Date.parse(schedule.next_run_at) <= Date.now(), 'A daily schedule set today is due now', schedule);
    step(`Daily schedule set; next run ${schedule.next_run_at} (due now)`);

    const refusedCron = await http(ctx.baseUrl, '/api/internal/schedules/run', { method: 'POST', headers: { authorization: `Bearer ${ctx.env.CRON_SECRET}` } });
    equal(refusedCron.status, 401, 'the scheduler route refuses the Vercel cron secret (it takes the scheduler secret)');
    const secret = (await ctx.db.query(`SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pm_webhook_scheduler_secret'`)).rows[0]?.decrypted_secret;
    check(secret, 'The local stack holds the scheduler secret pg_cron uses (run npm run local:seed)');
    const fired = await http(ctx.baseUrl, '/api/internal/schedules/run', { method: 'POST', headers: { authorization: `Bearer ${secret}` } });
    equal(fired.status, 200, 'the scheduler route answers', fired.body);
    const occurrence = await waitFor('the schedule occurrence', async () => {
      const list = dataOf(await owner.get(`/api/workspace/schedules/${schedule.id}/occurrences`), 200, 'occurrences');
      return (list.occurrences as Json[]).find((o) => o.status === 'created');
    }, 20_000);
    check(occurrence.run_id, 'The occurrence made a template run', occurrence);
    const runs = dataOf(await owner.get(`/api/workspace/task-templates/${template.id}/runs`), 200, 'template runs');
    const scheduled = (runs.runs as Json[]).find((r) => r.id === occurrence.run_id);
    check(scheduled && scheduled.via === 'schedule' && scheduled.schedule_id === schedule.id, 'The run came from the schedule', runs.runs);
    equal(scheduled.task_ids.length, 3, 'tasks made by the scheduled run');
    const later = dataOf(await owner.get(`/api/workspace/schedules/${schedule.id}`), 200, 'schedule after firing');
    check(later.next_on > String(occurrence.scheduled_for).slice(0, 10) && later.last_outcome, 'The schedule moved on to its next day', later);
    step(`Scheduler route fired it (${fired.body.created ? 'this call' : 'pg_cron got there first'}): a run via schedule with 3 tasks; next ${later.next_on}`);
  },
};

export default scenario;
