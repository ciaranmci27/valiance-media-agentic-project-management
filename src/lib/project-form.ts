import type { Project } from '@/lib/types';

/**
 * A project's basic fields as the forms hold them (strings for what is
 * typed), and the one mapping from them to what a save sends. The Edit
 * project modal and the guided setup (/projects/new) both go through these,
 * so a project is created the same way from either. Pure.
 */

export interface ProjectBasics {
  name: string;
  description: string;
  color: string;
  status: Project['status'];
  startDate: string;
  dueDate: string;
  timeTracking: boolean;
  clientTimeBilling: 'hourly' | 'included';
  budgetType: 'hours' | 'amount' | '';
  budgetValue: string;
  billingAddress: string;
  billingEmail: string;
  taxRate: string;
  memberIds: string[];
  /** The primary client (a contact id), set after the project exists. */
  clientId: string;
}

export interface ProjectFormRights {
  manageBilling: boolean;
  manageMembers: boolean;
  manageContacts: boolean;
  manageAgents: boolean;
  /** The Time module is on: off, a save leaves the stored setting alone. */
  timeOn: boolean;
}

export const PROJECT_DESCRIPTION_MAX = 100;

export function emptyProjectBasics(memberId: string | null): ProjectBasics {
  return {
    name: '',
    description: '',
    color: '',
    status: 'active',
    startDate: '',
    dueDate: '',
    timeTracking: false,
    clientTimeBilling: 'included',
    budgetType: '',
    budgetValue: '',
    billingAddress: '',
    billingEmail: '',
    taxRate: '',
    memberIds: memberId ? [memberId] : [],
    clientId: '',
  };
}

const numberOrNull = (value: string) => (value && !isNaN(parseFloat(value)) ? parseFloat(value) : null);

/** What a basics form must hold before it saves; keys match the fields. */
export function validateProjectBasics(fields: ProjectBasics, opts: { creating: boolean; rights: Pick<ProjectFormRights, 'manageContacts'> }): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!fields.name.trim()) errors.name = 'Give the project a name.';
  if (fields.description.length > PROJECT_DESCRIPTION_MAX) errors.description = `Keep the description under ${PROJECT_DESCRIPTION_MAX} characters.`;
  if (opts.creating && opts.rights.manageContacts && !fields.clientId) errors.clientId = 'Pick the primary client.';
  if (fields.startDate && fields.dueDate && fields.dueDate < fields.startDate) errors.dueDate = 'The due date is before the start date.';
  if (fields.billingEmail.trim() && !/^\S+@\S+\.\S+$/.test(fields.billingEmail.trim())) errors.billingEmail = 'Enter an email address.';
  return errors;
}

/**
 * The project row a save sends. Fields the person may not change are left
 * out (billing without billing.manage, members without project member
 * rights), and an existing project keeps what this form does not show.
 */
export function projectPayload(
  fields: ProjectBasics,
  rights: ProjectFormRights,
  existing: Pick<Project, 'member_ids' | 'hourly_rate' | 'autonomous_enabled' | 'suggestions_per_cycle' | 'repo_path'> | null,
  self: string | null,
  agentFields?: { autonomous_enabled: boolean; suggestions_per_cycle: number },
): Omit<Project, 'id' | 'created_at' | 'updated_at'> {
  return {
    name: fields.name.trim(),
    description: fields.description.trim(),
    color: fields.color,
    status: fields.status,
    start_date: fields.startDate || null,
    due_date: fields.dueDate || null,
    hourly_tracking: fields.timeTracking,
    time_tracking_enabled: fields.timeTracking,
    member_ids: rights.manageMembers
      ? fields.memberIds
      : existing?.member_ids || (self ? [self] : []),
    ...(rights.manageBilling
      ? {
          client_time_billing: fields.clientTimeBilling,
          hourly_rate: existing?.hourly_rate ?? null,
          budget_type: fields.budgetType || null,
          budget_value: numberOrNull(fields.budgetValue),
          billing_address: fields.billingAddress.trim() || null,
          billing_email: fields.billingEmail.trim() || null,
          tax_rate: numberOrNull(fields.taxRate),
        }
      : {}),
    ...(rights.manageAgents && agentFields
      ? {
          autonomous_enabled: agentFields.autonomous_enabled,
          suggestions_per_cycle: agentFields.suggestions_per_cycle,
          repo_path: existing?.repo_path ?? null,
        }
      : {}),
  } as Omit<Project, 'id' | 'created_at' | 'updated_at'>;
}

/** An update leaves out what the person may not touch. */
export function projectUpdatePayload(payload: Partial<Project>, rights: Pick<ProjectFormRights, 'manageMembers' | 'timeOn'>): Partial<Project> {
  const update: Partial<Project> = { ...payload };
  if (!rights.manageMembers) delete update.member_ids;
  if (!rights.timeOn) {
    delete update.hourly_tracking;
    delete update.time_tracking_enabled;
  }
  return update;
}
