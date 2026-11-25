import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { AccessContext } from '@/lib/access-control';
import { AGENT_TEMPLATES, CORE_AGENT_TEMPLATES, listAgentTemplates } from '@/lib/agent-templates';
import {
  AGENT_PROFILE_VALUE, checkAgentProfileTools, defineAgentProfiles, type AgentProfileDefinition,
} from '@/lib/extensions/agent-profiles';
import { defineAgentTemplates, type AgentTemplate } from '@/lib/extensions/agent-templates';
import { ExtensionError } from '@/lib/extensions/registry';
import { AGENT_PROFILES, CORE_AGENT_PROFILES } from '@/lib/mcp/profiles';
import { ApiError, forbidden, notFound } from './errors';

/**
 * The agent registries as the server reads them: agent profiles (which MCP
 * tools an agent sees) and agent templates, each code's (core, then the
 * install's src/custom) merged with an Owner's own rows (pm.mcp_profile_rows,
 * pm.agent_template_rows), so an AI setting a workspace up over MCP needs no
 * code deploy.
 *
 * - Code wins: a row never takes a key code holds (writes refuse it, 409
 *   registry_key_taken), and a row whose key code later took is ignored.
 * - Archived rows are kept, never deleted, and resolve as unknown: a member
 *   left on an archived profile sees only pm_guide.
 * - Reads only touch the database when code does not know the key, so an
 *   agent on generic (every fleet member today) costs nothing extra.
 * - Before the migration the tables do not exist: code's alone, plus the
 *   four fleet profiles core used to ship, so a member on one keeps its
 *   tools until the update lands.
 * - Writes are an Owner's (team.manage on the route, and the Owner role).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

/** The fleet's role profiles, core's before profiles became rows: what they resolve to until the migration makes them rows. */
export const LEGACY_FLEET_PROFILES: AgentProfileDefinition[] = defineAgentProfiles([
  { value: 'coordinator', label: 'Coordinator', description: 'Plans and assigns work, keeps projects and leads current' },
  { value: 'builder', label: 'Builder', description: 'Works assigned tasks, tracks time and raises blockers' },
  { value: 'auditor', label: 'Auditor', description: 'Audits projects against their goals and proposes tasks' },
  { value: 'reviewer', label: 'Reviewer', description: 'Reviews finished work and records verdicts' },
]);

export const missingRegistryTable = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === '42P01' || error.code === 'PGRST205' || /(mcp_profile_rows|agent_template_rows).*(does not exist|schema cache)/i.test(error.message ?? ''));

function pending(): ApiError {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'Agent profiles and templates of your own need the database update 20261125000100_handoff_scopes_registries.sql', { reason: 'migration_pending' });
}

function invalid(message: string, details: Record<string, unknown> = {}): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', message, details);
}

function extensionProblem(error: unknown): never {
  if (error instanceof ExtensionError) throw invalid(error.message.replace(/^Extensions: /, ''), { reason: 'invalid_registry_entry' });
  throw error;
}

export type RegistrySource = 'core' | 'install' | 'workspace';

// ── Profiles ─────────────────────────────────────────────────────────────

export interface ProfileRowView extends AgentProfileDefinition {
  source: RegistrySource;
  archived_at: string | null;
  created_at?: string;
  updated_at?: string;
}

const coreProfileValues = new Set(CORE_AGENT_PROFILES.map((profile) => profile.value));
const codeProfileValues = new Set(AGENT_PROFILES.map((profile) => profile.value));

function profileOfRow(row: Row): AgentProfileDefinition {
  return {
    value: row.value,
    label: row.label,
    description: row.description,
    ...(Array.isArray(row.tools) ? { tools: row.tools as string[] } : {}),
  };
}

/** An Owner's profile rows, oldest first; null before the migration. */
async function profileRows(service: SupabaseClient, includeArchived = false): Promise<Row[] | null> {
  let query = service.from('mcp_profile_rows').select('*').order('created_at').order('value');
  if (!includeArchived) query = query.is('archived_at', null);
  const { data, error } = await query;
  if (missingRegistryTable(error)) return null;
  if (error) throw error;
  return (data ?? []) as Row[];
}

