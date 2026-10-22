import { SupabaseClient } from '@supabase/supabase-js';
import type { AiReadiness, Project, Task, TeamMember, Subtask, AcceptanceCriterion, Comment, Activity, Contact, ContactEmail, ProjectContact, Lead, LeadInteraction, LeadProposal, LeadField, LeadContact, PortalSettings, PortalUpdate, PortalUpdateAttachment, EntityFile, ApiKey, ProjectGoal, TaskSuggestion, AgentActivity, FleetAgentActivity, ApiAuditEntry, TimeEntry, ProjectCredential, ProjectCredentialListItem, ProjectInvoice, InvoicePayment, InvoicePaymentMethod, BusinessSettings, InvoiceTimeEntryAllocation, WebhookEndpoint, WebhookDelivery, ProjectRetainer, ProjectRetainerAmount, ProjectRetainerShare, ProjectRetainerPeriod, RetainerDuePeriod, InvoiceLineShare, ProjectBillingPlan, ProjectBillingRun, BillingForecastItem, Reminder, TrashItem } from '@/lib/types';
import { fetchAllRows } from '@/lib/supabase/fetch-all';
import { notFound } from '@/lib/api/errors';
import { siteConfig } from '@/site-config';
import { generatePortalSlug } from '@/lib/portal-slug';
import { ensureLineItems } from '@/lib/invoice-utils';
import { TELEMETRY_EVENT_TYPES } from '@/lib/agent-events';
import { activitiesFromWindow, type AnalyticsWindowPayload } from '@/lib/agent-analytics-window';
import { moveToTrash, postgrestList, trashedProjectIds } from '@/lib/supabase/trash';

// ============================================================
// PROJECTS
// ============================================================

export async function fetchProjects(supabase: SupabaseClient) {
  const { data: projects, error } = await supabase
    .from('projects')
    .select(`
      *,
      project_members ( member_id ),
      project_hourly_rates ( hourly_rate, effective_at )
    `)
    .is('deleted_at', null)
    .is('project_hourly_rates.deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) throw error;

  type ProjectRateJoin = { hourly_rate: number; effective_at: string };
  type ProjectMemberJoin = { member_id: string };
  type ProjectWithJoins = Project & {
    project_members?: ProjectMemberJoin[];
    project_hourly_rates?: ProjectRateJoin[];
  };
  const now = Date.now();
  return ((projects || []) as ProjectWithJoins[]).map((p) => {
    const activeRate = (p.project_hourly_rates || [])
      .filter((rate) => new Date(rate.effective_at).getTime() <= now)
      .sort((a, b) => b.effective_at.localeCompare(a.effective_at))[0];
    return {
      ...p,
      hourly_rate: activeRate ? Number(activeRate.hourly_rate) : p.hourly_rate,
      member_ids: (p.project_members || []).map((pm) => pm.member_id),
      project_members: undefined,
      project_hourly_rates: undefined,
    };
  }) as Project[];
}

export async function insertProject(
  supabase: SupabaseClient,
  project: Omit<Project, 'id' | 'created_at' | 'updated_at' | 'member_ids'>,
  memberIds: string[],
  contactId?: string | null
) {
  const { data, error } = await supabase
    .from('projects')
    .insert({
      name: project.name,
      description: project.description,
      color: project.color,
      status: project.status,
      start_date: project.start_date,
      due_date: project.due_date,
      hourly_tracking: project.hourly_tracking ?? false,
      autonomous_enabled: project.autonomous_enabled ?? false,
      auto_merge_enabled: project.auto_merge_enabled ?? false,
      integration_branch: project.integration_branch ?? 'dev',
      production_branch: project.production_branch ?? 'main',
      suggestion_queue_cap: project.suggestion_queue_cap ?? 10,
      audit_interval_hours: project.audit_interval_hours ?? 4,
      suggestions_per_cycle: project.suggestions_per_cycle ?? 2,
      repo_path: project.repo_path ?? null,
      created_by: project.created_by,
    })
    .select()
    .single();

  if (error) throw error;

  if (memberIds.length > 0) {
    const { error: junctionError } = await supabase
      .from('project_members')
      .insert(memberIds.map(mid => ({ project_id: data.id, member_id: mid })));
    if (junctionError) throw junctionError;
  }

  // Link contact as primary client if contact_id was provided
  if (contactId) {
    const { error: pcError } = await supabase
      .from('project_contacts')
      .insert({
        project_id: data.id,
        contact_id: contactId,
        role: 'Client',
        is_primary_client: true,
      });
    if (pcError) throw pcError;
  }

  return { ...data, member_ids: memberIds } as Project;
}

export async function patchProject(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<Project>,
  memberIds?: string[]
) {
  const { member_ids, ...dbUpdates } = updates as any;
  // Remove fields that aren't DB columns
  delete dbUpdates.project_members;

  const projectQuery = Object.keys(dbUpdates).length > 0
    ? supabase.from('projects').update(dbUpdates).eq('id', id).is('deleted_at', null).select().single()
    : supabase.from('projects').select('*').eq('id', id).is('deleted_at', null).single();
  const { data, error } = await projectQuery;

  if (error) throw error;

  if (memberIds !== undefined) {
    await supabase.from('project_members').delete().eq('project_id', id);
    if (memberIds.length > 0) {
      const { error: junctionError } = await supabase
        .from('project_members')
        .insert(memberIds.map(mid => ({ project_id: id, member_id: mid })));
      if (junctionError) throw junctionError;
    }
  }

  let resolvedMemberIds = memberIds;
  if (resolvedMemberIds === undefined) {
    const { data: memberships, error: membershipError } = await supabase
      .from('project_members')
      .select('member_id')
      .eq('project_id', id);
    if (membershipError) throw membershipError;
    resolvedMemberIds = (memberships || []).map((membership: { member_id: string }) => membership.member_id);
  }

  return { ...data, member_ids: resolvedMemberIds } as Project;
}

export async function removeProject(supabase: SupabaseClient, id: string, actor?: string | null) {
  await moveToTrash(supabase, 'projects', id, actor);
}

// ============================================================
// TASKS
// ============================================================

export async function fetchTasks(supabase: SupabaseClient) {
  const tasks = await fetchAllRows((from, to, count) => supabase
    .from('tasks')
    .select(`
      *,
      task_assignees ( member_id ),
      subtasks:task_subtasks ( id, task_id, title, completed, sort_order ),
      comments:task_comments ( id, task_id, user_id, text, created_at ),
      criteria:task_acceptance_criteria ( id, task_id, criterion, satisfied, sort_order ),
      reviews:task_reviews ( id, round, verdict, summary, pr_url, head_sha, reviewer_member_id, created_at ),
      task_dependencies!task_dependencies_task_id_fkey ( blocked_by_task_id )
    `, { count })
    .is('deleted_at', null)
    .is('subtasks.deleted_at', null)
    .is('comments.deleted_at', null)
    .order('created_at', { ascending: false })
    .order('id')
    .range(from, to));

  return (tasks || []).map((t: any) => ({
    ...t,
    assignee_ids: (t.task_assignees || []).map((ta: any) => ta.member_id),
    subtasks: (t.subtasks || []).sort((a: any, b: any) => a.sort_order - b.sort_order),
    comments: (t.comments || []).sort(
      (a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    ),
    acceptance_criteria: (t.criteria || []).sort((a: any, b: any) => a.sort_order - b.sort_order),
    reviews: (t.reviews || []).sort(
      (a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    ),
    blocked_by_ids: (t.task_dependencies || []).map((d: any) => d.blocked_by_task_id),
    criteria: undefined,
    task_dependencies: undefined,
    task_assignees: undefined,
  })) as Task[];
}

export async function insertTask(
  supabase: SupabaseClient,
  task: Omit<Task, 'id' | 'created_at' | 'updated_at' | 'assignee_ids' | 'subtasks' | 'comments' | 'acceptance_criteria' | 'blocked_by_ids'>,
  assigneeIds: string[],
  criteria: string[] = [],
  blockedByIds: string[] = []
) {
  const insertPayload: Record<string, any> = {
    project_id: task.project_id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    due_date: task.due_date,
    tags: task.tags,
    created_by: task.created_by,
  };
  if (task.project_goal_id) insertPayload.project_goal_id = task.project_goal_id;
  if (task.source_task_suggestion_id) insertPayload.source_task_suggestion_id = task.source_task_suggestion_id;
  if (task.task_type) insertPayload.task_type = task.task_type;
  if (task.ai_readiness !== undefined) insertPayload.ai_readiness = task.ai_readiness;

  const saved = await saveTaskAtomically(supabase, null, insertPayload, assigneeIds, criteria, blockedByIds);

  return {
    ...saved.task,
    assignee_ids: assigneeIds,
    subtasks: [],
    comments: [],
    acceptance_criteria: saved.criteria,
    blocked_by_ids: blockedByIds,
  } as Task;
}

/** The task row as stored (no joined lists) plus its criteria, as save_task returns them. */
type SavedTask = {
  task: Omit<Task, 'assignee_ids' | 'subtasks' | 'comments' | 'acceptance_criteria' | 'blocked_by_ids'>;
  criteria: AcceptanceCriterion[];
};

/**
 * One transaction for a task row and its assignees, criteria and blockers
 * (the save_task RPC). Undefined lists are left as they are.
 */
async function saveTaskAtomically(
  supabase: SupabaseClient,
  id: string | null,
  columns: Record<string, unknown>,
  assigneeIds?: string[],
  criteria?: string[],
  blockedByIds?: string[],
): Promise<SavedTask> {
  const { data, error } = await supabase.rpc('save_task', {
    p_task_id: id,
    p_task: columns,
    p_assignee_ids: assigneeIds ?? null,
    p_criteria: criteria ?? null,
    p_blocked_by: blockedByIds ?? null,
  });
  if (error) throw error;
  const result = data as SavedTask | null;
  if (!result?.task) throw new Error('Task save returned no task');
  return result;
}

export async function patchTask(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<Task>,
  assigneeIds?: string[],
  criteria?: string[],
  blockedByIds?: string[]
) {
  const {
    assignee_ids,
    subtasks,
    comments,
    task_assignees,
    acceptance_criteria,
    blocked_by_ids,
    criteria: embeddedCriteria,
    task_dependencies,
    reviews,
    ...dbUpdates
  } = updates as any;

  // Criteria are a full replace that resets satisfied flags. Intended for
  // retrofitting specs before work starts, not for editing individual
  // criteria (use the acceptance-criteria endpoints for that).
  const saved = await saveTaskAtomically(supabase, id, dbUpdates, assigneeIds, criteria, blockedByIds);
  return saved.task;
}

export async function removeTask(supabase: SupabaseClient, id: string, actor?: string | null) {
  await moveToTrash(supabase, 'tasks', id, actor);
}

export async function reorderTasks(
  supabase: SupabaseClient,
  orders: { id: string; sort_order: number }[]
) {
  const results = await Promise.all(
    orders.map(({ id, sort_order }) =>
      supabase.from('tasks').update({ sort_order }).eq('id', id).is('deleted_at', null)
    )
  );
  const failed = results.find(r => r.error);
  if (failed?.error) throw failed.error;
}

// ============================================================
// SUBTASKS
// ============================================================

export async function insertSubtask(
  supabase: SupabaseClient,
  taskId: string,
  title: string
) {
  // Get current max sort_order
  const { data: existing } = await supabase
    .from('task_subtasks')
    .select('sort_order')
    .eq('task_id', taskId)
    .is('deleted_at', null)
    .order('sort_order', { ascending: false })
    .limit(1);

  const sortOrder = existing && existing.length > 0 ? existing[0].sort_order + 1 : 0;

  const { data, error } = await supabase
    .from('task_subtasks')
    .insert({ task_id: taskId, title, sort_order: sortOrder })
    .select()
    .single();

  if (error) throw error;
  return data as Subtask;
}

export async function toggleSubtaskCompleted(
  supabase: SupabaseClient,
  subtaskId: string,
  completed: boolean
) {
  const { error } = await supabase
    .from('task_subtasks')
    .update({ completed })
    .eq('id', subtaskId)
    .is('deleted_at', null);

  if (error) throw error;
}

export async function reorderSubtasks(
  supabase: SupabaseClient,
  subtaskIds: string[]
) {
  // Update sort_order for each subtask
  const updates = subtaskIds.map((id, index) =>
    supabase.from('task_subtasks').update({ sort_order: index }).eq('id', id).is('deleted_at', null)
  );
  const results = await Promise.all(updates);
  const failed = results.find(r => r.error);
  if (failed?.error) throw failed.error;
}

export async function patchSubtask(
  supabase: SupabaseClient,
  subtaskId: string,
  updates: Partial<Pick<Subtask, 'title' | 'completed' | 'sort_order'>>
) {
  const { error } = await supabase
    .from('task_subtasks')
    .update(updates)
    .eq('id', subtaskId)
    .is('deleted_at', null);

  if (error) throw error;
}

export async function removeSubtask(supabase: SupabaseClient, subtaskId: string, actor?: string | null) {
  await moveToTrash(supabase, 'task_subtasks', subtaskId, actor);
}

// ============================================================
// ACCEPTANCE CRITERIA
// ============================================================

export async function insertAcceptanceCriterion(
  supabase: SupabaseClient,
  taskId: string,
  criterion: string
) {
  // Get current max sort_order
  const { data: existing } = await supabase
    .from('task_acceptance_criteria')
    .select('sort_order')
    .eq('task_id', taskId)
    .order('sort_order', { ascending: false })
    .limit(1);

  const sortOrder = existing && existing.length > 0 ? existing[0].sort_order + 1 : 0;

  const { data, error } = await supabase
    .from('task_acceptance_criteria')
    .insert({ task_id: taskId, criterion, sort_order: sortOrder })
    .select()
    .single();

  if (error) throw error;
  return data as AcceptanceCriterion;
}

export async function patchAcceptanceCriterion(
  supabase: SupabaseClient,
  criterionId: string,
  updates: Partial<Pick<AcceptanceCriterion, 'criterion' | 'satisfied' | 'sort_order'>>
) {
  const { error } = await supabase
    .from('task_acceptance_criteria')
    .update(updates)
    .eq('id', criterionId);

  if (error) throw error;
}

export async function removeAcceptanceCriterion(supabase: SupabaseClient, criterionId: string) {
  const { error } = await supabase.from('task_acceptance_criteria').delete().eq('id', criterionId);
  if (error) throw error;
}

// ============================================================
// COMMENTS
// ============================================================

export async function insertComment(
  supabase: SupabaseClient,
  taskId: string,
  userId: string,
  text: string
) {
  const { data, error } = await supabase
    .from('task_comments')
    .insert({ task_id: taskId, user_id: userId, text })
    .select()
    .single();

  if (error) throw error;
  return data as Comment;
}

export async function patchComment(
  supabase: SupabaseClient,
  commentId: string,
  text: string
) {
  const { error } = await supabase
    .from('task_comments')
    .update({ text })
    .eq('id', commentId)
    .is('deleted_at', null);

  if (error) throw error;
}

export async function removeComment(supabase: SupabaseClient, commentId: string, actor?: string | null) {
  await moveToTrash(supabase, 'task_comments', commentId, actor);
}

// ============================================================
// TEAM MEMBERS
// ============================================================

export async function fetchTeamMembers(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('team_members')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) throw error;
  return (data || []) as TeamMember[];
}

export async function insertTeamMember(
  supabase: SupabaseClient,
  member: Omit<TeamMember, 'id' | 'created_at' | 'updated_at'>
) {
  const { data, error } = await supabase
    .from('team_members')
    .insert({
      name: member.name,
      email: member.email,
      avatar: member.avatar,
      role: member.role,
      auth_user_id: member.auth_user_id || null,
      ...(member.email_notifications_enabled !== undefined && { email_notifications_enabled: member.email_notifications_enabled }),
      ...(member.email_notification_prefs && { email_notification_prefs: member.email_notification_prefs }),
    })
    .select()
    .single();

  if (error) throw error;
  return data as TeamMember;
}

export async function patchTeamMember(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<TeamMember>
) {
  const { data, error } = await supabase
    .from('team_members')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data as TeamMember;
}

// ============================================================
// ACTIVITIES
// ============================================================

export async function fetchActivities(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('activities')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) throw error;
  return (data || []) as Activity[];
}

export async function insertActivity(
  supabase: SupabaseClient,
  activity: Omit<Activity, 'id' | 'created_at'>
) {
  const { data, error } = await supabase
    .from('activities')
    .insert(activity)
    .select()
    .single();

  if (error) throw error;
  return data as Activity;
}

// ============================================================
// CONTACTS
// ============================================================

export async function fetchContacts(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []) as Contact[];
}

