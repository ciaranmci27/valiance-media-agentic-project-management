/**
 * Security hardening (20261127001200_security_hardening.sql), on the whole
 * schema in PGlite with row security on, as the break-it tester ran it
 * through the REST API: each finding's repro as the member who tried it.
 *
 * - Storage: a guest cannot list, overwrite, delete or add files of records
 *   they cannot open (invoice PDFs, lead files, portal files), nor anyone's
 *   avatar; the file buckets are private; the people who should still can.
 * - task_comments: a comment never moves to another task, never changes its
 *   author and is never backdated.
 * - time_entry_tasks: read and written only with the time entry's own rules.
 * - Manage without View all: leads, contacts and task assignees stay scoped.
 * - Personal inboxes: a browser insert is never pre-verified.
 * - Tasks: created_at, completed_at, claims and repeats are server-set.
 * - Trash: no existence oracle for members without the right.
 *
 * Runs on a fresh install (schema.sql) and on an upgraded one (the schema
 * before the migration, then the migration twice). With
 * SECURITY_HARDENING_PROOF=before it runs the same checks on the schema
 * before the migration, without it, to show they fail there.
 *
 *   npm run -s test:security-hardening
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { actAs, createFullSchemaDatabase, schemaBeforeMigration } from './full-schema-db';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseStoredFileUrl, storedFileHref } from '../src/lib/storage/stored-file-url';
import { signStoredFileUrls } from '../src/lib/storage/sign-stored-file';
import { storedFileRedirect } from '../src/lib/storage/open-stored-file';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { startFakePostgrest } from './fake-postgrest';
import { createPmClient } from '../src/lib/supabase/pm-client';
import { portalFileLinks } from '../src/lib/portal-file-links';
import { filesWithFreshLinks, withFreshLinks } from '../src/components/portal/portal-links';
import type { PortalData } from '../src/lib/types';

const MIGRATION = '20261127001200_security_hardening.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8');

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 400)}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const LOGINS = {
  owner: randomUUID(), admin: randomUUID(), sam: randomUUID(), jordan: randomUUID(), guest: randomUUID(),
};

async function seed(db: PGlite) {
  const q = async (sql: string, params: unknown[] = []) => {
    await db.exec('RESET ROLE');
    return (await db.query<Row>(sql, params)).rows;
  };
  await q('DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users');
  // What Supabase grants on its storage schema.
  await q('GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role');
  await q('GRANT ALL ON storage.objects, storage.buckets TO authenticated, service_role');
  await q('UPDATE pm.workspace_modules SET enabled = true');

  const member = async (name: string, role: string, login?: string) => {
    const id = (await q('INSERT INTO pm.team_members (name, email, role, auth_user_id) VALUES ($1, $2, $3, $4) RETURNING id',
      [name, `${name.toLowerCase().replace(/[^a-z]/g, '')}@example.com`, role, null]))[0].id as string;
    if (login) {
      await q('INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())', [login, `${name.toLowerCase()}@example.com`]);
      await q('UPDATE pm.team_members SET auth_user_id = $1 WHERE id = $2', [login, id]);
    }
    return id;
  };
  const perm = (memberId: string, key: string, effect: 'allow' | 'deny') =>
    q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, $2, 'app', $3) ON CONFLICT DO NOTHING", [memberId, key, effect]);

  const owner = await member('Morgan', 'owner', LOGINS.owner);
  const admin = await member('Priya', 'admin', LOGINS.admin);
  const sam = await member('Sam', 'member', LOGINS.sam);
  const jordan = await member('Jordan', 'member', LOGINS.jordan);
  const guest = await member('Casey', 'guest', LOGINS.guest);
  const forge = await member('Forge', 'agent');

  for (const m of [sam, jordan]) await perm(m, 'projects.read_all', 'deny');
  await perm(jordan, 'tasks.read', 'deny');
  await perm(jordan, 'tasks.read_assigned', 'allow');
  await perm(sam, 'inbound_email.personal', 'allow');

  const project = async (name: string, members: string[]) => {
    const id = (await q('INSERT INTO pm.projects (name) VALUES ($1) RETURNING id', [name]))[0].id as string;
    for (const m of members) await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  const web = await project('Website', [sam, jordan, guest]);
  const mobile = await project('Mobile app MVP', [admin]);
  const task = async (projectId: string, title: string, assignees: string[] = []) => {
    const id = (await q('INSERT INTO pm.tasks (project_id, title) VALUES ($1, $2) RETURNING id', [projectId, title]))[0].id as string;
    for (const m of assignees) await q('INSERT INTO pm.task_assignees (task_id, member_id) VALUES ($1, $2)', [id, m]);
    return id;
  };
  const homepage = await task(web, 'Homepage design', [jordan]);
  const webOther = await task(web, 'Footer links');
  const crash = await task(mobile, 'Crash reporting', [admin]);
  const lead = (await q("INSERT INTO pm.leads (name, assigned_to) VALUES ('SECTEST lead', $1) RETURNING id", [admin]))[0].id as string;
  const contact = (await q("INSERT INTO pm.contacts (name, notes) VALUES ('SECTEST contact', 'private') RETURNING id"))[0].id as string;
  return { q, owner, admin, sam, jordan, guest, forge, web, mobile, homepage, webOther, crash, lead, contact };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

/** Runs `sql` as the login; the error message, or null when it worked. */
async function as(db: PGlite, login: string, sql: string, params: unknown[] = []): Promise<{ rows: Row[]; affected: number; error: string | null }> {
  await actAs(db, login);
  try {
    const result = await db.query<Row>(sql, params);
    return { rows: result.rows, affected: result.affectedRows ?? 0, error: null };
  } catch (error) {
    return { rows: [], affected: 0, error: (error as Error).message };
  } finally {
    await actAs(db, null);
    await db.exec('RESET ROLE');
  }
}

