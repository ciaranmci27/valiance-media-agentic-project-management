import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';
import { insertProject, patchProject } from '@/lib/supabase/queries';
import { accessAllows, apiKeyAllows, sanitizeProjectForAccess } from './access';
import { forbidden } from './errors';

/**
 * Creating a project: the one path the screens (POST /api/workspace/projects),
 * the v1 API (POST /api/v1/projects) and one-call project setup all take, so
 * a project made any way gets the same checks.
 *
 * - From the screens: projects.manage; billing fields need billing.manage and
 *   the agent fields agents.manage (left out otherwise); member_ids need
 *   project_members.manage (otherwise the creator alone is on it), and each
 *   must be an active member.
 * - Over the API: the same field rules on the key's scopes; member_ids
 *   without project_members.manage are refused; a contact needs
 *   contacts.manage and is made inline when one is sent.
 */

export const BILLING_FIELDS = ['hourly_rate', 'budget_type', 'budget_value', 'billing_address', 'billing_email', 'tax_rate', 'invoice_pdf_options', 'client_time_billing'] as const;
export const AGENT_FIELDS = ['autonomous_enabled', 'auto_merge_enabled', 'integration_branch', 'production_branch', 'suggestions_per_cycle', 'suggestion_queue_cap', 'audit_interval_hours', 'sensitive_paths', 'repo_path'] as const;
export const CORE_FIELDS = ['name', 'description', 'color', 'status', 'start_date', 'due_date', 'hourly_tracking', 'time_tracking_enabled'] as const;
const WRITABLE_FIELDS = new Set<string>([...CORE_FIELDS, ...BILLING_FIELDS, ...AGENT_FIELDS]);

export function restrictProjectFields(project: Record<string, unknown>, canBilling: boolean, canAgents: boolean) {
  const restricted = Object.fromEntries(Object.entries(project).filter(([field]) => WRITABLE_FIELDS.has(field)));
  if (!canBilling) BILLING_FIELDS.forEach((field) => delete restricted[field]);
  if (!canAgents) AGENT_FIELDS.forEach((field) => delete restricted[field]);
  return restricted;
}

export async function validateMemberIds(service: SupabaseClient, memberIds: string[]) {
  const uniqueIds = [...new Set(memberIds)];
  if (uniqueIds.length === 0) return uniqueIds;
  const { data, error } = await service.from('team_members').select('id').in('id', uniqueIds).eq('status', 'active');
  if (error) throw error;
  if ((data || []).length !== uniqueIds.length) throw new Error('Every assigned team member must be active');
  return uniqueIds;
}

/** A refusal of the screens' create, with the status the route answers. */
export class ProjectCreateError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * The screens' create (POST /api/workspace/projects): the caller already
 * holds projects.manage. Answers the project as the caller may see it, with
 * member_ids. Throws ProjectCreateError.
 */
export async function createProjectFromSession(
  service: SupabaseClient,
  access: AccessContext,
  memberId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> & { id: string }> {
  if (typeof body.name !== 'string' || !body.name.trim()) throw new ProjectCreateError('Project name is required', 400);

  const canAssign = accessAllows(access, 'project_members.manage', 'app');
  const requestedMembers = Array.isArray(body.member_ids) ? body.member_ids.filter((id): id is string => typeof id === 'string') : [];
  let memberIds: string[];
  try {
    memberIds = await validateMemberIds(service, canAssign ? requestedMembers : [memberId]);
  } catch (error) {
    throw new ProjectCreateError(error instanceof Error ? error.message : 'Invalid team member assignment', 422);
  }
  const projectData = restrictProjectFields(body, accessAllows(access, 'billing.manage', 'app'), accessAllows(access, 'agents.manage', 'app'));
  delete projectData.member_ids;
  projectData.created_by = memberId;

  try {
    const project = await insertProject(service, projectData as never, memberIds);
    const patchedFields = Object.fromEntries([...BILLING_FIELDS, ...AGENT_FIELDS, 'time_tracking_enabled']
      .filter((field) => field in projectData)
      .map((field) => [field, projectData[field]]));
    const result = Object.keys(patchedFields).length > 0
      ? await patchProject(service, project.id, patchedFields, undefined)
      : project;
    return sanitizeProjectForAccess({ ...result, member_ids: memberIds } as unknown as Record<string, unknown>, access) as Record<string, unknown> & { id: string };
  } catch (error) {
    throw new ProjectCreateError(error instanceof Error ? error.message : 'Failed to create project', 500);
  }
}

/**
 * The API's create (POST /api/v1/projects), on a body already parsed by
 * createProjectSchema. Answers the project. Throws ApiError.
 */
export async function createProjectFromApi(
  supabase: SupabaseClient,
  ctx: { access: AccessContext; scopes: string[]; teamMemberId: string },
  body: Record<string, unknown>,
): Promise<Record<string, unknown> & { id: string }> {
  const { access, scopes, teamMemberId } = ctx;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the parsed body is read field by field
  const { member_ids, contact_id, contact, ...projectData } = body as any;
  if (Array.isArray(member_ids) && !apiKeyAllows(access, scopes, 'project_members.manage')) {
    throw forbidden('Assigning project members requires the project_members.manage API scope');
  }
  if (contact && !apiKeyAllows(access, scopes, 'contacts.manage')) {
    throw forbidden('Creating a project contact requires the contacts.manage API scope');
  }
  if (!apiKeyAllows(access, scopes, 'billing.manage')) {
    for (const field of BILLING_FIELDS) delete projectData[field];
  }
  if (!apiKeyAllows(access, scopes, 'agents.manage')) {
    for (const field of AGENT_FIELDS) delete projectData[field];
  }

  // Resolve contact: use existing contact_id, or create a new contact inline
  let resolvedContactId = contact_id || null;
  if (!resolvedContactId && contact) {
    const { data: newContact, error: contactError } = await supabase
      .from('contacts')
      .insert({
        name: contact.name,
        email: contact.email || '',
        phone: contact.phone || '',
        company: contact.company || '',
        color: projectData.color,
        created_by: teamMemberId || null,
      })
      .select()
      .single();

    if (contactError) throw contactError;
    resolvedContactId = newContact.id;
  }

  return insertProject(supabase, projectData, member_ids || [], resolvedContactId) as unknown as Promise<Record<string, unknown> & { id: string }>;
}
