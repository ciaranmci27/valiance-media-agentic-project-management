import type { TeamActivity } from '@/lib/types';
import { isModuleEnabled, type AccessContext } from '@/lib/access-control';
import type { ModuleId } from '@/lib/modules/registry';

/**
 * The team activity log stores each row as a sentence that starts with its
 * verb ("Completed task …"); after a person's name it reads "Maya completed
 * task …".
 */
export function activityAfterName(description: string): string {
  return description ? description.charAt(0).toLowerCase() + description.slice(1) : description;
}

const PROJECT_TAB_BY_ENTITY: Record<string, { tab: string; module?: ModuleId }> = {
  time_entry: { tab: 'time', module: 'time' },
  invoice: { tab: 'billing', module: 'billing' },
  payment: { tab: 'billing', module: 'billing' },
  hourly_rate: { tab: 'billing', module: 'billing' },
  retainer: { tab: 'billing', module: 'billing' },
  retainer_amount: { tab: 'billing', module: 'billing' },
  file: { tab: 'files' },
  credential: { tab: 'credentials', module: 'credentials' },
  portal_update: { tab: 'portal', module: 'portal' },
  portal_update_attachment: { tab: 'portal', module: 'portal' },
  communication: { tab: 'communication', module: 'inbox' },
};

/**
 * Where a row leads: the task it is about, the project tab that shows it, or
 * the lead or contact. With `access`, a row never leads into a switched-off
 * module: a project row opens the project itself, and a lead or contact row
 * has no link and reads as plain text.
 */
export function teamActivityHref(activity: TeamActivity, access?: AccessContext | null): string | null {
  const meta = activity.metadata ?? {};
  const taskId = typeof meta.task_id === 'string' ? meta.task_id : null;
  const on = (mod?: ModuleId) => !mod || isModuleEnabled(access, mod);
  if (activity.project_id) {
    if (taskId) return `/projects/${activity.project_id}?task=${taskId}`;
    const target = PROJECT_TAB_BY_ENTITY[activity.entity_type];
    return target && on(target.module) ? `/projects/${activity.project_id}?tab=${target.tab}` : `/projects/${activity.project_id}`;
  }
  if (typeof meta.lead_id === 'string') return on('sales') ? `/leads/${meta.lead_id}` : null;
  if (activity.entity_type === 'contact') return on('contacts') ? `/contacts/${activity.entity_id}` : null;
  return null;
}