async function storageChecks(db: PGlite, s: Seeded, tag: string) {
  const buckets = await s.q("SELECT id, public FROM storage.buckets WHERE id IN ('pm-entity-files', 'pm-portal-files', 'pm-avatars') ORDER BY id");
  const isPublic = Object.fromEntries(buckets.map((b) => [b.id, b.public]));
  check(`${tag} storage: pm-entity-files is private`, isPublic['pm-entity-files'] === false, buckets);
  check(`${tag} storage: pm-portal-files is private`, isPublic['pm-portal-files'] === false, buckets);
  check(`${tag} storage: pm-avatars stays public to read`, isPublic['pm-avatars'] === true, buckets);

  const invoicePath = `invoices/${s.mobile}/1795700000000-SECTEST-INV-1001.pdf`;
  const put = (login: string, bucket: string, name: string) =>
    as(db, login, 'INSERT INTO storage.objects (bucket_id, name, owner) VALUES ($1, $2, $3)', [bucket, name, login]);

  // 1. The Owner stores an invoice PDF on Mobile app MVP (Owners manage invoices).
  check(`${tag} storage: the Owner stores an invoice PDF on a project`, (await put(LOGINS.owner,'pm-entity-files', invoicePath)).error === null);
  // 2. The guest cannot list it.
  const listed = await as(db, LOGINS.guest, "SELECT name FROM storage.objects WHERE bucket_id = 'pm-entity-files'");
  check(`${tag} storage: a guest lists no file of a project they are not on`, !listed.rows.some((r) => r.name === invoicePath), listed);
  // 4. Nor overwrite or delete it.
  const forged = await as(db, LOGINS.guest, "UPDATE storage.objects SET metadata = '{\"forged\":true}' WHERE bucket_id = 'pm-entity-files' AND name = $1", [invoicePath]);
  check(`${tag} storage: a guest cannot overwrite an invoice PDF`, forged.affected === 0, forged);
  const deleted = await as(db, LOGINS.guest, "DELETE FROM storage.objects WHERE bucket_id = 'pm-entity-files' AND name = $1", [invoicePath]);
  check(`${tag} storage: a guest cannot delete an invoice PDF`, deleted.affected === 0, deleted);
  check(`${tag} storage: the invoice PDF is untouched`, (await s.q("SELECT metadata FROM storage.objects WHERE name = $1", [invoicePath]))[0]?.metadata === null);
  check(`${tag} storage: a guest cannot add a file to another project's invoices`,
    (await put(LOGINS.guest, 'pm-entity-files', `invoices/${s.mobile}/forged.pdf`)).error !== null);
  check(`${tag} storage: a guest cannot add a file to a lead`,
    (await put(LOGINS.guest, 'pm-entity-files', `lead/${s.lead}/SECTEST-lead.txt`)).error !== null);
  check(`${tag} storage: a guest cannot upload to their own project without files.upload`,
    (await put(LOGINS.guest, 'pm-entity-files', `project/${s.web}/guest.txt`)).error !== null);
  check(`${tag} storage: a path that names no record is refused`,
    (await put(LOGINS.sam, 'pm-entity-files', 'loose-file.txt')).error !== null);

  // The people who should, still can: a member uploads to their project and reads it back.
  const samFile = `project/${s.web}/1795700000000-brief.pdf`;
  check(`${tag} storage: a member uploads to their project`, (await put(LOGINS.sam, 'pm-entity-files', samFile)).error === null);
  check(`${tag} storage: a guest on that project reads the project's file`,
    (await as(db, LOGINS.guest, 'SELECT name FROM storage.objects WHERE name = $1', [samFile])).rows.length === 1);
  check(`${tag} storage: a member cannot upload to a project they are not on`,
    (await put(LOGINS.sam, 'pm-entity-files', `project/${s.mobile}/x.pdf`)).error !== null);
  const jordanDelete = await as(db, LOGINS.jordan, 'DELETE FROM storage.objects WHERE name = $1', [samFile]);
  check(`${tag} storage: a teammate without files.manage cannot delete someone else's upload`, jordanDelete.affected === 0, jordanDelete);
  const samDelete = await as(db, LOGINS.sam, 'DELETE FROM storage.objects WHERE name = $1', [samFile]);
  check(`${tag} storage: the uploader removes their own upload`, samDelete.affected === 1, samDelete);

  // Portal files: managed by portal.manage on the project.
  const portalPath = `updates/${s.web}/1795700000000-SECTEST-portal.txt`;
  check(`${tag} storage: an admin adds a portal file`, (await put(LOGINS.admin, 'pm-portal-files', portalPath)).error === null);
  const portalGone = await as(db, LOGINS.guest, 'DELETE FROM storage.objects WHERE name = $1', [portalPath]);
  check(`${tag} storage: a guest cannot delete a portal file`, portalGone.affected === 0, portalGone);
  check(`${tag} storage: a guest cannot add a portal file`, (await put(LOGINS.guest, 'pm-portal-files', `updates/${s.web}/x.txt`)).error !== null);

  // Avatars: their own person, team.manage, or the agent's owners.
  const ownerAvatar = `team/${s.owner}.jpg`;
  check(`${tag} storage: the Owner stores their avatar`, (await put(LOGINS.owner, 'pm-avatars', ownerAvatar)).error === null);
  const avatarGone = await as(db, LOGINS.guest, 'DELETE FROM storage.objects WHERE name = $1', [ownerAvatar]);
  check(`${tag} storage: a guest cannot delete the Owner's avatar`, avatarGone.affected === 0, avatarGone);
  const avatarForged = await as(db, LOGINS.guest, "UPDATE storage.objects SET metadata = '{}' WHERE name = $1", [ownerAvatar]);
  check(`${tag} storage: a guest cannot overwrite the Owner's avatar`, avatarForged.affected === 0, avatarForged);
  check(`${tag} storage: a guest cannot put a picture at someone else's avatar path`,
    (await put(LOGINS.guest, 'pm-avatars', `team/${s.sam}.png`)).error !== null);
  check(`${tag} storage: a guest sets their own avatar`, (await put(LOGINS.guest, 'pm-avatars', `team/${s.guest}.jpg`)).error === null);
  check(`${tag} storage: an admin (team.manage) sets an agent's picture`, (await put(LOGINS.admin, 'pm-avatars', `team/${s.forge}.jpg`)).error === null);
  // An agent's owners change its picture, by name or through a group that owns it (canManageAgent).
  const group = (await s.q("INSERT INTO pm.groups (name, slug) VALUES ('SECTEST owners', 'sectest-owners') RETURNING id"))[0].id as string;
  await s.q('INSERT INTO pm.group_members (group_id, member_id) VALUES ($1, $2)', [group, s.sam]);
  await s.q('INSERT INTO pm.agent_owner_groups (agent_id, group_id) VALUES ($1, $2)', [s.forge, group]);
  const byGroup = await as(db, LOGINS.sam, "UPDATE storage.objects SET metadata = '{\"by\":\"group owner\"}' WHERE bucket_id = 'pm-avatars' AND name = $1", [`team/${s.forge}.jpg`]);
  check(`${tag} storage: a group owner of an agent changes its picture`, byGroup.error === null && byGroup.affected === 1, byGroup);
  const notOwner = await as(db, LOGINS.jordan, "UPDATE storage.objects SET metadata = '{}' WHERE bucket_id = 'pm-avatars' AND name = $1", [`team/${s.forge}.jpg`]);
  check(`${tag} storage: someone who does not own the agent cannot`, notOwner.affected === 0, notOwner);
  check(`${tag} storage: a member cannot set a contact's picture without contacts.manage`,
    (await put(LOGINS.sam, 'pm-avatars', `contacts/${s.contact}.jpg`)).error !== null);
}

