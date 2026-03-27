import { SupabaseClient } from '@supabase/supabase-js';
import type { Project, Task, TeamMember, Subtask, Comment, Activity, Contact, ProjectContact, Lead, LeadInteraction, LeadProposal, LeadField, LeadContact, PortalSettings, PortalUpdate, PortalUpdateAttachment, EntityFile, ApiKey, ProjectGoal, TaskSuggestion, AgentActivity, ApiAuditEntry, TimeEntry, ProjectCredential, ProjectCredentialListItem, ProjectInvoice } from '@/lib/types';
import { notFound } from '@/lib/api/errors';
import { siteConfig } from '@/site-config';
import { generatePortalSlug } from '@/lib/portal-slug';

// ============================================================
// PROJECTS
// ============================================================

export async function fetchProjects(supabase: SupabaseClient) {
  const { data: projects, error } = await supabase
    .from('projects')
    .select(`
      *,
      project_members ( member_id )
    `)
    .order('created_at', { ascending: false });

  if (error) throw error;

  return (projects || []).map((p: any) => ({
    ...p,
    member_ids: (p.project_members || []).map((pm: any) => pm.member_id),
    project_members: undefined,
  })) as Project[];
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
      deployment_policy: project.deployment_policy ?? 'production',
      max_concurrent_tasks: project.max_concurrent_tasks ?? 2,
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

  const { data, error } = await supabase
    .from('projects')
    .update(dbUpdates)
    .eq('id', id)
    .select()
    .single();

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

  return { ...data, member_ids: memberIds ?? [] } as Project;
}

