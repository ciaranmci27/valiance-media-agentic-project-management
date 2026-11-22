/**
 * Workspace modules: a permission whose module is off is held by nobody,
 * owners included, in the database and in the app; nothing changes while
 * every module is on; the registry and the SQL seed agree.
 *
 * Runs on PGlite over the whole real schema, plus the schema as it was before
 * the migration with the migration applied twice on top. Nothing touches a
 * live database.
 *
 *   npm run -s test:modules
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { actAs, createFullSchemaDatabase, schemaAt } from './full-schema-db';
import { PERMISSIONS, hasPermission, isModuleEnabled, type AccessContext, type PermissionKey } from '../src/lib/access-control';
import {
  MODULE_IDS,
  MODULES,
  PERMISSION_MODULE,
  PRESETS,
  applyModuleChange,
  dependentsOf,
  normalizeModules,
  presetFor,
  requirementsOf,
  type ModuleId,
} from '../src/lib/modules/registry';

const MIGRATION = '20261120194316_workspace_modules.sql';
const MIGRATION_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', MIGRATION), 'utf8');
// Billing split in two: Client invoicing keeps the id billing, Team pay is new.
const TEAM_PAY_MIGRATION = '20261121050000_team_pay_module.sql';
const TEAM_PAY_SQL = readFileSync(join(__dirname, '..', 'supabase', 'migrations', TEAM_PAY_MIGRATION), 'utf8');
const PAY_KEYS: PermissionKey[] = ['compensation.manage', 'payouts.manage', 'earnings.own.read'];

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

const ROLES = ['owner', 'admin', 'member', 'guest', 'agent'] as const;
type Role = typeof ROLES[number];
const USERS: Record<Role, string> = {
  owner: '00000000-0000-0000-0000-00000000a001',
  admin: '00000000-0000-0000-0000-00000000a002',
  member: '00000000-0000-0000-0000-00000000a003',
  guest: '00000000-0000-0000-0000-00000000a004',
  agent: '00000000-0000-0000-0000-00000000a005',
};

/** schema.sql before a migration: its parent commit's copy once committed, `fallback`'s before. */
function schemaBefore(migration = MIGRATION, fallback = 'origin/main'): string {
  const git = (args: string[]) => execFileSync('git', args, { cwd: join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const added = git(['log', '--diff-filter=A', '--format=%H', '--', `supabase/migrations/${migration}`]).trim().split('\n').filter(Boolean).pop();
  return schemaAt(added ? `${added}^` : fallback);
}

/** Setup writes run as the database owner, as a migration or the dashboard would. */
async function asOwnerOfDatabase(db: PGlite) {
  await actAs(db, null);
  await db.exec('RESET ROLE');
}

/** Where the app lives: pm since 2.0, public in the copies of earlier releases. */
async function appSchema(db: PGlite): Promise<'pm' | 'public'> {
  const { rows } = await db.query<{ pm: boolean }>("SELECT to_regclass('pm.team_members') IS NOT NULL AS pm");
  return rows[0].pm ? 'pm' : 'public';
}

async function seedMembers(db: PGlite) {
  await asOwnerOfDatabase(db);
  const s = await appSchema(db);
  for (const role of ROLES) {
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [USERS[role], `${role}@example.com`]);
    // Signing up may already have made the member (the auth trigger); either way, set the role.
    const updated = await db.query(`UPDATE ${s}.team_members SET role = $2, status = 'active' WHERE auth_user_id = $1`, [USERS[role], role]);
    if (!updated.affectedRows) {
      await db.query(
        `INSERT INTO ${s}.team_members (auth_user_id, name, email, role, status) VALUES ($1, $2, $3, $4, 'active')`,
        [USERS[role], role, `${role}@example.com`, role],
      );
    }
  }
}

type Snapshot = Record<Role, { context: Record<string, unknown>; granted: string[] }>;

async function snapshot(db: PGlite): Promise<Snapshot> {
  const out = {} as Snapshot;
  const s = await appSchema(db);
  for (const role of ROLES) {
    await actAs(db, USERS[role]);
    const context = (await db.query<{ ctx: Record<string, unknown> }>(`SELECT ${s}.get_my_access_context() AS ctx`)).rows[0].ctx;
    const granted: string[] = [];
    for (const key of PERMISSIONS) {
      for (const channel of ['app', 'api']) {
        const row = (await db.query<{ ok: boolean }>(`SELECT ${s}.has_permission($1, $2) AS ok`, [key, channel])).rows[0];
        if (row.ok) granted.push(`${channel}:${key}`);
      }
    }
    out[role] = { context, granted };
  }
  await actAs(db, null);
  return out;
}

async function setModule(db: PGlite, id: ModuleId, enabled: boolean) {
  await asOwnerOfDatabase(db);
  await db.query(`UPDATE ${await appSchema(db)}.workspace_modules SET enabled = $2 WHERE module_id = $1`, [id, enabled]);
}

function appAccess(context: Record<string, unknown>, modules: ModuleId[]): AccessContext {
  return { ...(context as unknown as AccessContext), modules };
}

async function main() {
  // --- The registry on its own -----------------------------------------------------------
  for (const key of PERMISSIONS) {
    check(`registry: ${key} has a module`, key in PERMISSION_MODULE);
  }
  for (const id of MODULE_IDS) {
    check(`registry: ${id} depends only on known modules`, MODULES[id].dependsOn.every((dep) => MODULE_IDS.includes(dep)));
    check(`registry: ${id} owns at least one permission`, Object.values(PERMISSION_MODULE).includes(id));
  }
  for (const preset of Object.values(PRESETS)) {
    check(`registry: preset ${preset.id} keeps its dependencies`, normalizeModules(preset.modules).length === preset.modules.length, preset.modules);
    check(`registry: preset ${preset.id} is recognised`, presetFor(preset.modules) === preset.id);
  }
  check('deps: Leads needs Contacts', requirementsOf('sales').includes('contacts'));
  check('deps: Webhooks needs Billing and Time', ['billing', 'time'].every((m) => requirementsOf('webhooks').includes(m as ModuleId)));
  check('deps: Webhooks does not need Team pay', !requirementsOf('webhooks').includes('team_pay'), requirementsOf('webhooks'));
  check('deps: Time off takes Billing, Team pay and Webhooks with it', ['billing', 'team_pay', 'webhooks'].every((m) => dependentsOf('time').includes(m as ModuleId)));
  check('deps: turning Leads on turns Contacts on',
    JSON.stringify(applyModuleChange([], 'sales', true)) === JSON.stringify(['contacts', 'sales']), applyModuleChange([], 'sales', true));
  check('deps: turning Contacts off turns Leads off',
    !applyModuleChange(MODULE_IDS, 'contacts', false).some((m) => ['contacts', 'sales'].includes(m)));
  // The portal needs no address book: only emailing clients does, and that checks Contacts itself.
  check('deps: the Client portal needs nothing', MODULES.portal.dependsOn.length === 0 && requirementsOf('portal').length === 0, MODULES.portal.dependsOn);
  check('deps: turning Contacts off keeps the Client portal', applyModuleChange(MODULE_IDS, 'contacts', false).includes('portal'));
  check('deps: the portal alone is a whole set', JSON.stringify(normalizeModules(['portal'])) === JSON.stringify(['portal']));
  // Team pay and Client invoicing are two switches over one need: Time.
  check('deps: Team pay needs Time only', JSON.stringify(requirementsOf('team_pay')) === JSON.stringify(['time']), requirementsOf('team_pay'));
  check('deps: Team pay is a money module', MODULES.team_pay.group === MODULES.billing.group);
  check('deps: turning Team pay on turns Time on, not Billing',
    JSON.stringify(applyModuleChange([], 'team_pay', true)) === JSON.stringify(['time', 'team_pay']), applyModuleChange([], 'team_pay', true));
  check('deps: Billing off keeps Team pay', applyModuleChange(MODULE_IDS, 'billing', false).includes('team_pay'));
  check('deps: Team pay off keeps Billing and Webhooks',
    ['billing', 'webhooks'].every((m) => applyModuleChange(MODULE_IDS, 'team_pay', false).includes(m as ModuleId)));
  for (const key of PAY_KEYS) check(`registry: ${key} is Team pay's`, PERMISSION_MODULE[key] === 'team_pay', PERMISSION_MODULE[key]);
  for (const key of ['invoices.read', 'invoices.manage', 'invoices.record_payments', 'billing.manage', 'finance.company.read'] as PermissionKey[]) {
    check(`registry: ${key} stays Client invoicing's`, PERMISSION_MODULE[key] === 'billing', PERMISSION_MODULE[key]);
  }
  check('registry: Billing is named Client invoicing', MODULES.billing.label === 'Client invoicing');
  check('presets: Agency is everything', PRESETS.agency.modules.length === MODULE_IDS.length);
  check('presets: Internal team leaves both money modules off',
    JSON.stringify([...PRESETS.team.modules].sort()) === JSON.stringify(['agents', 'credentials', 'inbox', 'time']), PRESETS.team.modules);
  check('presets: Solo invoices clients and has no Team pay',
    JSON.stringify([...PRESETS.solo.modules].sort()) === JSON.stringify(['billing', 'contacts', 'time', 'webhooks']), PRESETS.solo.modules);
  check('deps: a custom mix is no preset', presetFor(['time', 'agents']) === null);

  // --- The app-side rule -----------------------------------------------------------------
  const ownerAll: AccessContext = { member_id: 'o', role: 'owner', status: 'active', app_permissions: ['*'], api_permissions: ['*'], project_ids: [] };
  check('app: owner holds billing when modules are unknown', hasPermission(ownerAll, 'invoices.read'));
  const ownerNoBilling = { ...ownerAll, modules: MODULE_IDS.filter((m) => m !== 'billing') };
  check('app: owner loses billing when Billing is off', !hasPermission(ownerNoBilling, 'invoices.read'));
  check('app: owner keeps billing on the API channel off too', !hasPermission(ownerNoBilling, 'invoices.read', 'api'));
  check('app: owner keeps core when Billing is off', hasPermission(ownerNoBilling, 'tasks.manage_all') && hasPermission(ownerNoBilling, 'project_context.read'));
  check('app: isModuleEnabled reads the list', !isModuleEnabled(ownerNoBilling, 'billing') && isModuleEnabled(ownerNoBilling, 'time'));
  check('app: suspended holds nothing', !hasPermission({ ...ownerAll, status: 'suspended' }, 'tasks.read'));
  const ownerNoPay = { ...ownerAll, modules: MODULE_IDS.filter((m) => m !== 'team_pay') };
  check('app: owner loses pay when Team pay is off', PAY_KEYS.every((key) => !hasPermission(ownerNoPay, key)));
  check('app: owner keeps invoices when Team pay is off', hasPermission(ownerNoPay, 'invoices.read') && hasPermission(ownerNoPay, 'finance.company.read'));
  check('app: owner keeps pay when Billing is off', PAY_KEYS.every((key) => hasPermission(ownerNoBilling, key)));

  // --- The migration on today's production schema changes nothing --------------------------
  const before = await createFullSchemaDatabase({ schemaSql: schemaBefore() });
  await seedMembers(before);
  const pre = await snapshot(before);
  await asOwnerOfDatabase(before);
  await before.exec(MIGRATION_SQL);
  await before.exec(MIGRATION_SQL);
  // The split that followed in a later release, so the copy reaches today's modules.
  await before.exec(TEAM_PAY_SQL);
  const post = await snapshot(before);
  for (const role of ROLES) {
    const { modules, ...rest } = post[role].context;
    check(`migration: ${role} access context unchanged`, JSON.stringify(rest) === JSON.stringify(pre[role].context), { pre: pre[role].context, post: rest });
    check(`migration: ${role} lists every module`, JSON.stringify(modules) === JSON.stringify([...MODULE_IDS].sort()), modules);
    check(`migration: ${role} has_permission unchanged for every key and channel`,
      JSON.stringify(post[role].granted) === JSON.stringify(pre[role].granted),
      { lost: pre[role].granted.filter((g) => !post[role].granted.includes(g)), gained: post[role].granted.filter((g) => !pre[role].granted.includes(g)) });
  }
  const setup = (await before.query<{ done: boolean }>('SELECT setup_completed_at IS NOT NULL AS done FROM public.business_settings')).rows[0];
  check('migration: an existing install counts as set up', setup.done);
  await before.close();

  // --- The Team pay migration on the release before it changes nothing -------------------
  const prePay = await createFullSchemaDatabase({ schemaSql: schemaBefore(TEAM_PAY_MIGRATION, 'HEAD') });
  await seedMembers(prePay);
  const payPre = await snapshot(prePay);
  await asOwnerOfDatabase(prePay);
  await prePay.exec(TEAM_PAY_SQL);
  await prePay.exec(TEAM_PAY_SQL);
  const payPost = await snapshot(prePay);
  for (const role of ROLES) {
    const { modules, ...rest } = payPost[role].context;
    const { modules: modulesBefore, ...restBefore } = payPre[role].context;
    check(`team pay migration: ${role} access context unchanged`, JSON.stringify(rest) === JSON.stringify(restBefore), { pre: restBefore, post: rest });
    check(`team pay migration: ${role} gains Team pay in its module list`,
      Array.isArray(modules) && (modules as string[]).includes('team_pay') && !(modulesBefore as string[]).includes('team_pay'), modules);
    check(`team pay migration: ${role} has_permission unchanged for every key and channel`,
      JSON.stringify(payPost[role].granted) === JSON.stringify(payPre[role].granted),
      { lost: payPre[role].granted.filter((g) => !payPost[role].granted.includes(g)), gained: payPost[role].granted.filter((g) => !payPre[role].granted.includes(g)) });
  }
  await asOwnerOfDatabase(prePay);
  const movedKeys = (await prePay.query<{ permission_key: string; module_id: string }>(
    'SELECT permission_key, module_id FROM public.permission_modules WHERE permission_key = ANY($1) ORDER BY 1', [PAY_KEYS])).rows;
  check('team pay migration: the three pay permissions are Team pay\'s', movedKeys.length === 3 && movedKeys.every((r) => r.module_id === 'team_pay'), movedKeys);
  const stayKeys = (await prePay.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM public.permission_modules WHERE module_id = 'billing'")).rows[0].n;
  check('team pay migration: Client invoicing keeps its five', stayKeys === 5, stayKeys);
  // An Owner who switched Team pay off keeps that through a re-run.
  await prePay.query("UPDATE public.workspace_modules SET enabled = false WHERE module_id = 'team_pay'");
  await prePay.exec(TEAM_PAY_SQL);
  const kept = (await prePay.query<{ enabled: boolean }>("SELECT enabled FROM public.workspace_modules WHERE module_id = 'team_pay'")).rows[0];
  check('team pay migration: a re-run keeps an Owner\'s switch', kept?.enabled === false, kept);
  await prePay.close();

  // A workspace that had Billing off had no pay: Team pay arrives off, so nothing it did changes.
  const billingOff = await createFullSchemaDatabase({ schemaSql: schemaBefore(TEAM_PAY_MIGRATION, 'HEAD') });
  await asOwnerOfDatabase(billingOff);
  await billingOff.query("UPDATE public.workspace_modules SET enabled = false WHERE module_id IN ('billing', 'webhooks')");
  await billingOff.exec(TEAM_PAY_SQL);
  const arrived = (await billingOff.query<{ enabled: boolean }>("SELECT enabled FROM public.workspace_modules WHERE module_id = 'team_pay'")).rows[0];
  check('team pay migration: with Billing off, Team pay arrives off', arrived?.enabled === false, arrived);
  await billingOff.close();

  // --- schema.sql (a fresh install) ------------------------------------------------------
  const db = await createFullSchemaDatabase();
  await seedMembers(db);
  const fresh = (await db.query<{ done: boolean }>('SELECT setup_completed_at IS NOT NULL AS done FROM pm.business_settings')).rows[0];
  check('fresh install: setup not done yet', !fresh.done);

  const seeded = (await db.query<{ permission_key: string; module_id: string }>('SELECT permission_key, module_id FROM pm.permission_modules ORDER BY 1')).rows;
  const expected = (Object.entries(PERMISSION_MODULE) as Array<[PermissionKey, string]>).filter(([, m]) => m !== 'core').sort(([a], [b]) => (a < b ? -1 : 1));
  check('seed: permission_modules matches the registry', JSON.stringify(seeded.map((r) => [r.permission_key, r.module_id])) === JSON.stringify(expected),
    { onlySql: seeded.filter((r) => PERMISSION_MODULE[r.permission_key as PermissionKey] !== r.module_id), onlyRegistry: expected.filter(([k]) => !seeded.some((r) => r.permission_key === k)) });
  const mods = (await db.query<{ module_id: string; enabled: boolean }>('SELECT module_id, enabled FROM pm.workspace_modules ORDER BY 1')).rows;
  check('seed: one row per module, all on', JSON.stringify(mods.map((r) => r.module_id)) === JSON.stringify([...MODULE_IDS].sort()) && mods.every((r) => r.enabled), mods);
  check('seed: Team pay has its row and its three permissions',
    mods.some((r) => r.module_id === 'team_pay') && PAY_KEYS.every((key) => seeded.some((r) => r.permission_key === key && r.module_id === 'team_pay')));
  const roleKeys = (await db.query<{ permission_key: string }>('SELECT DISTINCT permission_key FROM pm.role_permissions')).rows;
  check('seed: every permission a role holds is a known key', roleKeys.every((r) => (PERMISSIONS as readonly string[]).includes(r.permission_key)),
    roleKeys.filter((r) => !(PERMISSIONS as readonly string[]).includes(r.permission_key)));

  const fullOn = await snapshot(db);
  for (const role of ROLES) {
    const app = appAccess(fullOn[role].context, [...MODULE_IDS]);
    const sqlApp = fullOn[role].granted.filter((g) => g.startsWith('app:')).map((g) => g.slice(4));
    const tsApp = PERMISSIONS.filter((key) => hasPermission(app, key));
    check(`agree: ${role} app grants match between SQL and the app`, JSON.stringify(sqlApp) === JSON.stringify(tsApp), { sqlApp, tsApp });
  }

  // --- Billing off: nobody holds it, owners included --------------------------------------
  await setModule(db, 'billing', false);
  const offBilling = await snapshot(db);
  for (const role of ROLES) {
    const billingKeys = offBilling[role].granted.filter((g) => PERMISSION_MODULE[g.split(':')[1] as PermissionKey] === 'billing');
    check(`billing off: ${role} holds no billing permission in SQL`, billingKeys.length === 0, billingKeys);
    const coreKept = fullOn[role].granted.filter((g) => PERMISSION_MODULE[g.split(':')[1] as PermissionKey] !== 'billing');
    check(`billing off: ${role} keeps everything else`, coreKept.every((g) => offBilling[role].granted.includes(g)));
    const ctx = offBilling[role].context as { modules: string[]; app_permissions: string[] };
    check(`billing off: ${role} context lists billing as off`, !ctx.modules.includes('billing'));
    check(`billing off: ${role} context drops billing keys`, role === 'owner' ? ctx.app_permissions[0] === '*' : !ctx.app_permissions.some((k) => PERMISSION_MODULE[k as PermissionKey] === 'billing'));
    const app = appAccess(offBilling[role].context, ctx.modules as ModuleId[]);
    const sqlApp = offBilling[role].granted.filter((g) => g.startsWith('app:')).map((g) => g.slice(4));
    const tsApp = PERMISSIONS.filter((key) => hasPermission(app, key));
    check(`agree: ${role} app grants match with Billing off`, JSON.stringify(sqlApp) === JSON.stringify(tsApp), { sqlApp, tsApp });
  }
  await actAs(db, null);
  check('module_enabled: reads the switch', (await db.query<{ a: boolean; b: boolean; c: boolean }>(
    "SELECT pm.module_enabled('billing') AS a, pm.module_enabled('time') AS b, pm.module_enabled('not-a-module') AS c")).rows
    .every((r) => r.a === false && r.b === true && r.c === true));
  await setModule(db, 'billing', true);

  // --- Team pay off: pay goes, invoicing stays --------------------------------------------
  await setModule(db, 'team_pay', false);
  const offPay = await snapshot(db);
  for (const role of ROLES) {
    const payKeys = offPay[role].granted.filter((g) => PERMISSION_MODULE[g.split(':')[1] as PermissionKey] === 'team_pay');
    check(`team pay off: ${role} holds no pay permission in SQL`, payKeys.length === 0, payKeys);
    const rest = fullOn[role].granted.filter((g) => PERMISSION_MODULE[g.split(':')[1] as PermissionKey] !== 'team_pay');
    check(`team pay off: ${role} keeps everything else, invoices included`, rest.every((g) => offPay[role].granted.includes(g)),
      rest.filter((g) => !offPay[role].granted.includes(g)));
    const ctx = offPay[role].context as { modules: string[] };
    const app = appAccess(offPay[role].context, ctx.modules as ModuleId[]);
    const sqlApp = offPay[role].granted.filter((g) => g.startsWith('app:')).map((g) => g.slice(4));
    const tsApp = PERMISSIONS.filter((key) => hasPermission(app, key));
    check(`agree: ${role} app grants match with Team pay off`, JSON.stringify(sqlApp) === JSON.stringify(tsApp), { sqlApp, tsApp });
  }
  check('team pay off: the owner still reads company finance', offPay.owner.granted.includes('app:finance.company.read'));
  await setModule(db, 'team_pay', true);

  // --- Rows follow the switch through RLS -------------------------------------------------
  await asOwnerOfDatabase(db);
  await db.query("INSERT INTO pm.leads (name) VALUES ('Acme Co')");
  const leadsSeen = async (role: Role) => {
    await actAs(db, USERS[role]);
    const n = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM pm.leads')).rows[0].n;
    await actAs(db, null);
    return n;
  };
  check('rls: owner and admin see the lead with Leads on', (await leadsSeen('owner')) === 1 && (await leadsSeen('admin')) === 1);
  await setModule(db, 'sales', false);
  check('rls: nobody sees the lead with Leads off', (await leadsSeen('owner')) === 0 && (await leadsSeen('admin')) === 0);
  await actAs(db, USERS.owner);
  let insertRefused = false;
  try {
    await db.query("INSERT INTO pm.leads (name) VALUES ('Sneaky')");
  } catch {
    insertRefused = true;
  }
  check('rls: an owner cannot add a lead with Leads off', insertRefused);
  await setModule(db, 'sales', true);
  check('rls: the lead is back with Leads on, nothing deleted', (await leadsSeen('owner')) === 1);

  // --- Nobody switches modules through the API --------------------------------------------
  for (const role of ['owner', 'admin'] as const) {
    await actAs(db, USERS[role]);
    let refused = false;
    try {
      await db.query("UPDATE pm.workspace_modules SET enabled = false WHERE module_id = 'billing'");
    } catch {
      refused = true;
    }
    check(`writes: ${role} cannot switch a module directly`, refused);
  }
  await actAs(db, USERS.member);
  const visible = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM pm.workspace_modules')).rows[0].n;
  check('reads: any member can see which modules are on', visible === MODULE_IDS.length);
  await actAs(db, null);

  console.log(`${passed} checks passed`);
  if (failures.length) {
    console.error(`${failures.length} failed:\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