async function commentChecks(db: PGlite, s: Seeded, tag: string) {
  const posted = await as(db, LOGINS.jordan, "INSERT INTO pm.task_comments (task_id, user_id, text, created_at) VALUES ($1, $2, 'SECTEST jordan comment', '2020-01-01') RETURNING id, created_at",
    [s.homepage, s.jordan]);
  check(`${tag} comments: an assigned member comments on their task`, posted.error === null, posted.error);
  const id = posted.rows[0]?.id as string;
  check(`${tag} comments: a comment is never backdated`, !!posted.rows[0] && new Date(posted.rows[0].created_at).getFullYear() > 2020, posted.rows[0]);
  const moved = await as(db, LOGINS.jordan, 'UPDATE pm.task_comments SET task_id = $1 WHERE id = $2', [s.crash, id]);
  check(`${tag} comments: a comment cannot be moved to a task in another project`, moved.error !== null || moved.affected === 0, moved);
  const sideways = await as(db, LOGINS.jordan, 'UPDATE pm.task_comments SET task_id = $1 WHERE id = $2', [s.webOther, id]);
  check(`${tag} comments: a comment cannot be moved to another task of the same project`, sideways.error !== null || sideways.affected === 0, sideways);
  check(`${tag} comments: the comment is still on its task`, (await s.q('SELECT task_id FROM pm.task_comments WHERE id = $1', [id]))[0]?.task_id === s.homepage);
  const edited = await as(db, LOGINS.jordan, "UPDATE pm.task_comments SET text = 'SECTEST edited' WHERE id = $1", [id]);
  check(`${tag} comments: the author still edits the text`, edited.error === null && edited.affected === 1, edited);

  // An admin (tasks.manage_all) cannot make a comment look like the Owner wrote it.
  const mine = await as(db, LOGINS.admin, "INSERT INTO pm.task_comments (task_id, user_id, text) VALUES ($1, $2, 'SECTEST approved, ship it') RETURNING id", [s.crash, s.admin]);
  const impersonated = await as(db, LOGINS.admin, 'UPDATE pm.task_comments SET user_id = $1 WHERE id = $2', [s.owner, mine.rows[0]?.id]);
  check(`${tag} comments: an admin cannot rewrite a comment's author`, impersonated.error !== null || impersonated.affected === 0, impersonated);
  check(`${tag} comments: the author is unchanged`, (await s.q('SELECT user_id FROM pm.task_comments WHERE id = $1', [mine.rows[0]?.id]))[0]?.user_id === s.admin);
  const moderated = await as(db, LOGINS.admin, "UPDATE pm.task_comments SET text = 'SECTEST moderated' WHERE id = $1", [id]);
  check(`${tag} comments: an admin still edits a comment's text on a task they reach`, moderated.error === null && moderated.affected === 1, moderated);
  const otherAuthor = await as(db, LOGINS.admin, "INSERT INTO pm.task_comments (task_id, user_id, text) VALUES ($1, $2, 'SECTEST as Owner')", [s.crash, s.owner]);
  check(`${tag} comments: nobody posts as someone else`, otherAuthor.error !== null, otherAuthor);
}