export async function insertContact(
  supabase: SupabaseClient,
  contact: Omit<Contact, 'id' | 'created_at' | 'updated_at'>
) {
  const { data, error } = await supabase
    .from('contacts')
    .insert({
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      company: contact.company,
      notes: contact.notes,
      color: contact.color,
      avatar_url: contact.avatar_url || '',
      created_by: contact.created_by || null,
    })
    .select()
    .single();

  if (error) throw error;
  return data as Contact;
}

export async function patchContact(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<Contact>
) {
  const { data, error } = await supabase
    .from('contacts')
    .update(updates)
    .eq('id', id)
    .is('deleted_at', null)
    .select()
    .single();

  if (error) throw error;
  return data as Contact;
}

export async function removeContact(supabase: SupabaseClient, id: string, actor?: string | null) {
  await moveToTrash(supabase, 'contacts', id, actor);
}

// ============================================================
// CONTACT EMAILS (several per contact; the primary mirrors contacts.email)
// ============================================================

export async function fetchContactEmails(supabase: SupabaseClient, contactId?: string) {
  return fetchAllRows<ContactEmail>((from, to, count) => {
    let query = supabase.from('contact_emails').select('*', count ? { count } : undefined);
    if (contactId) query = query.eq('contact_id', contactId);
    return query.order('contact_id').order('created_at').order('id').range(from, to);
  });
}

export async function insertContactEmail(
  supabase: SupabaseClient,
  row: { contact_id: string; email: string; label: string | null; is_primary?: boolean },
) {
  const { data, error } = await supabase
    .from('contact_emails')
    .insert({ contact_id: row.contact_id, email: row.email, label: row.label, is_primary: row.is_primary ?? false })
    .select()
    .single();
  if (error) throw error;
  return data as ContactEmail;
}

export async function patchContactEmail(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<Pick<ContactEmail, 'email' | 'label' | 'is_primary'>>,
) {
  const { error } = await supabase.from('contact_emails').update(updates).eq('id', id);
  if (error) throw error;
}

export async function removeContactEmail(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from('contact_emails').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================
// PROJECT CONTACTS
// ============================================================

export async function fetchAllProjectContacts(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('project_contacts')
    .select('*, contact:contacts(*)')
    .order('created_at', { ascending: true });

  if (error) throw error;
  return (data || []) as ProjectContact[];
}

export async function addProjectContact(
  supabase: SupabaseClient,
  projectId: string,
  contactId: string,
  role: string,
  customRole: string | null,
  isPrimaryClient: boolean
) {
  // If setting as primary client, unset existing primary on this project first
  if (isPrimaryClient) {
    await supabase
      .from('project_contacts')
      .update({ is_primary_client: false })
      .eq('project_id', projectId)
      .eq('is_primary_client', true);
  }

  const { data, error } = await supabase
    .from('project_contacts')
    .insert({
      project_id: projectId,
      contact_id: contactId,
      role,
      custom_role: customRole,
      is_primary_client: isPrimaryClient,
    })
    .select('*, contact:contacts(*)')
    .single();

  if (error) throw error;
  return data as ProjectContact;
}

export async function updateProjectContact(
  supabase: SupabaseClient,
  id: string,
  projectId: string,
  updates: Partial<Pick<ProjectContact, 'role' | 'custom_role' | 'is_primary_client'>>
) {
  // If setting as primary client, unset existing primary on this project first
  if (updates.is_primary_client) {
    await supabase
      .from('project_contacts')
      .update({ is_primary_client: false })
      .eq('project_id', projectId)
      .eq('is_primary_client', true);
  }

  const { data, error } = await supabase
    .from('project_contacts')
    .update(updates)
    .eq('id', id)
    .select('*, contact:contacts(*)')
    .single();

  if (error) throw error;
  return data as ProjectContact;
}

export async function removeProjectContact(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from('project_contacts').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================
// LEADS
// ============================================================

export async function fetchLeads(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('leads')
    .select(`
      *,
      lead_members ( member_id )
    `)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) throw error;

  return (data || []).map((l: any) => ({
    ...l,
    member_ids: (l.lead_members || []).map((lm: any) => lm.member_id),
    lead_members: undefined,
  })) as Lead[];
}

export async function insertLead(
  supabase: SupabaseClient,
  lead: Omit<Lead, 'id' | 'created_at' | 'updated_at' | 'member_ids'>,
  memberIds: string[]
) {
  // Auto-create a contact from lead data if no contact_id is provided
  let contactId = lead.contact_id || null;
  if (!contactId) {
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .insert({
        name: lead.name,
        email: lead.email,
        phone: lead.phone,
        company: lead.company,
        color: siteConfig.colors.brand[500],
        created_by: lead.created_by || null,
      })
      .select()
      .single();

    if (contactError) throw contactError;
    contactId = contact.id;
  }

  const { data, error } = await supabase
    .from('leads')
    .insert({
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      company: lead.company,
      source: lead.source,
      status: lead.status,
      notes: lead.notes,
      assigned_to: lead.assigned_to || null,
      contact_id: contactId,
      created_by: lead.created_by || null,
    })
    .select()
    .single();

  if (error) throw error;

  // Link the contact to the lead via the lead_contacts junction table
  if (contactId) {
    const { error: lcError } = await supabase
      .from('lead_contacts')
      .insert({
        lead_id: data.id,
        contact_id: contactId,
        role: 'Client',
        is_primary_client: true,
      });
    if (lcError) throw lcError;
  }

  if (memberIds.length > 0) {
    const { error: junctionError } = await supabase
      .from('lead_members')
      .insert(memberIds.map(mid => ({ lead_id: data.id, member_id: mid })));
    if (junctionError) throw junctionError;
  }

  return { ...data, member_ids: memberIds } as Lead;
}

export async function patchLead(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<Lead>,
  memberIds?: string[]
) {
  const { member_ids, lead_members, ...dbUpdates } = updates as any;

  const { data, error } = await supabase
    .from('leads')
    .update(dbUpdates)
    .eq('id', id)
    .is('deleted_at', null)
    .select()
    .single();

  if (error) throw error;

  if (memberIds !== undefined) {
    await supabase.from('lead_members').delete().eq('lead_id', id);
    if (memberIds.length > 0) {
      const { error: junctionError } = await supabase
        .from('lead_members')
        .insert(memberIds.map(mid => ({ lead_id: id, member_id: mid })));
      if (junctionError) throw junctionError;
    }
  }

  // When memberIds was explicitly passed, use it; otherwise re-fetch from junction table
  let resolvedMemberIds: string[] = [];
  if (memberIds !== undefined) {
    resolvedMemberIds = memberIds;
  } else {
    const { data: rows } = await supabase
      .from('lead_members')
      .select('member_id')
      .eq('lead_id', id);
    resolvedMemberIds = (rows || []).map(r => r.member_id);
  }

  return { ...data, member_ids: resolvedMemberIds } as Lead;
}

export async function removeLead(supabase: SupabaseClient, id: string, actor?: string | null) {
  await moveToTrash(supabase, 'leads', id, actor);
}

// ============================================================
// LEAD INTERACTIONS
// ============================================================

export async function fetchLeadInteractions(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('lead_interactions')
    .select('*')
    .is('deleted_at', null)
    .order('occurred_at', { ascending: false });

  if (error) throw error;
  return (data || []) as LeadInteraction[];
}

export async function fetchLeadInteractionsByLeadId(supabase: SupabaseClient, leadId: string) {
  const { data, error } = await supabase
    .from('lead_interactions')
    .select('*')
    .eq('lead_id', leadId)
    .is('deleted_at', null)
    .order('occurred_at', { ascending: false });

  if (error) throw error;
  return (data || []) as LeadInteraction[];
}

export async function insertLeadInteraction(
  supabase: SupabaseClient,
  interaction: Omit<LeadInteraction, 'id' | 'created_at' | 'updated_at'>
) {
  const { data, error } = await supabase
    .from('lead_interactions')
    .insert({
      lead_id: interaction.lead_id,
      type: interaction.type,
      title: interaction.title,
      description: interaction.description,
      occurred_at: interaction.occurred_at,
      scheduled_at: interaction.scheduled_at || null,
      completed: interaction.completed,
      created_by: interaction.created_by || null,
    })
    .select()
    .single();

  if (error) throw error;
  return data as LeadInteraction;
}

export async function patchLeadInteraction(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<LeadInteraction>
) {
  const { data, error } = await supabase
    .from('lead_interactions')
    .update(updates)
    .eq('id', id)
    .is('deleted_at', null)
    .select()
    .single();

  if (error) throw error;
  return data as LeadInteraction;
}

export async function removeLeadInteraction(supabase: SupabaseClient, id: string, actor?: string | null) {
  await moveToTrash(supabase, 'lead_interactions', id, actor);
}

// ============================================================
// LEAD PROPOSALS
// ============================================================

export async function fetchLeadProposals(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('lead_proposals')
    .select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []) as LeadProposal[];
}

