/**
 * Extensions: the plug-in points an install fills from src/custom.
 *
 * - The registry refuses duplicate slugs and keys with a line naming them.
 * - API routes are session routes unless they say otherwise; public only when
 *   written out; a route's auth runs before its handler, every time.
 * - Module, permission and role filtering hide what a member may not see.
 * - The brand is not in code: the old site config and core's logo files are
 *   gone, and no core file reaches for them.
 * - The Next config merge joins arrays and runs both redirect lists.
 * - The custom migration example passes check:core's SQL rule.
 *
 *   npm run -s test:extensions
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import type { AccessContext, PermissionKey } from '../src/lib/access-control';
import { MODULE_IDS } from '../src/lib/modules/registry';
import {
  ExtensionError,
  defineApiRoutes,
  defineExtensions,
  definePublicPaths,
  extensionAllowed,
  matchPage,
  matchesPublicPath,
  placeNavItems,
  settingsSectionAllowed,
  visibleNavItems,
} from '../src/lib/extensions/registry';
import { dispatchApiRoute, type ApiDispatchDeps } from '../src/lib/extensions/api';
import { mergeNextConfig } from '../src/lib/extensions/next-config';
import type { ApiRouteExtension, ExtensionsInput } from '../src/lib/extensions/types';
import customApi from '../src/custom/api';
import customExtensions from '../src/custom';
import customPublicPaths from '../src/custom/middleware';
import { checkCustomSql } from './lib/custom-sql';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

/** The message a call throws, or null when it does not. */
function thrown(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof ExtensionError ? error.message : `not an ExtensionError: ${String(error)}`;
  }
}

const Noop = () => null;
const Icon = Noop as unknown as NonNullable<ExtensionsInput['navItems']>[number]['icon'];

function access(role: AccessContext['role'], permissions: PermissionKey[], modules = [...MODULE_IDS]): AccessContext {
  return {
    member_id: 'm1',
    role,
    status: 'active',
    app_permissions: permissions,
    api_permissions: [],
    project_ids: [],
    modules,
  };
}

/**
 * Valiance's monorepo, where the core is built and src/custom ships as empty
 * stubs. In an install those files hold the install's own code, so the checks
 * about the stubs and the default brand run only here.
 */
const IS_SOURCE = existsSync(join(__dirname, '..', '..', 'app', 'package.json'))
  && existsSync(join(__dirname, '..', '..', 'admin', 'package.json'));

function registry() {
  if (IS_SOURCE) {
    check('stubs: src/custom/index.ts is an empty registry', Object.values(customExtensions).every((list) => list.length === 0));
    check('stubs: src/custom/api.ts has no routes', customApi.length === 0);
    check('stubs: src/custom/middleware.ts opens no paths', customPublicPaths.length === 0);
  }

  const dupSlug = thrown(() => defineExtensions({
    pages: [
      { slug: 'reports', title: 'A', component: Noop },
      { slug: '/Reports/', title: 'B', component: Noop },
    ],
  }));
  check('registry: duplicate page slugs are refused by name', !!dupSlug && dupSlug.includes('slug "reports"'), dupSlug);
  const dupTab = thrown(() => defineExtensions({
    projectTabs: [{ key: 'score', label: 'A', component: Noop }, { key: 'score', label: 'B', component: Noop }],
  }));
  check('registry: duplicate project tab keys are refused', !!dupTab && dupTab.includes('key "score"'), dupTab);
  const dupWidget = thrown(() => defineExtensions({
    dashboardWidgets: [{ key: 'w', title: 'A', component: Noop }, { key: 'w', title: 'B', component: Noop }],
  }));
  check('registry: duplicate widget keys are refused', !!dupWidget && dupWidget.includes('key "w"'), dupWidget);
  const dupSection = thrown(() => defineExtensions({
    settingsSections: [{ key: 'crm', label: 'A', icon: Icon, component: Noop }, { key: 'crm', label: 'B', icon: Icon, component: Noop }],
  }));
  check('registry: duplicate settings keys are refused', !!dupSection && dupSection.includes('key "crm"'), dupSection);
  const dupNav = thrown(() => defineExtensions({
    navItems: [{ href: '/x/a', label: 'A', icon: Icon }, { href: '/x/a', label: 'B', icon: Icon }],
  }));
  check('registry: duplicate nav hrefs are refused', !!dupNav && dupNav.includes('href "/x/a"'), dupNav);
  check('registry: a slug with a space is refused', !!thrown(() => defineExtensions({ pages: [{ slug: 'my page', title: 'A', component: Noop }] })));
  check('registry: an unknown module is refused', !!thrown(() => defineExtensions({
    projectTabs: [{ key: 'a', label: 'A', component: Noop, module: 'nope' as never }],
  })));
  check('registry: an unknown permission is refused', !!thrown(() => defineExtensions({
    navItems: [{ href: '/x/a', label: 'A', icon: Icon, permission: 'projects.everything' as never }],
  })));
  check('registry: an external nav href is refused', !!thrown(() => defineExtensions({
    navItems: [{ href: '//evil.example', label: 'A', icon: Icon }],
  })));

  const ok = defineExtensions({ pages: [{ slug: '/reports/', title: 'Reports', component: Noop }] });
  check('registry: slugs are normalized', ok.pages[0].slug === 'reports');
  check('registry: lists left out come back empty', ok.navItems.length === 0 && ok.settingsSections.length === 0);
}