async function timeEntryChecks(db: PGlite, s: Seeded, tag: string) {
  const entry = (await s.q("INSERT INTO pm.project_time_entries (project_id, member_id, start_time, end_time, description) VALUES ($1, $2, '2026-11-20 09:00Z', '2026-11-20 11:00Z', 'SECTEST') RETURNING id",
    [s.mobile, s.admin]))[0].id as string;
  await s.q('INSERT INTO pm.time_entry_tasks (time_entry_id, task_id) VALUES ($1, $2)', [entry, s.crash]);
  const read = await as(db, LOGINS.guest, 'SELECT * FROM pm.time_entry_tasks');
  check(`${tag} time links: a guest reads no one else's time links`, read.rows.length === 0, read);
  const linked = await as(db, LOGINS.guest, 'INSERT INTO pm.time_entry_tasks (time_entry_id, task_id) VALUES ($1, $2)', [entry, s.homepage]);
  check(`${tag} time links: a guest cannot link a task to someone's time`, linked.error !== null, linked);
  const unlinked = await as(db, LOGINS.guest, 'DELETE FROM pm.time_entry_tasks WHERE time_entry_id = $1', [entry]);
  check(`${tag} time links: a guest cannot unlink someone's time`, unlinked.affected === 0, unlinked);
  check(`${tag} time links: the link is still there`, (await s.q('SELECT 1 FROM pm.time_entry_tasks WHERE time_entry_id = $1', [entry])).length === 1);

  // Sam's own draft entry: Sam links his project's task, never another project's.
  const own = (await s.q("INSERT INTO pm.project_time_entries (project_id, member_id, start_time, end_time, description) VALUES ($1, $2, '2026-11-20 12:00Z', '2026-11-20 13:00Z', 'SECTEST own') RETURNING id",
    [s.web, s.sam]))[0].id as string;
  // A draft, which its person may still edit.
  await s.q("UPDATE pm.project_time_entries SET approval_status = 'draft' WHERE id = $1", [own]);
  const ok = await as(db, LOGINS.sam, 'INSERT INTO pm.time_entry_tasks (time_entry_id, task_id) VALUES ($1, $2)', [own, s.webOther]);
  check(`${tag} time links: a member links their own entry to their project's task`, ok.error === null, ok.error);
  const sees = await as(db, LOGINS.sam, 'SELECT task_id FROM pm.time_entry_tasks WHERE time_entry_id = $1', [own]);
  check(`${tag} time links: a member reads their own entry's links`, sees.rows.length === 1, sees);
  const cross = await as(db, LOGINS.sam, 'INSERT INTO pm.time_entry_tasks (time_entry_id, task_id) VALUES ($1, $2)', [own, s.crash]);
  check(`${tag} time links: a task from another project is refused`, cross.error !== null, cross);
  const removed = await as(db, LOGINS.sam, 'DELETE FROM pm.time_entry_tasks WHERE time_entry_id = $1', [own]);
  check(`${tag} time links: a member unlinks their own draft entry`, removed.affected === 1, removed);
}

