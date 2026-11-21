import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { NextRequest } from 'next/server';
import type { PermissionKey, TeamRole } from '@/lib/access-control';
import type { ModuleId } from '@/lib/modules/registry';
import type { SessionAccessResult } from '@/lib/api/access';
import type { ApiContext } from '@/lib/api/middleware';
import type { Project } from '@/lib/types';

/**
 * The plug-in points an install fills from src/custom. Core reads them; an
 * install never edits core to add a page, a tab, a widget or an endpoint.
 */

/**
 * Who sees an extension. Every field set narrows it further; none set means
 * everyone signed in (Settings sections excepted: Owners only by default).
 */
export interface ExtensionAccess {
  /** Shown only while this module is switched on. */
  module?: ModuleId;
  /** Shown only to members holding this permission. */
  permission?: PermissionKey;
  /** Shown only to these roles. */
  roles?: TeamRole[];
}

/** A sidebar entry. */
export interface NavItemExtension extends ExtensionAccess {
  /** An in-app path, usually a custom page: '/x/reports'. */
  href: string;
  label: string;
  icon: LucideIcon;
  /** Sits right after the entry with this href ('/projects', say). Absent or not shown: after the core entries. */
  after?: string;
}

export interface CustomPageProps {
  /** Path segments after the page's slug: /x/reports/2026 on slug 'reports' gives ['2026']. */
  rest: string[];
}

/** A page served at /x/<slug>, inside the normal shell (sidebar, sign-in). */
export interface PageExtension extends ExtensionAccess {
  /** One or more segments: 'reports' or 'reports/weekly'. Letters, numbers and dashes. */
  slug: string;
  /** The page header's title. */
  title: string;
  subtitle?: string;
  component: ComponentType<CustomPageProps>;
}

/** A tab on a project page, after the core tabs. */
export interface ProjectTabExtension extends ExtensionAccess {
  /** Letters, numbers and dashes; the tab's address is ?tab=x-<key>. */
  key: string;
  label: string;
  component: ComponentType<{ project: Project }>;
}

/** A card on the Dashboard. */
export interface DashboardWidgetExtension extends ExtensionAccess {
  key: string;
  title: string;
  icon?: LucideIcon;
  /** Adds the arrow link in the card's header. */
  href?: string;
  /** 'top' sits under the KPI tiles; 'bottom' (the default) at the end of the page. */
  placement?: 'top' | 'bottom';
  /** 'half' shares a row with the next half card from lg up. Default 'full'. */
  size?: 'full' | 'half';
  component: ComponentType;
}

/** A page under Settings, at /settings/custom/<key>. Owners only unless `roles` or `permission` is set. */
export interface SettingsSectionExtension extends ExtensionAccess {
  key: string;
  label: string;
  icon: LucideIcon;
  /** One line under the title on what it is for. */
  description?: string;
  component: ComponentType;
}

/** What an install passes to defineExtensions. Every list is optional. */
export interface ExtensionsInput {
  navItems?: NavItemExtension[];
  pages?: PageExtension[];
  projectTabs?: ProjectTabExtension[];
  dashboardWidgets?: DashboardWidgetExtension[];
  settingsSections?: SettingsSectionExtension[];
}

/** The validated registry core reads. */
export type Extensions = { readonly [K in keyof ExtensionsInput]-?: readonly NonNullable<ExtensionsInput[K]>[number][] };

// ---------------------------------------------------------------------------
// API routes (src/custom/api.ts, server only)
// ---------------------------------------------------------------------------

export const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ApiMethod = typeof API_METHODS[number];

export const API_ROUTE_AUTH = ['session', 'api-key', 'public'] as const;
export type ApiRouteAuth = typeof API_ROUTE_AUTH[number];

interface RouteContextBase {
  request: NextRequest;
  /** The path's `:name` segments: 'clients/:id' gives { id }. */
  params: Record<string, string>;
  searchParams: URLSearchParams;
}

/** A signed-in member: the same lookup core's session routes use. */
export interface SessionRouteContext extends RouteContextBase {
  session: SessionAccessResult;
}

/** A request carrying an API key with the route's permission. */
export interface ApiKeyRouteContext extends RouteContextBase {
  api: ApiContext;
}

export type PublicRouteContext = RouteContextBase;

type Handler<C> = (ctx: C) => Response | Promise<Response>;

interface ApiRouteBase {
  /** Served at /api/x/<path>. Segments are literal or `:name`: 'reports', 'clients/:id'. */
  path: string;
  method: ApiMethod;
  /** Answers 403 MODULE_OFF while this module is switched off. */
  module?: ModuleId;
}

/** Signed-in members only (the default). */
export interface SessionApiRoute extends ApiRouteBase {
  auth?: 'session';
  permission?: PermissionKey;
  handler: Handler<SessionRouteContext>;
}

/** An API key whose scopes and member both hold `permission`. */
export interface ApiKeyApiRoute extends ApiRouteBase {
  auth: 'api-key';
  permission: PermissionKey;
  handler: Handler<ApiKeyRouteContext>;
}

/** Anyone. The handler checks whatever it needs (a webhook signature, a cron secret). */
export interface PublicApiRoute extends ApiRouteBase {
  auth: 'public';
  permission?: never;
  handler: Handler<PublicRouteContext>;
}

export type ApiRouteExtension = SessionApiRoute | ApiKeyApiRoute | PublicApiRoute;

/** A validated route: auth always set. */
export type ResolvedApiRoute = ApiRouteExtension & { auth: ApiRouteAuth; segments: readonly string[] };