export async function fetchLeadProposalsByLeadId(supabase: SupabaseClient, leadId: string) {
  const { data, error } = await supabase
    .from('lead_proposals')
    .select('*')
    .eq('lead_id', leadId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []) as LeadProposal[];
}

export async function insertLeadProposal(
  supabase: SupabaseClient,
  proposal: Omit<LeadProposal, 'id' | 'created_at' | 'updated_at'>
) {
  const { data, error } = await supabase
    .from('lead_proposals')
    .insert({
      lead_id: proposal.lead_id,
      title: proposal.title,
      description: proposal.description,
      estimated_value: proposal.estimated_value,
      status: proposal.status,
      sent_at: proposal.sent_at || null,
      created_by: proposal.created_by || null,
    })
    .select()
    .single();

  if (error) throw error;
  return data as LeadProposal;
}

export async function patchLeadProposal(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<LeadProposal>
) {
  const { data, error } = await supabase
    .from('lead_proposals')
    .update(updates)
    .eq('id', id)
    .is('deleted_at', null)
    .select()
    .single();

  if (error) throw error;
  return data as LeadProposal;
}

export async function removeLeadProposal(supabase: SupabaseClient, id: string, actor?: string | null) {
  await moveToTrash(supabase, 'lead_proposals', id, actor);
}

// ============================================================
// LEAD FIELDS
// ============================================================

export async function fetchLeadFields(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('lead_fields')
    .select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return (data || []) as LeadField[];
}

export async function upsertLeadField(
  supabase: SupabaseClient,
  leadId: string,
  fieldKey: string,
  value: string
) {
  // A key is unique among live fields only (a field in Trash keeps its row),
  // so: change the live field, or add it. Two writers adding the same key at
  // once collide on the live-key index; the loser then changes the winner's.
  const updateLive = () => supabase
    .from('lead_fields')
    .update({ value })
    .eq('lead_id', leadId)
    .eq('field_key', fieldKey)
    .is('deleted_at', null)
    .select()
    .maybeSingle();

  const updated = await updateLive();
  if (updated.error) throw updated.error;
  if (updated.data) return updated.data as LeadField;

  const inserted = await supabase
    .from('lead_fields')
    .insert({ lead_id: leadId, field_key: fieldKey, value })
    .select()
    .single();
  if (inserted.error?.code === '23505') {
    const retried = await updateLive();
    if (retried.error) throw retried.error;
    if (retried.data) return retried.data as LeadField;
  }
  if (inserted.error) throw inserted.error;
  return inserted.data as LeadField;
}

export async function removeLeadField(supabase: SupabaseClient, id: string, actor?: string | null) {
  await moveToTrash(supabase, 'lead_fields', id, actor);
}

// ============================================================
// LEAD CONTACTS
// ============================================================

export async function fetchAllLeadContacts(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('lead_contacts')
    .select('*, contact:contacts(*)')
    .order('created_at', { ascending: true });

  if (error) throw error;
  return (data || []) as LeadContact[];
}

export async function addLeadContact(
  supabase: SupabaseClient,
  leadId: string,
  contactId: string,
  role: string,
  customRole: string | null,
  isPrimaryClient: boolean
) {
  // If setting as primary client, unset existing primary on this lead first
  if (isPrimaryClient) {
    await supabase
      .from('lead_contacts')
      .update({ is_primary_client: false })
      .eq('lead_id', leadId)
      .eq('is_primary_client', true);
  }

  const { data, error } = await supabase
    .from('lead_contacts')
    .insert({
      lead_id: leadId,
      contact_id: contactId,
      role,
      custom_role: customRole,
      is_primary_client: isPrimaryClient,
    })
    .select('*, contact:contacts(*)')
    .single();

  if (error) throw error;
  return data as LeadContact;
}

export async function updateLeadContact(
  supabase: SupabaseClient,
  id: string,
  leadId: string,
  updates: Partial<Pick<LeadContact, 'role' | 'custom_role' | 'is_primary_client'>>
) {
  // If setting as primary client, unset existing primary on this lead first
  if (updates.is_primary_client) {
    await supabase
      .from('lead_contacts')
      .update({ is_primary_client: false })
      .eq('lead_id', leadId)
      .eq('is_primary_client', true);
  }

  const { data, error } = await supabase
    .from('lead_contacts')
    .update(updates)
    .eq('id', id)
    .select('*, contact:contacts(*)')
    .single();

  if (error) throw error;
  return data as LeadContact;
}

export async function removeLeadContact(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from('lead_contacts').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================
// LEAD CONVERSION
// ============================================================

export async function convertLead(
  supabase: SupabaseClient,
  lead: Lead,
  projectName: string,
  projectColor: string,
  projectDescription: string,
  createdBy: string | null
) {
  // The whole conversion (contact + project + contacts + members + lead
  // status) runs atomically in the convert_lead RPC, which also locks the
  // lead row and rejects leads that are already won.
  const { data: rpcResult, error: rpcError } = await supabase.rpc('convert_lead', {
    p_lead_id: lead.id,
    p_project_name: projectName,
    p_project_color: projectColor,
    p_project_description: projectDescription,
    p_created_by: createdBy,
  });

  if (rpcError) throw rpcError;

  const projectId = rpcResult.project_id as string;
  const contactId = rpcResult.contact_id as string;

  // Two follow-up reads; the contact comes embedded in the primary
  // project_contact and the lead's final state is fully known locally.
  const [projectRes, pcRes] = await Promise.all([
    supabase.from('projects').select('id, name, description, color, status, start_date, due_date, hourly_tracking, time_tracking_enabled, created_by, created_at, updated_at, archived_at').eq('id', projectId).is('deleted_at', null).single(),
    supabase.from('project_contacts').select('*, contact:contacts(*)').eq('project_id', projectId),
  ]);

  if (projectRes.error) throw projectRes.error;
  if (pcRes.error) throw pcRes.error;

  const allProjectContacts = (pcRes.data || []) as ProjectContact[];
  const projectContact = allProjectContacts.find(pc => pc.is_primary_client);
  if (!projectContact) throw new Error('Conversion succeeded but the primary client could not be loaded');
  const additionalProjectContacts = allProjectContacts.filter(pc => !pc.is_primary_client);
  const leadMemberIds = lead.member_ids || [];

  return {
    contact: (projectContact as ProjectContact & { contact: Contact }).contact,
    project: {
      ...projectRes.data,
      hourly_rate: null,
      client_time_billing: 'included',
      budget_type: null,
      budget_value: null,
      autonomous_enabled: false,
      auto_merge_enabled: false,
      integration_branch: 'dev',
      production_branch: 'main',
      suggestions_per_cycle: 3,
      suggestion_queue_cap: 10,
      audit_interval_hours: 4,
      repo_path: null,
      member_ids: leadMemberIds,
    } as Project,
    projectContact,
    additionalProjectContacts,
    lead: { ...lead, status: 'won', contact_id: contactId, member_ids: leadMemberIds } as Lead,
  };
}

// ============================================================
// PORTAL SETTINGS
// ============================================================

export async function fetchAllPortalSettings(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('portal_settings')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []) as PortalSettings[];
}

export async function fetchPortalSettings(supabase: SupabaseClient, projectId: string) {
  const { data, error } = await supabase
    .from('portal_settings')
    .select('*')
    .eq('project_id', projectId)
    .maybeSingle();

  if (error) throw error;
  return data as PortalSettings | null;
}

export async function upsertPortalSettings(
  supabase: SupabaseClient,
  projectId: string,
  settings: Partial<Omit<PortalSettings, 'id' | 'project_id' | 'created_at' | 'updated_at'>>
) {
  // Check if settings exist for this project
  const existing = await fetchPortalSettings(supabase, projectId);

  if (existing) {
    const { data, error } = await supabase
      .from('portal_settings')
      .update(settings)
      .eq('id', existing.id)
      .select()
      .single();

    if (error) throw error;
    return data as PortalSettings;
  } else {
    // Generate a slug-based token from the project name
    const { data: project } = await supabase
      .from('projects')
      .select('name')
      .eq('id', projectId)
      .is('deleted_at', null)
      .single();

    let token = generatePortalSlug(project?.name || projectId);

    // Check for collisions and append suffix if needed
    const { data: collision } = await supabase
      .from('portal_settings')
      .select('token')
      .eq('token', token)
      .maybeSingle();

    if (collision) {
      let suffix = 2;
      const MAX_SLUG_ATTEMPTS = 50;
      while (suffix <= MAX_SLUG_ATTEMPTS) {
        const candidate = `${token}-${suffix}`;
        const { data: c } = await supabase
          .from('portal_settings')
          .select('token')
          .eq('token', candidate)
          .maybeSingle();
        if (!c) { token = candidate; break; }
        suffix++;
      }
      if (suffix > MAX_SLUG_ATTEMPTS) {
        token = `${token}-${Date.now().toString(36)}`;
      }
    }

    const { data, error } = await supabase
      .from('portal_settings')
      .insert({
        project_id: projectId,
        token,
        enabled: settings.enabled ?? false,
        pin: settings.pin ?? null,
        welcome_message: settings.welcome_message ?? '',
        logo_url: settings.logo_url ?? '',
        accent_color: settings.accent_color ?? siteConfig.colors.brand[500],
        show_progress: settings.show_progress ?? true,
        show_files: settings.show_files ?? true,
        show_hours: settings.show_hours ?? true,
        show_updates: settings.show_updates ?? true,
        section_order: settings.section_order ?? ['show_progress', 'show_hours', 'show_updates', 'show_files', 'show_credentials', 'show_invoices'],
      })
      .select()
      .single();

    if (error) throw error;
    return data as PortalSettings;
  }
}