async function manageScopeChecks(db: PGlite, s: Seeded, tag: string) {
  const allow = (key: string) => s.q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, $2, 'app', 'allow') ON CONFLICT DO NOTHING", [s.jordan, key]);
  const revoke = (key: string) => s.q("DELETE FROM pm.team_member_permissions WHERE member_id = $1 AND permission_key = $2 AND effect = 'allow'", [s.jordan, key]);

  await allow('leads.manage');
  const leads = await as(db, LOGINS.jordan, 'SELECT id FROM pm.leads WHERE id = $1', [s.lead]);
  check(`${tag} manage scope: leads.manage alone does not read a lead assigned to someone else`, leads.rows.length === 0, leads);
  const reassigned = await as(db, LOGINS.jordan, 'UPDATE pm.leads SET assigned_to = $1 WHERE id = $2', [s.jordan, s.lead]);
  check(`${tag} manage scope: nor reassign it`, reassigned.affected === 0, reassigned);
  const created = await as(db, LOGINS.jordan, "INSERT INTO pm.leads (name, created_by) VALUES ('SECTEST jordan lead', $1) RETURNING id", [s.jordan]);
  check(`${tag} manage scope: leads.manage still adds a lead and reads it back`, created.error === null && created.rows.length === 1, created.error);
  await revoke('leads.manage');

  await allow('contacts.manage');
  const contacts = await as(db, LOGINS.jordan, 'SELECT id, notes FROM pm.contacts WHERE id = $1', [s.contact]);
  check(`${tag} manage scope: contacts.manage alone does not read an unlinked contact`, contacts.rows.length === 0, contacts);
  const contactEdit = await as(db, LOGINS.jordan, "UPDATE pm.contacts SET notes = 'SECTEST' WHERE id = $1", [s.contact]);
  check(`${tag} manage scope: nor change it`, contactEdit.affected === 0, contactEdit);
  await revoke('contacts.manage');

  await allow('tasks.manage_all');
  const assignees = await as(db, LOGINS.jordan, 'SELECT * FROM pm.task_assignees WHERE task_id = $1', [s.crash]);
  check(`${tag} manage scope: tasks.manage_all alone does not read assignees of tasks they cannot open`, assignees.rows.length === 0, assignees);
  const unassigned = await as(db, LOGINS.jordan, 'DELETE FROM pm.task_assignees WHERE task_id = $1', [s.crash]);
  check(`${tag} manage scope: nor remove them`, unassigned.affected === 0, unassigned);
  check(`${tag} manage scope: the assignee is still there`, (await s.q('SELECT 1 FROM pm.task_assignees WHERE task_id = $1', [s.crash])).length === 1);
  await revoke('tasks.manage_all');
}

async function inboxChecks(db: PGlite, s: Seeded, tag: string) {
  const inserted = await as(db, LOGINS.sam, `INSERT INTO pm.inboxes (name, address, routing_domain, routing_local_part, owner_member_id, verified_at, verification_code, created_by)
    VALUES ('SECTEST spoof', 'owner@acme.test', 'inbox.acme.test', 'sectest-sam', $1, now(), 'VM-ZZ9Q', $1) RETURNING id`, [s.sam]);
  const row = inserted.rows[0]?.id ? (await s.q('SELECT verified_at, verification_code FROM pm.inboxes WHERE id = $1', [inserted.rows[0].id]))[0] : null;
  check(`${tag} inboxes: a member's own inbox insert works`, inserted.error === null, inserted.error);
  check(`${tag} inboxes: a browser insert is never pre-verified`, !!row && row.verified_at === null, row);
  check(`${tag} inboxes: the verification code is the server's`, !!row && row.verification_code !== 'VM-ZZ9Q', row);
  if (inserted.rows[0]?.id) {
    const verify = await as(db, LOGINS.sam, 'UPDATE pm.inboxes SET verified_at = now() WHERE id = $1', [inserted.rows[0].id]);
    const after = (await s.q('SELECT verified_at FROM pm.inboxes WHERE id = $1', [inserted.rows[0].id]))[0];
    check(`${tag} inboxes: a browser update never verifies an inbox`, after?.verified_at === null, { verify, after });
  }
}

