'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Project, Task, TeamMember, FilterState, ViewMode, Subtask, Comment, Client, Lead } from './types';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/lib/auth-context';
import {
  fetchProjects,
  insertProject,
  patchProject,
  removeProject,
  fetchTasks,
  insertTask,
  patchTask,
  removeTask,
  insertSubtask,
  toggleSubtaskCompleted,
  removeSubtask,
  insertComment,
  removeComment,
  fetchTeamMembers,
  insertTeamMember,
  patchTeamMember,
  removeTeamMember,
  fetchClients,
  insertClient,
  patchClient,
  removeClient,
  fetchLeads,
  insertLead,
  patchLead,
  removeLead,
  convertLead as convertLeadQuery,
} from '@/lib/supabase/queries';
import { toast } from '@/components/ui/Toast';

interface AppContextType {
  // Data
  projects: Project[];
  tasks: Task[];
  team: TeamMember[];
  clients: Client[];
  leads: Lead[];
  loading: boolean;

  // Filters
  filters: FilterState;
  setFilters: (filters: FilterState) => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;

  // Project CRUD
  addProject: (project: Omit<Project, 'id' | 'created_at' | 'updated_at'>) => void;
  updateProject: (id: string, updates: Partial<Project>) => void;
  deleteProject: (id: string) => void;

  // Task CRUD
  addTask: (task: Omit<Task, 'id' | 'created_at' | 'updated_at'>) => void;
  updateTask: (id: string, updates: Partial<Task>) => void;
  deleteTask: (id: string) => void;

  // Subtasks
  addSubtask: (taskId: string, title: string) => void;
  toggleSubtask: (taskId: string, subtaskId: string) => void;
  deleteSubtask: (taskId: string, subtaskId: string) => void;

  // Comments
  addComment: (taskId: string, text: string, userId: string) => void;
  deleteComment: (taskId: string, commentId: string) => void;

  // Team CRUD
  addTeamMember: (member: Omit<TeamMember, 'id'>) => void;
  updateTeamMember: (id: string, updates: Partial<TeamMember>) => void;
  deleteTeamMember: (id: string) => void;

  // Client CRUD
  addClient: (client: Omit<Client, 'id' | 'created_at' | 'updated_at'>) => void;
  updateClient: (id: string, updates: Partial<Client>) => void;
  deleteClient: (id: string) => void;

  // Lead CRUD
  addLead: (lead: Omit<Lead, 'id' | 'created_at' | 'updated_at'>) => void;
  updateLead: (id: string, updates: Partial<Lead>) => void;
  deleteLead: (id: string) => void;
  convertLead: (leadId: string, projectName: string, projectColor: string, projectDescription: string) => void;

  // Helpers
  getProject: (id: string) => Project | undefined;
  getTasksByProject: (projectId: string) => Task[];
  getTeamMember: (id: string) => TeamMember | undefined;
  getClient: (id: string) => Client | undefined;
  getProjectsByClient: (clientId: string) => Project[];
}