function filtering() {
  const owner = access('owner', ['projects.read_all']);
  const member = access('member', ['projects.read']);
  const billingOff = access('owner', ['projects.read_all'], MODULE_IDS.filter((id) => id !== 'billing'));

  check('filter: no rule shows to everyone', extensionAllowed(member, {}));
  check('filter: module on shows', extensionAllowed(owner, { module: 'billing' }));
  check('filter: module off hides, owners included', !extensionAllowed(billingOff, { module: 'billing' }));
  check('filter: permission held shows', extensionAllowed(owner, { permission: 'projects.read_all' }));
  check('filter: permission missing hides', !extensionAllowed(member, { permission: 'projects.read_all' }));
  check('filter: role listed shows', extensionAllowed(owner, { roles: ['owner', 'admin'] }));
  check('filter: role not listed hides', !extensionAllowed(member, { roles: ['owner', 'admin'] }));
  check('filter: a role rule hides from a signed-out viewer', !extensionAllowed(null, { roles: ['member'] }));
  check('filter: settings sections are Owners only by default', settingsSectionAllowed(owner, {}) && !settingsSectionAllowed(member, {}));
  check('filter: a settings section opens wider with a permission', settingsSectionAllowed(member, { permission: 'projects.read' }));

  const ext = defineExtensions({
    pages: [
      { slug: 'reports', title: 'Reports', component: Noop, permission: 'projects.read_all' },
      { slug: 'reports/weekly', title: 'Weekly', component: Noop },
    ],
    navItems: [
      { href: '/x/reports', label: 'Reports', icon: Icon },
      { href: '/x/reports/weekly', label: 'Weekly', icon: Icon, after: '/projects' },
      { href: '/x/billing', label: 'Billing', icon: Icon, module: 'billing' },
    ],
  });
  const forMember = visibleNavItems(member, ext).map((item) => item.href);
  check('filter: a nav item to a page the member cannot see is hidden', !forMember.includes('/x/reports'), forMember);
  check('filter: a nav item to a page the member can see shows', forMember.includes('/x/reports/weekly'), forMember);
  check('filter: a nav item of a module that is off is hidden', !visibleNavItems(billingOff, ext).some((item) => item.href === '/x/billing'));

  const match = matchPage(ext.pages, ['reports', 'weekly', '2026']);
  check('pages: the longest slug wins, the rest is passed on', match?.page.slug === 'reports/weekly' && match.rest.join('/') === '2026', match?.rest);
  check('pages: an unknown slug matches nothing', matchPage(ext.pages, ['nope']) === null);

  const placed = placeNavItems(
    [{ href: '/dashboard' }, { href: '/projects' }, { href: '/team' }],
    [{ href: '/x/end' }, { href: '/x/mid', after: '/projects' }, { href: '/x/lost', after: '/leads' }, { href: '/team' }],
  ).map((item) => item.href);
  check('nav: custom entries sit after their anchor or at the end; a core href is not repeated',
    placed.join(' ') === '/dashboard /projects /x/mid /team /x/end /x/lost', placed);
}