export async function removeProject(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from('projects').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================
// TASKS
// ============================================================

export async function fetchTasks(supabase: SupabaseClient) {
  const { data: tasks, error } = await supabase
    .from('tasks')
    .select(`
      *,
      task_assignees ( member_id ),
      subtasks:task_subtasks ( id, task_id, title, completed, sort_order ),
      comments:task_comments ( id, task_id, user_id, text, created_at )
    `)
    .order('created_at', { ascending: false });

  if (error) throw error;

  return (tasks || []).map((t: any) => ({
    ...t,
    assignee_ids: (t.task_assignees || []).map((ta: any) => ta.member_id),
    subtasks: (t.subtasks || []).sort((a: any, b: any) => a.sort_order - b.sort_order),
    comments: (t.comments || []).sort(
      (a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    ),
    task_assignees: undefined,
  })) as Task[];
}

export async function insertTask(
  supabase: SupabaseClient,
  task: Omit<Task, 'id' | 'created_at' | 'updated_at' | 'assignee_ids' | 'subtasks' | 'comments'>,
  assigneeIds: string[]
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
  if (task.ai_managed !== undefined) insertPayload.ai_managed = task.ai_managed;

  const { data, error } = await supabase
    .from('tasks')
    .insert(insertPayload)
    .select()
    .single();

  if (error) throw error;

  if (assigneeIds.length > 0) {
    const { error: junctionError } = await supabase
      .from('task_assignees')
      .insert(assigneeIds.map(mid => ({ task_id: data.id, member_id: mid })));
    if (junctionError) throw junctionError;
  }

  return { ...data, assignee_ids: assigneeIds, subtasks: [], comments: [] } as Task;
}

export async function patchTask(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<Task>,
  assigneeIds?: string[]
) {
  const { assignee_ids, subtasks, comments, task_assignees, ...dbUpdates } = updates as any;

  const { data, error } = await supabase
    .from('tasks')
    .update(dbUpdates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;

  if (assigneeIds !== undefined) {
    await supabase.from('task_assignees').delete().eq('task_id', id);
    if (assigneeIds.length > 0) {
      const { error: junctionError } = await supabase
        .from('task_assignees')
        .insert(assigneeIds.map(mid => ({ task_id: id, member_id: mid })));
      if (junctionError) throw junctionError;
    }
  }

  return data;
}

export async function removeTask(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from('tasks').delete().eq('id', id);
  if (error) throw error;
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
    .eq('id', subtaskId);

  if (error) throw error;
}

export async function reorderSubtasks(
  supabase: SupabaseClient,
  subtaskIds: string[]
) {
  // Update sort_order for each subtask
  const updates = subtaskIds.map((id, index) =>
    supabase.from('task_subtasks').update({ sort_order: index }).eq('id', id)
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
    .eq('id', subtaskId);

  if (error) throw error;
}

export async function removeSubtask(supabase: SupabaseClient, subtaskId: string) {
  const { error } = await supabase.from('task_subtasks').delete().eq('id', subtaskId);
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
    .eq('id', commentId);

  if (error) throw error;
}

export async function removeComment(supabase: SupabaseClient, commentId: string) {
  const { error } = await supabase.from('task_comments').delete().eq('id', commentId);
  if (error) throw error;
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

export async function removeTeamMember(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from('team_members').delete().eq('id', id);
  if (error) throw error;
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
    .select()
    .single();

  if (error) throw error;
  return data as Contact;
}

export async function removeContact(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from('contacts').delete().eq('id', id);
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
      value: lead.value,
      equity: lead.equity,
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

export async function removeLead(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from('leads').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================
// LEAD INTERACTIONS
// ============================================================

export async function fetchLeadInteractions(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('lead_interactions')
    .select('*')
    .order('occurred_at', { ascending: false });

  if (error) throw error;
  return (data || []) as LeadInteraction[];
}

export async function fetchLeadInteractionsByLeadId(supabase: SupabaseClient, leadId: string) {
  const { data, error } = await supabase
    .from('lead_interactions')
    .select('*')
    .eq('lead_id', leadId)
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
    .select()
    .single();

  if (error) throw error;
  return data as LeadInteraction;
}

export async function removeLeadInteraction(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from('lead_interactions').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================
// LEAD PROPOSALS
// ============================================================

export async function fetchLeadProposals(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('lead_proposals')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []) as LeadProposal[];
}

export async function fetchLeadProposalsByLeadId(supabase: SupabaseClient, leadId: string) {
  const { data, error } = await supabase
    .from('lead_proposals')
    .select('*')
    .eq('lead_id', leadId)
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
    .select()
    .single();

  if (error) throw error;
  return data as LeadProposal;
}

export async function removeLeadProposal(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from('lead_proposals').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================
// LEAD FIELDS
// ============================================================

export async function fetchLeadFields(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('lead_fields')
    .select('*')
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
  const { data, error } = await supabase
    .from('lead_fields')
    .upsert(
      { lead_id: leadId, field_key: fieldKey, value },
      { onConflict: 'lead_id,field_key' }
    )
    .select()
    .single();

  if (error) throw error;
  return data as LeadField;
}

export async function removeLeadField(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from('lead_fields').delete().eq('id', id);
  if (error) throw error;
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
  // 1. Reuse existing contact if lead has one, otherwise create one
  let contactId = lead.contact_id;

  if (!contactId) {
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .insert({
        name: lead.name,
        email: lead.email,
        phone: lead.phone,
        company: lead.company,
        color: projectColor,
        created_by: createdBy,
      })
      .select()
      .single();

    if (contactError) throw contactError;
    contactId = contact.id;
  }

  // 2. Create project (no client_id)
  const { data: project, error: projectError } = await supabase
    .from('projects')
    .insert({
      name: projectName,
      description: projectDescription,
      color: projectColor,
      status: 'active',
      created_by: createdBy,
    })
    .select()
    .single();

  if (projectError) throw projectError;

  // 3. Create project_contact (role='Client', is_primary_client=true)
  const { data: projectContact, error: pcError } = await supabase
    .from('project_contacts')
    .insert({
      project_id: project.id,
      contact_id: contactId,
      role: 'Client',
      is_primary_client: true,
    })
    .select('*, contact:contacts(*)')
    .single();

  if (pcError) throw pcError;

  // 4. Copy additional lead_contacts (non-primary) to project_contacts
  const { data: additionalLeadContacts } = await supabase
    .from('lead_contacts')
    .select('*')
    .eq('lead_id', lead.id)
    .eq('is_primary_client', false);

  const additionalProjectContacts: ProjectContact[] = [];
  if (additionalLeadContacts && additionalLeadContacts.length > 0) {
    for (const lc of additionalLeadContacts) {
      const { data: newPc, error: addPcError } = await supabase
        .from('project_contacts')
        .insert({
          project_id: project.id,
          contact_id: lc.contact_id,
          role: lc.role,
          custom_role: lc.custom_role,
          is_primary_client: false,
        })
        .select('*, contact:contacts(*)')
        .single();

      if (!addPcError && newPc) {
        additionalProjectContacts.push(newPc as ProjectContact);
      }
    }
  }

  // 5. Copy lead_members to project_members
  const leadMemberIds = lead.member_ids || [];
  if (leadMemberIds.length > 0) {
    const { error: pmError } = await supabase
      .from('project_members')
      .insert(leadMemberIds.map(mid => ({ project_id: project.id, member_id: mid })));
    if (pmError) throw pmError;
  }

  // 6. Update lead status to won and link contact
  const { data: updatedLead, error: leadError } = await supabase
    .from('leads')
    .update({ status: 'won', contact_id: contactId })
    .eq('id', lead.id)
    .select()
    .single();

  if (leadError) throw leadError;

  // Fetch the contact for return
  const { data: contact } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', contactId)
    .single();

  return {
    contact: contact as Contact,
    project: { ...project, member_ids: leadMemberIds } as Project,
    projectContact: projectContact as ProjectContact,
    additionalProjectContacts,
    lead: { ...updatedLead, member_ids: leadMemberIds } as Lead,
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
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []) as PortalUpdate[];
}

export async function fetchPortalUpdates(supabase: SupabaseClient, projectId: string) {
  const { data, error } = await supabase
    .from('portal_updates')
    .select('*')
    .eq('project_id', projectId)
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
    .select()
    .single();

  if (error) throw error;
  return data as PortalUpdate;
}

export async function removePortalUpdate(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from('portal_updates').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================
// PORTAL UPDATE ATTACHMENTS
// ============================================================

export async function fetchAllPortalUpdateAttachments(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('portal_update_attachments')
    .select('*')
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

export async function removePortalUpdateAttachment(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from('portal_update_attachments').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================
// ENTITY FILES
// ============================================================

export async function fetchAllEntityFiles(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('entity_files')
    .select('*')
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
    .select()
    .single();
  if (error) throw error;
  return data as EntityFile;
}

export async function removeEntityFile(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from('entity_files').delete().eq('id', id);
  if (error) throw error;
}

export async function updateEntityFileVisibility(supabase: SupabaseClient, id: string, visibility: 'internal' | 'external') {
  const { data, error } = await supabase
    .from('entity_files')
    .update({ visibility })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data as EntityFile;
}

// ============================================================
// API KEYS
// ============================================================

export async function fetchApiKeys(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, name, key_prefix, permissions, last_used_at, revoked_at, created_by, team_member_id, created_at, updated_at')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []) as ApiKey[];
}

export async function insertApiKey(
  supabase: SupabaseClient,
  apiKey: { name: string; key_prefix: string; key_hash: string; created_by: string | null; permissions?: string; team_member_id?: string | null }
) {
  const { data, error } = await supabase
    .from('api_keys')
    .insert({
      name: apiKey.name,
      key_prefix: apiKey.key_prefix,
      key_hash: apiKey.key_hash,
      created_by: apiKey.created_by,
      permissions: apiKey.permissions || 'full',
      team_member_id: apiKey.team_member_id || null,
    })
    .select('id, name, key_prefix, permissions, last_used_at, revoked_at, created_by, team_member_id, created_at, updated_at')
    .single();

  if (error) throw error;
  return data as ApiKey;
}

export async function revokeApiKey(supabase: SupabaseClient, id: string) {
  const { data, error } = await supabase
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data as ApiKey;
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

export async function approveTaskSuggestion(
  supabase: SupabaseClient,
  id: string,
  taskOverrides: { priority?: string; assigned_to?: string | null; due_date?: string | null; project_id?: string; task_type?: string | null },
  reviewedBy: string,
  aiManaged?: boolean
) {
  // Fetch the suggestion
  const { data: suggestion, error: fetchErr } = await supabase
    .from('task_suggestions')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchErr || !suggestion) throw fetchErr || new Error('Suggestion not found');

  // Create the task
  const resolvedTaskType = taskOverrides.task_type !== undefined ? taskOverrides.task_type : suggestion.task_type || null;
  const taskData: Record<string, any> = {
    project_id: taskOverrides.project_id || suggestion.project_id,
    title: suggestion.title,
    description: suggestion.description,
    status: 'todo' as const,
    priority: (taskOverrides.priority || suggestion.priority) as Task['priority'],
    due_date: taskOverrides.due_date || null,
    tags: [] as string[],
    source_task_suggestion_id: id,
    project_goal_id: suggestion.goal_id,
  };
  if (resolvedTaskType) taskData.task_type = resolvedTaskType;
  if (aiManaged !== undefined) taskData.ai_managed = aiManaged;

  const { data: task, error: taskErr } = await supabase
    .from('tasks')
    .insert(taskData)
    .select()
    .single();

  if (taskErr) throw taskErr;

  // If assigned_to is set, create task_assignee
  const assignedTo = taskOverrides.assigned_to || suggestion.assigned_to;
  if (assignedTo) {
    await supabase
      .from('task_assignees')
      .insert({ task_id: task.id, member_id: assignedTo })
      .then(() => {}, () => {});
  }

  // Update the suggestion
  const { data: updated, error: updateErr } = await supabase
    .from('task_suggestions')
    .update({
      status: 'approved',
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
      converted_task_id: task.id,
    })
    .eq('id', id)
    .select()
    .single();

  if (updateErr) throw updateErr;

  return {
    suggestion: updated as TaskSuggestion,
    task: { ...task, assignee_ids: assignedTo ? [assignedTo] : [], subtasks: [], comments: [] } as Task,
  };
}

export async function rejectTaskSuggestion(
  supabase: SupabaseClient,
  id: string,
  reason: string | undefined,
  reviewedBy: string
) {
  const { data, error } = await supabase
    .from('task_suggestions')
    .update({
      status: 'rejected',
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
      rejection_reason: reason || null,
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data as TaskSuggestion;
}

export async function requestInfoTaskSuggestion(
  supabase: SupabaseClient,
  id: string,
  infoRequest: string,
  reviewedBy: string
) {
  const { data, error } = await supabase
    .from('task_suggestions')
    .update({
      status: 'needs_info',
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
      info_request: infoRequest,
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
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

export async function fetchAgentActivity(supabase: SupabaseClient, filters?: { agent_id?: string; project_id?: string; activity_type?: string }) {
  let query = supabase
    .from('agent_activities')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

  if (filters?.agent_id) query = query.eq('agent_id', filters.agent_id);
  if (filters?.project_id) query = query.eq('project_id', filters.project_id);
  if (filters?.activity_type) query = query.eq('activity_type', filters.activity_type);

  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as AgentActivity[];
}

export async function insertAgentActivity(
  supabase: SupabaseClient,
  entry: Omit<AgentActivity, 'id' | 'created_at'>
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

export async function fetchAllTimeEntries(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('project_time_entries')
    .select('*')
    .order('start_time', { ascending: false });

  if (error) throw error;
  return (data || []) as TimeEntry[];
}

export async function fetchTimeEntriesByProject(supabase: SupabaseClient, projectId: string) {
  const { data, error } = await supabase
    .from('project_time_entries')
    .select('*')
    .eq('project_id', projectId)
    .order('start_time', { ascending: false });

  if (error) throw error;
  return (data || []) as TimeEntry[];
}

export async function insertTimeEntry(
  supabase: SupabaseClient,
  entry: Omit<TimeEntry, 'id' | 'created_at' | 'updated_at'>
) {
  const { data, error } = await supabase
    .from('project_time_entries')
    .insert({
      project_id: entry.project_id,
      member_id: entry.member_id,
      start_time: entry.start_time,
      end_time: entry.end_time,
      description: entry.description,
    })
    .select()
    .single();

  if (error) throw error;
  return data as TimeEntry;
}

export async function patchTimeEntry(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<Pick<TimeEntry, 'member_id' | 'start_time' | 'end_time' | 'description'>>
) {
  const { data, error } = await supabase
    .from('project_time_entries')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data as TimeEntry;
}

export async function removeTimeEntry(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from('project_time_entries').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================
// PROJECT CREDENTIALS
// ============================================================

const CREDENTIAL_LIST_COLUMNS = 'id, project_id, label, category, submitted_by_client, submitted_by_name, created_by, created_at, updated_at';

export async function fetchAllProjectCredentials(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('project_credentials')
    .select(CREDENTIAL_LIST_COLUMNS)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []) as ProjectCredentialListItem[];
}

export async function fetchProjectCredentials(supabase: SupabaseClient, projectId: string) {
  const { data, error } = await supabase
    .from('project_credentials')
    .select(CREDENTIAL_LIST_COLUMNS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []) as ProjectCredentialListItem[];
}

export async function fetchCredentialWithEncryptedData(supabase: SupabaseClient, id: string, projectId?: string) {
  let query = supabase.from('project_credentials').select('*').eq('id', id);
  if (projectId) query = query.eq('project_id', projectId);
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
  const { data, error } = await supabase
    .from('project_credentials')
    .update(updates)
    .eq('id', id)
    .select(CREDENTIAL_LIST_COLUMNS)
    .single();
  if (error) throw error;
  return data as ProjectCredentialListItem;
}

export async function removeProjectCredential(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from('project_credentials').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================
// PROJECT INVOICES
// ============================================================

export async function fetchAllProjectInvoices(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('project_invoices')
    .select('*')
    .order('date', { ascending: false });
  if (error) throw error;
  return (data || []) as ProjectInvoice[];
}

export async function insertProjectInvoice(
  supabase: SupabaseClient,
  invoice: Omit<ProjectInvoice, 'id' | 'created_at' | 'updated_at'>
) {
  const { data, error } = await supabase
    .from('project_invoices')
    .insert({
      project_id: invoice.project_id,
      invoice_number: invoice.invoice_number,
      amount: invoice.amount,
      status: invoice.status,
      date: invoice.date,
      due_date: invoice.due_date,
      paid_date: invoice.paid_date,
      description: invoice.description,
      file_url: invoice.file_url,
      file_name: invoice.file_name,
      file_size: invoice.file_size,
      mime_type: invoice.mime_type,
      created_by: invoice.created_by,
    })
    .select()
    .single();
  if (error) throw error;
  return data as ProjectInvoice;
}

export async function patchProjectInvoice(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<ProjectInvoice>
) {
  const { id: _id, created_at, updated_at, ...rest } = updates as any;
  const { data, error } = await supabase
    .from('project_invoices')
    .update(rest)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data as ProjectInvoice;
}

export async function removeProjectInvoice(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from('project_invoices').delete().eq('id', id);
  if (error) throw error;
}
