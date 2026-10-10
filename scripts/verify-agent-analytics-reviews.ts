/**
 * The Agent Analytics review migration (20261010212024_agent_analytics_reviews.sql)
 * against the real table and permission definitions from schema.sql: it
 * re-runs; leaving `done` records one reopen whoever moves the task, other
 * moves record nothing; reopens and gap reviews are visible to agents.manage
 * holders only; and a gap review never touches the gap row.
 *
 * Run: npx tsx --tsconfig tsconfig.mcp-test.json scripts/verify-agent-analytics-reviews.ts
 */
import { randomUUID } from 'node:crypto';
import { asPerson, asService, createEmailDatabase, readMigration } from './inbound-email-db';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 500)}`);
}

const OWNER = randomUUID();
const OWNER_AUTH = randomUUID();
const MEMBER = randomUUID();
const MEMBER_AUTH = randomUUID();
const JEFF = randomUUID();
const PROJECT = randomUUID();

async function main() {
  const db = await createEmailDatabase();
  // Production order: the telemetry vocabulary lands before this migration.
  await db.exec(await readMigration('../supabase/migrations/20261010210652_agent_telemetry.sql'));
  const migration = await readMigration('../supabase/migrations/20261010212024_agent_analytics_reviews.sql');
  await db.exec(migration);
  await db.exec(migration); // safe to re-run
  await db.exec('GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows;

  await db.query(`INSERT INTO team_members(id, auth_user_id, name, role) VALUES
    ($1, $2, 'Ciaran', 'owner'), ($3, $4, 'Mia', 'member'), ($5, NULL, 'Jeff', 'agent')`,
  [OWNER, OWNER_AUTH, MEMBER, MEMBER_AUTH, JEFF]);
  await db.query("INSERT INTO projects(id, name) VALUES ($1, 'Site')", [PROJECT]);
  await db.query('INSERT INTO project_members(project_id, member_id) VALUES ($1, $2)', [PROJECT, MEMBER]);
  await db.query("INSERT INTO role_permissions(role, permission_key, access_channel) VALUES ('member', 'projects.read', 'app') ON CONFLICT DO NOTHING");
  const task = (await rows("INSERT INTO tasks(project_id, title, status) VALUES ($1, 'Ship it', 'done') RETURNING id", [PROJECT]))[0].id as string;

  const starts = await rows("SELECT started_at FROM analytics_tracking_starts WHERE metric = 'task_reopens'");
  check('the migration records when reopen tracking began, once', starts.length === 1);
  const ownerStarts = await asPerson(db, OWNER_AUTH, () => db.query('SELECT metric FROM analytics_tracking_starts'));
  const memberStarts = await asPerson(db, MEMBER_AUTH, () => db.query('SELECT metric FROM analytics_tracking_starts'));
  check('tracking starts are visible to agents.manage only', ownerStarts.rows.length === 1 && memberStarts.rows.length === 0);

  // The owner reopens it in the app.
  await asPerson(db, OWNER_AUTH, () => db.query("UPDATE tasks SET status = 'in_progress' WHERE id = $1", [task]));
  let reopens = await rows('SELECT * FROM task_reopens');
  check('leaving done records one reopen', reopens.length === 1 && reopens[0].task_id === task && reopens[0].to_status === 'in_progress'
    && reopens[0].project_id === PROJECT, reopens);
  check('the reopen names who moved it', reopens[0]?.reopened_by === OWNER, reopens[0]);

  // Moves that are not a reopen record nothing.
  await asService(db, () => db.query("UPDATE tasks SET status = 'in_review' WHERE id = $1", [task]));
  await asService(db, () => db.query("UPDATE tasks SET status = 'done' WHERE id = $1", [task]));
  await asService(db, () => db.query("UPDATE tasks SET title = 'Ship it now' WHERE id = $1", [task]));
  check('other moves record nothing', (await rows('SELECT count(*)::int AS n FROM task_reopens'))[0].n === 1);

  // An agent's reopen through the API (service role, no person) still counts.
  await asService(db, () => db.query("UPDATE tasks SET status = 'todo' WHERE id = $1", [task]));
  reopens = await rows('SELECT * FROM task_reopens ORDER BY reopened_at');
  check('a reopen through the API counts, with no person named', reopens.length === 2 && reopens[1].reopened_by === null, reopens);

  // Visibility: agents.manage only.
  const ownerSees = await asPerson(db, OWNER_AUTH, () => db.query('SELECT id FROM task_reopens'));
  const memberSees = await asPerson(db, MEMBER_AUTH, () => db.query('SELECT id FROM task_reopens'));
  check('the owner sees reopens', ownerSees.rows.length === 2);
  check('a member without agents.manage sees none', memberSees.rows.length === 0, memberSees.rows);
  let memberWrote = false;
  try {
    await asPerson(db, MEMBER_AUTH, () => db.query('INSERT INTO task_reopens(task_id, to_status) VALUES ($1, $2)', [task, 'todo']));
    memberWrote = true;
  } catch { /* refused */ }
  check('nobody writes reopens by hand', !memberWrote);

  // Gap reviews: the owner marks one; the gap row is untouched; members cannot.
  const gap = (await rows(`INSERT INTO agent_activities(agent_id, activity_type, title, metadata)
    VALUES ($1, 'billing.gap', 'Billing gap: 3 min mid turn', '{"phase":"mid_turn","minutes":3}') RETURNING id, metadata`, [JEFF]))[0];
  await asPerson(db, OWNER_AUTH, () => db.query(
    "INSERT INTO agent_billing_gap_reviews(activity_id, status, note, reviewed_by) VALUES ($1, 'reconciled', 'logged with pm-log-time', $2)",
    [gap.id, OWNER]));
  await asPerson(db, OWNER_AUTH, () => db.query(
    "INSERT INTO agent_billing_gap_reviews(activity_id, status, note, reviewed_by) VALUES ($1, 'dismissed', 'setup, not billable', $2) ON CONFLICT (activity_id) DO UPDATE SET status = excluded.status, note = excluded.note",
    [gap.id, OWNER]));
  const review = (await rows('SELECT * FROM agent_billing_gap_reviews'))[0];
  check('a review can be changed', review.status === 'dismissed' && review.note === 'setup, not billable', review);
  // The client cannot attribute a review to someone else.
  await asPerson(db, OWNER_AUTH, () => db.query(
    "UPDATE agent_billing_gap_reviews SET reviewed_by = $1, reviewed_at = '2000-01-01' WHERE activity_id = $2", [MEMBER, gap.id]));
  const stamped = (await rows('SELECT reviewed_by, reviewed_at FROM agent_billing_gap_reviews'))[0];
  check('the database stamps who reviewed and when', stamped.reviewed_by === OWNER
    && new Date(stamped.reviewed_at).getFullYear() >= 2026, stamped);
  const after = (await rows('SELECT metadata FROM agent_activities WHERE id = $1', [gap.id]))[0];
  check('the gap row itself is untouched', JSON.stringify(after.metadata) === JSON.stringify(gap.metadata));
  let memberReviewed = false;
  try {
    await asPerson(db, MEMBER_AUTH, () => db.query("UPDATE agent_billing_gap_reviews SET status = 'reconciled' WHERE activity_id = $1 RETURNING 1", [gap.id])
      .then((result) => { if (result.rows.length) memberReviewed = true; }));
  } catch { /* refused */ }
  check('a member cannot review a gap', !memberReviewed);
  let badStatus = false;
  try {
    await db.query("UPDATE agent_billing_gap_reviews SET status = 'ignored' WHERE activity_id = $1", [gap.id]);
  } catch (error) {
    badStatus = (error as { code?: string }).code === '23514';
  }
  check('only reconciled or dismissed', badStatus);
  await db.query('DELETE FROM agent_activities WHERE id = $1', [gap.id]);
  check('a review goes with its gap', (await rows('SELECT count(*)::int AS n FROM agent_billing_gap_reviews'))[0].n === 0);

  console.log(`agent analytics reviews: ${passed} passed, ${failures.length} failed`);
  for (const failure of failures) console.log(`FAIL ${failure}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
