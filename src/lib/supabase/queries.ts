import { SupabaseClient } from '@supabase/supabase-js';
import type { Project, Task, TeamMember, Subtask, Comment, Activity, Client, Lead } from '@/lib/types';

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
      client_id: project.client_id || null,
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
// CLIENTS
// ============================================================

export async function fetchClients(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []) as Client[];
}

export async function insertClient(
  supabase: SupabaseClient,
  client: Omit<Client, 'id' | 'created_at' | 'updated_at'>
) {
  const { data, error } = await supabase
    .from('clients')
    .insert({
      name: client.name,
      email: client.email,
      phone: client.phone,
      company: client.company,
      notes: client.notes,
      color: client.color,
      created_by: client.created_by || null,
    })
    .select()
    .single();

  if (error) throw error;
  return data as Client;
}

export async function patchClient(
  supabase: SupabaseClient,
  id: string,
  updates: Partial<Client>
) {
  const { data, error } = await supabase
    .from('clients')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data as Client;
}

export async function removeClient(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from('clients').delete().eq('id', id);
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
      client_id: lead.client_id || null,
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

export async function convertLead(
  supabase: SupabaseClient,
  lead: Lead,
  projectName: string,
  projectColor: string,
  projectDescription: string,
  createdBy: string | null
) {
  // 1. Create client from lead data
  const { data: client, error: clientError } = await supabase
    .from('clients')
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

  if (clientError) throw clientError;

  // 2. Create project linked to client
  const { data: project, error: projectError } = await supabase
    .from('projects')
    .insert({
      name: projectName,
      description: projectDescription,
      color: projectColor,
      status: 'active',
      client_id: client.id,
      created_by: createdBy,
    })
    .select()
    .single();

  if (projectError) throw projectError;

  // 3. Update lead status to won and link to client
  const { data: updatedLead, error: leadError } = await supabase
    .from('leads')
    .update({ status: 'won', client_id: client.id })
    .eq('id', lead.id)
    .select()
    .single();

  if (leadError) throw leadError;

  return {
    client: client as Client,
    project: { ...project, member_ids: [], client_id: client.id } as Project,
    lead: updatedLead as Lead,
  };
}