async function apiRoutes() {
  const handler = async () => new Response('ok');
  const [sessionRoute] = defineApiRoutes([{ path: 'a', method: 'GET', handler }]);
  check('api: a route without auth is a session route', sessionRoute.auth === 'session');
  const [publicRoute] = defineApiRoutes([{ path: 'b', method: 'GET', auth: 'public', handler }]);
  check('api: public only when written out', publicRoute.auth === 'public');
  check('api: an unknown auth value is refused, never public', !!thrown(() => defineApiRoutes([
    { path: 'a', method: 'GET', auth: 'none', handler } as unknown as ApiRouteExtension,
  ])));
  check('api: an api-key route needs a permission', !!thrown(() => defineApiRoutes([
    { path: 'a', method: 'GET', auth: 'api-key', handler } as unknown as ApiRouteExtension,
  ])));
  check('api: a public route cannot take a permission', !!thrown(() => defineApiRoutes([
    { path: 'a', method: 'GET', auth: 'public', permission: 'projects.read', handler } as unknown as ApiRouteExtension,
  ])));
  const dup = thrown(() => defineApiRoutes([
    { path: 'clients/:id', method: 'GET', handler },
    { path: 'clients/:slug', method: 'GET', handler },
  ]));
  check('api: two routes answering the same addresses are refused', !!dup && dup.includes('method and path'), dup);
  check('api: the same path with another method is fine', !thrown(() => defineApiRoutes([
    { path: 'clients/:id', method: 'GET', handler },
    { path: 'clients/:id', method: 'DELETE', handler },
  ])));

  const calls: string[] = [];
  const ran: Record<string, unknown> = {};
  const routes = defineApiRoutes([
    // No auth written: must still ask for a session.
    { path: 'reports/:id', method: 'GET', handler: async ({ params, session }) => { ran.session = { params, member: session.memberId }; return new Response('session'); } },
    { path: 'billing', method: 'GET', module: 'billing', handler: async () => { ran.billing = true; return new Response('billing'); } },
    { path: 'keys', method: 'POST', auth: 'api-key', permission: 'projects.manage', handler: async ({ api }) => { ran.key = api.teamMemberId; return new Response('key'); } },
    { path: 'hook', method: 'POST', auth: 'public', handler: async () => { ran.hook = true; return new Response('hook'); } },
  ]);
  let signedIn: AccessContext | null = null;
  const deps: ApiDispatchDeps = {
    requireSession: async (permission) => {
      calls.push(`session:${permission ?? ''}`);
      if (!signedIn) return { data: null, error: Response.json({ error: 'Unauthorized' }, { status: 401 }) };
      return { data: { memberId: 'm1', access: signedIn } as never, error: null };
    },
    withApiKey: async (_request, permission, run) => {
      calls.push(`key:${permission}`);
      return run({ teamMemberId: 'm2', access: access('agent', ['projects.manage']) } as never);
    },
    moduleEnabled: async () => true,
  };
  const call = (method: string, path: string) => dispatchApiRoute(new NextRequest(`http://localhost/api/x/${path}`, { method }), path.split('/'), routes, deps);

  let res = await call('GET', 'reports/42');
  check('api: a session route without a session gets the session refusal', res.status === 401 && !ran.session, res.status);
  check('api: the session check ran', calls.includes('session:'), calls);
  signedIn = access('member', ['projects.read']);
  res = await call('GET', 'reports/42');
  check('api: a session route with a session reaches its handler with params', res.status === 200
    && JSON.stringify(ran.session) === JSON.stringify({ params: { id: '42' }, member: 'm1' }), ran.session);

  signedIn = access('owner', [], MODULE_IDS.filter((id) => id !== 'billing'));
  res = await call('GET', 'billing');
  const body = await res.json().catch(() => ({})) as { error?: { code?: string } };
  check('api: a route of a switched-off module answers MODULE_OFF', res.status === 403 && body.error?.code === 'MODULE_OFF' && !ran.billing, body);

  calls.length = 0;
  res = await call('POST', 'keys');
  check('api: an api-key route goes through the key check with its permission', res.status === 200 && calls.join() === 'key:projects.manage' && ran.key === 'm2', calls);
  calls.length = 0;
  res = await call('POST', 'hook');
  check('api: a public route asks for nothing', res.status === 200 && calls.length === 0 && ran.hook === true, calls);

  res = await call('GET', 'nope');
  const missing = await res.json() as { success: boolean; error: { code: string } };
  check('api: an unknown path is a 404 in the API envelope', res.status === 404 && missing.success === false && missing.error.code === 'not_found', missing);
  res = await call('DELETE', 'hook');
  check('api: a known path with another method is a 405 naming the allowed ones', res.status === 405 && res.headers.get('Allow') === 'POST', res.status);
}

