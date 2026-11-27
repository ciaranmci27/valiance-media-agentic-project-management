import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { NextRequest } from 'next/server';
import type { PermissionKey, TeamRole } from '@/lib/access-control';
import type { ModuleId } from '@/lib/modules/registry';
import type { SessionAccessResult } from '@/lib/api/access';
import type { ApiContext } from '@/lib/api/middleware';
import type { AgentActivity, FleetAgentActivity, Project } from '@/lib/types';
import type { DateRange } from '@/lib/finance/summary';
import type { AgentAnalyticsModel } from '@/lib/agent-analytics-model';
import type { AttributionDelta } from '@/lib/agent-telemetry-analytics';

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
  /**
   * Sits right after the entry with this href ('/projects', say). Absent or not shown: after the core entries.
   * After an entry under the sidebar's More (Leads, Contacts, Team, Finances), it sits under More too.
   */
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

/**
 * A small badge beside a project's name on the Projects list and project
 * cards, after the core badges. The component gets the project and returns
 * null when the badge does not apply to it.
 */
export interface ProjectBadgeExtension extends ExtensionAccess {
  /** Letters, numbers and dashes. */
  key: string;
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

/** What an agent analytics card is handed: the Analytics tab's range, filters, read model and events. */
export interface AgentAnalyticsCardProps {
  range: DateRange;
  /** The viewer's zone for day keys; undefined is the browser's. */
  timezone?: string;
  /** The report's "now" (fixed per visit). */
  now: number;
  selectedAgentIds: ReadonlySet<string>;
  selectedProjectIds: ReadonlySet<string>;
  /** The core read model for this selection: facts, totals, money visibility. */
  model: AgentAnalyticsModel;
  /** Every agent event in the range (with telemetry), as the core model read them. */
  activities: AgentActivity[];
  /** Host records that name no agent. */
  fleetActivities: FleetAgentActivity[];
  /** Directed-session usage for token attribution, when the server summed usage per hour. */
  attribution?: AttributionDelta[];
  /** The range is still loading: show a skeleton, never a guess. */
  measuring: boolean;
}

/** A card on the Agents page's Analytics tab, below the core breakdown. */
export interface AgentAnalyticsCardExtension extends ExtensionAccess {
  key: string;
  title: string;
  /** 'half' shares a row with the next half card from lg up. Default 'full'. */
  size?: 'full' | 'half';
  component: ComponentType<AgentAnalyticsCardProps>;
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
  projectBadges?: ProjectBadgeExtension[];
  dashboardWidgets?: DashboardWidgetExtension[];
  agentAnalyticsCards?: AgentAnalyticsCardExtension[];
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