export async function updatePortalSlug(
  supabase: SupabaseClient,
  projectId: string,
  newSlug: string
) {
  // Normalize: lowercase, alphanumeric + hyphens only, collapse and trim hyphens
  let slug = newSlug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');

  if (!slug) throw new Error('Slug cannot be empty');

  // Check for collisions excluding current project's own row
  const { data: collision } = await supabase
    .from('portal_settings')
    .select('token')
    .eq('token', slug)
    .neq('project_id', projectId)
    .maybeSingle();

  if (collision) {
    let suffix = 2;
    const MAX_SLUG_ATTEMPTS = 50;
    while (suffix <= MAX_SLUG_ATTEMPTS) {
      const candidate = `${slug}-${suffix}`;
      const { data: c } = await supabase
        .from('portal_settings')
        .select('token')
        .eq('token', candidate)
        .neq('project_id', projectId)
        .maybeSingle();
      if (!c) { slug = candidate; break; }
      suffix++;
    }
    if (suffix > MAX_SLUG_ATTEMPTS) {
      slug = `${slug}-${Date.now().toString(36)}`;
    }
  }

  const { data, error } = await supabase
    .from('portal_settings')
    .update({ token: slug })
    .eq('project_id', projectId)
    .select()
    .single();

  if (error) throw error;
  return data as PortalSettings;
}

// ============================================================
// PORTAL UPDATES
// ============================================================

export async function fetchAllPortalUpdates(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('portal_updates')
    .select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []) as PortalUpdate[];
}

export async function fetchPortalUpdates(supabase: SupabaseClient, projectId: string) {
  const { data, error } = await supabase
    .from('portal_updates')
    .select('*')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []) as PortalUpdate[];
}

export async function insertPortalUpdate(
  supabase: SupabaseClient,
  update: Omit<PortalUpdate, 'id' | 'created_at' | 'updated_at'>
) {
  const { data, error } = await supabase
    .from('portal_updates')
    .insert({
      project_id: update.project_id,
      title: update.title,
      content: update.content,
      update_type: update.update_type,
      author_id: update.author_id || null,
      pinned: update.pinned ?? false,
    })
    .select()
    .single();

  if (error) throw error;
  return data as PortalUpdate;
}

export async function patchPortalUpdate(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<Pick<PortalUpdate, 'title' | 'content' | 'update_type' | 'pinned'>>
) {
  const { data, error } = await supabase
    .from('portal_updates')
    .update(updates)
    .eq('id', id)
    .is('deleted_at', null)
    .select()
    .single();

  if (error) throw error;
  return data as PortalUpdate;
}

export async function removePortalUpdate(supabase: SupabaseClient, id: string, actor?: string | null) {
  await moveToTrash(supabase, 'portal_updates', id, actor);
}

// ============================================================
// PORTAL UPDATE ATTACHMENTS
// ============================================================

export async function fetchAllPortalUpdateAttachments(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('portal_update_attachments')
    .select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return (data || []) as PortalUpdateAttachment[];
}

export async function insertPortalUpdateAttachments(
  supabase: SupabaseClient,
  attachments: Omit<PortalUpdateAttachment, 'id' | 'created_at' | 'updated_at'>[]
) {
  const { data, error } = await supabase
    .from('portal_update_attachments')
    .insert(attachments.map(a => ({
      update_id: a.update_id,
      name: a.name,
      file_url: a.file_url,
      file_size: a.file_size,
      mime_type: a.mime_type,
      uploaded_by: a.uploaded_by || null,
    })))
    .select();

  if (error) throw error;
  return (data || []) as PortalUpdateAttachment[];
}

export async function removePortalUpdateAttachment(supabase: SupabaseClient, id: string, actor?: string | null) {
  await moveToTrash(supabase, 'portal_update_attachments', id, actor);
}

// ============================================================
// ENTITY FILES
// ============================================================

export async function fetchAllEntityFiles(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('entity_files')
    .select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []) as EntityFile[];
}

export async function insertEntityFile(
  supabase: SupabaseClient,
  file: Omit<EntityFile, 'id' | 'created_at' | 'updated_at'>
) {
  const { data, error } = await supabase
    .from('entity_files')
    .insert({
      entity_type: file.entity_type,
      entity_id: file.entity_id,
      name: file.name,
      file_url: file.file_url,
      file_size: file.file_size,
      mime_type: file.mime_type,
      visibility: file.visibility || 'internal',
      uploaded_by: file.uploaded_by || null,
    })
    .select()
    .single();

  if (error) throw error;
  return data as EntityFile;
}

export async function renameEntityFile(supabase: SupabaseClient, id: string, name: string) {
  const { data, error } = await supabase
    .from('entity_files')
    .update({ name })
    .eq('id', id)
    .is('deleted_at', null)
    .select()
    .single();
  if (error) throw error;
  return data as EntityFile;
}

/** Point an existing file row at new content (a note edit), keeping its id,
 *  visibility and history instead of deleting and re-adding it. */
export async function replaceEntityFileContent(
  supabase: SupabaseClient,
  id: string,
  content: Pick<EntityFile, 'name' | 'file_url' | 'file_size' | 'mime_type'>,
) {
  const { data, error } = await supabase
    .from('entity_files')
    .update(content)
    .eq('id', id)
    .is('deleted_at', null)
    .select()
    .single();
  if (error) throw error;
  return data as EntityFile;
}

export async function removeEntityFile(supabase: SupabaseClient, id: string, actor?: string | null) {
  await moveToTrash(supabase, 'entity_files', id, actor);
}

export async function updateEntityFileVisibility(supabase: SupabaseClient, id: string, visibility: 'internal' | 'external') {
  const { data, error } = await supabase
    .from('entity_files')
    .update({ visibility })
    .eq('id', id)
    .is('deleted_at', null)
    .select()
    .single();
  if (error) throw error;
  return data as EntityFile;
}

// ============================================================
// API KEYS
// ============================================================

/** Every api_keys column except key_hash, which never leaves the server. */
export const API_KEY_COLUMNS = 'id, name, key_prefix, permissions, scopes, expires_at, disabled_at, last_used_at, revoked_at, created_by, team_member_id, created_at, updated_at';

export async function fetchApiKeys(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('api_keys')
    .select(API_KEY_COLUMNS)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []) as ApiKey[];
}

// ============================================================
// WEBHOOK ENDPOINTS + DELIVERIES
// ============================================================

const WEBHOOK_ENDPOINT_COLUMNS =
  'id, name, url, secret, events, is_active, description, amount_basis, created_by, last_delivery_at, created_at, updated_at';

export async function fetchWebhookEndpoints(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('webhook_endpoints')
    .select(WEBHOOK_ENDPOINT_COLUMNS)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []) as WebhookEndpoint[];
}

export async function insertWebhookEndpoint(
  supabase: SupabaseClient,
  endpoint: { name: string; url: string; secret: string; events: string[]; description?: string; amount_basis?: WebhookEndpoint['amount_basis']; created_by: string | null },
) {
  const { data, error } = await supabase
    .from('webhook_endpoints')
    .insert({
      name: endpoint.name,
      url: endpoint.url,
      secret: endpoint.secret,
      events: endpoint.events,
      description: endpoint.description || '',
      amount_basis: endpoint.amount_basis ?? 'gross',
      created_by: endpoint.created_by,
    })
    .select(WEBHOOK_ENDPOINT_COLUMNS)
    .single();
  if (error) throw error;
  return data as WebhookEndpoint;
}

export async function updateWebhookEndpoint(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<Pick<WebhookEndpoint, 'name' | 'url' | 'events' | 'is_active' | 'description' | 'amount_basis'>>,
) {
  const { data, error } = await supabase
    .from('webhook_endpoints')
    .update(patch)
    .eq('id', id)
    .select(WEBHOOK_ENDPOINT_COLUMNS)
    .single();
  if (error) throw error;
  return data as WebhookEndpoint;
}

export async function deleteWebhookEndpoint(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from('webhook_endpoints').delete().eq('id', id);
  if (error) throw error;
}

export async function fetchWebhookDeliveries(supabase: SupabaseClient, limit = 25) {
  const { data, error } = await supabase
    .from('webhook_deliveries')
    .select('*, webhook_events(event_id, event_type, created_at)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []) as WebhookDelivery[];
}

/** Manual resend: a failed delivery goes back to pending with a fresh attempt budget. */
export async function requeueWebhookDelivery(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.rpc('requeue_webhook_delivery', { p_delivery_id: id });
  if (error) throw error;
}

// ============================================================
// REMINDERS
// ============================================================

/** What a person sets on a reminder; the database owns the rest. */
export type ReminderFields = Pick<Reminder, 'title'> &
  Partial<Pick<Reminder, 'notes' | 'remind_on' | 'remind_at' | 'project_id' | 'task_id' | 'owner_id' | 'status'>>;

/** Done reminders older than this stay in the database but not in the app. */
const DONE_REMINDER_DAYS = 30;

/** Every reminder the reader can see that is open, or was finished recently. */
export async function fetchReminders(supabase: SupabaseClient) {
  const since = new Date(Date.now() - DONE_REMINDER_DAYS * 86_400_000).toISOString();
  return fetchAllRows<Reminder>((from, to, count) =>
    supabase
      .from('reminders')
      .select('*', { count })
      .is('deleted_at', null)
      .or(`status.eq.open,completed_at.gte.${since}`)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to));
}

export async function insertReminder(supabase: SupabaseClient, reminder: ReminderFields & { id?: string; owner_id: string }) {
  const { data, error } = await supabase.from('reminders').insert(reminder).select().single();
  if (error) throw error;
  return data as Reminder;
}

export async function patchReminder(supabase: SupabaseClient, id: string, updates: Partial<ReminderFields>) {
  const { data, error } = await supabase.from('reminders').update(updates).eq('id', id).is('deleted_at', null).select().single();
  if (error) throw error;
  return data as Reminder;
}

export async function deleteReminder(supabase: SupabaseClient, id: string, actor?: string | null) {
  await moveToTrash(supabase, 'reminders', id, actor);
}

// ============================================================
// PROJECT GOALS
// ============================================================

export async function fetchGoalsByProject(supabase: SupabaseClient, projectId: string) {
  const { data, error } = await supabase
    .from('project_goals')
    .select('*')
    .eq('project_id', projectId)
    .is('archived_at', null)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []) as ProjectGoal[];
}

export async function fetchGoals(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('project_goals')
    .select('*')
    .is('archived_at', null)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []) as ProjectGoal[];
}

export async function insertGoal(
  supabase: SupabaseClient,
  goal: { project_id: string; title: string; description?: string; target_date?: string | null; status?: string; created_by?: string | null }
) {
  const { data, error } = await supabase
    .from('project_goals')
    .insert({
      project_id: goal.project_id,
      title: goal.title,
      description: goal.description || '',
      target_date: goal.target_date || null,
      status: goal.status || 'active',
      created_by: goal.created_by || null,
    })
    .select()
    .single();

  if (error) throw error;
  return data as ProjectGoal;
}

export async function patchGoal(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<ProjectGoal>
) {
  const { data, error } = await supabase
    .from('project_goals')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data as ProjectGoal;
}

export async function archiveGoal(supabase: SupabaseClient, id: string) {
  const { data, error } = await supabase
    .from('project_goals')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data as ProjectGoal;
}

// ============================================================
// TASK SUGGESTIONS
// ============================================================

