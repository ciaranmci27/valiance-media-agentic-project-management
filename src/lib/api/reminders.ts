import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';
import { accessAllows, accessAllowsProject } from './access';
import { badRequest, forbidden, notFound } from './errors';

/**
 * Reminders over the API. Routes run with the service client, so the
 * visibility the database gives a signed-in member is enforced here instead:
 * a caller sees their own reminders, ones they wrote (an agent following up
 * on a reminder it made for someone), and shared ones on projects they can
 * open. A reminder may belong to someone else only when an agent or a task
 * manager writes it: an agent turning an email into "remind Ciaran" is the
 * case this exists for.
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use HH:MM (24-hour)');

export const createReminderSchema = z.object({
  title: z.string().trim().min(1).max(500),
  notes: z.string().max(5000).optional(),
  remind_on: date.nullable().optional(),
  remind_at: time.nullable().optional(),
  task_id: z.uuid().nullable().optional(),
  project_id: z.uuid().nullable().optional(),
  owner_id: z.uuid().optional(),
}).strict().refine((r) => !r.remind_at || !!r.remind_on, { message: 'A time needs a date (remind_on)', path: ['remind_at'] });

export const updateReminderSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  notes: z.string().max(5000).optional(),
  remind_on: date.nullable().optional(),
  remind_at: time.nullable().optional(),
  status: z.enum(['open', 'done']).optional(),
}).strict().refine((r) => Object.values(r).some((v) => v !== undefined), { message: 'Send at least one field to change' });

export const REMINDER_SELECT = '*, task:tasks(title, status), project:projects(name)';

export interface ReminderRow {
  id: string;
  owner_id: string;
  created_by: string | null;
  project_id: string | null;
  task_id: string | null;
  remind_on: string | null;
  remind_at: string | null;
  status: 'open' | 'done';
}

export function canSeeReminder(access: AccessContext, memberId: string, row: ReminderRow): boolean {
  return row.owner_id === memberId
    || row.created_by === memberId
    || (!!row.project_id && accessAllowsProject(access, row.project_id, 'api'));
}

/** Delete is narrower than edit: the owner, the writer, or a task manager. */
export function canDeleteReminder(access: AccessContext, memberId: string, row: ReminderRow): boolean {
  return row.owner_id === memberId || row.created_by === memberId || accessAllows(access, 'tasks.manage_all', 'api');
}

/** The `.or()` filter for every reminder the caller may see. */
export function visibleReminderFilter(access: AccessContext, memberId: string): string {
  const own = `owner_id.eq.${memberId},created_by.eq.${memberId}`;
  if (accessAllows(access, 'projects.read_all', 'api')) return `${own},project_id.not.is.null`;
  const projects = accessAllows(access, 'projects.read', 'api') ? access.project_ids : [];
  return projects.length ? `${own},project_id.in.(${projects.join(',')})` : own;
}

export async function loadReminder(supabase: SupabaseClient, access: AccessContext, memberId: string, id: string) {
  const { data, error } = await supabase.from('reminders').select(REMINDER_SELECT).eq('id', id).maybeSingle();
  if (error) throw error;
  // Hidden and missing read the same, so ids cannot be probed.
  if (!data || !canSeeReminder(access, memberId, data as ReminderRow)) throw notFound('Reminder');
  return data as ReminderRow & Record<string, unknown>;
}

/**
 * Where a new reminder hangs: a task (its project comes with it), a
 * project, or nothing. The caller must be able to open what it names.
 */
export async function resolveReminderPlace(
  supabase: SupabaseClient,
  access: AccessContext,
  input: { task_id?: string | null; project_id?: string | null },
): Promise<{ task_id: string | null; project_id: string | null }> {
  if (input.task_id) {
    const { data: task, error } = await supabase.from('tasks').select('id, project_id').eq('id', input.task_id).maybeSingle();
    if (error) throw error;
    if (!task || !accessAllowsProject(access, task.project_id, 'api')) throw notFound('Task');
    if (input.project_id && input.project_id !== task.project_id) {
      throw badRequest('project_id does not match the task\'s project; send task_id alone');
    }
    return { task_id: task.id, project_id: task.project_id };
  }
  if (input.project_id) {
    if (!accessAllowsProject(access, input.project_id, 'api')) throw notFound('Project');
    return { task_id: null, project_id: input.project_id };
  }
  return { task_id: null, project_id: null };
}

/** Whose reminder it is: the caller, unless an agent or task manager names someone. */
export async function resolveReminderOwner(
  supabase: SupabaseClient,
  access: AccessContext,
  memberId: string,
  ownerId: string | undefined,
): Promise<string> {
  if (!ownerId || ownerId === memberId) return memberId;
  if (access.role !== 'agent' && !accessAllows(access, 'tasks.manage_all', 'api')) {
    throw forbidden('Only an agent or a task manager can write a reminder for someone else');
  }
  const { data: owner, error } = await supabase.from('team_members').select('id, status').eq('id', ownerId).maybeSingle();
  if (error) throw error;
  if (!owner || owner.status !== 'active') throw badRequest('owner_id is not an active team member');
  return owner.id;
}