async function taskFieldChecks(db: PGlite, s: Seeded, tag: string) {
  const made = await as(db, LOGINS.sam, `INSERT INTO pm.tasks (project_id, title, created_by, created_at, status, completed_at, claimed_by, claim_expires_at, occurrences)
    VALUES ($1, 'SECTEST backdated', $2, '2020-01-01', 'done', '2020-01-01', $3, '2099-01-01', 999) RETURNING id`, [s.web, s.sam, s.forge]);
  check(`${tag} task fields: a member still creates a task`, made.error === null, made.error);
  const row = made.rows[0]?.id ? (await s.q('SELECT * FROM pm.tasks WHERE id = $1', [made.rows[0].id]))[0] : null;
  check(`${tag} task fields: created_at is the server's`, !!row && new Date(row.created_at).getFullYear() > 2020, row?.created_at);
  check(`${tag} task fields: completed_at is the server's`, !!row && new Date(row.completed_at).getFullYear() > 2020, row?.completed_at);
  check(`${tag} task fields: a browser insert never claims`, !!row && row.claimed_by === null && row.claim_expires_at === null, row && { claimed_by: row.claimed_by, claim_expires_at: row.claim_expires_at });
  check(`${tag} task fields: the repeat count is the server's`, !!row && row.occurrences === 1, row?.occurrences);
  if (row) {
    const backdate = await as(db, LOGINS.sam, "UPDATE pm.tasks SET completed_at = '2020-01-01', created_at = '2020-01-01', claimed_by = $2, claim_expires_at = '2099-01-01' WHERE id = $1", [row.id, s.forge]);
    const after = (await s.q('SELECT created_at, completed_at, claimed_by FROM pm.tasks WHERE id = $1', [row.id]))[0];
    check(`${tag} task fields: an update never backdates or claims`, new Date(after.completed_at).getFullYear() > 2020
      && new Date(after.created_at).getFullYear() > 2020 && after.claimed_by === null, { backdate, after });
  }
}

async function trashChecks(db: PGlite, s: Seeded, tag: string) {
  const existing = await as(db, LOGINS.guest, "SELECT pm.restore_record('tasks', $1)", [s.crash]);
  const missing = await as(db, LOGINS.guest, "SELECT pm.restore_record('tasks', $1)", [randomUUID()]);
  check(`${tag} trash: restore answers the same for a hidden record and a missing one`, !!existing.error && existing.error === missing.error, { existing: existing.error, missing: missing.error });
  const delExisting = await as(db, LOGINS.guest, "SELECT pm.soft_delete_record('tasks', $1)", [s.crash]);
  const delMissing = await as(db, LOGINS.guest, "SELECT pm.soft_delete_record('tasks', $1)", [randomUUID()]);
  check(`${tag} trash: delete answers the same for a hidden record and a missing one`, !!delExisting.error && delExisting.error === delMissing.error, { delExisting: delExisting.error, delMissing: delMissing.error });
  const own = await as(db, LOGINS.admin, "SELECT pm.soft_delete_record('tasks', $1) AS ok", [s.crash]);
  check(`${tag} trash: whoever may still moves a record to Trash`, own.error === null && own.rows[0]?.ok === true, own);
  const back = await as(db, LOGINS.admin, "SELECT pm.restore_record('tasks', $1) AS ok", [s.crash]);
  check(`${tag} trash: and restores it`, back.error === null && back.rows[0]?.ok === true, back);
}

/** How the app opens stored files now that the buckets are private (stored-file-url.ts). */
function storedFileUrlChecks() {
  const base = 'https://abc.supabase.co';
  const entity = `${base}/storage/v1/object/public/pm-entity-files/invoices/1a07a870-d6f3-4e46-a2e8-b23ace614a92/17957-INV%201001.pdf`;
  const parsed = parseStoredFileUrl(entity, base);
  check('stored files: a stored invoice address names its bucket and path',
    parsed?.bucket === 'pm-entity-files' && parsed.path === 'invoices/1a07a870-d6f3-4e46-a2e8-b23ace614a92/17957-INV 1001.pdf', parsed);
  check('stored files: a pre-2.0 bucket maps to its pm- twin',
    parseStoredFileUrl(`${base}/storage/v1/object/public/portal-files/updates/x/y.txt`, base)?.bucket === 'pm-portal-files');
  check('stored files: avatars stay public addresses', parseStoredFileUrl(`${base}/storage/v1/object/public/pm-avatars/team/a.jpg`, base) === null);
  check('stored files: an already signed link is left alone', parseStoredFileUrl(`${base}/storage/v1/object/sign/pm-entity-files/a/b/c?token=t`, base) === null);
  check('stored files: another Supabase project is not ours', parseStoredFileUrl(entity.replace('abc.', 'evil.'), base) === null);
  check('stored files: path tricks are refused', parseStoredFileUrl(`${base}/storage/v1/object/public/pm-entity-files/project/a%2F..%2Fb/x`, base) === null
    && parseStoredFileUrl(`${base}/storage/v1/object/public/pm-entity-files/project/a%5Cb/x`, base) === null);
  check('stored files: outside links and placeholders are not stored files', parseStoredFileUrl('https://docs.example.com/a.pdf', base) === null
    && parseStoredFileUrl('#', base) === null && parseStoredFileUrl('javascript:alert(1)', base) === null);
  const saved = process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_URL = base;
  try {
    check('stored files: the app opens a private file through the checked redirect',
      storedFileHref(entity) === `/api/storage/file?u=${encodeURIComponent(entity)}`);
    check('stored files: any other address opens as it is', storedFileHref('https://docs.example.com/a.pdf') === 'https://docs.example.com/a.pdf');
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = saved;
  }
}

