import type { SupabaseClient } from '@supabase/supabase-js';
import { isModuleEnabled } from '@/lib/access-control';
import {
  BRIEF_ENTRY_MAX,
  BRIEF_SEARCH_MAX,
  BRIEF_SECTION_PAGE,
  BRIEF_SECTIONS,
  SECTION_CATEGORY,
  sectionOfCategory,
  type BriefEntry,
  type BriefGoal,
  type BriefSection,
  type BriefSectionKey,
  type ProjectBrief,
} from '@/lib/project-brief';
import { callerHolds, type AgentCaller } from './agent-owners';
import { requireReachableProject } from './project-agents';
import { BRIEF_CONTEXT_COLUMNS } from './project-context';
import { ApiError, forbidden, notFound } from './errors';

/**
 * A project's brief: its context entries read as sections, plus its goals.
 * One store (pm.project_context), so get_project_context, the fleet's
 * add_project_context and the brief always agree.
 *
 * - Read with project_context.read on a project the caller reaches; goals
 *   too with goals.read while AI agents is on (else named in omitted).
 * - Write with project_context.manage. Removing an entry archives it
 *   (is_active false), as the v1 route always has.
 * - Bounded: each section answers its first BRIEF_SECTION_PAGE entries
 *   (pinned first, then the newest) with its total; ?section= pages one
 *   section; search answers at most BRIEF_SEARCH_MAX, best first, over the
 *   full-text index.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const missingColumn = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === '42703' || error.code === 'PGRST204' || error.code === 'PGRST202' || error.code === '42883'
    || /section|pinned|search_project_context/.test(error.message ?? ''));

function pending(): ApiError {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'The project brief needs the database update 20261124000800_agent_workspaces.sql', { reason: 'migration_pending' });
}

export function briefEntry(row: Row): BriefEntry {
  return {
    id: row.id,
    section: (row.section ?? sectionOfCategory(row.category)) as BriefSectionKey,
    category: row.category,
    content: row.content,
    pinned: row.pinned === true,
    source: row.source,
    file_path: row.file_path ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(typeof row.rank === 'number' ? { rank: row.rank } : {}),
  };
}

function requireRead(caller: AgentCaller) {
  if (!callerHolds(caller, 'project_context.read') && !callerHolds(caller, 'project_context.manage')) {
    throw forbidden('Reading a project brief needs project_context.read', { reason: 'missing_permission', needs: 'project_context.read' });
  }
}

function requireWrite(caller: AgentCaller) {
  if (!callerHolds(caller, 'project_context.manage')) {
    throw forbidden('Changing a project brief needs project_context.manage', { reason: 'missing_permission', needs: 'project_context.manage' });
  }
}

/** One section's entries, pinned first then newest, paged, with its total. */
async function sectionPage(service: SupabaseClient, projectId: string, section: BriefSectionKey, offset: number, limit: number): Promise<BriefSection> {
  const { data, error, count } = await service
    .from('project_context')
    .select(BRIEF_CONTEXT_COLUMNS, { count: 'exact' })
    .eq('project_id', projectId)
    .eq('section', section)
    .eq('is_active', true)
    .order('pinned', { ascending: false })
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (missingColumn(error)) throw pending();
  if (error) throw error;
  const label = BRIEF_SECTIONS.find((s) => s.key === section)?.label ?? section;
  return { key: section, label, entries: ((data ?? []) as unknown as Row[]).map(briefEntry), total: count ?? 0 };
}

/**
 * The brief: every section's first page (or one section's page with
 * section), and the project's live goals.
 */
export async function readBrief(
  service: SupabaseClient,
  caller: AgentCaller,
  projectId: string,
  options: { section?: BriefSectionKey | null; offset?: number; limit?: number } = {},
): Promise<ProjectBrief> {
  requireRead(caller);
  await requireReachableProject(service, caller, projectId);
  const limit = Math.min(Math.max(options.limit ?? BRIEF_SECTION_PAGE, 1), 200);
  const keys = options.section ? [options.section] : BRIEF_SECTIONS.map((s) => s.key);
  const omitted: string[] = [];
  const seeGoals = isModuleEnabled(caller.access, 'agents') && (callerHolds(caller, 'goals.read') || callerHolds(caller, 'goals.manage'));
  if (!seeGoals) omitted.push('goals');
  const [sections, goals] = await Promise.all([
    Promise.all(keys.map((key) => sectionPage(service, projectId, key, options.section ? options.offset ?? 0 : 0, limit))),
    seeGoals
      ? service.from('project_goals').select('id, title, description, target_date, status, created_at').eq('project_id', projectId)
        .is('archived_at', null).order('created_at').limit(50)
        .then(({ data, error }) => { if (error) throw error; return (data ?? []) as Row[]; })
      : Promise.resolve([] as Row[]),
  ]);
  return {
    sections,
    goals: goals.map((goal): BriefGoal => ({
      id: goal.id, title: goal.title, description: goal.description ?? null, target_date: goal.target_date ?? null, status: goal.status,
    })),
    omitted,
  };
}

export interface BriefEntryInput {
  section: BriefSectionKey;
  content: string;
  pinned?: boolean;
}

function checkContent(content: unknown): string {
  if (typeof content !== 'string' || !content.trim()) throw new ApiError(422, 'VALIDATION_ERROR', 'Content is required', { reason: 'content_required' });
  if (content.length > BRIEF_ENTRY_MAX) {
    throw new ApiError(422, 'VALIDATION_ERROR', `An entry must be ${BRIEF_ENTRY_MAX} characters or fewer`, { reason: 'content_too_long', max: BRIEF_ENTRY_MAX });
  }
  return content;
}

