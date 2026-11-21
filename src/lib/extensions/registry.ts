import {
  PERMISSIONS,
  TEAM_ROLES,
  hasPermission,
  isModuleEnabled,
  type AccessContext,
} from '@/lib/access-control';
import { isModuleId } from '@/lib/modules/registry';
import {
  API_METHODS,
  API_ROUTE_AUTH,
  type ApiMethod,
  type ApiRouteExtension,
  type ExtensionAccess,
  type Extensions,
  type ExtensionsInput,
  type NavItemExtension,
  type PageExtension,
  type ResolvedApiRoute,
} from './types';

/**
 * Validation and lookups for the install's extensions. Pure: the browser, the
 * server, the edge middleware and the tests all read the same rules.
 *
 * A mistake throws when the file loads, with a line that names the fix, so a
 * broken extension stops the dev server and the build instead of shipping.
 */

export class ExtensionError extends Error {
  constructor(message: string) {
    super(`Extensions: ${message}`);
    this.name = 'ExtensionError';
  }
}

const SEGMENT = /^[a-z0-9][a-z0-9-]*$/i;
const KEY = /^[a-z0-9][a-z0-9-]*$/;

function fail(message: string): never {
  throw new ExtensionError(message);
}

function checkAccess(where: string, item: ExtensionAccess) {
  if (item.module !== undefined && !isModuleId(item.module)) fail(`${where}: unknown module "${item.module}".`);
  if (item.permission !== undefined && !(PERMISSIONS as readonly string[]).includes(item.permission)) {
    fail(`${where}: unknown permission "${item.permission}".`);
  }
  for (const role of item.roles ?? []) {
    if (!(TEAM_ROLES as readonly string[]).includes(role)) fail(`${where}: unknown role "${role}".`);
  }
}

function unique<T>(list: readonly T[], keyOf: (item: T) => string, what: string, field: string) {
  const seen = new Set<string>();
  for (const item of list) {
    const key = keyOf(item);
    if (seen.has(key)) fail(`two ${what} use the ${field} "${key}". Each ${field} must be unique.`);
    seen.add(key);
  }
}

function checkKeys(list: readonly { key: string }[], what: string) {
  for (const item of list) {
    if (!KEY.test(item.key ?? '')) fail(`${what} key "${item.key}" must be lowercase letters, numbers and dashes.`);
  }
  unique(list, (item) => item.key, what, 'key');
}

/** 'reports/' or '/reports' read as 'reports'. */
export function normalizeSlug(slug: string): string {
  return slug.trim().replace(/^\/+|\/+$/g, '');
}

/** Validates the install's UI extensions and returns the registry core reads. */
export function defineExtensions(input: ExtensionsInput = {}): Extensions {
  const navItems = input.navItems ?? [];
  const pages = (input.pages ?? []).map((page) => ({ ...page, slug: normalizeSlug(page.slug ?? '') }));
  const projectTabs = input.projectTabs ?? [];
  const dashboardWidgets = input.dashboardWidgets ?? [];
  const settingsSections = input.settingsSections ?? [];

  for (const item of navItems) {
    if (!item.href?.startsWith('/') || item.href.startsWith('//')) fail(`nav item "${item.label}" needs an in-app href starting with /.`);
    if (!item.label) fail(`nav item ${item.href} needs a label.`);
    checkAccess(`nav item ${item.href}`, item);
  }
  unique(navItems, (item) => item.href, 'nav items', 'href');

  for (const page of pages) {
    if (!page.slug || !page.slug.split('/').every((s) => SEGMENT.test(s))) {
      fail(`page slug "${page.slug}" must be letters, numbers and dashes, with / between segments.`);
    }
    if (!page.title) fail(`page /x/${page.slug} needs a title.`);
    checkAccess(`page /x/${page.slug}`, page);
  }
  unique(pages, (page) => page.slug.toLowerCase(), 'pages', 'slug');

  checkKeys(projectTabs, 'project tabs');
  projectTabs.forEach((tab) => checkAccess(`project tab ${tab.key}`, tab));
  checkKeys(dashboardWidgets, 'dashboard widgets');
  dashboardWidgets.forEach((widget) => {
    if (widget.placement && !['top', 'bottom'].includes(widget.placement)) fail(`dashboard widget ${widget.key}: placement is 'top' or 'bottom'.`);
    checkAccess(`dashboard widget ${widget.key}`, widget);
  });
  checkKeys(settingsSections, 'settings sections');
  settingsSections.forEach((section) => checkAccess(`settings section ${section.key}`, section));

  return Object.freeze({ navItems, pages, projectTabs, dashboardWidgets, settingsSections });
}

// ---------------------------------------------------------------------------
// Who sees what
// ---------------------------------------------------------------------------

/** Whether this member may see an extension: its module on, its permission held, its role listed. */
export function extensionAllowed(access: AccessContext | null | undefined, item: ExtensionAccess): boolean {
  if (item.module && !isModuleEnabled(access, item.module)) return false;
  if (item.permission && !hasPermission(access, item.permission)) return false;
  if (item.roles && !(access && item.roles.includes(access.role))) return false;
  return true;
}

/** Settings sections are Owners only until the install opens them with `roles` or `permission`. */
export function settingsSectionAllowed(access: AccessContext | null | undefined, item: ExtensionAccess): boolean {
  const rule = item.roles || item.permission ? item : { ...item, roles: ['owner' as const] };
  return extensionAllowed(access, rule);
}

