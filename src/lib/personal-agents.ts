import { z } from 'zod';

/**
 * Personal agents ("Assistants"): an agent bound to one person
 * (team_members.delegate_of). Whoever asks, its access is its own and its
 * person's together, so it never sees more than they do; its person owns it
 * and is who it escalates to; it is paused the moment they are suspended,
 * and its keys are revoked then.
 *
 * One per person per template: provisioning twice makes nothing new, and a
 * person in two setups with different templates (an inbox helper and a
 * reporter) gets one of each.
 *
 * Assistant setups (pm.assistant_setups) say which template a role or a
 * group gets, with default settings. An Owner provisions everyone who
 * matches in bulk, and a person who joins with a matching role gets theirs
 * at once. Their keys reach the harness that runs them through a key with
 * assistants.provision, which collects each agent's key once: no person
 * handles those keys. Client-safe: no server code here.
 */

/** The display name a personal agent starts with: {first_name} and {name} are the person's. */
export const ASSISTANT_DEFAULT_NAME_TEMPLATE = "{first_name}'s Assistant";
/** The template a setup uses when it names none. */
export const ASSISTANT_DEFAULT_TEMPLATE = 'personal-assistant';
export const ASSISTANT_SETUP_ROLES = ['owner', 'admin', 'member', 'guest'] as const;
/** People provisioned per call at most; the answer says how many remain. */
export const PROVISION_PAGE_MAX = 500;
export const PROVISION_PAGE_DEFAULT = 100;

const templateKey = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'template_key is a template key, such as personal-assistant');

/** A setup's default settings for the agents it makes. */
export const assistantSetupSettingsSchema = z.object({
  name_template: z.string().trim().min(1).max(80).optional(),
  title: z.string().trim().max(80).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  rules: z.object({
    agent_self_assign: z.boolean().optional(),
    agent_close_policy: z.enum(['close', 'review']).optional(),
    agent_create_policy: z.enum(['live', 'approval']).optional(),
  }).strict().optional(),
}).strict();
export type AssistantSetupSettings = z.infer<typeof assistantSetupSettingsSchema>;

/** POST: a role or a group (exactly one), its template, settings, and whether it is on. */
export const createAssistantSetupSchema = z.object({
  match_role: z.enum(ASSISTANT_SETUP_ROLES).optional(),
  match_group_id: z.uuid('match_group_id must be a group id').optional(),
  template_key: templateKey.default(ASSISTANT_DEFAULT_TEMPLATE),
  settings: assistantSetupSettingsSchema.default({}),
  enabled: z.boolean().default(true),
}).strict().refine((body) => (body.match_role ? 1 : 0) + (body.match_group_id ? 1 : 0) === 1, 'Send match_role or match_group_id, exactly one');
export type CreateAssistantSetup = z.infer<typeof createAssistantSetupSchema>;

/** PATCH: what it matches never changes; make another setup instead. */
export const updateAssistantSetupSchema = z.object({
  template_key: templateKey.optional(),
  settings: assistantSetupSettingsSchema.optional(),
  enabled: z.boolean().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'Send template_key, settings or enabled');
export type UpdateAssistantSetup = z.infer<typeof updateAssistantSetupSchema>;

/** POST /api/workspace/assistants/provision. */
export const provisionAssistantsSchema = z.object({
  dry_run: z.boolean().default(false),
  setup_id: z.uuid('setup_id must be an assistant setup id').optional(),
  limit: z.number().int().min(1).max(PROVISION_PAGE_MAX).default(PROVISION_PAGE_DEFAULT),
  /** For a dry run's next page: the next_after of the one before. */
  after: z.uuid('after is the next_after of the previous page').optional(),
}).strict();
export type ProvisionAssistants = z.infer<typeof provisionAssistantsSchema>;

/** POST /api/workspace/assistants/bind: who an agent works for (null: nobody). Owner only. */
export const bindAssistantSchema = z.object({
  agent_id: z.uuid('agent_id must be a team member id'),
  person_id: z.uuid('person_id must be a team member id').nullable(),
}).strict();

/** A key for your own personal agent, or one a harness collects. */
export const assistantKeySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  scopes: z.array(z.string()).min(1).optional(),
  read_only: z.boolean().optional(),
}).strict();
export type AssistantKeyInput = z.infer<typeof assistantKeySchema>;

/** PATCH /api/workspace/key-settings. */
export const keySettingsSchema = z.object({
  agent_key_lifetime_days: z.number().int().min(1).max(3650).nullable(),
}).strict();

/** Body of PATCH /api/workspace/key-settings/personal: how long a person's new key lasts unless they choose (null: until revoked). */
export const personalKeySettingsSchema = z.object({
  personal_key_lifetime_days: z.number().int().min(1).max(3650).nullable(),
}).strict();

/** The name a personal agent starts with, from its setup's template ("{first_name}'s Assistant"). */
export function assistantNameFor(personName: string, nameTemplate: string = ASSISTANT_DEFAULT_NAME_TEMPLATE): string {
  const name = personName.trim() || 'Someone';
  const first = name.split(/\s+/)[0];
  return nameTemplate.split('{first_name}').join(first).split('{name}').join(name).slice(0, 100).trim() || `${first}'s Assistant`;
}

/** What a personal agent is told about itself, first in its context. */
export function personalAgentBrief(personName: string): string {
  return `You work for ${personName}: you are their personal agent. You see only what ${personName} can see and do only what you and ${personName} may both do, on every call, so a project or task out of their reach is out of yours. Everything you make records ${personName} as the person you acted for. Questions you cannot settle go to ${personName}. You need no X-Act-For header; if you send one, it must be for ${personName}.`;
}
