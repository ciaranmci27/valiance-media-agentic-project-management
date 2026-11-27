import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import type { ModuleId } from '@/lib/modules/registry';
import type { PermissionKey } from '@/lib/access-control';

/**
 * Records are never permanently deleted: "delete" moves one to Trash and
 * Restore brings it back. Both go through database functions that check the
 * person's delete permission (a signed-in client) or trust the server route
 * that already checked it (the service role, which passes the acting member).
 * The database refuses DELETE on these tables outright.
 */
export const TRASH_TABLES = [
  'projects', 'tasks', 'task_comments', 'reminders', 'project_credentials',
  'entity_files', 'portal_updates', 'portal_update_attachments', 'contacts', 'leads',
  'lead_interactions', 'lead_proposals', 'lead_fields',
  'project_time_entries', 'project_invoices', 'invoice_payments', 'project_hourly_rates',
  'project_retainers', 'project_retainer_amounts', 'task_files', 'task_templates',
  'initiatives', 'initiative_entries',
] as const;

export type TrashTable = (typeof TRASH_TABLES)[number];

/**
 * The module each Trash table belongs to. A `Record`, so a new Trash table
 * does not compile until it is placed. Trash hides rows of a switched-off
 * module; they stay in Trash and show again when it is back on.
 */
export const TRASH_TABLE_MODULE: Record<TrashTable, ModuleId | 'core'> = {
  projects: 'core',
  tasks: 'core',
  task_comments: 'core',
  reminders: 'core',
  project_credentials: 'credentials',
  entity_files: 'core',
  portal_updates: 'portal',
  portal_update_attachments: 'portal',
  contacts: 'contacts',
  leads: 'sales',
  lead_interactions: 'sales',
  lead_proposals: 'sales',
  lead_fields: 'sales',
  project_time_entries: 'time',
  project_invoices: 'billing',
  invoice_payments: 'billing',
  project_hourly_rates: 'billing',
  project_retainers: 'billing',
  project_retainer_amounts: 'billing',
  task_files: 'core',
  task_templates: 'core',
  initiatives: 'core',
  initiative_entries: 'core',
};

export type TrashErrorReason = 'not_found' | 'forbidden' | 'blocked' | 'invalid';

/** Why a move to Trash or a restore was refused; `message` is written for the person. */
export class TrashError extends Error {
  constructor(public reason: TrashErrorReason, message: string) {
    super(message);
    this.name = 'TrashError';
  }
}

/** The HTTP status a route answers a refusal with. */
export const TRASH_ERROR_STATUS: Record<TrashErrorReason, number> = { not_found: 404, forbidden: 403, blocked: 409, invalid: 400 };

// The functions' error codes: P0002 not found, 42501 no permission, 55000
// blocked (what must happen first, or why it cannot), 22023 not a Trash type.
function toTrashError(error: { code?: string; message: string }): Error {
  switch (error.code) {
    case 'P0002': return new TrashError('not_found', 'Not found');
    case '42501': return new TrashError('forbidden', error.message);
    case '55000': return new TrashError('blocked', error.message.replace(/^PAYMENT_RECORDED_ELSEWHERE: /, ''));
    case '22023': return new TrashError('invalid', error.message);
    default: return new Error(error.message);
  }
}

async function call(
  supabase: SupabaseClient,
  fn: 'soft_delete_record' | 'restore_record',
  table: TrashTable,
  id: string,
  actor?: string | null,
): Promise<boolean> {
  const { data, error } = await supabase.rpc(fn, { p_table: table, p_id: id, ...(actor ? { p_actor: actor } : {}) });
  if (error) throw toTrashError(error);
  return data === true;
}

/**
 * Moves a record to Trash. `actor` is the team member acting, for server
 * routes on the service role; a signed-in client is stamped as itself.
 * Returns false when it was already in Trash.
 */
export function moveToTrash(supabase: SupabaseClient, table: TrashTable, id: string, actor?: string | null) {
  return call(supabase, 'soft_delete_record', table, id, actor);
}

/** Brings a record back from Trash exactly as it was. Returns false when it was not in Trash. */
export function restoreFromTrash(supabase: SupabaseClient, table: TrashTable, id: string, actor?: string | null) {
  return call(supabase, 'restore_record', table, id, actor);
}

/**
 * Ids of projects in Trash, for service-role reads that span projects: what
 * belongs to a trashed project is out of reach with it. Trash is small, so a
 * list beats a join on every read.
 */
export async function trashedProjectIds(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase.from('projects').select('id').not('deleted_at', 'is', null); // includes-deleted: lists the trashed ones
  if (error) throw error;
  return (data || []).map((row: { id: string }) => row.id);
}

/**
 * Ids of subtasks whose parent is in Trash: they went with it. For
 * service-role task lists, as trashedProjectIds.
 */
export async function hiddenSubtaskIds(supabase: SupabaseClient): Promise<string[]> {
  // Paged: a capped read would quietly bring older parents' subtasks back.
  const parents = await fetchAllRows<{ id: string }>((from, to, count) => supabase
    .from('tasks')
    .select('id', { count })
    .is('parent_task_id', null)
    .not('deleted_at', 'is', null) // includes-deleted: lists the trashed ones
    .order('id')
    .range(from, to));
  const parentIds = parents.map((row) => row.id);
  // Trash keeps every task ever deleted, so ask in chunks to keep URLs short.
  const hidden: string[] = [];
  for (let i = 0; i < parentIds.length; i += 100) {
    const { data, error: childError } = await supabase.from('tasks').select('id').in('parent_task_id', parentIds.slice(i, i + 100)).is('deleted_at', null);
    if (childError) throw childError;
    hidden.push(...(data || []).map((row: { id: string }) => row.id));
  }
  return hidden;
}

/** False when the project is missing or in Trash (and so is everything it owns). */
export async function projectIsLive(supabase: SupabaseClient, projectId: string | null | undefined): Promise<boolean> {
  if (!projectId) return false;
  const { data, error } = await supabase.from('projects').select('id').eq('id', projectId).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

/** A PostgREST `in` list, for `.not('project_id', 'in', postgrestList(ids))`. */
export function postgrestList(ids: string[]): string {
  return `(${ids.join(',')})`;
}

/** The record types the API names (GET /api/v1/trash, its restore route): the Trash tables. */
export const TRASH_TYPES = TRASH_TABLES;


/** Every permission one of the per-type rules can rest on: the withApi gate, so a key with none of them is refused up front. */
export const TRASH_PERMISSIONS: PermissionKey[] = [
  'projects.manage', 'tasks.read', 'tasks.manage_assigned', 'tasks.manage_all', 'tasks.create', 'reminders.manage_own',
  'credentials.manage', 'files.upload', 'files.manage', 'portal.manage', 'contacts.manage', 'leads.manage',
  'time.manage_own', 'time.manage_all', 'invoices.manage', 'invoices.record_payments', 'billing.manage', 'templates.manage',
];

