import type { TeamActivity } from '@/lib/types';

/**
 * The team activity log stores each row as a sentence that starts with its
 * verb ("Completed task …"); after a person's name it reads "Maya completed
 * task …".
 */
export function activityAfterName(description: string): string {
  return description ? description.charAt(0).toLowerCase() + description.slice(1) : description;
}

const PROJECT_TAB_BY_ENTITY: Record<string, string> = {
  time_entry: 'time',
  invoice: 'billing',
  payment: 'billing',
  hourly_rate: 'billing',
  retainer: 'billing',
  retainer_amount: 'billing',
  file: 'files',
  credential: 'credentials',
  portal_update: 'portal',
  portal_update_attachment: 'portal',
  communication: 'communication',
};

/** Where a row leads: the task it is about, the project tab that shows it, or the lead or contact. */
export function teamActivityHref(activity: TeamActivity): string | null {
  const meta = activity.metadata ?? {};
  const taskId = typeof meta.task_id === 'string' ? meta.task_id : null;
  if (activity.project_id) {
    if (taskId) return `/projects/${activity.project_id}?task=${taskId}`;
    const tab = PROJECT_TAB_BY_ENTITY[activity.entity_type];
    return tab ? `/projects/${activity.project_id}?tab=${tab}` : `/projects/${activity.project_id}`;
  }
  if (typeof meta.lead_id === 'string') return `/leads/${meta.lead_id}`;
  if (activity.entity_type === 'contact') return `/contacts/${activity.entity_id}`;
  return null;
}
