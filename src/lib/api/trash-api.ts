import type { SupabaseClient } from '@supabase/supabase-js';
import { isModuleEnabled, type AccessContext, type PermissionKey } from '@/lib/access-control';
import { restoreFromTrash, TRASH_TABLE_MODULE, TRASH_TABLES, type TrashTable } from '@/lib/supabase/trash';
import type { TrashItem } from '@/lib/types';
import { accessAllows, apiKeyAllows } from './access';
import { ApiError, notFound } from './errors';
import { readAll } from './read-all';
import { trashApiError } from './trash';
import { PERMISSION_IMPLIED_BY } from '@/lib/access-control';

/**
 * Trash over the API (GET /api/v1/trash, POST /api/v1/trash/{type}/{id}/restore).
 * A key sees and restores what its member could move to Trash over the API:
 * the same rules as pm.can_trash_record (the app's), read on the api channel,
 * with the key's scopes too. The database trusts the service role, so these
 * checks are the gate.
 *
 * Restoring is safe, so it is open to MCP; a credential's row is restored
 * over REST only (credentials never pass through an agent's tools).
 */

export { TRASH_PERMISSIONS, TRASH_TYPES } from '@/lib/supabase/trash';

export interface TrashCaller {
  service: SupabaseClient;
  access: AccessContext;
  scopes: string[];
  memberId: string;
}

type Row = Record<string, unknown> & { id: string };

function holds(caller: TrashCaller, permission: PermissionKey): boolean {
  return [permission, ...(PERMISSION_IMPLIED_BY[permission] ?? [])].some((p) => apiKeyAllows(caller.access, caller.scopes, p));
}

/**
 * Reach read once and shared by every row a call checks, so listing a page of
 * Trash costs a bounded number of queries (review of wave 3, finding 7): the
 * member's projects, leads and assigned tasks in one read each, and rows (the
 * records and their parents) read in batches.
 */
export interface TrashReach {
  projects?: Promise<Set<string>>;
  leads?: Promise<Set<string>>;
  assignedTasks?: Promise<Set<string>>;
  rows: Map<string, Row | null>;
}

export const trashReach = (): TrashReach => ({ rows: new Map() });

async function idSet(page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>, column: string): Promise<Set<string>> {
  const rows = await readAll<Record<string, string>>(page);
  return new Set(rows.map((row) => row[column]));
}

/** Project reach read directly: access.project_ids leaves out projects in Trash, and a project being restored is one. */
async function reachesProjectOf(caller: TrashCaller, reach: TrashReach, projectId: unknown): Promise<boolean> {
  if (typeof projectId !== 'string') return false;
  if (accessAllows(caller.access, 'projects.read_all', 'api')) return true;
  if (!accessAllows(caller.access, 'projects.read', 'api')) return false;
  reach.projects ??= idSet((from, to) => caller.service.from('project_members').select('project_id').eq('member_id', caller.memberId)
    .order('project_id').range(from, to), 'project_id');
  return (await reach.projects).has(projectId);
}

async function reachesLeadOf(caller: TrashCaller, reach: TrashReach, leadId: unknown): Promise<boolean> {
  if (typeof leadId !== 'string') return false;
  if (accessAllows(caller.access, 'leads.read_all', 'api')) return true;
  // Acting for a person, the agent's own assignment is no reach of theirs (withApi's lead rule).
  if (caller.access.principal_id) return false;
  // includes-deleted: a lead child's lead may itself be in Trash; who could open it is what counts
  reach.leads ??= Promise.all([
    idSet((from, to) => caller.service.from('leads').select('id').eq('assigned_to', caller.memberId).order('id').range(from, to), 'id'),
    idSet((from, to) => caller.service.from('lead_members').select('lead_id').eq('member_id', caller.memberId).order('lead_id').range(from, to), 'lead_id'),
  ]).then(([assigned, member]) => new Set([...assigned, ...member]));
  return (await reach.leads).has(leadId);
}

async function assignedToTask(caller: TrashCaller, reach: TrashReach, taskId: string): Promise<boolean> {
  reach.assignedTasks ??= idSet((from, to) => caller.service.from('task_assignees').select('task_id').eq('member_id', caller.memberId)
    .order('task_id').range(from, to), 'task_id');
  return (await reach.assignedTasks).has(taskId);
}

async function readRow(service: SupabaseClient, table: string, id: string): Promise<Row | null> {
  // includes-deleted: Trash reads records that are in it
  const { data, error } = await service.from(table).select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as Row | null) ?? null;
}

/** Ids per batched read: keeps the request address short. */
const ROW_BATCH = 100;
const rowKey = (table: string, id: string) => `${table}:${id}`;