/** Every profile a write may name: code's, then an Owner's live rows (the fleet four before the migration). */
export async function agentProfileRegistry(service: SupabaseClient): Promise<AgentProfileDefinition[]> {
  const rows = await profileRows(service);
  if (rows === null) return [...AGENT_PROFILES, ...LEGACY_FLEET_PROFILES.filter((p) => !codeProfileValues.has(p.value))];
  return [...AGENT_PROFILES, ...rows.filter((row) => !codeProfileValues.has(row.value)).map(profileOfRow)];
}

/**
 * One stored profile value as it resolves: code's (no read), else a live
 * row, else (before the migration) the fleet profile it was. Null for a
 * value nothing knows, which sees only pm_guide.
 */
export async function resolveAgentProfile(service: SupabaseClient, value: string): Promise<AgentProfileDefinition | null> {
  const code = AGENT_PROFILES.find((profile) => profile.value === value);
  if (code) return code;
  if (!AGENT_PROFILE_VALUE.test(value)) return null;
  const { data, error } = await service.from('mcp_profile_rows').select('*').eq('value', value).is('archived_at', null).maybeSingle();
  if (missingRegistryTable(error)) return LEGACY_FLEET_PROFILES.find((profile) => profile.value === value) ?? null;
  if (error) throw error;
  return data ? profileOfRow(data as Row) : null;
}

/** A profile value a write names must be one a registry holds: 422 naming them otherwise. */
export async function assertKnownAgentProfile(service: SupabaseClient, value: string | undefined | null): Promise<void> {
  if (value === undefined || value === null) return;
  if (await resolveAgentProfile(service, value)) return;
  const known = (await agentProfileRegistry(service)).map((profile) => profile.value);
  throw invalid(`agent_profile must be one of: ${known.join(', ')}`, { reason: 'unknown_agent_profile', profiles: known });
}

/** Profiles for the Team page and list_agent_profiles: code's and the rows, each with where it comes from. */
export async function listAgentProfiles(service: SupabaseClient, includeArchived = false): Promise<ProfileRowView[]> {
  const rows = await profileRows(service, includeArchived);
  const code: ProfileRowView[] = AGENT_PROFILES.map((profile) => ({
    ...profile, source: coreProfileValues.has(profile.value) ? 'core' : 'install', archived_at: null,
  }));
  const own: ProfileRowView[] = (rows ?? []).filter((row) => !codeProfileValues.has(row.value)).map((row) => ({
    ...profileOfRow(row), source: 'workspace', archived_at: row.archived_at ?? null, created_at: row.created_at, updated_at: row.updated_at,
  }));
  return [...code, ...own];
}

// ── Templates ────────────────────────────────────────────────────────────

const coreTemplateKeys = new Set(CORE_AGENT_TEMPLATES.map((template) => template.key));
const codeTemplateKeys = new Set(AGENT_TEMPLATES.map((template) => template.key));

const TEMPLATE_SPEC_FIELDS = ['rules', 'scopes', 'context', 'webhook_events', 'module', 'settings', 'role', 'profile', 'limits'] as const;

function templateOfRow(row: Row): AgentTemplate {
  const spec = (row.spec && typeof row.spec === 'object' ? row.spec : {}) as Row;
  const template: Row = { key: row.key, label: row.label, description: row.description };
  for (const field of TEMPLATE_SPEC_FIELDS) if (spec[field] !== undefined && spec[field] !== null) template[field] = spec[field];
  return template as AgentTemplate;
}

async function templateRows(service: SupabaseClient, includeArchived = false): Promise<Row[] | null> {
  let query = service.from('agent_template_rows').select('*').order('created_at').order('key');
  if (!includeArchived) query = query.is('archived_at', null);
  const { data, error } = await query;
  if (missingRegistryTable(error)) return null;
  if (error) throw error;
  return (data ?? []) as Row[];
}

/** A row that no longer passes the checks (it never should) is left out and logged, never served. */
function validRowTemplates(rows: Row[]): AgentTemplate[] {
  const out: AgentTemplate[] = [];
  for (const row of rows) {
    if (codeTemplateKeys.has(row.key)) continue;
    try {
      out.push(...defineAgentTemplates([templateOfRow(row)]));
    } catch (error) {
      console.error(`[agent-registries] template row "${row.key}" is not valid and is skipped`, error);
    }
  }
  return out;
}