export function visibleTo<T extends ExtensionAccess>(access: AccessContext | null | undefined, list: readonly T[]): T[] {
  return list.filter((item) => extensionAllowed(access, item));
}

/** The page at /x/<segments>: the longest slug that prefixes the path, with what is left over. */
export function matchPage(pages: readonly PageExtension[], segments: readonly string[]): { page: PageExtension; rest: string[] } | null {
  let best: { page: PageExtension; rest: string[] } | null = null;
  for (const page of pages) {
    const parts = page.slug.toLowerCase().split('/');
    if (parts.length > segments.length) continue;
    if (!parts.every((part, i) => part === segments[i].toLowerCase())) continue;
    if (!best || parts.length > best.page.slug.split('/').length) best = { page, rest: segments.slice(parts.length) };
  }
  return best;
}

/**
 * The nav items this member sees. An item pointing at a custom page also needs
 * that page to be visible, so a link never leads to a page that refuses them.
 */
export function visibleNavItems(access: AccessContext | null | undefined, extensions: Extensions): NavItemExtension[] {
  return visibleTo(access, extensions.navItems).filter((item) => {
    if (!item.href.startsWith('/x/')) return true;
    const match = matchPage(extensions.pages, item.href.slice(3).split(/[?#]/)[0].split('/').filter(Boolean));
    return !match || extensionAllowed(access, match.page);
  });
}

/**
 * Places custom entries among the core ones: after their `after` entry when it
 * is shown, else at the end. An entry repeating a core href is left out: core's wins.
 */
export function placeNavItems<T extends { href: string }>(core: T[], custom: (T & { after?: string })[]): T[] {
  const out = [...core];
  const tail: T[] = [];
  const taken = new Set(core.map((entry) => entry.href));
  for (const item of custom) {
    if (taken.has(item.href)) continue;
    const at = item.after ? out.findIndex((entry) => entry.href === item.after) : -1;
    if (at === -1) tail.push(item);
    else out.splice(at + 1, 0, item);
  }
  return [...out, ...tail];
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

/** Validates the install's API routes. A route without `auth` is a session route. */
export function defineApiRoutes(routes: ApiRouteExtension[] = []): readonly ResolvedApiRoute[] {
  const resolved = routes.map((route): ResolvedApiRoute => {
    const path = normalizeSlug(route.path ?? '');
    const where = `API route ${route.method} /api/x/${path}`;
    const segments = path.split('/');
    if (!path || !segments.every((s) => SEGMENT.test(s) || /^:[a-z_][a-z0-9_]*$/i.test(s))) {
      fail(`${where}: path segments are letters, numbers and dashes, or :name.`);
    }
    if (!(API_METHODS as readonly string[]).includes(route.method)) fail(`${where}: method must be one of ${API_METHODS.join(', ')}.`);
    // Anything but the three named modes is refused, so a typo can never open a route.
    const auth = route.auth ?? 'session';
    if (!(API_ROUTE_AUTH as readonly string[]).includes(auth)) fail(`${where}: auth must be 'session', 'api-key' or 'public'.`);
    if (auth === 'api-key' && !route.permission) fail(`${where}: an api-key route needs the permission a key must hold.`);
    if (auth === 'public' && route.permission) fail(`${where}: a public route cannot require a permission; use 'session' or 'api-key'.`);
    if (typeof route.handler !== 'function') fail(`${where}: handler must be a function.`);
    checkAccess(where, route);
    return { ...route, path, auth, segments } as ResolvedApiRoute;
  });
  // 'clients/:id' and 'clients/:slug' answer the same addresses.
  unique(resolved, (route) => `${route.method} ${route.segments.map((s) => (s.startsWith(':') ? ':' : s.toLowerCase())).join('/')}`, 'API routes', 'method and path');
  return Object.freeze(resolved);
}

/** The route for this method and path, or why there is none. */
export function matchApiRoute(
  routes: readonly ResolvedApiRoute[],
  method: string,
  segments: readonly string[],
): { route: ResolvedApiRoute; params: Record<string, string> } | { route: null; allowed: ApiMethod[] } {
  const allowed: ApiMethod[] = [];
  for (const route of routes) {
    if (route.segments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const fits = route.segments.every((part, i) => {
      if (part.startsWith(':')) {
        params[part.slice(1)] = segments[i];
        return true;
      }
      return part.toLowerCase() === segments[i].toLowerCase();
    });
    if (!fits) continue;
    if (route.method === method) return { route, params };
    allowed.push(route.method);
  }
  return { route: null, allowed };
}

// ---------------------------------------------------------------------------
// Public paths (src/custom/middleware.ts)
// ---------------------------------------------------------------------------

/** Validates extra paths the sign-in wall lets through. Each covers itself and everything under it. */
export function definePublicPaths(paths: string[] = []): readonly string[] {
  for (const path of paths) {
    if (!path.startsWith('/') || path.startsWith('//') || /[?#*]/.test(path)) {
      fail(`public path "${path}" must be a plain path starting with / (it covers everything under it).`);
    }
    if (path.replace(/\/+$/, '') === '') fail('public path "/" would switch off sign-in for the whole app.');
  }
  return Object.freeze(paths.map((path) => path.replace(/\/+$/, '')));
}

/** Whether a request path is one of the public paths or under one. */
export function matchesPublicPath(paths: readonly string[], pathname: string): boolean {
  return paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}