/** Reads these rows of a table into the shared cache, a batch at a time; ids already read are skipped. */
async function readRows(service: SupabaseClient, reach: TrashReach, table: string, ids: string[]): Promise<void> {
  const wanted = [...new Set(ids)].filter((id) => !reach.rows.has(rowKey(table, id)));
  for (let i = 0; i < wanted.length; i += ROW_BATCH) {
    const batch = wanted.slice(i, i + ROW_BATCH);
    // includes-deleted: Trash reads records that are in it, and their parents whatever their state
    const { data, error } = await service.from(table).select('*').in('id', batch);
    if (error) throw error;
    const found = new Map(((data ?? []) as Row[]).map((row) => [row.id, row]));
    for (const id of batch) reach.rows.set(rowKey(table, id), found.get(id) ?? null);
  }
}

async function cachedRow(service: SupabaseClient, reach: TrashReach, table: string, id: string): Promise<Row | null> {
  const key = rowKey(table, id);
  if (!reach.rows.has(key)) reach.rows.set(key, await readRow(service, table, id));
  return reach.rows.get(key) ?? null;
}

/** The parent row a check reads, by the record's table: [parent table, column]. */
const PARENT_OF: Partial<Record<TrashTable, [string, string]>> = {
  task_comments: ['tasks', 'task_id'],
  task_files: ['tasks', 'task_id'],
  reminders: ['tasks', 'task_id'],
  portal_update_attachments: ['portal_updates', 'update_id'],
  invoice_payments: ['project_invoices', 'invoice_id'],
  project_retainer_amounts: ['project_retainers', 'retainer_id'],
};

/** Whether the key may move this record to Trash, and so see it there and restore it. */
export async function apiMayTrash(caller: TrashCaller, table: TrashTable, row: Row, reach: TrashReach = trashReach()): Promise<boolean> {
  const module = TRASH_TABLE_MODULE[table];
  if (module !== 'core' && !isModuleEnabled(caller.access, module)) return false;
  const me = caller.memberId;
  const parent = async (parentTable: string, column: string) => (typeof row[column] === 'string' ? cachedRow(caller.service, reach, parentTable, row[column] as string) : null);
  const reachesProject = (projectId: unknown) => reachesProjectOf(caller, reach, projectId);
  const reachesLead = (leadId: unknown) => reachesLeadOf(caller, reach, leadId);
  switch (table) {
    case 'projects':
      return holds(caller, 'projects.manage') && reachesProject(row.id);
    case 'tasks': {
      if (!(await reachesProject(row.project_id))) return false;
      if (holds(caller, 'tasks.manage_all')) return true;
      if (!row.parent_task_id || !holds(caller, 'tasks.manage_assigned')) return false;
      return assignedToTask(caller, reach, row.parent_task_id as string);
    }
    case 'task_comments': {
      const task = await parent('tasks', 'task_id');
      return !!task && holds(caller, 'tasks.read') && await reachesProject(task.project_id)
        && (row.user_id === me || holds(caller, 'tasks.manage_all'));
    }
    case 'task_files': {
      const task = await parent('tasks', 'task_id');
      return !!task && await reachesProject(task.project_id)
        && (holds(caller, 'files.manage') || (row.added_by === me && holds(caller, 'files.upload')));
    }
    case 'reminders':
      if (!holds(caller, 'reminders.manage_own')) return false;
      if (row.project_id && !(await reachesProject(row.project_id))) return false;
      if (row.task_id) {
        const task = await parent('tasks', 'task_id');
        if (!task || !(await reachesProject(task.project_id))) return false;
      }
      if (!row.project_id && !row.task_id && row.owner_id !== me) return false;
      return row.owner_id === me || row.created_by === me || holds(caller, 'tasks.manage_all');
    case 'project_credentials':
      return holds(caller, 'credentials.manage') && reachesProject(row.project_id);
    case 'entity_files': {
      const mayManage = holds(caller, 'files.manage') || (row.uploaded_by === me && row.visibility === 'internal' && holds(caller, 'files.upload'));
      if (!mayManage) return false;
      if (row.entity_type === 'project') return reachesProject(row.entity_id);
      if (row.entity_type === 'lead') return reachesLead(row.entity_id);
      if (row.entity_type === 'contact') return accessAllows(caller.access, 'contacts.read_all', 'api');
      return false;
    }
    case 'portal_updates':
      return holds(caller, 'portal.manage') && reachesProject(row.project_id);
    case 'portal_update_attachments': {
      const update = await parent('portal_updates', 'update_id');
      return !!update && !update.deleted_at && holds(caller, 'portal.manage') && reachesProject(update.project_id);
    }
    case 'contacts':
      return holds(caller, 'contacts.manage');
    case 'leads':
      return holds(caller, 'leads.manage');
    case 'lead_interactions':
    case 'lead_proposals':
    case 'lead_fields':
      return holds(caller, 'leads.manage') && reachesLead(row.lead_id);
    case 'project_time_entries':
      if (!(await reachesProject(row.project_id))) return false;
      return holds(caller, 'time.manage_all') || (holds(caller, 'time.manage_own') && row.member_id === me
        && ['draft', 'pending', 'rejected'].includes(String(row.approval_status)));
    case 'project_invoices':
      return holds(caller, 'invoices.manage') && reachesProject(row.project_id);
    case 'invoice_payments': {
      const invoice = await parent('project_invoices', 'invoice_id');
      return !!invoice && !invoice.deleted_at && row.recorded_via === 'app' && holds(caller, 'invoices.record_payments')
        && reachesProject(invoice.project_id);
    }
    case 'project_hourly_rates':
      return holds(caller, 'billing.manage') && reachesProject(row.project_id);
    case 'project_retainers':
      return holds(caller, 'invoices.manage') && reachesProject(row.project_id);
    case 'project_retainer_amounts': {
      const retainer = await parent('project_retainers', 'retainer_id');
      return !!retainer && !retainer.deleted_at && holds(caller, 'invoices.manage') && reachesProject(retainer.project_id);
    }
    case 'task_templates':
      if (!row.project_id) return holds(caller, 'templates.manage');
      return (holds(caller, 'templates.manage') || holds(caller, 'projects.manage')) && reachesProject(row.project_id);
    case 'initiatives':
      return await reachesProject(row.project_id)
        && (holds(caller, 'projects.manage') || (row.created_by === me && holds(caller, 'tasks.create')));
    case 'initiative_entries':
      return caller.access.role !== 'guest' && holds(caller, 'tasks.read') && await reachesProject(row.project_id)
        && (row.created_by === me || holds(caller, 'projects.manage'));
    case 'groups':
      // An Owner or Manage groups, as the groups routes (canManageGroups).
      return (caller.access.role === 'owner' && caller.access.status === 'active') || holds(caller, 'groups.manage');
    default:
      return false;
  }
}