/** Signing in batches (sign-stored-file.ts) and the checked redirect (open-stored-file.ts). */
async function signingChecks() {
  const base = 'https://abc.supabase.co';
  const saved = process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_URL = base;
  try {
    const stored = (bucket: string, path: string) => `${base}/storage/v1/object/public/${bucket}/${path}`;
    const calls: { bucket: string; paths: string[] }[] = [];
    // The new bucket holds every file but legacy.png, which is still in the pre-2.0 bucket.
    const client = {
      storage: {
        from: (bucket: string) => ({
          createSignedUrls: async (paths: string[]) => {
            calls.push({ bucket, paths });
            return { data: paths.map((path) => (bucket === 'pm-entity-files' && path.endsWith('legacy.png')
              ? { path, signedUrl: null, error: 'Object not found' }
              : { path, signedUrl: `${base}/storage/v1/object/sign/${bucket}/${path}?token=t`, error: null })), error: null };
          },
        }),
      },
    } as unknown as SupabaseClient;
    const urls = [
      stored('pm-entity-files', 'project/p1/a.png'), stored('pm-entity-files', 'project/p1/b.png'), stored('pm-entity-files', 'project/p1/b.png'),
      stored('pm-entity-files', 'project/p1/legacy.png'), stored('pm-portal-files', 'updates/p1/c.png'), 'https://docs.example.com/d.pdf', null,
    ];
    const signed = await signStoredFileUrls(client, urls, 3600);
    const firstPass = calls.filter((c) => c.bucket.startsWith('pm-'));
    check('signing: one storage call per bucket for a whole grid', firstPass.length === 2
      && firstPass.find((c) => c.bucket === 'pm-entity-files')?.paths.length === 3, calls);
    check('signing: a file still in its pre-2.0 bucket is signed there',
      calls.some((c) => c.bucket === 'entity-files' && c.paths.length === 1 && c.paths[0].endsWith('legacy.png'))
      && (signed.get(urls[3]!) ?? '').includes('/entity-files/'), { calls, legacy: signed.get(urls[3]!) });
    check('signing: every stored file gets its link', [0, 1, 4].every((i) => (signed.get(urls[i]!) ?? '').includes('token=t')));
    check('signing: an outside link stays as it is', signed.get('https://docs.example.com/d.pdf') === 'https://docs.example.com/d.pdf');

    const entity = stored('pm-entity-files', 'project/p1/a.png');
    const sign = async () => 'https://signed.example/a.png';
    const missing = await storedFileRedirect(entity, { allowed: async () => ({ data: null, error: { code: 'PGRST202' } }), sign });
    check('open: before the migration (no access check yet) the stored address opens, as the bucket is still public',
      missing.status === 302 && missing.location === entity, missing);
    const missingPg = await storedFileRedirect(entity, { allowed: async () => ({ data: null, error: { code: '42883' } }), sign });
    check('open: the same for Postgres\'s own missing-function error', missingPg.status === 302 && missingPg.location === entity, missingPg);
    check('open: a refused file answers 404', (await storedFileRedirect(entity, { allowed: async () => ({ data: false, error: null }), sign })).status === 404);
    check('open: any other database error answers 404', (await storedFileRedirect(entity, { allowed: async () => ({ data: null, error: { code: 'XX000' } }), sign })).status === 404);
    const ok = await storedFileRedirect(entity, { allowed: async () => ({ data: true, error: null }), sign });
    check('open: an allowed file redirects to its signed link', ok.status === 302 && ok.location === 'https://signed.example/a.png', ok);
    check('open: an outside address is never redirected to', (await storedFileRedirect('https://evil.example/x', { allowed: async () => ({ data: true, error: null }), sign })).status === 404);
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = saved;
  }
}

/**
 * An open portal page keeps working past an hour: /api/portal/[token]/links
 * (portalFileLinks) signs exactly the files the portal shows, in one batch,
 * and the page swaps them in (withFreshLinks).
 */
