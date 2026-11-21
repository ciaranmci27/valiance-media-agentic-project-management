/**
 * Role rules on the full schema (PGlite):
 * - the Admin role starts without money or workspace-setup permissions;
 * - a workspace always keeps at least one active Owner.
 * Run with: npm run test:roles
 */
import type { PGlite } from '@electric-sql/pglite';
import { actAs, createFullSchemaDatabase } from './full-schema-db';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

const USERS = {
  owner: '00000000-0000-0000-0000-00000000c001',
  owner2: '00000000-0000-0000-0000-00000000c002',
  admin: '00000000-0000-0000-0000-00000000c003',
  member: '00000000-0000-0000-0000-00000000c004',
} as const;
type Who = keyof typeof USERS;
const ROLE: Record<Who, string> = { owner: 'owner', owner2: 'owner', admin: 'admin', member: 'member' };

const OWNER_ONLY = [
  'settings.manage', 'smtp.manage', 'webhooks.manage', 'inbound_email.manage',
  'billing.manage', 'finance.company.read', 'invoices.read', 'invoices.manage',
  'invoices.record_payments', 'compensation.manage', 'payouts.manage',
];

async function seed(db: PGlite) {
  await actAs(db, null);
  await db.exec('RESET ROLE');
  for (const who of Object.keys(USERS) as Who[]) {
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [USERS[who], `${who}@example.com`]);
    const updated = await db.query(`UPDATE public.team_members SET role = $2, status = 'active' WHERE auth_user_id = $1`, [USERS[who], ROLE[who]]);
    if (!updated.affectedRows) {
      await db.query(`INSERT INTO public.team_members (auth_user_id, name, email, role, status) VALUES ($1, $2, $3, $4, 'active')`,
        [USERS[who], who, `${who}@example.com`, ROLE[who]]);
    }
  }
}

async function memberId(db: PGlite, who: Who): Promise<string> {
  await db.exec('RESET ROLE');
  return (await db.query<{ id: string }>('SELECT id FROM public.team_members WHERE auth_user_id = $1', [USERS[who]])).rows[0].id;
}

/** Runs `sql` as `who` inside a transaction that is always rolled back; returns the error message or rows changed. */
async function attempt(db: PGlite, who: Who | null, sql: string, params: unknown[] = []): Promise<{ error: string | null; rows: number }> {
  await db.exec('RESET ROLE');
  await db.exec('BEGIN');
  try {
    if (who) await actAs(db, USERS[who]); else await db.exec('RESET ROLE');
    // Several statements run as a script; one statement reports the rows it changed.
    if (!params.length && sql.trim().replace(/;$/, '').includes(';')) {
      await db.exec(sql);
      return { error: null, rows: -1 };
    }
    const result = await db.query(sql, params);
    return { error: null, rows: result.affectedRows ?? 0 };
  } catch (error) {
    return { error: (error as Error).message, rows: 0 };
  } finally {
    // ROLLBACK first: after an error the transaction accepts nothing else.
    await db.exec('ROLLBACK');
    await db.exec('RESET ROLE');
  }
}