/** Every template: code's first, then an Owner's live rows. */
export async function agentTemplateRegistry(service: SupabaseClient): Promise<AgentTemplate[]> {
  const rows = await templateRows(service);
  return rows === null ? AGENT_TEMPLATES : [...AGENT_TEMPLATES, ...validRowTemplates(rows)];
}

/** One template by key: code's (no read), else a live row. */
export async function resolveAgentTemplate(service: SupabaseClient, key: string): Promise<AgentTemplate | null> {
  const code = AGENT_TEMPLATES.find((template) => template.key === key);
  if (code) return code;
  const { data, error } = await service.from('agent_template_rows').select('*').eq('key', key).is('archived_at', null).maybeSingle();
  if (missingRegistryTable(error)) return null;
  if (error) throw error;
  return data ? validRowTemplates([data as Row])[0] ?? null : null;
}

/** Templates whose module is on, rows included. */
export async function listAgentTemplatesFor(service: SupabaseClient, access: AccessContext): Promise<AgentTemplate[]> {
  return listAgentTemplates(access, await agentTemplateRegistry(service));
}

export interface TemplateRowView {
  key: string;
  label: string;
  description: string;
  source: RegistrySource;
  archived_at: string | null;
  template: AgentTemplate;
}

export async function listTemplateRegistry(service: SupabaseClient, includeArchived = false): Promise<TemplateRowView[]> {
  const rows = await templateRows(service, includeArchived);
  const code: TemplateRowView[] = AGENT_TEMPLATES.map((template) => ({
    key: template.key, label: template.label, description: template.description,
    source: coreTemplateKeys.has(template.key) ? 'core' : 'install', archived_at: null, template,
  }));
  const own: TemplateRowView[] = (rows ?? []).filter((row) => !codeTemplateKeys.has(row.key)).map((row) => ({
    key: row.key, label: row.label, description: row.description, source: 'workspace', archived_at: row.archived_at ?? null, template: templateOfRow(row),
  }));
  return [...code, ...own];
}

// ── Writes (an Owner's) ──────────────────────────────────────────────────

export interface RegistryCaller {
  memberId: string;
  access: AccessContext;
}

function requireOwner(caller: RegistryCaller) {
  if (caller.access.role !== 'owner' || caller.access.status !== 'active') {
    throw forbidden('Only an Owner changes agent profiles and templates', { reason: 'owner_only' });
  }
}

function keyTaken(kind: 'profile' | 'template', key: string): ApiError {
  return new ApiError(409, 'CONFLICT', `The ${kind} "${key}" is defined in code. Give yours its own ${kind === 'profile' ? 'value' : 'key'}.`, { reason: 'registry_key_taken', key });
}

const toolList = z.array(z.string().min(1).max(64)).min(1).max(300);

export const profileRowInputSchema = z.object({
  value: z.string().regex(AGENT_PROFILE_VALUE, 'value is lowercase letters, numbers and dashes, starting with a letter, at most 40'),
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  tools: toolList.nullable().optional(),
}).strict();
export type ProfileRowInput = z.infer<typeof profileRowInputSchema>;

export const profileRowPatchSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().min(1).max(500).optional(),
  tools: toolList.nullable().optional(),
  archived: z.boolean().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'Send something to change');
export type ProfileRowPatch = z.infer<typeof profileRowPatchSchema>;

/** Checks a profile definition the way code's are checked: its shape and that every tool exists. */
async function checkProfile(definition: AgentProfileDefinition): Promise<AgentProfileDefinition> {
  // Read at call time: the tool list imports this module's neighbours.
  const { PM_TOOLS } = await import('@/lib/mcp/tools');
  try {
    const [checked] = defineAgentProfiles([definition]);
    checkAgentProfileTools([checked], PM_TOOLS.map((tool) => tool.name));
    return checked;
  } catch (error) {
    return extensionProblem(error);
  }
}

function presentProfileRow(row: Row): ProfileRowView {
  return { ...profileOfRow(row), source: 'workspace', archived_at: row.archived_at ?? null, created_at: row.created_at, updated_at: row.updated_at };
}

