import { z } from 'zod';
import { AGENT_CLOSE_POLICIES, AGENT_CREATE_POLICIES } from '@/lib/agent-rules';
import { agentLimitsPatchSchema } from '@/lib/agent-limits';
import { agentProfileSchema } from '@/lib/mcp/profiles';
import { AGENT_ROLE_PATTERN, PROJECT_AGENT_INSTRUCTIONS_MAX, PROJECT_AGENT_STATUSES } from '@/lib/project-agents';
import { BRIEF_ENTRY_MAX, BRIEF_SECTION_KEYS } from '@/lib/project-brief';
import { avatarUrlSchema } from './profile';

/**
 * Bodies of the agent workspace routes: hiring an agent, editing it, its
 * project assignments, the project brief and one-call project setup. Shared
 * by the session routes (/api/workspace/...) and the v1 API.
 */

const uuid = (what: string) => z.string().uuid(`${what} must be a uuid`);

export const agentRoleSchema = z.string().trim().regex(AGENT_ROLE_PATTERN, 'A role is lowercase words joined by dashes, 40 characters at most (builder, code-reviewer)');

/** Rules by their short names (as the screens send them) or their column names. */
export const agentRulesPatchSchema = z.object({
  self_assign: z.boolean().optional(),
  close_policy: z.enum(AGENT_CLOSE_POLICIES).optional(),
  create_policy: z.enum(AGENT_CREATE_POLICIES).optional(),
  escalate_to: uuid('escalate_to').nullable().optional(),
  escalate_to_group: uuid('escalate_to_group').nullable().optional(),
  agent_self_assign: z.boolean().optional(),
  agent_close_policy: z.enum(AGENT_CLOSE_POLICIES).optional(),
  agent_create_policy: z.enum(AGENT_CREATE_POLICIES).optional(),
  agent_escalate_to: uuid('agent_escalate_to').nullable().optional(),
  agent_escalate_to_group: uuid('agent_escalate_to_group').nullable().optional(),
}).strict();
export type AgentRulesPatch = z.infer<typeof agentRulesPatchSchema>;

/** The rules as their columns, from either spelling. */
export function rulesColumnsFrom(rules: AgentRulesPatch | undefined) {
  if (!rules) return {};
  const pick = <T>(short: T | undefined, long: T | undefined) => (long !== undefined ? long : short);
  const out: Record<string, unknown> = {};
  const selfAssign = pick(rules.self_assign, rules.agent_self_assign);
  const close = pick(rules.close_policy, rules.agent_close_policy);
  const create = pick(rules.create_policy, rules.agent_create_policy);
  const escalate = pick(rules.escalate_to, rules.agent_escalate_to);
  const escalateGroup = pick(rules.escalate_to_group, rules.agent_escalate_to_group);
  if (selfAssign !== undefined) out.agent_self_assign = selfAssign;
  if (close !== undefined) out.agent_close_policy = close;
  if (create !== undefined) out.agent_create_policy = create;
  if (escalate !== undefined) out.agent_escalate_to = escalate;
  if (escalateGroup !== undefined) out.agent_escalate_to_group = escalateGroup;
  return out as {
    agent_self_assign?: boolean;
    agent_close_policy?: (typeof AGENT_CLOSE_POLICIES)[number];
    agent_create_policy?: (typeof AGENT_CREATE_POLICIES)[number];
    agent_escalate_to?: string | null;
    agent_escalate_to_group?: string | null;
  };
}

const settingsSchema = z.record(z.string(), z.unknown());
const instructionsSchema = z.string().max(PROJECT_AGENT_INSTRUCTIONS_MAX, `Instructions must be ${PROJECT_AGENT_INSTRUCTIONS_MAX} characters or fewer`);
const templateKeySchema = z.string().trim().min(1).max(100);

