import { SupabaseClient } from '@supabase/supabase-js';
import type { Project, Task, TeamMember, Subtask, Comment, Activity, Contact, ProjectContact, Lead, LeadInteraction, LeadProposal } from '@/lib/types';

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
  memberIds: string[]
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
      subtasks ( id, task_id, title, completed, sort_order ),
      comments ( id, task_id, user_id, text, created_at )
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
  const { data, error } = await supabase
    .from('tasks')
    .insert({
      project_id: task.project_id,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      due_date: task.due_date,
      tags: task.tags,
      created_by: task.created_by,
    })
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
    .from('subtasks')
    .select('sort_order')
    .eq('task_id', taskId)
    .order('sort_order', { ascending: false })
    .limit(1);

  const sortOrder = existing && existing.length > 0 ? existing[0].sort_order + 1 : 0;

  const { data, error } = await supabase
    .from('subtasks')
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
    .from('subtasks')
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
    supabase.from('subtasks').update({ sort_order: index }).eq('id', id)
  );
  await Promise.all(updates);
}

export async function patchSubtask(
  supabase: SupabaseClient,
  subtaskId: string,
  updates: Partial<Pick<Subtask, 'title' | 'completed' | 'sort_order'>>
) {
  const { error } = await supabase
    .from('subtasks')
    .update(updates)
    .eq('id', subtaskId);

  if (error) throw error;
}

export async function removeSubtask(supabase: SupabaseClient, subtaskId: string) {
  const { error } = await supabase.from('subtasks').delete().eq('id', subtaskId);
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
    .from('comments')
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
    .from('comments')
    .update({ text })
    .eq('id', commentId);

  if (error) throw error;
}

export async function removeComment(supabase: SupabaseClient, commentId: string) {
  const { error } = await supabase.from('comments').delete().eq('id', commentId);
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
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []) as Lead[];
}

export async function insertLead(
  supabase: SupabaseClient,
  lead: Omit<Lead, 'id' | 'created_at' | 'updated_at'>
) {
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
      notes: lead.notes,
      assigned_to: lead.assigned_to || null,
      contact_id: lead.contact_id || null,
      created_by: lead.created_by || null,
    })
    .select()
    .single();

  if (error) throw error;
  return data as Lead;
}

export async function patchLead(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<Lead>
) {
  const { data, error } = await supabase
    .from('leads')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data as Lead;
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

  // 4. Update lead status to won and link contact
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
    project: { ...project, member_ids: [] } as Project,
    projectContact: projectContact as ProjectContact,
    lead: updatedLead as Lead,
  };
}
