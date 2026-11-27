import { z } from 'zod';
import { BRIEF_ENTRY_MAX, BRIEF_SECTION_KEYS, type BriefEntry, type BriefSection } from '@/lib/project-brief';

/**
 * Context at every level: the same entries a project brief holds (sections,
 * pinned, search), for five scopes. One store, pm.project_context, with
 * scope_type and scope_id; a project's rows are what they always were.
 *
 * - workspace: company knowledge, for every member (not guests).
 * - group: a group's knowledge, for its members (and whoever manages groups).
 * - project: a project's brief, exactly as before.
 * - agent: an agent's own notes, for that agent and the people who manage it.
 * - member: one person's memory, for that person (their own keys and
 *   connected AI tools only with context.memory) and their own personal
 *   agent only (while they allow it with "Remember things for me"). Never
 *   an Owner, never anyone else.
 * - initiative: an initiative's brief (standing knowledge about that body
 *   of work), for whoever reads its project's context. Its log is not here:
 *   that is the dated record (initiative_entries).
 *
 * Pinned entries of the workspace, the agent's groups, the task's project,
 * the agent itself and (for a personal agent) its person's memory go into
 * the agent's context pack and task brief, bounded; the rest are found by
 * search_context.
 */

export const CONTEXT_SCOPES = ['workspace', 'group', 'project', 'agent', 'member', 'initiative'] as const;
export type ContextScope = (typeof CONTEXT_SCOPES)[number];

export function isContextScope(value: unknown): value is ContextScope {
  return typeof value === 'string' && (CONTEXT_SCOPES as readonly string[]).includes(value);
}

export interface ScopeRef {
  scope_type: ContextScope;
  /** The group, project, agent, person or initiative; null for the workspace. */
  scope_id: string | null;
}

export const SCOPE_WORDS: Record<ContextScope, { label: string; says: string }> = {
  workspace: { label: 'Company knowledge', says: 'What everyone here should know.' },
  group: { label: 'Group knowledge', says: "What this group's members should know." },
  project: { label: 'Project brief', says: 'What every agent and person on this project should know.' },
  agent: { label: 'Agent notes', says: 'What this agent should always keep in mind.' },
  member: { label: 'What it remembers', says: 'What your assistant remembers about you. Only you and your assistant see it.' },
  initiative: { label: 'Initiative brief', says: 'What every agent and person working on this initiative should know.' },
};

/** One entry with the scope it belongs to (search results, the pack's scoped context). */
export interface ScopedEntry extends BriefEntry {
  scope_type: ContextScope;
  scope_id: string | null;
}

/** A scope's entries as sections, like a project brief without goals. */
export interface ScopedBrief {
  scope: ScopeRef;
  /** The scope's name for people: the group's, project's, agent's or person's. */
  name: string | null;
  sections: BriefSection[];
  /** Whether the reader may add, change and remove entries here. */
  can_edit: boolean;
  /** Pinned entries in the whole scope (a full read only). */
  pinned_total?: number;
}

const uuid = z.uuid('scope_id must be an id');

/** A scope named on a request: scope_id for every scope but the workspace. */
export const scopeRefSchema = z.object({
  scope_type: z.enum(CONTEXT_SCOPES),
  scope_id: uuid.nullable().optional(),
}).refine((ref) => (ref.scope_type === 'workspace') === !ref.scope_id, {
  message: 'scope_id names the group, project, agent or person; leave it out for the workspace',
  path: ['scope_id'],
});

/** POST /api/v1/context and add_context: an entry in a scope. */
export const addScopedEntrySchema = z.object({
  scope_type: z.enum(CONTEXT_SCOPES),
  scope_id: uuid.nullable().optional(),
  section: z.enum(BRIEF_SECTION_KEYS).optional(),
  content: z.string().trim().min(1, 'Content is required').max(BRIEF_ENTRY_MAX),
  pinned: z.boolean().optional(),
}).strict().refine((ref) => (ref.scope_type === 'workspace') === !ref.scope_id, {
  message: 'scope_id names the group, project, agent or person; leave it out for the workspace',
  path: ['scope_id'],
});
export type AddScopedEntry = z.infer<typeof addScopedEntrySchema>;

/** PATCH an entry: content, section or pinned. */
export const patchScopedEntrySchema = z.object({
  section: z.enum(BRIEF_SECTION_KEYS).optional(),
  content: z.string().trim().min(1).max(BRIEF_ENTRY_MAX).optional(),
  pinned: z.boolean().optional(),
  /** A person confirms an agent's entry: "Written by an agent" clears. */
  checked: z.literal(true).optional(),
}).strict().refine((body) => Object.keys(body).length > 0, 'Send something to change');
export type PatchScopedEntry = z.infer<typeof patchScopedEntrySchema>;

/** POST /api/v1/context/clear: every note an agent wrote in its own notes, archived. */
export const clearAgentNotesSchema = z.object({
  scope_type: z.literal('agent'),
  scope_id: uuid,
  written_by: z.literal('agent'),
}).strict();
export type ClearAgentNotes = z.infer<typeof clearAgentNotesSchema>;

/** POST /api/v1/context/restore: archived entries back (the Undo of Clear or Remove). */
export const restoreEntriesSchema = z.object({
  entry_ids: z.array(uuid).min(1).max(200),
}).strict();
export type RestoreEntries = z.infer<typeof restoreEntriesSchema>;

/** The URL segment the screens use for a scope: workspace, or group/agent/member with ?scope_id=. */
export function scopeQuery(ref: ScopeRef): string {
  return ref.scope_id ? `?scope_id=${encodeURIComponent(ref.scope_id)}` : '';
}