/** POST /api/workspace/agents: hire an agent in one call. */
export const hireAgentSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  title: z.string().trim().max(80, 'Title must be 80 characters or fewer').optional(),
  description: z.string().trim().max(2000, 'Description must be 2000 characters or fewer').optional(),
  avatar_url: avatarUrlSchema.optional(),
  agent_role: agentRoleSchema.optional(),
  agent_profile: agentProfileSchema.optional(),
  /** An address only this agent uses; left out, one is made up (it never signs in). */
  email: z.string().trim().toLowerCase().email('Invalid email address').optional(),
  template_key: templateKeySchema.optional(),
  rules: agentRulesPatchSchema.optional(),
  owner_ids: z.array(uuid('owner_ids')).max(20).optional(),
  /** Groups that own it beside its people: any member manages it as an owner. */
  owner_group_ids: z.array(uuid('owner_group_ids')).max(20).optional(),
  project_ids: z.array(uuid('project_ids')).max(200).optional(),
  project_settings: z.record(z.string(), z.object({
    settings: settingsSchema.optional(),
    instructions: instructionsSchema.optional(),
    status: z.enum(PROJECT_AGENT_STATUSES).optional(),
  }).strict()).optional(),
  create_key: z.boolean().optional(),
  key_name: z.string().trim().min(1).max(100).optional(),
  scopes: z.array(z.string().max(100)).max(100).optional(),
  /** Days its key lasts (1 to 3650), or null for until revoked. Left out: the workspace's agent key lifetime, else 90 days. */
  key_expires_in_days: z.number().int().min(1).max(3650).nullable().optional(),
  /**
   * Its limits (null clears one). Left out: the safe defaults (writes and
   * messages a minute, no spend budget; src/lib/agent-defaults.ts) with
   * the template's own limits laid over them.
   */
  limits: agentLimitsPatchSchema.optional(),
  /**
   * One id per hire attempt (a UUID the caller makes once and sends on every
   * retry of it): a second call with the same id hires nothing more and is
   * answered 409 already_hired (or hire_in_progress while the first runs).
   * The answer holds a key secret, so it is never replayed.
   */
  request_id: z.string().uuid('request_id must be a UUID').optional(),
}).strict();
export type HireAgent = z.infer<typeof hireAgentSchema>;

/** PATCH /api/workspace/agents/{id} and PATCH /api/v1/agents/{id}: what an agent's managers change. */
export const patchAgentSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  title: z.string().trim().max(80).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  avatar_url: avatarUrlSchema.nullable().optional(),
  agent_role: agentRoleSchema.nullable().optional(),
  rules: agentRulesPatchSchema.optional(),
  owner_ids: z.array(uuid('owner_ids')).max(20).optional(),
  owner_group_ids: z.array(uuid('owner_group_ids')).max(20).optional(),
  /** Its limits (an Owner only): any field, null clears it. */
  limits: agentLimitsPatchSchema.optional(),
  /** Pause or resume it (whoever may manage it): reads, heartbeats and telemetry go on, other writes stop. */
  paused: z.boolean().optional(),
}).strict().refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change');
export type PatchAgent = z.infer<typeof patchAgentSchema>;

/** POST /api/workspace/agents/{id}/keys: a key for the agent, its secret once. */
export const agentKeySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  scopes: z.array(z.string().max(100)).min(1, 'Choose at least one scope').max(100),
  read_only: z.boolean().optional(),
}).strict();
export type AgentKeyInput = z.infer<typeof agentKeySchema>;

/** PUT /projects/{id}/agents/{agentId}: add or change an assignment. */
export const putProjectAgentSchema = z.object({
  status: z.enum(PROJECT_AGENT_STATUSES).optional(),
  template_key: templateKeySchema.nullable().optional(),
  settings: settingsSchema.optional(),
  instructions: instructionsSchema.optional(),
}).strict();
export type PutProjectAgent = z.infer<typeof putProjectAgentSchema>;

const sectionSchema = z.enum(BRIEF_SECTION_KEYS);
const contentSchema = z.string().min(1, 'Content is required').max(BRIEF_ENTRY_MAX, `An entry must be ${BRIEF_ENTRY_MAX} characters or fewer`);

export const createBriefEntrySchema = z.object({
  section: sectionSchema,
  content: contentSchema,
  pinned: z.boolean().optional(),
}).strict();
export type CreateBriefEntry = z.infer<typeof createBriefEntrySchema>;

export const updateBriefEntrySchema = z.object({
  section: sectionSchema.optional(),
  content: contentSchema.optional(),
  pinned: z.boolean().optional(),
  /** A person confirms an agent's entry: "Written by an agent" clears. */
  checked: z.literal(true).optional(),
}).strict().refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field to change');
export type UpdateBriefEntry = z.infer<typeof updateBriefEntrySchema>;

/** POST /projects/setup: a whole project in one call. project takes the fields the project create takes. */
export const projectSetupSchema = z.object({
  project: z.record(z.string(), z.unknown()),
  brief: z.array(createBriefEntrySchema).max(200).optional(),
  goals: z.array(z.object({
    title: z.string().trim().min(1, 'A goal needs a title').max(500),
    description: z.string().max(5000).optional(),
    target_date: z.string().max(40).nullable().optional(),
  }).strict()).max(50).optional(),
  agents: z.array(z.object({
    agent_id: uuid('agent_id'),
    template_key: templateKeySchema.nullable().optional(),
    settings: settingsSchema.optional(),
    instructions: instructionsSchema.optional(),
    status: z.enum(PROJECT_AGENT_STATUSES).optional(),
  }).strict()).max(200).optional(),
  members: z.array(uuid('members')).max(500).optional(),
}).strict();
export type ProjectSetup = z.infer<typeof projectSetupSchema>;