/** The row a new brief entry is stored as: its section's category, so readers by category find it. */
export function briefInsertRow(projectId: string, input: BriefEntryInput, source: 'human' | 'agent' = 'human'): Row {
  return {
    project_id: projectId,
    category: SECTION_CATEGORY[input.section],
    section: input.section,
    content: checkContent(input.content),
    pinned: input.pinned === true,
    source,
  };
}

export async function addBriefEntry(service: SupabaseClient, caller: AgentCaller, projectId: string, input: BriefEntryInput): Promise<BriefEntry> {
  requireWrite(caller);
  await requireReachableProject(service, caller, projectId);
  const { data, error } = await service.from('project_context')
    .insert(briefInsertRow(projectId, input, caller.access.role === 'agent' ? 'agent' : 'human'))
    .select(BRIEF_CONTEXT_COLUMNS).single();
  if (missingColumn(error)) throw pending();
  if (error) throw error;
  return briefEntry(data as unknown as Row);
}

async function loadEntry(service: SupabaseClient, projectId: string, entryId: string): Promise<Row> {
  const { data, error } = await service.from('project_context').select(BRIEF_CONTEXT_COLUMNS).eq('id', entryId).eq('project_id', projectId).maybeSingle();
  if (missingColumn(error)) throw pending();
  if (error) throw error;
  if (!data) throw notFound('Brief entry');
  return data as unknown as Row;
}

export interface BriefEntryPatch {
  section?: BriefSectionKey;
  content?: string;
  pinned?: boolean;
  is_active?: boolean;
}

export async function updateBriefEntry(service: SupabaseClient, caller: AgentCaller, projectId: string, entryId: string, patch: BriefEntryPatch) {
  requireWrite(caller);
  await requireReachableProject(service, caller, projectId);
  const before = await loadEntry(service, projectId, entryId);
  const changes: Row = {};
  if (patch.content !== undefined) changes.content = checkContent(patch.content);
  if (patch.pinned !== undefined) changes.pinned = patch.pinned;
  if (patch.is_active !== undefined) changes.is_active = patch.is_active;
  if (patch.section !== undefined && patch.section !== before.section) {
    changes.section = patch.section;
    // The category follows the section, unless the category already reads in it.
    if (sectionOfCategory(before.category) !== patch.section) changes.category = SECTION_CATEGORY[patch.section];
  }
  if (Object.keys(changes).length === 0) return { before: briefEntry(before), entry: briefEntry(before) };
  const { data, error } = await service.from('project_context').update(changes).eq('id', entryId).eq('project_id', projectId)
    .select(BRIEF_CONTEXT_COLUMNS).single();
  if (error) throw error;
  return { before: briefEntry(before), entry: briefEntry(data as unknown as Row) };
}

/** Archives an entry (is_active false), as DELETE /api/v1/projects/{id}/context/{entryId} does. */
export async function removeBriefEntry(service: SupabaseClient, caller: AgentCaller, projectId: string, entryId: string) {
  return updateBriefEntry(service, caller, projectId, entryId, { is_active: false });
}

/**
 * Active entries matching a query, best first, over the full-text index.
 * Answers [] for a blank query.
 */
export async function searchProjectContext(service: SupabaseClient, projectId: string, query: string, limit = 20): Promise<BriefEntry[]> {
  const q = query.trim().slice(0, 500);
  if (!q) return [];
  const { data, error } = await service.rpc('search_project_context', {
    p_project_id: projectId,
    p_query: q,
    p_limit: Math.min(Math.max(Math.trunc(limit) || 20, 1), BRIEF_SEARCH_MAX),
  });
  if (missingColumn(error)) throw pending();
  if (error) throw error;
  return ((data ?? []) as Row[]).map(briefEntry);
}

/** The brief's search for a caller: read permission and project reach checked first. */
export async function searchBrief(service: SupabaseClient, caller: AgentCaller, projectId: string, query: string, limit?: number) {
  requireRead(caller);
  await requireReachableProject(service, caller, projectId);
  return searchProjectContext(service, projectId, query, limit);
}

/**
 * Pinned entries of several projects in one read, newest first, at most
 * `perProject` each and `max` in all: what an agent's context carries.
 * Answers the entries by project and how many were left out.
 */
export async function pinnedEntries(service: SupabaseClient, projectIds: string[], perProject: number, max: number) {
  const out = new Map<string, BriefEntry[]>();
  let more = 0;
  if (projectIds.length === 0) return { byProject: out, more };
  const { data, error } = await service.from('project_context').select(BRIEF_CONTEXT_COLUMNS)
    .in('project_id', projectIds).eq('pinned', true).eq('is_active', true)
    .order('updated_at', { ascending: false }).limit(max + projectIds.length * perProject);
  // Before the update there is nothing pinned.
  if (missingColumn(error)) return { byProject: out, more };
  if (error) throw error;
  let taken = 0;
  for (const row of (data ?? []) as unknown as Row[]) {
    const list = out.get(row.project_id) ?? [];
    if (list.length >= perProject || taken >= max) { more++; continue; }
    list.push(briefEntry(row));
    out.set(row.project_id, list);
    taken++;
  }
  return { byProject: out, more };
}
