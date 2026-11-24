/**
 * What an install's code in src/custom imports. Safe in the browser, the
 * server and the edge middleware: validation and types only, no React and no
 * database. Core reads the registries through hooks.ts (the app's screens) and
 * the /api/x and /x catch-all routes.
 */
export {
  ExtensionError,
  defineApiRoutes,
  defineExtensions,
  definePublicPaths,
} from './registry';
export { defineAgentTemplates } from './agent-templates';
export type { AgentTemplate, AgentTemplateRules } from './agent-templates';
export type { SettingsField, SettingsFieldType, SettingsOption } from '@/lib/project-agents';
export { defineAgentProfiles } from './agent-profiles';
export type { AgentProfileDefinition } from './agent-profiles';
export type {
  ApiKeyRouteContext,
  ApiMethod,
  ApiRouteExtension,
  CustomPageProps,
  DashboardWidgetExtension,
  ExtensionAccess,
  Extensions,
  ExtensionsInput,
  NavItemExtension,
  PageExtension,
  ProjectTabExtension,
  PublicRouteContext,
  SessionRouteContext,
  SettingsSectionExtension,
} from './types';
