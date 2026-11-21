/**
 * First-run setup rules (lib/setup/gate.ts and lib/setup/checks.ts), pure:
 * - who the shell sends to the setup wizard, and who it sends away from it;
 * - the wizard's steps for the switched-on modules;
 * - what the Dashboard's Getting started list still shows;
 * - the setup check reports set or not per variable, never a value.
 *
 *   npm run -s test:setup-gate
 */
import { AFTER_SETUP_PATH, WELCOME_PATH, gettingStartedLeft, setupPending, setupRedirect, wizardSteps } from '../src/lib/setup/gate';
import { envChecks } from '../src/lib/setup/checks';
import { MODULE_IDS } from '../src/lib/modules/registry';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

const gate = (role: string, setupCompleted: boolean | undefined, pathname = '/dashboard', demo = false) =>
  setupRedirect({ role, setupCompleted, pathname, demo });

// ---- Who goes to the wizard ------------------------------------------------
check('an Owner with setup not done goes to the wizard', gate('owner', false) === WELCOME_PATH, gate('owner', false));
check('from any page, a task link included', gate('owner', false, '/projects/abc/tasks/1') === WELCOME_PATH);
check('an Owner already on the wizard stays', gate('owner', false, WELCOME_PATH) === null);
for (const role of ['admin', 'member', 'guest', 'agent']) {
  check(`${role}: never sent to the wizard`, gate(role, false) === null, gate(role, false));
  check(`${role}: sent away from the wizard`, gate(role, false, WELCOME_PATH) === AFTER_SETUP_PATH);
}
check('after setup, an Owner is not sent to the wizard', gate('owner', true) === null);
check('after setup, the wizard sends an Owner to the Dashboard', gate('owner', true, WELCOME_PATH) === AFTER_SETUP_PATH);
check('the demo workspace never shows the wizard', gate('owner', false, '/dashboard', true) === null && gate('owner', false, WELCOME_PATH, true) === AFTER_SETUP_PATH);
check('while the state loads, an Owner is not moved', gate('owner', undefined) === null && gate('owner', undefined, WELCOME_PATH) === null);
check('the set-password page is not the wizard', gate('member', false, '/welcome/set-password') === null);

const pv = (role: string, setupCompleted: boolean | undefined, demo = false) =>
  setupRedirect({ role, setupCompleted, pathname: WELCOME_PATH, demo, preview: true });
check('preview: an Owner after setup stays on the wizard', pv('owner', true) === null, pv('owner', true));
for (const role of ['admin', 'member', 'guest', 'agent']) {
  check(`preview: ${role} is still sent away`, pv(role, true) === AFTER_SETUP_PATH, pv(role, true));
}
check('preview: before setup it is just the wizard', pv('owner', false) === null);
check('preview: never in the demo workspace', pv('owner', true, true) === AFTER_SETUP_PATH, pv('owner', true, true));
check('preview: elsewhere in the app it changes nothing', setupRedirect({ role: 'owner', setupCompleted: true, pathname: '/dashboard', demo: false, preview: true }) === null);
check('steps: your account comes first', wizardSteps()[0] === 'account');

check('pending: an Owner waits for the state', setupPending({ role: 'owner', setupCompleted: undefined, demo: false }));
check('pending: not once it is known', !setupPending({ role: 'owner', setupCompleted: false, demo: false }));
check('pending: nobody else waits', !setupPending({ role: 'member', setupCompleted: undefined, demo: false }));
check('pending: not in the demo workspace', !setupPending({ role: 'owner', setupCompleted: undefined, demo: true }));

// ---- The wizard's steps ----------------------------------------------------
const all = wizardSteps(MODULE_IDS);
check('steps: Billing details with Client invoicing on', JSON.stringify(all) === JSON.stringify(['account', 'workspace', 'usage', 'billing', 'email', 'team', 'projects', 'done']), all);
const noBilling = wizardSteps(['time', 'inbox']);
check('steps: no Billing details with Client invoicing off', !noBilling.includes('billing') && noBilling.length === 7, noBilling);

// ---- Getting started ---------------------------------------------------------
const nothingDone = { brandSet: false, teamInvited: false, hasProject: false, billingOn: true, billingDetailsSet: false };
check('getting started: everything left, in order', JSON.stringify(gettingStartedLeft(nothingDone)) === JSON.stringify(['brand', 'team', 'project', 'billing']));
check('getting started: billing only with Client invoicing on', !gettingStartedLeft({ ...nothingDone, billingOn: false }).includes('billing'));
check('getting started: done items leave', JSON.stringify(gettingStartedLeft({ ...nothingDone, brandSet: true, hasProject: true })) === JSON.stringify(['team', 'billing']));
check('getting started: nothing left when all done', gettingStartedLeft({ brandSet: true, teamInvited: true, hasProject: true, billingOn: true, billingDetailsSet: true }).length === 0);

// ---- Setup check: set or not, never a value ---------------------------------
const secret = 'super-secret-value-123';
const report = envChecks({ NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: secret, NEXT_PUBLIC_APP_URL: '   ' }, { crons: true });
check('env: no value appears anywhere in the report', !JSON.stringify(report).includes(secret) && !JSON.stringify(report).includes('supabase.co'));
check('env: a set variable reads true', report.find((item) => item.name === 'SUPABASE_SERVICE_ROLE_KEY')?.set === true);
check('env: a missing variable reads false', report.find((item) => item.name === 'NEXT_PUBLIC_APP_URL')?.set === false);
check('env: a blank variable counts as not set', report.find((item) => item.name === 'NEXT_PUBLIC_APP_URL')?.set === false);
check('env: CRON_SECRET is checked when crons exist', report.some((item) => item.name === 'CRON_SECRET'));
check('env: and left out when there are none', !envChecks({}, { crons: false }).some((item) => item.name === 'CRON_SECRET'));
check('env: every asked-for variable is checked', ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'APP_ENCRYPTION_KEY', 'NEXT_PUBLIC_APP_URL']
  .every((name) => report.some((item) => item.name === name)));
check('env: each entry is name, set, required and purpose only', report.every((item) => JSON.stringify(Object.keys(item).sort()) === JSON.stringify(['name', 'purpose', 'required', 'set'])));

if (failures.length) {
  console.error(`setup gate: ${passed} passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`setup gate: ${passed} checks passed`);