export async function fetchTaskSuggestions(supabase: SupabaseClient, filters?: { status?: string; project_id?: string; goal_id?: string; proposed_by?: string }) {
  let query = supabase
    .from('task_suggestions')
    .select('*')
    .order('created_at', { ascending: false });

  if (filters?.status) query = query.eq('status', filters.status);
  if (filters?.project_id) query = query.eq('project_id', filters.project_id);
  if (filters?.goal_id) query = query.eq('goal_id', filters.goal_id);
  if (filters?.proposed_by) query = query.eq('proposed_by', filters.proposed_by);

  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as TaskSuggestion[];
}

export async function insertTaskSuggestion(
  supabase: SupabaseClient,
  suggestion: Omit<TaskSuggestion, 'id' | 'created_at' | 'updated_at' | 'reviewed_by' | 'reviewed_at' | 'rejection_reason' | 'info_request' | 'converted_task_id'>
) {
  const { data, error } = await supabase
    .from('task_suggestions')
    .insert({
      project_id: suggestion.project_id,
      goal_id: suggestion.goal_id,
      proposed_by: suggestion.proposed_by,
      assigned_to: suggestion.assigned_to || null,
      title: suggestion.title,
      description: suggestion.description,
      reasoning: suggestion.reasoning,
      priority: suggestion.priority,
      effort_estimate: suggestion.effort_estimate || null,
      task_type: suggestion.task_type || null,
      status: suggestion.status || 'pending',
      metadata: suggestion.metadata || {},
      bundle_key: (suggestion as { bundle_key?: string | null }).bundle_key || null,
    })
    .select()
    .single();

  if (error) throw error;
  return data as TaskSuggestion;
}

export async function patchTaskSuggestion(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<TaskSuggestion>
) {
  const { data, error } = await supabase
    .from('task_suggestions')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data as TaskSuggestion;
}

/** Refuses work for a project that is missing or in Trash. */
async function assertProjectLive(supabase: SupabaseClient, projectId: string | null | undefined) {
  if (!projectId) return;
  const { data, error } = await supabase.from('projects').select('id').eq('id', projectId).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Project not found');
}