export async function createProfileRow(service: SupabaseClient, caller: RegistryCaller, input: ProfileRowInput): Promise<ProfileRowView> {
  requireOwner(caller);
  if (codeProfileValues.has(input.value)) throw keyTaken('profile', input.value);
  const checked = await checkProfile({ value: input.value, label: input.label, description: input.description, ...(input.tools ? { tools: input.tools } : {}) });
  const { data, error } = await service.from('mcp_profile_rows').insert({
    value: checked.value, label: checked.label, description: checked.description, tools: checked.tools ?? null,
    created_by: caller.memberId, updated_by: caller.memberId,
  }).select('*').single();
  if (missingRegistryTable(error)) throw pending();
  if (error?.code === '23505') throw new ApiError(409, 'CONFLICT', `A profile "${input.value}" already exists`, { reason: 'registry_key_exists', key: input.value });
  if (error) throw error;
  return presentProfileRow(data as Row);
}

async function loadProfileRow(service: SupabaseClient, value: string): Promise<Row> {
  const { data, error } = await service.from('mcp_profile_rows').select('*').eq('value', value).maybeSingle();
  if (missingRegistryTable(error)) throw pending();
  if (error) throw error;
  if (!data) {
    if (codeProfileValues.has(value)) throw keyTaken('profile', value);
    throw notFound('Agent profile');
  }
  return data as Row;
}

export async function updateProfileRow(service: SupabaseClient, caller: RegistryCaller, value: string, patch: ProfileRowPatch): Promise<ProfileRowView> {
  requireOwner(caller);
  const before = await loadProfileRow(service, value);
  const next = { ...profileOfRow(before), ...(patch.label !== undefined ? { label: patch.label } : {}), ...(patch.description !== undefined ? { description: patch.description } : {}) };
  if (patch.tools !== undefined) {
    if (patch.tools === null) delete next.tools;
    else next.tools = patch.tools;
  }
  const checked = await checkProfile(next);
  const changes: Row = { label: checked.label, description: checked.description, tools: checked.tools ?? null, updated_by: caller.memberId };
  if (patch.archived === true && !before.archived_at) {
    const { count, error } = await service.from('team_members').select('id', { count: 'exact', head: true }).eq('agent_profile', value);
    if (error) throw error;
    if ((count ?? 0) > 0) {
      throw new ApiError(409, 'CONFLICT', `${count} ${count === 1 ? 'agent uses' : 'agents use'} this profile. Move them to another first.`, { reason: 'profile_in_use', members: count });
    }
    changes.archived_at = new Date().toISOString();
  }
  if (patch.archived === false) changes.archived_at = null;
  const { data, error } = await service.from('mcp_profile_rows').update(changes).eq('value', value).select('*').single();
  if (error) throw error;
  return presentProfileRow(data as Row);
}