const defaultFilters: FilterState = {
  status: [],
  priority: [],
  assigneeIds: [],
  tags: [],
  search: '',
};

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [viewMode, setViewMode] = useState<ViewMode>('board');
  const [loading, setLoading] = useState(true);

  const { user, teamMemberId } = useAuth();
  const supabase = createClient();

  // Fetch all data from Supabase on mount
  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }

    const loadData = async () => {
      try {
        const [projectsData, tasksData, teamData, clientsData, leadsData] = await Promise.all([
          fetchProjects(supabase),
          fetchTasks(supabase),
          fetchTeamMembers(supabase),
          fetchClients(supabase),
          fetchLeads(supabase),
        ]);

        setProjects(projectsData);
        setTasks(tasksData);
        setTeam(teamData);
        setClients(clientsData);
        setLeads(leadsData);
      } catch (err) {
        console.error('Failed to load data:', err);
        toast('error', 'Failed to load data from server');
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [user]);

  // Project CRUD
  const addProject = async (project: Omit<Project, 'id' | 'created_at' | 'updated_at'>) => {
    const memberIds = project.member_ids || [];
    const optimisticId = crypto.randomUUID();
    const now = new Date().toISOString();
    const optimistic: Project = {
      ...project,
      id: optimisticId,
      member_ids: memberIds,
      created_at: now,
      updated_at: now,
    };

    setProjects(prev => [optimistic, ...prev]);

    try {
      const newProject = await insertProject(supabase, { ...project, created_by: teamMemberId }, memberIds);
      setProjects(prev => prev.map(p => p.id === optimisticId ? newProject : p));
    } catch (err) {
      setProjects(prev => prev.filter(p => p.id !== optimisticId));
      toast('error', 'Failed to create project');
    }
  };

  const updateProject = async (id: string, updates: Partial<Project>) => {
    const prev = projects;
    setProjects(p => p.map(proj =>
      proj.id === id ? { ...proj, ...updates, updated_at: new Date().toISOString() } : proj
    ));

    try {
      await patchProject(supabase, id, updates, updates.member_ids);
    } catch (err) {
      setProjects(prev);
      toast('error', 'Failed to update project');
    }
  };

  const deleteProject = async (id: string) => {
    const prev = projects;
    const prevTasks = tasks;
    setProjects(p => p.filter(proj => proj.id !== id));
    setTasks(t => t.filter(task => task.project_id !== id));

    try {
      await removeProject(supabase, id);
    } catch (err) {
      setProjects(prev);
      setTasks(prevTasks);
      toast('error', 'Failed to delete project');
    }
  };

  // Task CRUD
  const addTask = async (task: Omit<Task, 'id' | 'created_at' | 'updated_at'>) => {
    const assigneeIds = task.assignee_ids || [];
    const optimisticId = crypto.randomUUID();
    const now = new Date().toISOString();
    const optimistic: Task = {
      ...task,
      id: optimisticId,
      assignee_ids: assigneeIds,
      subtasks: task.subtasks || [],
      comments: task.comments || [],
      created_at: now,
      updated_at: now,
    };

    setTasks(prev => [optimistic, ...prev]);

    try {
      const newTask = await insertTask(supabase, { ...task, created_by: teamMemberId }, assigneeIds);
      setTasks(prev => prev.map(t => t.id === optimisticId ? newTask : t));
    } catch (err) {
      setTasks(prev => prev.filter(t => t.id !== optimisticId));
      toast('error', 'Failed to create task');
    }
  };

  const updateTask = async (id: string, updates: Partial<Task>) => {
    const prev = tasks;
    setTasks(t => t.map(task =>
      task.id === id ? { ...task, ...updates, updated_at: new Date().toISOString() } : task
    ));

    try {
      await patchTask(supabase, id, updates, updates.assignee_ids);
    } catch (err) {
      setTasks(prev);
      toast('error', 'Failed to update task');
    }
  };

  const deleteTask = async (id: string) => {
    const prev = tasks;
    setTasks(t => t.filter(task => task.id !== id));

    try {
      await removeTask(supabase, id);
    } catch (err) {
      setTasks(prev);
      toast('error', 'Failed to delete task');
    }
  };

  // Subtasks
  const addSubtask = async (taskId: string, title: string) => {
    const optimisticId = crypto.randomUUID();
    const optimistic: Subtask = { id: optimisticId, task_id: taskId, title, completed: false, sort_order: 999 };

    setTasks(prev => prev.map(t =>
      t.id === taskId
        ? { ...t, subtasks: [...t.subtasks, optimistic], updated_at: new Date().toISOString() }
        : t
    ));

    try {
      const newSubtask = await insertSubtask(supabase, taskId, title);
      setTasks(prev => prev.map(t =>
        t.id === taskId
          ? { ...t, subtasks: t.subtasks.map(s => s.id === optimisticId ? newSubtask : s) }
          : t
      ));
    } catch (err) {
      setTasks(prev => prev.map(t =>
        t.id === taskId
          ? { ...t, subtasks: t.subtasks.filter(s => s.id !== optimisticId) }
          : t
      ));
      toast('error', 'Failed to add subtask');
    }
  };

  const toggleSubtask = async (taskId: string, subtaskId: string) => {
    const task = tasks.find(t => t.id === taskId);
    const subtask = task?.subtasks.find(s => s.id === subtaskId);
    if (!subtask) return;

    const newCompleted = !subtask.completed;

    setTasks(prev => prev.map(t =>
      t.id === taskId
        ? {
            ...t,
            subtasks: t.subtasks.map(s => s.id === subtaskId ? { ...s, completed: newCompleted } : s),
            updated_at: new Date().toISOString(),
          }
        : t
    ));

    try {
      await toggleSubtaskCompleted(supabase, subtaskId, newCompleted);
    } catch (err) {
      setTasks(prev => prev.map(t =>
        t.id === taskId
          ? {
              ...t,
              subtasks: t.subtasks.map(s => s.id === subtaskId ? { ...s, completed: !newCompleted } : s),
            }
          : t
      ));
      toast('error', 'Failed to update subtask');
    }
  };

  const deleteSubtask = async (taskId: string, subtaskId: string) => {
    const prev = tasks;
    setTasks(t => t.map(task =>
      task.id === taskId
        ? { ...task, subtasks: task.subtasks.filter(s => s.id !== subtaskId), updated_at: new Date().toISOString() }
        : task
    ));

    try {
      await removeSubtask(supabase, subtaskId);
    } catch (err) {
      setTasks(prev);
      toast('error', 'Failed to delete subtask');
    }
  };

  // Comments
  const addComment = async (taskId: string, text: string, userId: string) => {
    const optimisticId = crypto.randomUUID();
    const optimistic: Comment = { id: optimisticId, task_id: taskId, user_id: userId, text, created_at: new Date().toISOString() };

    setTasks(prev => prev.map(t =>
      t.id === taskId
        ? { ...t, comments: [...t.comments, optimistic], updated_at: new Date().toISOString() }
        : t
    ));

    try {
      const newComment = await insertComment(supabase, taskId, userId, text);
      setTasks(prev => prev.map(t =>
        t.id === taskId
          ? { ...t, comments: t.comments.map(c => c.id === optimisticId ? newComment : c) }
          : t
      ));
    } catch (err) {
      setTasks(prev => prev.map(t =>
        t.id === taskId
          ? { ...t, comments: t.comments.filter(c => c.id !== optimisticId) }
          : t
      ));
      toast('error', 'Failed to add comment');
    }
  };

  const deleteComment = async (taskId: string, commentId: string) => {
    const prev = tasks;
    setTasks(t => t.map(task =>
      task.id === taskId
        ? { ...task, comments: task.comments.filter(c => c.id !== commentId), updated_at: new Date().toISOString() }
        : task
    ));

    try {
      await removeComment(supabase, commentId);
    } catch (err) {
      setTasks(prev);
      toast('error', 'Failed to delete comment');
    }
  };

  // Team CRUD
  const addTeamMember = async (member: Omit<TeamMember, 'id'>) => {
    const optimisticId = crypto.randomUUID();
    const optimistic: TeamMember = { ...member, id: optimisticId };

    setTeam(prev => [...prev, optimistic]);

    try {
      const newMember = await insertTeamMember(supabase, member);
      setTeam(prev => prev.map(m => m.id === optimisticId ? newMember : m));
    } catch (err) {
      setTeam(prev => prev.filter(m => m.id !== optimisticId));
      toast('error', 'Failed to add team member');
    }
  };

  const updateTeamMember = async (id: string, updates: Partial<TeamMember>) => {
    const prev = team;
    setTeam(t => t.map(m => m.id === id ? { ...m, ...updates } : m));

    try {
      await patchTeamMember(supabase, id, updates);
    } catch (err) {
      setTeam(prev);
      toast('error', 'Failed to update team member');
    }
  };

  const deleteTeamMember = async (id: string) => {
    const prev = team;
    setTeam(t => t.filter(m => m.id !== id));

    try {
      await removeTeamMember(supabase, id);
    } catch (err) {
      setTeam(prev);
      toast('error', 'Failed to remove team member');
    }
  };

  // Client CRUD
  const addClient = async (client: Omit<Client, 'id' | 'created_at' | 'updated_at'>) => {
    const optimisticId = crypto.randomUUID();
    const now = new Date().toISOString();
    const optimistic: Client = {
      ...client,
      id: optimisticId,
      created_at: now,
      updated_at: now,
    };

    setClients(prev => [optimistic, ...prev]);

    try {
      const newClient = await insertClient(supabase, { ...client, created_by: teamMemberId });
      setClients(prev => prev.map(c => c.id === optimisticId ? newClient : c));
    } catch (err) {
      setClients(prev => prev.filter(c => c.id !== optimisticId));
      toast('error', 'Failed to create client');
    }
  };

  const updateClient = async (id: string, updates: Partial<Client>) => {
    const prev = clients;
    setClients(c => c.map(client =>
      client.id === id ? { ...client, ...updates, updated_at: new Date().toISOString() } : client
    ));

    try {
      await patchClient(supabase, id, updates);
    } catch (err) {
      setClients(prev);
      toast('error', 'Failed to update client');
    }
  };

  const deleteClient = async (id: string) => {
    const prev = clients;
    setClients(c => c.filter(client => client.id !== id));

    try {
      await removeClient(supabase, id);
    } catch (err) {
      setClients(prev);
      toast('error', 'Failed to delete client');
    }
  };

  // Lead CRUD
  const addLead = async (lead: Omit<Lead, 'id' | 'created_at' | 'updated_at'>) => {
    const optimisticId = crypto.randomUUID();
    const now = new Date().toISOString();
    const optimistic: Lead = {
      ...lead,
      id: optimisticId,
      created_at: now,
      updated_at: now,
    };

    setLeads(prev => [optimistic, ...prev]);

    try {
      const newLead = await insertLead(supabase, { ...lead, created_by: teamMemberId });
      setLeads(prev => prev.map(l => l.id === optimisticId ? newLead : l));
    } catch (err) {
      setLeads(prev => prev.filter(l => l.id !== optimisticId));
      toast('error', 'Failed to create lead');
    }
  };

  const updateLead = async (id: string, updates: Partial<Lead>) => {
    const prev = leads;
    setLeads(l => l.map(lead =>
      lead.id === id ? { ...lead, ...updates, updated_at: new Date().toISOString() } : lead
    ));

    try {
      await patchLead(supabase, id, updates);
    } catch (err) {
      setLeads(prev);
      toast('error', 'Failed to update lead');
    }
  };

  const deleteLead = async (id: string) => {
    const prev = leads;
    setLeads(l => l.filter(lead => lead.id !== id));

    try {
      await removeLead(supabase, id);
    } catch (err) {
      setLeads(prev);
      toast('error', 'Failed to delete lead');
    }
  };

  const convertLeadAction = async (leadId: string, projectName: string, projectColor: string, projectDescription: string) => {
    const lead = leads.find(l => l.id === leadId);
    if (!lead) return;

    const optimisticClientId = crypto.randomUUID();
    const optimisticProjectId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Optimistic updates
    const optimisticClient: Client = {
      id: optimisticClientId,
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      company: lead.company,
      notes: '',
      color: projectColor,
      created_by: teamMemberId,
      created_at: now,
      updated_at: now,
    };

    const optimisticProject: Project = {
      id: optimisticProjectId,
      name: projectName,
      description: projectDescription,
      color: projectColor,
      status: 'active',
      start_date: null,
      due_date: null,
      member_ids: [],
      client_id: optimisticClientId,
      created_by: teamMemberId,
      created_at: now,
      updated_at: now,
    };

    setClients(prev => [optimisticClient, ...prev]);
    setProjects(prev => [optimisticProject, ...prev]);
    setLeads(prev => prev.map(l =>
      l.id === leadId ? { ...l, status: 'won' as const, client_id: optimisticClientId, updated_at: now } : l
    ));

    try {
      const result = await convertLeadQuery(supabase, lead, projectName, projectColor, projectDescription, teamMemberId);
      setClients(prev => prev.map(c => c.id === optimisticClientId ? result.client : c));
      setProjects(prev => prev.map(p => p.id === optimisticProjectId ? result.project : p));
      setLeads(prev => prev.map(l => l.id === leadId ? result.lead : l));
    } catch (err) {
      // Rollback
      setClients(prev => prev.filter(c => c.id !== optimisticClientId));
      setProjects(prev => prev.filter(p => p.id !== optimisticProjectId));
      setLeads(prev => prev.map(l =>
        l.id === leadId ? lead : l
      ));
      toast('error', 'Failed to convert lead');
    }
  };

  // Helpers
  const getProject = (id: string) => projects.find(p => p.id === id);
  const getTasksByProject = (projectId: string) => tasks.filter(t => t.project_id === projectId);
  const getTeamMember = (id: string) => team.find(m => m.id === id);
  const getClient = (id: string) => clients.find(c => c.id === id);
  const getProjectsByClient = (clientId: string) => projects.filter(p => p.client_id === clientId);

  return (
    <AppContext.Provider value={{
      projects,
      tasks,
      team,
      clients,
      leads,
      loading,
      filters,
      setFilters,
      viewMode,
      setViewMode,
      addProject,
      updateProject,
      deleteProject,
      addTask,
      updateTask,
      deleteTask,
      addSubtask,
      toggleSubtask,
      deleteSubtask,
      addComment,
      deleteComment,
      addTeamMember,
      updateTeamMember,
      deleteTeamMember,
      addClient,
      updateClient,
      deleteClient,
      addLead,
      updateLead,
      deleteLead,
      convertLead: convertLeadAction,
      getProject,
      getTasksByProject,
      getTeamMember,
      getClient,
      getProjectsByClient,
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}