/** What is in Trash that the key could restore, newest first, optionally of some types. */
export async function listTrashForApi(caller: TrashCaller, types: TrashTable[] | null, limit: number): Promise<TrashItem[]> {
  const { data, error } = await caller.service.rpc('list_trash', { p_types: types, p_limit: 2000 });
  if (error) throw error;
  const items = ((data ?? []) as TrashItem[]).sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
  const reach = trashReach();
  const out: TrashItem[] = [];
  // A window at a time, in order: its rows and their parents in one read per table, then the checks from the shared reach.
  for (let start = 0; start < items.length && out.length < limit; start += ROW_BATCH) {
    const window = items.slice(start, start + ROW_BATCH).filter((item) => TRASH_TABLES.includes(item.record_type as TrashTable));
    const byTable = new Map<TrashTable, string[]>();
    for (const item of window) byTable.set(item.record_type as TrashTable, [...(byTable.get(item.record_type as TrashTable) ?? []), item.id]);
    for (const [table, ids] of byTable) await readRows(caller.service, reach, table, ids);
    const parents = new Map<string, string[]>();
    for (const [table, ids] of byTable) {
      const link = PARENT_OF[table];
      if (!link) continue;
      for (const id of ids) {
        const parentId = reach.rows.get(rowKey(table, id))?.[link[1]];
        if (typeof parentId === 'string') parents.set(link[0], [...(parents.get(link[0]) ?? []), parentId]);
      }
    }
    for (const [table, ids] of parents) await readRows(caller.service, reach, table, ids);
    for (const item of window) {
      if (out.length >= limit) break;
      const table = item.record_type as TrashTable;
      const row = reach.rows.get(rowKey(table, item.id)) ?? null;
      if (row && await apiMayTrash(caller, table, row, reach)) out.push(item);
    }
  }
  return out;
}

/**
 * Brings one record back for the key's member. Not found, not in Trash, or
 * out of the key's reach all answer 404 (the answer never confirms an id it
 * may not restore); what still blocks it (its task or project in Trash) is 409.
 */
export async function restoreForApi(caller: TrashCaller, table: TrashTable, id: string): Promise<{ restored: true; record_type: TrashTable; id: string }> {
  const row = await readRow(caller.service, table, id);
  if (!row || !row.deleted_at || !(await apiMayTrash(caller, table, row))) {
    throw new ApiError(404, 'NOT_FOUND', 'Not found in Trash', { reason: 'not_in_trash', hint: 'GET /api/v1/trash lists what this key can restore.' });
  }
  let restored: boolean;
  try {
    restored = await restoreFromTrash(caller.service, table, id, caller.memberId);
  } catch (error) {
    throw trashApiError(error, 'Record');
  }
  if (!restored) throw notFound('Record in Trash');
  return { restored: true, record_type: table, id };
}