const templateSpecSchema = z.object({
  rules: z.object({
    agent_self_assign: z.boolean(),
    agent_close_policy: z.enum(['close', 'review']),
    agent_create_policy: z.enum(['live', 'approval']),
  }).strict(),
  scopes: z.array(z.string().min(1).max(100)).min(1).max(100),
  context: z.string().min(1).max(2000),
  webhook_events: z.array(z.string().min(1).max(100)).max(50).optional(),
  module: z.string().min(1).max(40).optional(),
  settings: z.array(z.record(z.string(), z.unknown())).max(30).optional(),
  role: z.string().min(1).max(40).optional(),
  profile: z.string().min(1).max(40).optional(),
  limits: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const templateRowInputSchema = templateSpecSchema.extend({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'key is lowercase letters, numbers and dashes').max(100),
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
}).strict();
export type TemplateRowInput = z.infer<typeof templateRowInputSchema>;

export const templateRowPatchSchema = templateSpecSchema.partial().extend({
  label: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().min(1).max(500).optional(),
  archived: z.boolean().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'Send something to change');
export type TemplateRowPatch = z.infer<typeof templateRowPatchSchema>;

/** Checks a template the way code's are checked, and that its profile is one a registry holds. */
async function checkTemplate(service: SupabaseClient, template: AgentTemplate): Promise<AgentTemplate> {
  let checked: AgentTemplate;
  try {
    [checked] = defineAgentTemplates([template]);
  } catch (error) {
    return extensionProblem(error);
  }
  if (checked.profile !== undefined) await assertKnownAgentProfile(service, checked.profile);
  return checked;
}

function specOf(template: AgentTemplate): Row {
  const spec: Row = {};
  for (const field of TEMPLATE_SPEC_FIELDS) if (template[field] !== undefined) spec[field] = template[field];
  return spec;
}

function presentTemplateRow(row: Row): TemplateRowView {
  return { key: row.key, label: row.label, description: row.description, source: 'workspace', archived_at: row.archived_at ?? null, template: templateOfRow(row) };
}

export async function createTemplateRow(service: SupabaseClient, caller: RegistryCaller, input: TemplateRowInput): Promise<TemplateRowView> {
  requireOwner(caller);
  if (codeTemplateKeys.has(input.key)) throw keyTaken('template', input.key);
  const checked = await checkTemplate(service, input as unknown as AgentTemplate);
  const { data, error } = await service.from('agent_template_rows').insert({
    key: checked.key, label: checked.label, description: checked.description, spec: specOf(checked),
    created_by: caller.memberId, updated_by: caller.memberId,
  }).select('*').single();
  if (missingRegistryTable(error)) throw pending();
  if (error?.code === '23505') throw new ApiError(409, 'CONFLICT', `A template "${input.key}" already exists`, { reason: 'registry_key_exists', key: input.key });
  if (error) throw error;
  return presentTemplateRow(data as Row);
}

export async function updateTemplateRow(service: SupabaseClient, caller: RegistryCaller, key: string, patch: TemplateRowPatch): Promise<TemplateRowView> {
  requireOwner(caller);
  const { data: before, error: readError } = await service.from('agent_template_rows').select('*').eq('key', key).maybeSingle();
  if (missingRegistryTable(readError)) throw pending();
  if (readError) throw readError;
  if (!before) {
    if (codeTemplateKeys.has(key)) throw keyTaken('template', key);
    throw notFound('Agent template');
  }
  const { archived, ...fields } = patch;
  const next = { ...templateOfRow(before as Row), ...fields } as AgentTemplate;
  const checked = await checkTemplate(service, next);
  const changes: Row = { label: checked.label, description: checked.description, spec: specOf(checked), updated_by: caller.memberId };
  if (archived === true && !(before as Row).archived_at) changes.archived_at = new Date().toISOString();
  if (archived === false) changes.archived_at = null;
  const { data, error } = await service.from('agent_template_rows').update(changes).eq('key', key).select('*').single();
  if (error) throw error;
  return presentTemplateRow(data as Row);
}

// ── Export and import ────────────────────────────────────────────────────

export const REGISTRY_DOCUMENT_FORMAT = 'pm-agent-registries';

export interface RegistryDocument {
  format: typeof REGISTRY_DOCUMENT_FORMAT;
  version: 1;
  exported_at: string;
  profiles: AgentProfileDefinition[];
  templates: AgentTemplate[];
}

/** An Owner's own live profiles and templates as one document (code's ship with the code, so they are left out). */
export async function exportRegistries(service: SupabaseClient): Promise<RegistryDocument> {
  const [profiles, templates] = await Promise.all([profileRows(service), templateRows(service)]);
  return {
    format: REGISTRY_DOCUMENT_FORMAT,
    version: 1,
    exported_at: new Date().toISOString(),
    profiles: (profiles ?? []).filter((row) => !codeProfileValues.has(row.value)).map(profileOfRow),
    templates: (templates ?? []).filter((row) => !codeTemplateKeys.has(row.key)).map(templateOfRow),
  };
}

export const registryImportSchema = z.object({
  document: z.object({
    format: z.literal(REGISTRY_DOCUMENT_FORMAT),
    version: z.literal(1),
    profiles: z.array(z.record(z.string(), z.unknown())).max(200).default([]),
    templates: z.array(z.record(z.string(), z.unknown())).max(200).default([]),
  }).passthrough(),
  dry_run: z.boolean().optional(),
}).strict();
export type RegistryImport = z.infer<typeof registryImportSchema>;

export interface RegistryImportPlan {
  dry_run: boolean;
  profiles: { created: string[]; updated: string[]; refused: { key: string; reason: string; message: string }[] };
  templates: { created: string[]; updated: string[]; refused: { key: string; reason: string; message: string }[] };
}

/**
 * Brings profiles and templates from a document in: each one is created, or
 * updates (and unarchives) the row with its key. A key code holds is
 * refused, never overridden; an entry that fails a check is refused with
 * why. Profiles go first, so a template may name one from the same
 * document. dry_run answers the plan and writes nothing.
 */
export async function importRegistries(service: SupabaseClient, caller: RegistryCaller, input: RegistryImport): Promise<RegistryImportPlan> {
  requireOwner(caller);
  const dryRun = input.dry_run === true;
  const plan: RegistryImportPlan = {
    dry_run: dryRun,
    profiles: { created: [], updated: [], refused: [] },
    templates: { created: [], updated: [], refused: [] },
  };
  const [existingProfiles, existingTemplates] = await Promise.all([profileRows(service, true), templateRows(service, true)]);
  if (existingProfiles === null || existingTemplates === null) throw pending();
  const profileKeys = new Set(existingProfiles.map((row) => row.value));
  const templateKeys = new Set(existingTemplates.map((row) => row.key));
  const refusal = (error: unknown) => (error instanceof ApiError
    ? { reason: String((error.details as Row | undefined)?.reason ?? error.code), message: error.message }
    : { reason: 'invalid', message: error instanceof Error ? error.message : 'Not valid' });

  const importedProfiles: AgentProfileDefinition[] = [];
  for (const raw of input.document.profiles) {
    const key = String(raw.value ?? '');
    try {
      if (codeProfileValues.has(key)) throw keyTaken('profile', key);
      const parsed = profileRowInputSchema.safeParse(raw);
      if (!parsed.success) throw invalid(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'value'} ${issue.message}`).join('; '), { reason: 'invalid_registry_entry' });
      const checked = await checkProfile({ value: parsed.data.value, label: parsed.data.label, description: parsed.data.description, ...(parsed.data.tools ? { tools: parsed.data.tools } : {}) });
      importedProfiles.push(checked);
      (profileKeys.has(key) ? plan.profiles.updated : plan.profiles.created).push(key);
      if (!dryRun) {
        const { error } = await service.from('mcp_profile_rows').upsert({
          value: checked.value, label: checked.label, description: checked.description, tools: checked.tools ?? null,
          archived_at: null, updated_by: caller.memberId, ...(profileKeys.has(key) ? {} : { created_by: caller.memberId }),
        }, { onConflict: 'value' });
        if (error) throw error;
      }
    } catch (error) {
      plan.profiles.refused.push({ key, ...refusal(error) });
    }
  }

  for (const raw of input.document.templates) {
    const key = String(raw.key ?? '');
    try {
      if (codeTemplateKeys.has(key)) throw keyTaken('template', key);
      const parsed = templateRowInputSchema.safeParse(raw);
      if (!parsed.success) throw invalid(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'value'} ${issue.message}`).join('; '), { reason: 'invalid_registry_entry' });
      const template = parsed.data as unknown as AgentTemplate;
      // A profile from this same document counts, even on a dry run.
      const sameDocument = template.profile !== undefined && importedProfiles.some((profile) => profile.value === template.profile);
      let checked: AgentTemplate;
      if (sameDocument) {
        try {
          [checked] = defineAgentTemplates([template]);
        } catch (error) {
          checked = extensionProblem(error);
        }
      } else {
        checked = await checkTemplate(service, template);
      }
      (templateKeys.has(key) ? plan.templates.updated : plan.templates.created).push(key);
      if (!dryRun) {
        const { error } = await service.from('agent_template_rows').upsert({
          key: checked.key, label: checked.label, description: checked.description, spec: specOf(checked),
          archived_at: null, updated_by: caller.memberId, ...(templateKeys.has(key) ? {} : { created_by: caller.memberId }),
        }, { onConflict: 'key' });
        if (error) throw error;
      }
    } catch (error) {
      plan.templates.refused.push({ key, ...refusal(error) });
    }
  }
  return plan;
}
