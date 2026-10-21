/**
 * Reminders: who sees and changes them (row level security), a task moved to
 * done closing its reminders (and reopening them when it moves back), and the
 * due bells. Runs the real migration, twice, on PGlite (real Postgres) over
 * minimal tables; nothing touches a live database.
 *
 *   npm run -s test:reminders
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION = join(__dirname, '..', 'supabase', 'migrations', '20261021215512_create_reminders.sql');

const OWNER_USER = '00000000-0000-0000-0000-0000000000a1';
const MATE_USER = '00000000-0000-0000-0000-0000000000a2';
const STRANGER_USER = '00000000-0000-0000-0000-0000000000a3';
const OWNER = '00000000-0000-0000-0000-0000000000b1';
const MATE = '00000000-0000-0000-0000-0000000000b2';
const STRANGER = '00000000-0000-0000-0000-0000000000b3';
const P1 = '00000000-0000-0000-0000-0000000000c1';
const P2 = '00000000-0000-0000-0000-0000000000c2';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

async function main() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA auth TO authenticated;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TABLE public.team_members (id uuid PRIMARY KEY, auth_user_id uuid, name text NOT NULL DEFAULT 'x');
    CREATE TABLE public.projects (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES public.projects(id),
      title text NOT NULL DEFAULT 'A task', status text NOT NULL DEFAULT 'todo');
    -- Who may open which project, and who holds tasks.manage_all.
    CREATE TABLE public.project_access (member_id uuid, project_id uuid);
    CREATE TABLE public.member_permissions (member_id uuid, permission_key text);
    CREATE TABLE public.team_member_notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, title text NOT NULL, message text, link text,
      is_read boolean NOT NULL DEFAULT false, entity_type text, entity_id text, created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT team_member_notifications_entity_type_check CHECK (entity_type IN ('task')));

    CREATE FUNCTION public.current_team_member_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT id FROM public.team_members WHERE auth_user_id = auth.uid() LIMIT 1 $$;
    CREATE FUNCTION public.can_access_project(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT EXISTS (SELECT 1 FROM public.project_access WHERE project_id = p AND member_id = public.current_team_member_id()) $$;
    CREATE FUNCTION public.can_access_task(t uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT EXISTS (SELECT 1 FROM public.tasks WHERE id = t AND public.can_access_project(project_id)) $$;
    CREATE FUNCTION public.has_permission(k text, c text DEFAULT 'app') RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
      AS $$ SELECT EXISTS (SELECT 1 FROM public.member_permissions WHERE permission_key = k AND member_id = public.current_team_member_id()) $$;
    CREATE FUNCTION public.workspace_timezone() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'America/Phoenix' $$;
    CREATE FUNCTION public.upsert_notification(p_user uuid, p_title text, p_message text, p_link text, p_type text, p_id text)
      RETURNS void LANGUAGE sql SECURITY DEFINER
      AS $$ INSERT INTO public.team_member_notifications (user_id, title, message, link, entity_type, entity_id)
            VALUES (p_user, p_title, p_message, p_link, p_type, p_id) $$;

    INSERT INTO public.team_members (id, auth_user_id) VALUES
      ('${OWNER}', '${OWNER_USER}'), ('${MATE}', '${MATE_USER}'), ('${STRANGER}', '${STRANGER_USER}');
    INSERT INTO public.projects VALUES ('${P1}', 'Plan4TheFuture'), ('${P2}', 'Happy Innovations');
    INSERT INTO public.project_access VALUES ('${OWNER}', '${P1}'), ('${OWNER}', '${P2}'), ('${MATE}', '${P1}');
    INSERT INTO public.member_permissions VALUES ('${OWNER}', 'tasks.manage_all');
    GRANT SELECT ON public.tasks, public.projects, public.team_members TO authenticated;
  `);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  check('the migration runs twice', true);

  // Act as a signed-in member (RLS applies) or as the service role (it does not).
  const as = async (user: string | null) => {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [user ?? '']);
    if (user) await db.exec('SET ROLE authenticated');
  };
  const tryQuery = async <T,>(sql: string, params: unknown[] = []) => {
    try {
      return { rows: (await db.query<T>(sql, params)).rows, error: null as string | null };
    } catch (error) {
      return { rows: [] as T[], error: (error as Error).message };
    }
  };
  const visible = async (user: string) => {
    await as(user);
    const { rows } = await db.query<{ title: string }>('SELECT title FROM public.reminders ORDER BY title');
    return rows.map((r) => r.title);
  };
  const task = async (project: string, title: string) => {
    await as(null);
    return (await db.query<{ id: string }>('INSERT INTO public.tasks (project_id, title) VALUES ($1, $2) RETURNING id', [project, title])).rows[0].id;
  };
  type Row = { id: string; status: string; project_id: string | null; completed_at: string | null; completed_by: string | null;
    closed_by_task: boolean; notified_at: string | null; created_by: string | null; source: string };
  const row = async (id: string) => {
    await as(null);
    return (await db.query<Row>('SELECT * FROM public.reminders WHERE id = $1', [id])).rows[0];
  };

  // --- Writing and seeing -------------------------------------------------
  const delivery = await task(P1, 'Update local delivery wording');
  await as(OWNER_USER);
  const mine = (await db.query<{ id: string }>(
    "INSERT INTO public.reminders (title, owner_id) VALUES ('  Renew the domain  ', $1) RETURNING id", [OWNER])).rows[0].id;
  const ask = (await db.query<{ id: string; project_id: string; created_by: string }>(
    "INSERT INTO public.reminders (title, owner_id, task_id) VALUES ('Ask Stephanie the 3 delivery questions', $1, $2) RETURNING id, project_id, created_by",
    [OWNER, delivery])).rows[0];
  check('a task reminder takes its task\'s project', ask.project_id === P1, ask);
  check('the creator is stamped from the signed-in member', ask.created_by === OWNER, ask);
  const projectNote = (await db.query<{ id: string }>(
    "INSERT INTO public.reminders (title, owner_id, project_id) VALUES ('Check the November ad budget', $1, $2) RETURNING id", [OWNER, P2])).rows[0].id;

  check('the owner sees all three, title trimmed',
    JSON.stringify(await visible(OWNER_USER)) === JSON.stringify(['Ask Stephanie the 3 delivery questions', 'Check the November ad budget', 'Renew the domain']),
    await visible(OWNER_USER));
  check('a teammate on the project sees the task reminder only: never a private one, never a project they cannot open',
    JSON.stringify(await visible(MATE_USER)) === JSON.stringify(['Ask Stephanie the 3 delivery questions']), await visible(MATE_USER));
  check('someone with no access sees nothing', (await visible(STRANGER_USER)).length === 0);

  await as(MATE_USER);
  const forOther = await tryQuery("INSERT INTO public.reminders (title, owner_id) VALUES ('Private for someone else', $1)", [OWNER]);
  check('a standalone reminder cannot be made for someone else', !!forOther.error, forOther);
  const forOtherShared = await tryQuery(
    "INSERT INTO public.reminders (title, owner_id, task_id) VALUES ('Remind the owner', $1, $2) RETURNING id", [OWNER, delivery]);
  check('a shared one can (on a task the writer can open)', !forOtherShared.error, forOtherShared);
  await as(STRANGER_USER);
  const noAccess = await tryQuery("INSERT INTO public.reminders (title, owner_id, task_id) VALUES ('Sneak', $1, $2)", [STRANGER, delivery]);
  check('no reminder on a task the writer cannot open', !!noAccess.error, noAccess);
  await as(OWNER_USER);
  const timeOnly = await tryQuery("INSERT INTO public.reminders (title, owner_id, remind_at) VALUES ('Time but no day', $1, '09:00')", [OWNER]);
  check('a time needs a date', !!timeOnly.error, timeOnly);

  await as(MATE_USER);
  const touchPrivate = await db.query("UPDATE public.reminders SET title = 'hijacked' WHERE id = $1", [mine]);
  check('a teammate cannot change someone\'s private reminder', touchPrivate.affectedRows === 0);
  await db.query("UPDATE public.reminders SET status = 'done' WHERE id = $1", [ask.id]);
  let r = await row(ask.id);
  check('a teammate can tick off a shared reminder; who and when are stamped',
    r.status === 'done' && r.completed_by === MATE && !!r.completed_at && !r.closed_by_task, r);
  await as(MATE_USER);
  await db.query("UPDATE public.reminders SET status = 'open', created_by = $2, source = 'email' WHERE id = $1", [ask.id, MATE]);
  r = await row(ask.id);
  check('reopening clears the stamps; creator and source never change',
    r.status === 'open' && r.completed_at === null && r.completed_by === null && r.created_by === OWNER && r.source === 'manual', r);

  await as(MATE_USER);
  const mateDelete = await db.query('DELETE FROM public.reminders WHERE id = $1', [ask.id]);
  check('a teammate who neither owns nor wrote it cannot delete it', mateDelete.affectedRows === 0);

  // --- A task moved to done ---------------------------------------------
  await as(OWNER_USER);
  const tickedByHand = (await db.query<{ id: string }>(
    "INSERT INTO public.reminders (title, owner_id, task_id, status) VALUES ('Send the draft wording', $1, $2, 'done') RETURNING id",
    [OWNER, delivery])).rows[0].id;
  await as(null);
  await db.query("UPDATE public.tasks SET status = 'done' WHERE id = $1", [delivery]);
  const afterDone = (await db.query<Row & { title: string }>(
    'SELECT title, status, closed_by_task FROM public.reminders WHERE task_id = $1 ORDER BY title', [delivery])).rows;
  check('moving the task to done closes its open reminders',
    afterDone.every((x) => x.status === 'done')
      && afterDone.filter((x) => x.closed_by_task).map((x) => x.title).sort().join('|') === 'Ask Stephanie the 3 delivery questions|Remind the owner',
    afterDone);
  await db.query("UPDATE public.tasks SET status = 'in_progress' WHERE id = $1", [delivery]);
  const afterBack = Object.fromEntries((await db.query<{ title: string; status: string }>(
    'SELECT title, status FROM public.reminders WHERE task_id = $1', [delivery])).rows.map((x) => [x.title, x.status]));
  check('moving it back reopens the ones the move closed; one ticked by hand stays done',
    afterBack['Ask Stephanie the 3 delivery questions'] === 'open' && afterBack['Remind the owner'] === 'open'
      && afterBack['Send the draft wording'] === 'done', afterBack);
  check('the hand-ticked one keeps its own stamps', !(await row(tickedByHand)).closed_by_task);

  await db.query('UPDATE public.tasks SET project_id = $1 WHERE id = $2', [P2, delivery]);
  check('a task moved to another project takes its reminders along', (await row(ask.id)).project_id === P2);
  check('...so the teammate, who cannot open that project, no longer sees them', (await visible(MATE_USER)).length === 0, await visible(MATE_USER));
  await as(null);
  await db.query('UPDATE public.tasks SET project_id = $1 WHERE id = $2', [P1, delivery]);

  // --- Due bells ----------------------------------------------------------
  await as(null);
  await db.exec('DELETE FROM public.reminders');
  const dated = async (title: string, on: string | null, at: string | null, extra = '') =>
    (await db.query<{ id: string }>(
      `INSERT INTO public.reminders (title, owner_id, remind_on, remind_at${extra ? ', task_id' : ''})
       VALUES ($1, $2, $3, $4${extra ? ', $5' : ''}) RETURNING id`,
      extra ? [title, OWNER, on, at, extra] : [title, OWNER, on, at])).rows[0].id;
  const morning = await dated('Call the printer', '2026-11-02', null);
  const afternoon = await dated('Follow up with Stephanie', '2026-11-02', '14:30', delivery);
  await dated('Someday', null, null);
  const finished = await dated('Already handled', '2026-11-01', null);
  await db.query("UPDATE public.reminders SET status = 'done' WHERE id = $1", [finished]);

  const run = async (iso: string) => (await db.query<{ n: number }>('SELECT public.send_due_reminders($1::timestamptz) n', [iso])).rows[0].n;
  const bells = async () => (await db.query<{ message: string; link: string; entity_type: string }>(
    'SELECT message, link, entity_type FROM public.team_member_notifications ORDER BY created_at, message')).rows;

  check('7:59 am Phoenix: nothing is due yet', await run('2026-11-02T14:59:00Z') === 0);
  check('8:00 am Phoenix: a dated reminder with no time rings', await run('2026-11-02T15:00:00Z') === 1);
  check('the next run does not ring it again', await run('2026-11-02T15:05:00Z') === 0);
  check('2:30 pm: the timed one rings', await run('2026-11-02T21:30:00Z') === 1);
  const sent = await bells();
  check('bells name the task and link to it; a standalone one links to the reminders page',
    sent.length === 2 && sent[0].message === 'Call the printer' && sent[0].link === '/reminders'
      && sent[1].message === 'Follow up with Stephanie (Update local delivery wording)'
      && sent[1].link === `/projects/${P1}?task=${delivery}` && sent.every((b) => b.entity_type === 'reminder'), sent);
  check('undated and finished reminders never ring', await run('2027-01-01T00:00:00Z') === 0);

  await db.query("UPDATE public.reminders SET remind_on = '2026-11-03' WHERE id = $1", [morning]);
  check('moving the date resets it, and it rings again on the new day',
    (await row(morning)).notified_at === null && await run('2026-11-03T15:00:00Z') === 1);
  await db.query("UPDATE public.reminders SET title = 'Call the printer today' WHERE id = $1", [afternoon]);
  check('editing the text alone does not re-ring', (await row(afternoon)).notified_at !== null);

  const invoiceBell = await tryQuery(
    "INSERT INTO public.team_member_notifications (user_id, title, entity_type, entity_id) VALUES ($1, 'x', 'invoice', 'y')", [OWNER]);
  check('the bell accepts invoice notifications too', !invoiceBell.error, invoiceBell);

  await db.close();
  if (failures.length) {
    console.error(`reminders: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log(`reminders: all ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
