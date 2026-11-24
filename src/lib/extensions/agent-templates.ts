import { API_ENDPOINT_PERMISSION_SET, type PermissionKey } from '@/lib/access-control';
import { AGENT_CLOSE_POLICIES, AGENT_CREATE_POLICIES, type AgentClosePolicy, type AgentCreatePolicy } from '@/lib/agent-rules';
import { isModuleId, type ModuleId } from '@/lib/modules/registry';
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from '@/lib/types';
import { ExtensionError } from './registry';

/**
 * Agent templates: a starting setup for a kind of agent, as code. Core ships
 * a few generic ones (lib/agent-templates.ts) and an install adds its own in
 * src/custom/agent-templates.ts. A template is only a suggestion fed through
 * the agent setup API: applying one sets the agent's rules and can make a key
 * with its scopes, and every check of that API still runs (the caller grants
 * only scopes its own key carries). It adds nothing to the security model.
 *
 * - key: lowercase letters, numbers and dashes, unique across core and the install.
 * - rules: the three agent rules a template sets (escalate_to is left to the
 *   install, since it names a member).
 * - scopes: the API scopes a key for this agent should carry.
 * - context: a short brief added to the agent's context pack (pm_guide, its
 *   AGENTS.md export), 2,000 characters at most.
 * - webhook_events: events its harness should hear, suggested when setting up
 *   its webhook endpoint.
 * - module: a module the template needs (inbox triage needs the Inbox); while
 *   it is off the template is not listed.
 */
export interface AgentTemplateRules {
  agent_self_assign: boolean;
  agent_close_policy: AgentClosePolicy;
  agent_create_policy: AgentCreatePolicy;
}

export interface AgentTemplate {
  key: string;
  label: string;
  description: string;
  rules: AgentTemplateRules;
  scopes: PermissionKey[];
  context: string;
  webhook_events?: WebhookEventType[];
  module?: ModuleId;
}

export const AGENT_TEMPLATE_CONTEXT_MAX = 2000;

const KEY = /^[a-z0-9][a-z0-9-]*$/;

function fail(message: string): never {
  throw new ExtensionError(message);
}

function checkTemplate(template: AgentTemplate) {
  const where = `agent template "${template.key}"`;
  if (!KEY.test(template.key ?? '')) fail(`agent template key "${template.key}" must be lowercase letters, numbers and dashes.`);
  if (!template.label?.trim()) fail(`${where} needs a label.`);
  if (!template.description?.trim()) fail(`${where} needs a description.`);
  if (!template.context?.trim()) fail(`${where} needs a context brief.`);
  if (template.context.length > AGENT_TEMPLATE_CONTEXT_MAX) {
    fail(`${where}: context is over ${AGENT_TEMPLATE_CONTEXT_MAX} characters.`);
  }
  const rules = template.rules;
  if (!rules || typeof rules.agent_self_assign !== 'boolean'
    || !(AGENT_CLOSE_POLICIES as readonly string[]).includes(rules.agent_close_policy)
    || !(AGENT_CREATE_POLICIES as readonly string[]).includes(rules.agent_create_policy)) {
    fail(`${where}: rules need agent_self_assign (true or false), agent_close_policy (close or review) and agent_create_policy (live or approval).`);
  }
  if (!Array.isArray(template.scopes) || template.scopes.length === 0) fail(`${where} needs at least one scope.`);
  for (const scope of template.scopes) {
    if (!API_ENDPOINT_PERMISSION_SET.has(scope)) fail(`${where}: "${scope}" is not an API scope.`);
  }
  for (const event of template.webhook_events ?? []) {
    if (!(WEBHOOK_EVENT_TYPES as readonly string[]).includes(event)) fail(`${where}: unknown webhook event "${event}".`);
  }
  if (template.module !== undefined && !isModuleId(template.module)) fail(`${where}: unknown module "${template.module}".`);
}

/** Validates a list of agent templates and returns it, scopes and events deduplicated. */
export function defineAgentTemplates(templates: readonly AgentTemplate[] = []): AgentTemplate[] {
  const seen = new Set<string>();
  return templates.map((template) => {
    checkTemplate(template);
    if (seen.has(template.key)) fail(`two agent templates use the key "${template.key}". Each key must be unique.`);
    seen.add(template.key);
    return {
      ...template,
      scopes: [...new Set(template.scopes)],
      ...(template.webhook_events ? { webhook_events: [...new Set(template.webhook_events)] } : {}),
    };
  });
}

/** Core's templates then the install's; an install's key that repeats a core one stops the build. */
export function mergeAgentTemplates(core: readonly AgentTemplate[], custom: readonly AgentTemplate[]): AgentTemplate[] {
  const coreKeys = new Set(core.map((template) => template.key));
  for (const template of custom) {
    if (coreKeys.has(template.key)) {
      fail(`the agent template key "${template.key}" is core's. Give the install's template its own key.`);
    }
  }
  return [...core, ...defineAgentTemplates(custom)];
}