export async function approveTaskSuggestion(
  supabase: SupabaseClient,
  id: string,
  taskOverrides: { priority?: string; assigned_to?: string | null; due_date?: string | null; project_id?: string; task_type?: string | null; ai_readiness?: AiReadiness | null },
  reviewedBy: string
) {
  // Snapshot the pre-claim review state so a failed approval can restore it
  // exactly (a needs_info suggestion must not silently become pending).
  const { data: before } = await supabase
    .from('task_suggestions')
    .select('status, reviewed_by, reviewed_at, project_id')
    .eq('id', id)
    .maybeSingle();
  // No new task goes into a project in Trash.
  await assertProjectLive(supabase, taskOverrides.project_id ?? before?.project_id);

  // Claim the suggestion with a compare-and-set on its status so two
  // concurrent approvals can't both create a task.
  const { data: suggestion, error: claimErr } = await supabase
    .from('task_suggestions')
    .update({
      status: 'approved',
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id)
    .in('status', ['pending', 'needs_info'])
    .select()
    .maybeSingle();

  if (claimErr) throw claimErr;
  if (!suggestion) throw new Error('Suggestion has already been reviewed');

  // Create the task, carrying the suggestion's spec with it. The auditing
  // agent proposes a concrete fix, behavioral acceptance criteria, and an
  // AI-readiness recommendation in metadata; approval is the human gate, so
  // whatever is approved must land on the task intact or the dev agent
  // (which refuses tasks without criteria) can never pick it up.
  const metadata = (suggestion.metadata || {}) as Record<string, any>;
  const proposedFix = typeof metadata.proposed_fix === 'string' ? metadata.proposed_fix.trim() : '';
  const specCriteria: string[] = Array.isArray(metadata.acceptance_criteria)
    ? metadata.acceptance_criteria.filter((c: unknown): c is string => typeof c === 'string' && c.trim().length > 0)
    : [];
  // The reviewer's explicit choice wins: needs_spec (meant for the dev agent,
  // spec not written yet, which the spec sweep picks up), ai_ready,
  // human_only, or null (a person's task). Otherwise the recommendation, and
  // anything else ('hybrid' included) maps to null: a needs_spec task is
  // always a deliberate choice, never a guess.
  const recommended = metadata.ai_readiness_recommendation;
  const resolvedReadiness: AiReadiness | null =
    taskOverrides.ai_readiness !== undefined
      ? taskOverrides.ai_readiness
      : recommended === 'ai_ready' || recommended === 'human_only'
        ? recommended
        : null;

  const resolvedTaskType = taskOverrides.task_type !== undefined ? taskOverrides.task_type : suggestion.task_type || null;
  const composedDescription = proposedFix ? `${suggestion.description}\n\nProposed fix: ${proposedFix}` : suggestion.description;
  const taskData: Record<string, any> = {
    project_id: taskOverrides.project_id || suggestion.project_id,
    title: suggestion.title,
    description: composedDescription,
    status: 'todo' as const,
    priority: (taskOverrides.priority || suggestion.priority) as Task['priority'],
    due_date: taskOverrides.due_date || null,
    tags: [] as string[],
    source_task_suggestion_id: id,
    project_goal_id: suggestion.goal_id,
    // Required, not cosmetic: the tasks_insert RLS policy checks
    // `created_by = current_team_member_id()`, so omitting it inserts NULL and
    // every approval from the browser fails with a 403 that names no column.
    created_by: reviewedBy,
  };
  if (resolvedTaskType) taskData.task_type = resolvedTaskType;
  if (resolvedReadiness) taskData.ai_readiness = resolvedReadiness;

  const { data: task, error: taskErr } = await supabase
    .from('tasks')
    .insert(taskData)
    .select()
    .single();

  if (taskErr) {
    // Release the claim, restoring the exact pre-claim review state
    await supabase
      .from('task_suggestions')
      .update({
        status: before?.status ?? 'pending',
        reviewed_by: before?.reviewed_by ?? null,
        reviewed_at: before?.reviewed_at ?? null,
      })
      .eq('id', id)
      .then(() => {}, () => {});
    throw taskErr;
  }

  // Copy the approved acceptance criteria onto the task. Best-effort is not
  // good enough here: a task that silently lost its criteria looks done but is
  // permanently unstartable for the dev agent, so a failure surfaces.
  let insertedCriteria: AcceptanceCriterion[] = [];
  if (specCriteria.length) {
    const { data: criteriaRows, error: criteriaError } = await supabase
      .from('task_acceptance_criteria')
      .insert(specCriteria.map((criterion, index) => ({ task_id: task.id, criterion, sort_order: index })))
      .select();
    if (criteriaError) throw criteriaError;
    insertedCriteria = (criteriaRows || []) as AcceptanceCriterion[];
  }

  // If assigned_to is set, create task_assignee
  const assignedTo = taskOverrides.assigned_to || suggestion.assigned_to;
  if (assignedTo) {
    await supabase
      .from('task_assignees')
      .insert({ task_id: task.id, member_id: assignedTo })
      .then(() => {}, () => {});
  }

  // Link the created task back to the suggestion
  const { data: updated, error: updateErr } = await supabase
    .from('task_suggestions')
    .update({ converted_task_id: task.id })
    .eq('id', id)
    .select()
    .single();

  if (updateErr) throw updateErr;

  return {
    suggestion: updated as TaskSuggestion,
    task: {
      ...task,
      assignee_ids: assignedTo ? [assignedTo] : [],
      subtasks: [],
      comments: [],
      acceptance_criteria: insertedCriteria,
      blocked_by_ids: [],
    } as Task,
  };
}

/**
 * Approve several bundled suggestions as ONE task.
 *
 * Composition, never blending: the task description carries one section per
 * member verbatim, criteria are the union of every member's criteria, and
 * each member links to the same converted task. Members are claimed with the
 * same compare-and-set as single approval, one by one; a member that loses
 * its race is skipped (reported back) rather than failing the batch, because
 * the remaining members still deserve their task.
 */
export async function approveTaskSuggestionBundle(
  supabase: SupabaseClient,
  ids: string[],
  taskOverrides: { title?: string; priority?: string; assigned_to?: string | null; due_date?: string | null; task_type?: string | null; ai_readiness?: AiReadiness | null },
  reviewedBy: string
) {
  if (ids.length < 2) throw new Error('A bundle approval needs at least two suggestions');

  const { data: members, error: memberErr } = await supabase
    .from('task_suggestions')
    .select('*')
    .in('id', ids);
  if (memberErr) throw memberErr;
  const list = (members || []) as TaskSuggestion[];
  if (list.length !== ids.length) throw new Error('Some bundle members no longer exist');
  const projectIds = new Set(list.map(s => s.project_id));
  if (projectIds.size !== 1) throw new Error('Bundle members must share one project');
  await assertProjectLive(supabase, [...projectIds][0]);

  // Claim each member; losers of a concurrent race are excluded, not fatal.
  const claimed: TaskSuggestion[] = [];
  const skipped: string[] = [];
  for (const member of list) {
    const { data: row, error: claimErr } = await supabase
      .from('task_suggestions')
      .update({ status: 'approved', reviewed_by: reviewedBy, reviewed_at: new Date().toISOString() })
      .eq('id', member.id)
      .in('status', ['pending', 'needs_info'])
      .select()
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (row) claimed.push(row as TaskSuggestion); else skipped.push(member.id);
  }
  if (claimed.length === 0) throw new Error('Suggestion has already been reviewed');

  const sections: string[] = [];
  const criteria: string[] = [];
  for (const member of claimed) {
    const md = (member.metadata || {}) as Record<string, any>;
    const fix = typeof md.proposed_fix === 'string' && md.proposed_fix.trim() ? `

Proposed fix: ${md.proposed_fix.trim()}` : '';
    sections.push(`## ${member.title}

${member.description}${fix}`);
    if (Array.isArray(md.acceptance_criteria)) {
      for (const c of md.acceptance_criteria) {
        if (typeof c === 'string' && c.trim() && !criteria.includes(c.trim())) criteria.push(c.trim());
      }
    }
  }

  const first = claimed[0];
  const priorities = ['urgent', 'high', 'medium', 'low'];
  const topPriority = priorities.find(p => claimed.some(m => m.priority === p)) || 'medium';
  // The reviewer's explicit choice wins; otherwise inherit the members'
  // recommendations, mirroring the solo path: unanimous ai_ready runs
  // autonomously, any human_only makes the whole composed task human (one
  // human member gates the branch), anything mixed or hybrid stays unset (a
  // person's task) unless the reviewer chooses needs_spec.
  const recommendations = claimed.map(
    m => ((m.metadata || {}) as Record<string, unknown>).ai_readiness_recommendation
  );
  const inheritedReadiness = recommendations.every(r => r === 'ai_ready')
    ? 'ai_ready'
    : recommendations.some(r => r === 'human_only')
      ? 'human_only'
      : null;
  const resolvedReadiness = taskOverrides.ai_readiness !== undefined
    ? taskOverrides.ai_readiness
    : inheritedReadiness;
  const taskData: Record<string, any> = {
    project_id: first.project_id,
    title: taskOverrides.title?.trim() || `${first.title} (+${claimed.length - 1} bundled)`,
    description: sections.join('\n\n---\n\n'),
    status: 'todo' as const,
    priority: (taskOverrides.priority || topPriority) as Task['priority'],
    due_date: taskOverrides.due_date || null,
    tags: [] as string[],
    source_task_suggestion_id: first.id,
    project_goal_id: first.goal_id,
    created_by: reviewedBy,
  };
  const resolvedTaskType = taskOverrides.task_type !== undefined ? taskOverrides.task_type : first.task_type || null;
  if (resolvedTaskType) taskData.task_type = resolvedTaskType;
  if (resolvedReadiness) taskData.ai_readiness = resolvedReadiness;

  const { data: task, error: taskErr } = await supabase.from('tasks').insert(taskData).select().single();
  if (taskErr) {
    for (const member of claimed) {
      await supabase
        .from('task_suggestions')
        .update({ status: 'pending', reviewed_by: null, reviewed_at: null })
        .eq('id', member.id)
        .then(() => {}, () => {});
    }
    throw taskErr;
  }

  let insertedCriteria: AcceptanceCriterion[] = [];
  if (criteria.length) {
    const { data: criteriaRows, error: criteriaError } = await supabase
      .from('task_acceptance_criteria')
      .insert(criteria.map((criterion, index) => ({ task_id: task.id, criterion, sort_order: index })))
      .select();
    if (criteriaError) throw criteriaError;
    insertedCriteria = (criteriaRows || []) as AcceptanceCriterion[];
  }

  const assignedTo = taskOverrides.assigned_to || first.assigned_to;
  if (assignedTo) {
    await supabase.from('task_assignees').insert({ task_id: task.id, member_id: assignedTo }).then(() => {}, () => {});
  }

  const { data: updatedRows, error: linkErr } = await supabase
    .from('task_suggestions')
    .update({ converted_task_id: task.id })
    .in('id', claimed.map(m => m.id))
    .select();
  if (linkErr) throw linkErr;

  return {
    suggestions: (updatedRows || []) as TaskSuggestion[],
    skipped,
    task: {
      ...task,
      assignee_ids: assignedTo ? [assignedTo] : [],
      subtasks: [],
      comments: [],
      acceptance_criteria: insertedCriteria,
      blocked_by_ids: [],
    } as Task,
  };
}

export async function declineTaskSuggestion(
  supabase: SupabaseClient,
  id: string,
  reviewedBy: string
) {
  // Decline is "we do not want this, no comment". Unlike reject it records no
  // reason and, crucially, writes no lesson_learned: declining housekeeping
  // (say, four sibling instances of an approved pattern fix) must not teach
  // the auditing agent that the finding class was unwanted. Same status guard
  // as approve/reject so a concurrent review cannot be overwritten.
  const { data, error } = await supabase
    .from('task_suggestions')
    .update({
      status: 'declined',
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id)
    .in('status', ['pending', 'needs_info'])
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('Suggestion has already been reviewed');
  return data as TaskSuggestion;
}

export async function rejectTaskSuggestion(
  supabase: SupabaseClient,
  id: string,
  reason: string | undefined,
  reviewedBy: string
) {
  // Status guard mirrors the approve claim: don't overwrite a suggestion a
  // concurrent approval already converted into a task.
  const { data, error } = await supabase
    .from('task_suggestions')
    .update({
      status: 'rejected',
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
      rejection_reason: reason || null,
    })
    .eq('id', id)
    .in('status', ['pending', 'needs_info'])
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('Suggestion has already been reviewed');
  return data as TaskSuggestion;
}

export async function requestInfoTaskSuggestion(
  supabase: SupabaseClient,
  id: string,
  infoRequest: string,
  reviewedBy: string
) {
  // Same status guard as approve/reject: never downgrade an approved row
  const { data, error } = await supabase
    .from('task_suggestions')
    .update({
      status: 'needs_info',
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
      info_request: infoRequest,
    })
    .eq('id', id)
    .in('status', ['pending', 'needs_info'])
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('Suggestion has already been reviewed');
  return data as TaskSuggestion;
}

export async function fetchPendingSuggestionCount(supabase: SupabaseClient) {
  const { count, error } = await supabase
    .from('task_suggestions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');

  if (error) throw error;
  return count || 0;
}

// ============================================================
// AGENT ACTIVITY
// ============================================================

/**
 * The NARRATIVE feed: recent events a person would want to read.
 *
 * Telemetry (usage counters, turn runtimes) is excluded by type rather than
 * trimmed by luck. Host publishers emit those in the hundreds per backfill, and
 * with a bounded window they crowd out every real event: hours after the usage
 * publisher went live, all 100 rows here were usage deltas, which blanked the
 * dashboard feed and starved analytics of the handoffs it counts. Analytics
 * reads telemetry through `fetchAgentActivityRange` instead.
 */
export async function fetchAgentActivity(supabase: SupabaseClient, filters?: { agent_id?: string; project_id?: string; activity_type?: string }) {
  let query = supabase
    .from('agent_activities')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

  // An explicit type filter is a deliberate request and wins over the default.
  if (!filters?.activity_type) {
    query = query.not('activity_type', 'in', `(${TELEMETRY_EVENT_TYPES.join(',')})`);
  }
  if (filters?.agent_id) query = query.eq('agent_id', filters.agent_id);
  if (filters?.project_id) query = query.eq('project_id', filters.project_id);
  if (filters?.activity_type) query = query.eq('activity_type', filters.activity_type);

  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as AgentActivity[];
}

/**
 * Every agent event in a date range, telemetry included, paged so a wide range
 * is complete rather than silently truncated.
 *
 * Analytics cannot read the narrative window: it needs all of a range (a month
 * of turns and usage deltas runs to thousands of rows) and it needs the types
 * that window deliberately drops. A hard ceiling still applies, and the caller
 * is told when it was hit so the UI can say so instead of quietly under-reporting.
 *
 * Host telemetry is often posted after the event it describes (the first
 * attention scan reaches 30 days back, the outcome backfill about three
 * weeks), so a second, separately capped read takes telemetry recorded up to
 * ANALYTICS_LOOKAHEAD_DAYS after the range. Separate so late rows can never
 * use up the range's own budget. Each metric places a row by its own event
 * time and drops what falls outside the range.
 *
 * Fleet host alerts carry no agent, so they come back separately: an
 * AgentActivity always has one.
 */
export const ANALYTICS_LOOKAHEAD_DAYS = 32;

export async function fetchAgentActivityRange(
  supabase: SupabaseClient,
  range: { startKey: string; endKey: string },
  options?: { maxRows?: number },
): Promise<{ rows: AgentActivity[]; fleet: FleetAgentActivity[]; truncated: boolean }> {
  const maxRows = options?.maxRows ?? 20000;
  const pageSize = 1000;
  const rows: AgentActivity[] = [];
  const fleet: FleetAgentActivity[] = [];
  // Date keys are calendar days; widen to cover the whole end day in any zone.
  const from = `${range.startKey}T00:00:00.000Z`;
  const to = `${range.endKey}T23:59:59.999Z`;
  const [y, m, d] = range.endKey.split('-').map(Number);
  const lateTo = new Date(Date.UTC(y, m - 1, d + ANALYTICS_LOOKAHEAD_DAYS, 23, 59, 59, 999)).toISOString();

  const read = async (lower: string, upper: string, types: readonly string[] | null, cap: number) => {
    for (let offset = 0; offset < cap; offset += pageSize) {
      let query = supabase
        .from('agent_activities')
        .select('*')
        .gte('created_at', lower)
        .lte('created_at', upper);
      if (types) query = query.in('activity_type', [...types]);
      const { data, error } = await query
        .order('created_at', { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      const page = (data || []) as (AgentActivity | FleetAgentActivity)[];
      for (const row of page) {
        if (row.agent_id === null) fleet.push(row as FleetAgentActivity);
        else rows.push(row as AgentActivity);
      }
      if (page.length < pageSize) return false;
    }
    return true;
  };

  const truncated = await read(from, to, null, maxRows);
  // gt, not gte: the range read already took rows at exactly `to`.
  const lateTruncated = lateTo > to
    ? await read(new Date(Date.parse(to) + 1).toISOString(), lateTo, TELEMETRY_EVENT_TYPES, maxRows)
    : false;
  return { rows, fleet, truncated: truncated || lateTruncated };
}

/**
 * Agent Analytics in one round trip: the agent_analytics_window database
 * function returns turns, hourly usage, directed-session usage and every
 * other event for the range, compactly (see agent-analytics-window.ts). The
 * bounds are widened a day each side so every viewer timezone's days are
 * inside; the read models cut to the exact range.
 */
export async function fetchAgentAnalyticsWindow(
  supabase: SupabaseClient,
  range: { startKey: string; endKey: string },
) {
  const DAY = 86_400_000;
  const startMs = Date.parse(`${range.startKey}T00:00:00.000Z`) - DAY;
  const endMs = Date.parse(`${range.endKey}T23:59:59.999Z`);
  const { data, error } = await supabase.rpc('agent_analytics_window', {
    p_from: new Date(startMs).toISOString(),
    p_to: new Date(endMs + DAY).toISOString(),
    p_late_to: new Date(endMs + ANALYTICS_LOOKAHEAD_DAYS * DAY).toISOString(),
  });
  if (error) throw error;
  return activitiesFromWindow(data as AnalyticsWindowPayload);
}

/** Billing gap reviews (Reconciled / Dismissed), for the analytics gaps list. */
export async function fetchBillingGapReviews(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('agent_billing_gap_reviews')
    .select('activity_id, status, note, reviewed_at');
  if (error) throw error;
  return (data || []) as { activity_id: string; status: 'reconciled' | 'dismissed'; note: string; reviewed_at: string }[];
}

/** Save a review; the database stamps who reviewed it and when. */
export async function saveBillingGapReview(
  supabase: SupabaseClient,
  review: { activity_id: string; status: 'reconciled' | 'dismissed'; note: string },
) {
  const { data, error } = await supabase
    .from('agent_billing_gap_reviews')
    .upsert(review, { onConflict: 'activity_id' })
    .select('activity_id, status, note, reviewed_at')
    .single();
  if (error) throw error;
  return data as { activity_id: string; status: 'reconciled' | 'dismissed'; note: string; reviewed_at: string };
}

/** Undo a review: the gap goes back to open. */
export async function clearBillingGapReview(supabase: SupabaseClient, activityId: string) {
  const { error } = await supabase.from('agent_billing_gap_reviews').delete().eq('activity_id', activityId);
  if (error) throw error;
}

/**
 * Task reopens (a task leaving done) and when the recorder began, which is
 * when its migration ran. Throws when either table is missing: reopens are
 * then not tracked, which the page must not show as zero.
 */
export async function fetchTaskReopens(supabase: SupabaseClient) {
  const [{ data: start, error: startError }, { data, error }] = await Promise.all([
    supabase.from('analytics_tracking_starts').select('started_at').eq('metric', 'task_reopens').maybeSingle(),
    supabase
      .from('task_reopens')
      .select('task_id, project_id, reopened_at')
      .order('reopened_at', { ascending: false })
      .limit(5000),
  ]);
  if (startError) throw startError;
  if (error) throw error;
  if (!start) throw new Error('reopen tracking start not recorded');
  return {
    since: (start as { started_at: string }).started_at,
    rows: (data || []) as { task_id: string; project_id: string | null; reopened_at: string }[],
  };
}

export async function insertAgentActivity(
  supabase: SupabaseClient,
  // agent_id is null only for a fleet host alert (see the activities route).
  entry: Omit<AgentActivity, 'id' | 'created_at' | 'agent_id'> & { agent_id: string | null }
) {
  const { data, error } = await supabase
    .from('agent_activities')
    .insert({
      agent_id: entry.agent_id,
      project_id: entry.project_id || null,
      activity_type: entry.activity_type,
      title: entry.title,
      description: entry.description || '',
      reference_type: entry.reference_type || null,
      reference_id: entry.reference_id || null,
      metadata: entry.metadata || {},
      // Only host telemetry sets it; omitted otherwise so a database without
      // the column (before its migration) still takes every older type.
      ...(entry.source_key ? { source_key: entry.source_key } : {}),
    })
    .select()
    .single();

  if (error) throw error;
  return data as AgentActivity;
}

// ============================================================
// API AUDIT LOG
// ============================================================

export async function fetchAuditLog(supabase: SupabaseClient, filters?: { entity_type?: string; entity_id?: string; team_member_id?: string; method?: string }) {
  let query = supabase
    .from('api_audit_log')
    .select('*', { count: 'exact' })
    .order('timestamp', { ascending: false })
    .limit(100);

  if (filters?.entity_type) query = query.eq('entity_type', filters.entity_type);
  if (filters?.entity_id) query = query.eq('entity_id', filters.entity_id);
  if (filters?.team_member_id) query = query.eq('team_member_id', filters.team_member_id);
  if (filters?.method) query = query.eq('method', filters.method);

  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as ApiAuditEntry[];
}

export async function fetchAuditLogForEntity(supabase: SupabaseClient, entityType: string, entityId: string) {
  const { data, error } = await supabase
    .from('api_audit_log')
    .select('*')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('timestamp', { ascending: false });

  if (error) throw error;
  return (data || []) as ApiAuditEntry[];
}

// ============================================================
// TIME ENTRIES
// ============================================================

export async function resolveProjectHourlyRate(
  supabase: SupabaseClient,
  projectId: string,
  startTime: string,
  fallbackRate?: number,
): Promise<number> {
  const { data: scheduled, error } = await supabase
    .from('project_hourly_rates')
    .select('hourly_rate')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .lte('effective_at', startTime)
    .order('effective_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (scheduled) return Number(scheduled.hourly_rate) || 0;
  if (fallbackRate !== undefined) return fallbackRate;
  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('hourly_rate')
    .eq('id', projectId)
    .is('deleted_at', null)
    .single();
  if (projectError) throw projectError;
  return Number(project.hourly_rate) || 0;
}

// The member's current billing-multiplier dial, snapshotted onto each time
// entry at session start. Agent sessions are converted on stop into one
// continuous slot of worked time times this snapshot; the rate is never
// multiplied. Falls back to 1 (parity) if unset or the column is absent.
export async function fetchMemberBillingMultiplier(
  supabase: SupabaseClient,
  memberId: string | null | undefined,
): Promise<number> {
  if (!memberId) return 1;
  const { data: member } = await supabase
    .from('team_members')
    .select('billing_multiplier')
    .eq('id', memberId)
    .maybeSingle();
  const multiplier = Number(member?.billing_multiplier);
  return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
}

// Shared embed + mapping so every read path returns task_ids consistently.
export const TIME_ENTRY_SELECT = '*, time_entry_tasks ( task_id )';

export function mapTimeEntryRow<T extends Record<string, any>>(row: T): TimeEntry {
  const { time_entry_tasks, ...entry } = row as any;
  return {
    ...entry,
    task_ids: (time_entry_tasks || []).map((link: any) => link.task_id),
  } as TimeEntry;
}

async function replaceTimeEntryTasks(supabase: SupabaseClient, entryId: string, taskIds: string[]) {
  await supabase.from('time_entry_tasks').delete().eq('time_entry_id', entryId);
  if (taskIds.length > 0) {
    const { error } = await supabase
      .from('time_entry_tasks')
      .insert([...new Set(taskIds)].map(taskId => ({ time_entry_id: entryId, task_id: taskId })));
    if (error) throw error;
  }
}

export async function fetchAllTimeEntries(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('project_time_entries')
    .select(TIME_ENTRY_SELECT)
    .is('deleted_at', null)
    .order('start_time', { ascending: false });

  if (error) throw error;
  return (data || []).map(mapTimeEntryRow);
}

export async function fetchTimeEntriesByProject(supabase: SupabaseClient, projectId: string) {
  const { data, error } = await supabase
    .from('project_time_entries')
    .select(TIME_ENTRY_SELECT)
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('start_time', { ascending: false });

  if (error) throw error;
  return (data || []).map(mapTimeEntryRow);
}

export async function insertTimeEntry(
  supabase: SupabaseClient,
  entry: Omit<TimeEntry, 'id' | 'created_at' | 'updated_at'>
) {
  const hourlyRate = await resolveProjectHourlyRate(
    supabase,
    entry.project_id,
    entry.start_time,
    entry.hourly_rate,
  );
  const billingMultiplier = await fetchMemberBillingMultiplier(supabase, entry.member_id);
  const { data, error } = await supabase
    .from('project_time_entries')
    .insert({
      project_id: entry.project_id,
      member_id: entry.member_id,
      start_time: entry.start_time,
      end_time: entry.end_time,
      segments: entry.segments ?? [],
      hourly_rate: hourlyRate,
      description: entry.description,
      billing_multiplier: billingMultiplier,
    })
    .select()
    .single();

  if (error) throw error;
  const taskIds = entry.task_ids ?? [];
  if (taskIds.length > 0) {
    await replaceTimeEntryTasks(supabase, data.id, taskIds);
  }
  return { ...data, task_ids: taskIds } as TimeEntry;
}

export async function patchTimeEntry(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<Pick<TimeEntry, 'member_id' | 'start_time' | 'end_time' | 'segments' | 'description' | 'task_ids'>>
) {
  const { task_ids, ...fieldUpdates } = updates;
  const patch: typeof fieldUpdates & { hourly_rate?: number } = { ...fieldUpdates };
  if (updates.start_time) {
    const { data: existing, error: existingError } = await supabase
      .from('project_time_entries')
      .select('project_id')
      .eq('id', id)
      .is('deleted_at', null)
      .single();
    if (existingError) throw existingError;
    patch.hourly_rate = await resolveProjectHourlyRate(supabase, existing.project_id, updates.start_time);
  }
  const { data, error } = await supabase
    .from('project_time_entries')
    .update(patch)
    .eq('id', id)
    .is('deleted_at', null)
    .select(TIME_ENTRY_SELECT)
    .single();

  if (error) throw error;
  if (task_ids !== undefined) {
    await replaceTimeEntryTasks(supabase, id, task_ids);
    return { ...mapTimeEntryRow(data), task_ids: [...new Set(task_ids)] } as TimeEntry;
  }
  return mapTimeEntryRow(data);
}

export async function removeTimeEntry(supabase: SupabaseClient, id: string, actor?: string | null) {
  await moveToTrash(supabase, 'project_time_entries', id, actor);
}

// ============================================================
// PROJECT CREDENTIALS
// ============================================================

const CREDENTIAL_LIST_COLUMNS = 'id, project_id, label, category, submitted_by_client, submitted_by_name, created_by, created_at, updated_at';

export async function fetchAllProjectCredentials(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('project_credentials')
    .select(CREDENTIAL_LIST_COLUMNS)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []) as ProjectCredentialListItem[];
}

export async function fetchProjectCredentials(supabase: SupabaseClient, projectId: string) {
  const { data, error } = await supabase
    .from('project_credentials')
    .select(CREDENTIAL_LIST_COLUMNS)
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []) as ProjectCredentialListItem[];
}

export async function fetchCredentialWithEncryptedData(supabase: SupabaseClient, id: string, projectId?: string) {
  let query = supabase.from('project_credentials').select('*').eq('id', id).is('deleted_at', null);
  if (projectId) query = query.eq('project_id', projectId);
  // Server routes reach a credential by its id alone, so one whose project is
  // in Trash must not answer either.
  const trashed = await trashedProjectIds(supabase);
  if (trashed.length) query = query.not('project_id', 'in', postgrestList(trashed));
  const { data, error } = await query.single();
  if (error) throw error;
  return data as ProjectCredential;
}

export async function insertProjectCredential(
  supabase: SupabaseClient,
  credential: {
    project_id: string;
    label: string;
    category: string;
    encrypted_data: string;
    iv: string;
    submitted_by_client?: boolean;
    submitted_by_name?: string;
    created_by?: string | null;
  },
) {
  const { data, error } = await supabase
    .from('project_credentials')
    .insert(credential)
    .select(CREDENTIAL_LIST_COLUMNS)
    .single();
  if (error) throw error;
  return data as ProjectCredentialListItem;
}

export async function patchProjectCredential(
  supabase: SupabaseClient,
  id: string,
  updates: {
    label?: string;
    category?: string;
    encrypted_data?: string;
    iv?: string;
  },
) {
  // Reached by id alone from a server route: a credential whose project is in
  // Trash is not editable either.
  const trashed = await trashedProjectIds(supabase);
  let query = supabase
    .from('project_credentials')
    .update(updates)
    .eq('id', id)
    .is('deleted_at', null);
  if (trashed.length) query = query.not('project_id', 'in', postgrestList(trashed));
  const { data, error } = await query
    .select(CREDENTIAL_LIST_COLUMNS)
    .single();
  if (error) throw error;
  return data as ProjectCredentialListItem;
}

export async function removeProjectCredential(supabase: SupabaseClient, id: string, actor?: string | null) {
  await moveToTrash(supabase, 'project_credentials', id, actor);
}

// ============================================================
// PROJECT INVOICES
// ============================================================

const INVOICE_COLUMNS = '*, invoice_time_entry_allocations(*), invoice_payments(*)';

/** A stored invoice row with its allocations and payments, as the app holds it. */
function hydrateInvoice(row: Record<string, unknown>): ProjectInvoice {
  const { invoice_time_entry_allocations, invoice_payments, ...rest } = row as Record<string, unknown> & {
    invoice_time_entry_allocations?: InvoiceTimeEntryAllocation[];
    invoice_payments?: InvoicePayment[];
  };
  const inv = rest as unknown as ProjectInvoice;
  return {
    ...inv,
    line_items: ensureLineItems(inv),
    time_allocations: invoice_time_entry_allocations || [],
    payments: (invoice_payments || [])
      .map((payment) => ({ ...payment, amount: Number(payment.amount) }))
      .sort((a, b) => a.paid_date.localeCompare(b.paid_date) || a.created_at.localeCompare(b.created_at)),
  };
}

/** One invoice re-read after a change the database made around it (payments, status). */
export async function fetchProjectInvoice(supabase: SupabaseClient, id: string) {
  const { data, error } = await supabase
    .from('project_invoices')
    .select(INVOICE_COLUMNS)
    .eq('id', id)
    .is('deleted_at', null)
    .is('invoice_payments.deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  return data ? hydrateInvoice(data as Record<string, unknown>) : null;
}

export async function fetchAllProjectInvoices(supabase: SupabaseClient) {
  const data = await fetchAllRows((from, to, count) => supabase
    .from('project_invoices')
    .select(INVOICE_COLUMNS, { count })
    .is('deleted_at', null)
    .is('invoice_payments.deleted_at', null)
    .order('date', { ascending: false })
    .order('id')
    .range(from, to));
  // Hydrate line_items via lazy synthesis so consumers always see a populated array.
  return data.map((row) => hydrateInvoice(row as Record<string, unknown>));
}

export async function insertProjectInvoice(
  supabase: SupabaseClient,
  invoice: Omit<ProjectInvoice, 'id' | 'created_at' | 'updated_at'>
) {
  const { time_allocations = [], ...invoiceRow } = invoice;
  const { data, error } = await supabase
    .rpc('save_project_invoice_with_allocations', {
      p_invoice_id: null,
      p_invoice: invoiceRow,
      p_allocations: time_allocations,
    })
    .single();
  if (error) throw error;
  const inv = data as ProjectInvoice;
  // Created as paid: the database recorded its payment too.
  if (inv.status === 'paid') {
    const fresh = await fetchProjectInvoice(supabase, inv.id);
    if (fresh) return fresh;
  }
  return { ...inv, line_items: ensureLineItems(inv), time_allocations, payments: [] };
}

export async function patchProjectInvoice(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<ProjectInvoice>
) {
  const rest: Partial<ProjectInvoice> = { ...updates };
  const time_allocations = rest.time_allocations;
  delete rest.id;
  delete rest.created_at;
  delete rest.updated_at;
  delete rest.time_allocations;
  const { data, error } = await supabase
    .rpc('save_project_invoice_with_allocations', {
      p_invoice_id: id,
      p_invoice: rest,
      p_allocations: time_allocations === undefined ? null : time_allocations,
    })
    .single();
  if (error) throw error;
  // Re-read with allocations and payments: a status change records or
  // removes payments in the same save.
  const fresh = await fetchProjectInvoice(supabase, id);
  if (!fresh) throw new Error('Invoice not found');
  return fresh;
}

export async function removeProjectInvoice(supabase: SupabaseClient, id: string, actor?: string | null) {
  await moveToTrash(supabase, 'project_invoices', id, actor);
}

/** A project's payments with the name of the API key that recorded each. */
export async function fetchProjectInvoicePayments(supabase: SupabaseClient, projectId: string) {
  const { data, error } = await supabase.rpc('project_invoice_payments', { p_project_id: projectId });
  if (error) throw error;
  return ((data ?? []) as InvoicePayment[]).map((payment) => ({ ...payment, amount: Number(payment.amount) }));
}

/** Record a payment by hand (recorded_via app). The invoice's status follows. */
export async function recordInvoicePayment(
  supabase: SupabaseClient,
  invoiceId: string,
  payment: { amount: number; paid_date: string; method: InvoicePaymentMethod | null; reference: string | null },
) {
  const { error } = await supabase.rpc('record_invoice_payment', { p_invoice_id: invoiceId, p_payment: payment });
  if (error) throw error;
}

/** Remove a payment recorded by hand. */
export async function removeInvoicePayment(supabase: SupabaseClient, paymentId: string) {
  const { error } = await supabase.rpc('remove_invoice_payment', { p_payment_id: paymentId });
  if (error) throw error;
}

// ============================================================
// PROJECT RETAINERS
// All period math lives in SQL (20260919050750_create_project_retainers.sql);
// these only read rows and call the RPCs.
// ============================================================

export interface ProjectRetainerBundle {
  retainers: ProjectRetainer[];
  amounts: ProjectRetainerAmount[];
  periods: ProjectRetainerPeriod[];
  /** Empty unless the caller holds compensation.manage (RLS). */
  shares: ProjectRetainerShare[];
}

export async function fetchProjectRetainers(
  supabase: SupabaseClient,
  projectId: string,
  includeShares: boolean,
): Promise<ProjectRetainerBundle> {
  const { data: retainers, error } = await supabase
    .from('project_retainers')
    .select('*')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('created_at');
  if (error) throw error;
  const ids = (retainers || []).map((retainer) => retainer.id);
  if (ids.length === 0) return { retainers: [], amounts: [], periods: [], shares: [] };

  const [amounts, periods, shares] = await Promise.all([
    supabase.from('project_retainer_amounts').select('*').in('retainer_id', ids).is('deleted_at', null).order('effective_date'),
    supabase.from('project_retainer_periods').select('*').in('retainer_id', ids).order('period_start'),
    includeShares
      ? supabase.from('project_retainer_shares').select('*').in('retainer_id', ids).order('effective_from')
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (amounts.error) throw amounts.error;
  if (periods.error) throw periods.error;
  if (shares.error) throw shares.error;

  return {
    retainers: (retainers || []) as ProjectRetainer[],
    amounts: ((amounts.data || []) as ProjectRetainerAmount[]).map((row) => ({ ...row, amount: Number(row.amount) })),
    periods: (periods.data || []) as ProjectRetainerPeriod[],
    shares: ((shares.data || []) as ProjectRetainerShare[]).map((row) => ({ ...row, percent: Number(row.percent) })),
  };
}

export interface SaveRetainerInput {
  project_id?: string;
  name?: string;
  billing_timing?: ProjectRetainer['billing_timing'];
  start_date?: string;
  end_date?: string | null;
  status?: ProjectRetainer['status'];
  lead_days?: number;
  /** Create only. */
  amount?: number;
  /** Create only; needs compensation.manage. */
  shares?: Array<{ member_id: string; percent: number }>;
  /** Create only: lines invoiced by hand before the retainer existed. */
  link_lines?: Array<{ invoice_id: string; line_item_id: string }>;
}

export async function saveProjectRetainer(
  supabase: SupabaseClient,
  retainerId: string | null,
  input: SaveRetainerInput,
) {
  const { data, error } = await supabase
    .rpc('save_project_retainer', { p_retainer_id: retainerId, p_retainer: input })
    .single();
  if (error) throw error;
  return data as ProjectRetainer;
}

export async function removeProjectRetainer(supabase: SupabaseClient, retainerId: string, actor?: string | null) {
  await moveToTrash(supabase, 'project_retainers', retainerId, actor);
}

export async function scheduleRetainerAmount(
  supabase: SupabaseClient,
  retainerId: string,
  amount: number,
  effectiveDate: string,
) {
  const { error } = await supabase.rpc('schedule_retainer_amount', {
    p_retainer_id: retainerId,
    p_amount: amount,
    p_effective_date: effectiveDate,
  });
  if (error) throw error;
}

export async function removeRetainerAmount(supabase: SupabaseClient, amountId: string, actor?: string | null) {
  await moveToTrash(supabase, 'project_retainer_amounts', amountId, actor);
}

export async function setRetainerShares(
  supabase: SupabaseClient,
  retainerId: string,
  shares: Array<{ member_id: string; percent: number }>,
  effectiveFrom: string,
) {
  const { error } = await supabase.rpc('set_retainer_shares', {
    p_retainer_id: retainerId,
    p_shares: shares,
    p_effective_from: effectiveFrom,
  });
  if (error) throw error;
}

export async function generateRetainerPeriod(
  supabase: SupabaseClient,
  retainerId: string,
  periodStart: string,
) {
  const { data, error } = await supabase
    .rpc('generate_retainer_period', { p_retainer_id: retainerId, p_period_start: periodStart })
    .single();
  if (error) throw error;
  const invoice = data as ProjectInvoice;
  return { ...invoice, line_items: ensureLineItems(invoice), time_allocations: [] };
}

export async function fetchRetainerDuePeriods(supabase: SupabaseClient, projectId: string) {
  const { data, error } = await supabase.rpc('retainer_due_periods', { p_project_id: projectId });
  if (error) throw error;
  return ((data || []) as RetainerDuePeriod[]).map((row) => ({
    ...row,
    amount: Number(row.amount),
    full_amount: Number(row.full_amount),
  }));
}

// -- Billing plans (scheduled hourly drafts, payment terms, forecast) --------

const DEFAULT_BILLING_PLAN: Omit<ProjectBillingPlan, 'project_id'> = {
  payment_terms_days: 0,
  hours_trigger: 'manual',
  days_of_month: [1],
  every_weeks: 2,
  weeks_anchor: null,
  trigger_amount: null,
  cap_mode: 'none',
  cap_value: null,
  min_amount: 0,
  combine_with_retainer: true,
  paused: false,
  starts_on: null,
  ends_on: null,
};

function normalizeBillingPlan(row: Record<string, unknown>): ProjectBillingPlan {
  const plan = row as unknown as ProjectBillingPlan;
  return {
    ...plan,
    payment_terms_days: Number(plan.payment_terms_days),
    days_of_month: (plan.days_of_month ?? [1]).map(Number),
    every_weeks: Number(plan.every_weeks),
    trigger_amount: plan.trigger_amount === null ? null : Number(plan.trigger_amount),
    cap_value: plan.cap_value === null ? null : Number(plan.cap_value),
    min_amount: Number(plan.min_amount),
  };
}

/** The project's plan, or the defaults (manual, due on receipt) when none is saved. */
export async function fetchBillingPlan(supabase: SupabaseClient, projectId: string): Promise<ProjectBillingPlan> {
  const { data, error } = await supabase.from('project_billing_plans').select('*').eq('project_id', projectId).maybeSingle();
  if (error) throw error;
  return data ? normalizeBillingPlan(data) : { project_id: projectId, ...DEFAULT_BILLING_PLAN };
}

export async function saveBillingPlan(
  supabase: SupabaseClient,
  projectId: string,
  plan: Partial<Omit<ProjectBillingPlan, 'project_id'>>,
): Promise<ProjectBillingPlan> {
  const { data, error } = await supabase
    .rpc('save_project_billing_plan', { p_project_id: projectId, p_plan: plan })
    .single();
  if (error) throw error;
  return normalizeBillingPlan(data as Record<string, unknown>);
}

export async function fetchBillingRuns(supabase: SupabaseClient, projectId: string, limit = 12): Promise<ProjectBillingRun[]> {
  const { data, error } = await supabase
    .from('project_billing_runs')
    .select('*')
    .eq('project_id', projectId)
    .order('run_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data || []) as ProjectBillingRun[]).map((run) => ({
    ...run,
    hours: run.hours === null ? null : Number(run.hours),
    amount: run.amount === null ? null : Number(run.amount),
    pending_hours: Number(run.pending_hours),
    pending_amount: Number(run.pending_amount),
  }));
}

/**
 * Invoices the retainers and billing plan will produce, oldest first. One
 * project, or every project the viewer can open (projectId null). previewPlan
 * shows unsaved settings for one project before Save.
 */
export async function fetchBillingForecast(
  supabase: SupabaseClient,
  projectId: string | null,
  options: { from?: string; until?: string; previewPlan?: Partial<ProjectBillingPlan> } = {},
): Promise<BillingForecastItem[]> {
  const { data, error } = await supabase.rpc('billing_forecast', {
    p_project_id: projectId,
    p_from: options.from ?? null,
    p_until: options.until ?? null,
    p_plan: options.previewPlan ?? null,
  });
  if (error) throw error;
  return ((data || []) as BillingForecastItem[]).map((item) => ({
    ...item,
    exact: Number(item.exact),
    estimated: Number(item.estimated),
    lines: item.lines.map((line) => ({ ...line, amount: Number(line.amount) })),
  }));
}

export async function fetchInvoiceLineShares(supabase: SupabaseClient, invoiceId: string) {
  const { data, error } = await supabase
    .from('invoice_line_shares')
    .select('*')
    .eq('invoice_id', invoiceId);
  if (error) throw error;
  return ((data || []) as InvoiceLineShare[]).map((row) => ({ ...row, percent: Number(row.percent) }));
}

export async function setInvoiceLineShares(
  supabase: SupabaseClient,
  invoiceId: string,
  shares: Array<Pick<InvoiceLineShare, 'line_item_id' | 'member_id' | 'percent'>>,
) {
  const { error } = await supabase.rpc('set_invoice_line_shares', {
    p_invoice_id: invoiceId,
    p_shares: shares,
  });
  if (error) throw error;
}

// ============================================================
// BUSINESS SETTINGS (singleton)
// ============================================================

export async function fetchBusinessSettings(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('business_settings')
    .select('*')
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data || null) as BusinessSettings | null;
}

export async function patchBusinessSettings(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<Omit<BusinessSettings, 'id' | 'created_at' | 'updated_at'>>,
) {
  const { data, error } = await supabase
    .from('business_settings')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data as BusinessSettings;
}

// ============================================================
// TRASH
// ============================================================

/** Everything in Trash the signed-in member may restore, newest first. */
export async function fetchTrash(supabase: SupabaseClient): Promise<TrashItem[]> {
  const { data, error } = await supabase.rpc('list_trash');
  if (error) throw error;
  return ((data || []) as TrashItem[]).sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
}