async function main() {
  const db = await createFullSchemaDatabase();
  await seed(db);

  // ---- Admin defaults ------------------------------------------------------
  await db.exec('RESET ROLE');
  const adminPerms = (await db.query<{ permission_key: string }>("SELECT permission_key FROM public.role_permissions WHERE role = 'admin'")).rows.map((r) => r.permission_key);
  const leaked = OWNER_ONLY.filter((key) => adminPerms.includes(key));
  check('admin: starts without money or workspace-setup permissions', leaked.length === 0, leaked);
  check('admin: still runs the team and the projects', ['team.manage', 'projects.manage', 'tasks.manage_all', 'time.approve'].every((key) => adminPerms.includes(key)));

  // ---- At least one active Owner --------------------------------------------
  const owner2 = await memberId(db, 'owner2');
  const owner = await memberId(db, 'owner');
  const demoteOther = await attempt(db, 'owner', "UPDATE public.team_members SET role = 'admin' WHERE id = $1", [owner2]);
  check('owner: can demote another Owner while one remains', !demoteOther.error && demoteOther.rows === 1, demoteOther);

  const lastOwner = await attempt(db, null, `
    UPDATE public.team_members SET role = 'admin' WHERE id = '${owner2}';
    UPDATE public.team_members SET role = 'admin' WHERE id = '${owner}';`);
  check('owner: the last active Owner cannot be demoted', !!lastOwner.error && lastOwner.error.includes('At least one active Owner'), lastOwner);

  const suspendAll = await attempt(db, null, "UPDATE public.team_members SET status = 'suspended' WHERE role = 'owner'");
  check('owner: suspending every Owner is refused', !!suspendAll.error && suspendAll.error.includes('At least one active Owner'), suspendAll);

  const suspendOne = await attempt(db, null, "UPDATE public.team_members SET status = 'suspended' WHERE id = $1", [owner2]);
  check('owner: suspending one of two Owners is allowed', !suspendOne.error && suspendOne.rows === 1, suspendOne);

  const rename = await attempt(db, null, "UPDATE public.team_members SET name = 'Renamed' WHERE id = $1", [owner]);
  check('owner: other edits to the last Owner are unaffected', !rename.error && rename.rows === 1, rename);

  // ---- Invoice drafts reach people who may see invoices ---------------------
  await db.exec('RESET ROLE');
  const adminId = await memberId(db, 'admin');
  const ownerId = await memberId(db, 'owner');
  const holds = async (id: string, key: string) =>
    (await db.query<{ ok: boolean }>('SELECT public.member_has_permission($1, $2) AS ok', [id, key])).rows[0].ok;
  check('member_has_permission: an Owner holds invoices.read', await holds(ownerId, 'invoices.read'));
  check('member_has_permission: an Admin does not by default', !(await holds(adminId, 'invoices.read')));
  check('member_has_permission: an Admin still holds team.manage', await holds(adminId, 'team.manage'));
  const project = (await db.query<{ id: string }>("INSERT INTO public.projects (name) VALUES ('Billing project') RETURNING id")).rows[0].id;
  const invoice = (await db.query<{ id: string }>("INSERT INTO public.project_invoices (project_id, invoice_number, date, amount, status) VALUES ($1, 'INV-9', '2026-11-21', 100, 'draft') RETURNING id", [project])).rows[0].id;
  const bells = async () => (await db.query<{ user_id: string }>("SELECT user_id FROM public.team_member_notifications WHERE entity_type = 'invoice' AND entity_id = $1", [invoice])).rows.map((row) => row.user_id);
  await db.query("SELECT public.announce_billing_draft($1, 'Invoice drafted', 'INV-9 is ready')", [invoice]);
  const first = await bells();
  check('invoice draft bell: Owners get it, an Admin without the grant does not', first.includes(ownerId) && !first.includes(adminId), first);
  await db.query("INSERT INTO public.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'invoices.read', 'app', 'allow')", [adminId]);
  await db.query("SELECT public.announce_billing_draft($1, 'Invoice drafted', 'INV-9 is ready')", [invoice]);
  check('invoice draft bell: an Admin granted invoices.read gets it', (await bells()).includes(adminId));

  // ---- Nobody raises their own access --------------------------------------
  const admin = await memberId(db, 'admin');
  const selfPromote = await attempt(db, 'admin', "UPDATE public.team_members SET role = 'owner' WHERE id = $1", [admin]);
  check('admin: cannot make themselves an Owner', !!selfPromote.error || selfPromote.rows === 0, selfPromote);
  const member = await memberId(db, 'member');
  const memberPromote = await attempt(db, 'member', "UPDATE public.team_members SET role = 'admin' WHERE id = $1", [member]);
  check('member: cannot make themselves an Admin', !!memberPromote.error || memberPromote.rows === 0, memberPromote);

  await db.close();
  if (failures.length) {
    console.log(`roles: ${passed} passed, ${failures.length} failed:`);
    for (const failure of failures) console.log(` - ${failure}`);
    process.exit(1);
  }
  console.log(`roles: ${passed} checks passed.`);
}

main().catch((error) => { console.error(error); process.exit(1); });