/** Every file under a folder, skipping the ones `skip` names. */
function filesUnder(dir: string, skip: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (skip(path)) continue;
    if (entry.isDirectory()) out.push(...filesUnder(path, skip));
    else if (/\.(ts|tsx|mjs|css|json|webmanifest)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/**
 * The brand lives in the database now (Settings > Workspace > Brand), so the
 * old code config and core's own logo files are gone, and no core file may
 * reach for them again.
 */
function brandNotInCode() {
  const app = join(__dirname, '..');
  for (const gone of ['src/site-config.ts', 'src/custom/site-config.ts', 'src/lib/extensions/site-config.ts', 'public/logos', 'public/favicon']) {
    check(`brand: ${gone} is gone`, !existsSync(join(app, gone)));
  }
  const custom = join(app, 'src', 'custom');
  const core = filesUnder(join(app, 'src'), (path) => path === custom);
  const oldModule = /from\s+['"][^'"]*\bsite-config['"]|\b(define|merge)SiteConfig\b|\bsiteConfig\.|['"`(]\/(logos|favicon)\//;
  const offenders = core.filter((path) => oldModule.test(readFileSync(path, 'utf8'))).map((path) => path.slice(app.length + 1));
  check('brand: no core file uses the old site config or core logo files', core.length > 100 && offenders.length === 0, offenders);
  check('brand: extensions no longer export defineSiteConfig', !readFileSync(join(app, 'src/lib/extensions/index.ts'), 'utf8').includes('SiteConfig'));
}

async function nextConfigMerge() {
  const merged = mergeNextConfig(
    {
      allowedDevOrigins: ['127.0.0.1'],
      images: { remotePatterns: [{ protocol: 'https', hostname: 'core.example' }], unoptimized: false },
      async redirects() { return [{ source: '/command', destination: '/agent/live', permanent: true }]; },
    },
    {
      allowedDevOrigins: ['127.0.0.1', 'box.local'],
      images: { remotePatterns: [{ protocol: 'https', hostname: 'cdn.example' }] },
      async redirects() { return [{ source: '/old', destination: '/x/new', permanent: false }]; },
      poweredByHeader: false,
    },
  );
  check('next: arrays join without duplicates', merged.allowedDevOrigins?.join() === '127.0.0.1,box.local', merged.allowedDevOrigins);
  check('next: remotePatterns add to core\'s', merged.images?.remotePatterns?.length === 2 && merged.images.unoptimized === false, merged.images);
  const redirects = await merged.redirects!();
  check('next: both redirect lists run, core first', redirects.map((r) => r.source).join() === '/command,/old', redirects);
  check('next: other keys are the install\'s', merged.poweredByHeader === false);
  check('next: an empty custom config changes nothing', mergeNextConfig({ poweredByHeader: true }, {}).poweredByHeader === true);
}

function publicPaths() {
  check('public: "/" is refused', !!thrown(() => definePublicPaths(['/'])));
  check('public: a wildcard is refused', !!thrown(() => definePublicPaths(['/book/*'])));
  const paths = definePublicPaths(['/book/']);
  check('public: a path covers itself and what is under it', matchesPublicPath(paths, '/book') && matchesPublicPath(paths, '/book/call'));
  check('public: a path does not cover a longer name', !matchesPublicPath(paths, '/bookings'));
}

function customSqlExample() {
  const readme = readFileSync(join(__dirname, '..', 'supabase', 'migrations', 'custom', 'README.md'), 'utf8');
  const sql = readme.match(/```sql\r?\n([\s\S]*?)```/)?.[1] ?? '';
  check('sql: the README has an example', sql.includes('create table custom.'));
  const violations = checkCustomSql(sql);
  check('sql: the example passes check:core\'s custom schema rule', violations.length === 0, violations);
}

async function main() {
  registry();
  filtering();
  await apiRoutes();
  brandNotInCode();
  await nextConfigMerge();
  publicPaths();
  customSqlExample();

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