async function portalLinkChecks() {
  const db = await createFullSchemaDatabase();
  const q = async (sql: string, params: unknown[] = []) => { await db.exec('RESET ROLE'); return (await db.query<Row>(sql, params)).rows; };
  const signCalls: string[] = [];
  const server = await startFakePostgrest(db, {
    handle: async (request: IncomingMessage, response: ServerResponse, url: URL) => {
      const match = /^\/storage\/v1\/object\/sign\/([^/]+)$/.exec(url.pathname);
      if (!match || request.method !== 'POST') return false;
      const text = await new Promise<string>((resolve) => { let b = ''; request.on('data', (c) => (b += c)); request.on('end', () => resolve(b)); });
      const { paths } = JSON.parse(text) as { paths: string[] };
      signCalls.push(match[1]);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(paths.map((path) => ({ path, error: null, signedURL: `/object/sign/${match[1]}/${path}?token=fresh` }))));
      return true;
    },
  });
  const saved = process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_URL = server.url;
  try {
    const stored = (bucket: string, path: string) => `${server.url}/storage/v1/object/public/${bucket}/${path}`;
    const project = (await q("INSERT INTO pm.projects (name) VALUES ('Portal project') RETURNING id"))[0].id as string;
    const other = (await q("INSERT INTO pm.projects (name) VALUES ('Other project') RETURNING id"))[0].id as string;
    const file = async (projectId: string, visibility: string, name: string) => (await q(
      "INSERT INTO pm.entity_files (entity_type, entity_id, name, file_url, file_size, mime_type, visibility) VALUES ('project', $1, $2, $3, 1, 'image/png', $4) RETURNING id",
      [projectId, name, stored('pm-entity-files', `project/${projectId}/${name}`), visibility]))[0].id as string;
    const shared = await file(project, 'external', 'shared.png');
    const internal = await file(project, 'internal', 'internal.png');
    const elsewhere = await file(other, 'external', 'elsewhere.png');
    const update = (await q("INSERT INTO pm.portal_updates (project_id, title, content) VALUES ($1, 'Week 1', 'Done') RETURNING id", [project]))[0].id as string;
    const attachment = (await q("INSERT INTO pm.portal_update_attachments (update_id, name, file_url, file_size, mime_type) VALUES ($1, 'shot.png', $2, 1, 'image/png') RETURNING id",
      [update, stored('pm-portal-files', `updates/${project}/shot.png`)]))[0].id as string;
    const service = createPmClient(server.url, 'fake-service-key');
    const links = await portalFileLinks(service, { project_id: project, show_files: true, show_invoices: false, show_updates: true }, new Set(['portal', 'billing']));
    check('portal links: a shared project file gets a fresh link', (links.files[shared] ?? '').includes('token=fresh'), links);
    check('portal links: an internal file is never in them', !(internal in links.files), links.files);
    check('portal links: another project\'s file is never in them', !(elsewhere in links.files), links.files);
    check('portal links: an update attachment gets a fresh link', (links.attachments[attachment] ?? '').includes('token=fresh'), links.attachments);
    check('portal links: one signing call per bucket', signCalls.length === 2 && new Set(signCalls).size === 2, signCalls);
    const hidden = await portalFileLinks(service, { project_id: project, show_files: false, show_invoices: false, show_updates: false }, new Set(['portal']));
    check('portal links: sections the portal hides give no links', Object.keys(hidden.files).length + Object.keys(hidden.attachments).length + Object.keys(hidden.invoices).length === 0, hidden);

    const page = {
      invoices: [{ id: 'inv-1', file_url: 'old-invoice' }],
      updates: [{ id: update, attachments: [{ id: attachment, file_url: 'old-shot' }, { id: 'kept', file_url: 'old-kept' }] }],
    } as unknown as PortalData;
    const fresh = withFreshLinks(page, { files: {}, invoices: { 'inv-1': 'new-invoice' }, attachments: { [attachment]: 'new-shot' } });
    check('portal page: fresh links replace the old ones', fresh.invoices[0].file_url === 'new-invoice'
      && fresh.updates![0].attachments[0].file_url === 'new-shot' && fresh.updates![0].attachments[1].file_url === 'old-kept', fresh);
    const files = filesWithFreshLinks([{ id: shared, file_url: 'old', name: 'a', file_size: 1, mime_type: 'image/png' }], links);
    check('portal page: shared files get their fresh links', files[0].file_url === links.files[shared]);
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = saved;
    await server.close();
  }
}

async function runAll(db: PGlite, tag: string) {
  const s = await seed(db);
  await storageChecks(db, s, tag);
  await commentChecks(db, s, tag);
  await timeEntryChecks(db, s, tag);
  await manageScopeChecks(db, s, tag);
  await inboxChecks(db, s, tag);
  await taskFieldChecks(db, s, tag);
  await trashChecks(db, s, tag);
}

async function main() {
  if (process.env.SECURITY_HARDENING_PROOF === 'before') {
    await runAll(await createFullSchemaDatabase({ schemaSql: schemaBeforeMigration(MIGRATION) }), '[before]');
  } else {
    storedFileUrlChecks();
    await signingChecks();
    await portalLinkChecks();
    await runAll(await createFullSchemaDatabase(), '[fresh]');
    const upgraded = await createFullSchemaDatabase({ schemaSql: schemaBeforeMigration(MIGRATION) });
    await upgraded.exec(MIGRATION_SQL);
    await upgraded.exec(MIGRATION_SQL);
    await runAll(upgraded, '[upgraded]');
  }
  console.log(`${passed} passed, ${failures.length} failed`);
  for (const failure of failures) console.log(`  FAIL ${failure}`);
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
