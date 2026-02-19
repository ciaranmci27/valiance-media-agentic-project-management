'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Project, Task, TeamMember, FilterState, ViewMode, Subtask, Comment, Contact, ProjectContact, Lead, LeadInteraction, LeadProposal, Activity } from './types';
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
  patchSubtask,
  reorderSubtasks as reorderSubtasksQuery,
  removeSubtask,
  insertComment,
  patchComment,
  removeComment,
  fetchTeamMembers,
  insertTeamMember,
  patchTeamMember,
  removeTeamMember,
  fetchContacts,
  insertContact,
  patchContact,
  removeContact,
  fetchAllProjectContacts,
  addProjectContact as addProjectContactQuery,
  updateProjectContact as updateProjectContactQuery,
  removeProjectContact as removeProjectContactQuery,
  fetchLeads,
  insertLead,
  patchLead,
  removeLead,
  convertLead as convertLeadQuery,
  fetchLeadInteractions,
  insertLeadInteraction,
  patchLeadInteraction,
  removeLeadInteraction,
  fetchLeadProposals,
  insertLeadProposal,
  patchLeadProposal,
  removeLeadProposal,
  fetchActivities,
} from '@/lib/supabase/queries';
import { toast } from '@/components/ui/Toast';

interface AppContextType {
  // Data
  projects: Project[];
  tasks: Task[];
  team: TeamMember[];
  contacts: Contact[];
  projectContacts: ProjectContact[];
  leads: Lead[];
  leadInteractions: LeadInteraction[];
  leadProposals: LeadProposal[];
  activities: Activity[];
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
  updateSubtask: (taskId: string, subtaskId: string, title: string) => void;
  reorderSubtasks: (taskId: string, subtaskIds: string[]) => void;
  deleteSubtask: (taskId: string, subtaskId: string) => void;

  // Comments
  addComment: (taskId: string, text: string, userId: string) => void;
  updateComment: (taskId: string, commentId: string, text: string) => void;
  deleteComment: (taskId: string, commentId: string) => void;

  // Team CRUD
  addTeamMember: (member: Omit<TeamMember, 'id'>) => void;
  updateTeamMember: (id: string, updates: Partial<TeamMember>) => void;
  deleteTeamMember: (id: string) => void;

  // Contact CRUD
  addContact: (contact: Omit<Contact, 'id' | 'created_at' | 'updated_at'>) => Promise<Contact | undefined>;
  updateContact: (id: string, updates: Partial<Contact>) => void;
  deleteContact: (id: string) => void;

  // Project Contact CRUD
  addProjectContact: (projectId: string, contactId: string, role: string, customRole: string | null, isPrimaryClient: boolean) => void;
  updateProjectContact: (pcId: string, projectId: string, updates: Partial<Pick<ProjectContact, 'role' | 'custom_role' | 'is_primary_client'>>) => void;
  removeProjectContact: (pcId: string, projectId: string) => void;

  // Lead CRUD
  addLead: (lead: Omit<Lead, 'id' | 'created_at' | 'updated_at'>) => void;
  updateLead: (id: string, updates: Partial<Lead>) => void;
  deleteLead: (id: string) => void;
  convertLead: (leadId: string, projectName: string, projectColor: string, projectDescription: string) => void;

  // Lead Interaction CRUD
  addLeadInteraction: (interaction: Omit<LeadInteraction, 'id' | 'created_at' | 'updated_at'>) => void;
  updateLeadInteraction: (id: string, updates: Partial<LeadInteraction>) => void;
  deleteLeadInteraction: (id: string) => void;

  // Lead Proposal CRUD
  addLeadProposal: (proposal: Omit<LeadProposal, 'id' | 'created_at' | 'updated_at'>) => void;
  updateLeadProposal: (id: string, updates: Partial<LeadProposal>) => void;
  deleteLeadProposal: (id: string) => void;

  // Helpers
  getProject: (id: string) => Project | undefined;
  getTasksByProject: (projectId: string) => Task[];
  getTeamMember: (id: string) => TeamMember | undefined;
  getContact: (id: string) => Contact | undefined;
  getContactsByProject: (projectId: string) => ProjectContact[];
  getPrimaryClient: (projectId: string) => ProjectContact | undefined;
  getProjectsByContact: (contactId: string) => Project[];
  getLead: (id: string) => Lead | undefined;
  getInteractionsByLead: (leadId: string) => LeadInteraction[];
  getProposalsByLead: (leadId: string) => LeadProposal[];
  getUpcomingFollowUps: (leadId: string) => LeadInteraction[];
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
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [projectContacts, setProjectContacts] = useState<ProjectContact[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [leadInteractions, setLeadInteractions] = useState<LeadInteraction[]>([]);
  const [leadProposals, setLeadProposals] = useState<LeadProposal[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
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
        const [projectsData, tasksData, teamData, contactsData, projectContactsData, leadsData, leadInteractionsData, leadProposalsData, activitiesData] = await Promise.all([
          fetchProjects(supabase),
          fetchTasks(supabase),
          fetchTeamMembers(supabase),
          fetchContacts(supabase),
          fetchAllProjectContacts(supabase),
          fetchLeads(supabase),
          fetchLeadInteractions(supabase),
          fetchLeadProposals(supabase),
          fetchActivities(supabase),
        ]);

        setProjects(projectsData);
        setTasks(tasksData);
        setTeam(teamData);
        setContacts(contactsData);
        setProjectContacts(projectContactsData);
        setLeads(leadsData);
        setLeadInteractions(leadInteractionsData);
        setLeadProposals(leadProposalsData);
        setActivities(activitiesData);
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
      return newProject;
    } catch (err) {
      setProjects(prev => prev.filter(p => p.id !== optimisticId));
      toast('error', 'Failed to create project');
      return undefined;
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
    const prevPc = projectContacts;
    setProjects(p => p.filter(proj => proj.id !== id));
    setTasks(t => t.filter(task => task.project_id !== id));
    setProjectContacts(pc => pc.filter(p => p.project_id !== id));

    try {
      await removeProject(supabase, id);
    } catch (err) {
      setProjects(prev);
      setTasks(prevTasks);
      setProjectContacts(prevPc);
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

  const updateSubtask = async (taskId: string, subtaskId: string, title: string) => {
    const prev = tasks;
    setTasks(t => t.map(task =>
      task.id === taskId
        ? { ...task, subtasks: task.subtasks.map(s => s.id === subtaskId ? { ...s, title } : s), updated_at: new Date().toISOString() }
        : task
    ));

    try {
      await patchSubtask(supabase, subtaskId, { title });
    } catch (err) {
      setTasks(prev);
      toast('error', 'Failed to update subtask');
    }
  };

  const reorderSubtasksAction = async (taskId: string, subtaskIds: string[]) => {
    const prev = tasks;
    setTasks(t => t.map(task => {
      if (task.id !== taskId) return task;
      const reordered = subtaskIds
        .map(id => task.subtasks.find(s => s.id === id))
        .filter(Boolean) as typeof task.subtasks;
      return { ...task, subtasks: reordered, updated_at: new Date().toISOString() };
    }));

    try {
      await reorderSubtasksQuery(supabase, subtaskIds);
    } catch (err) {
      setTasks(prev);
      toast('error', 'Failed to reorder subtasks');
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

  const updateComment = async (taskId: string, commentId: string, text: string) => {
    const prev = tasks;
    setTasks(t => t.map(task =>
      task.id === taskId
        ? { ...task, comments: task.comments.map(c => c.id === commentId ? { ...c, text } : c), updated_at: new Date().toISOString() }
        : task
    ));

    try {
      await patchComment(supabase, commentId, text);
    } catch (err) {
      setTasks(prev);
      toast('error', 'Failed to update comment');
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

  // Contact CRUD
  const addContact = async (contact: Omit<Contact, 'id' | 'created_at' | 'updated_at'>): Promise<Contact | undefined> => {
    const optimisticId = crypto.randomUUID();
    const now = new Date().toISOString();
    const optimistic: Contact = {
      ...contact,
      id: optimisticId,
      created_at: now,
      updated_at: now,
    };

    setContacts(prev => [optimistic, ...prev]);

    try {
      const newContact = await insertContact(supabase, { ...contact, created_by: teamMemberId });
      setContacts(prev => prev.map(c => c.id === optimisticId ? newContact : c));
      return newContact;
    } catch (err) {
      setContacts(prev => prev.filter(c => c.id !== optimisticId));
      toast('error', 'Failed to create contact');
      return undefined;
    }
  };

  const updateContact = async (id: string, updates: Partial<Contact>) => {
    const prev = contacts;
    setContacts(c => c.map(contact =>
      contact.id === id ? { ...contact, ...updates, updated_at: new Date().toISOString() } : contact
    ));

    try {
      await patchContact(supabase, id, updates);
    } catch (err) {
      setContacts(prev);
      toast('error', 'Failed to update contact');
    }
  };

  const deleteContact = async (id: string) => {
    const prev = contacts;
    setContacts(c => c.filter(contact => contact.id !== id));

    try {
      await removeContact(supabase, id);
    } catch (err) {
      setContacts(prev);
      toast('error', 'Failed to delete contact');
    }
  };

  // Project Contact CRUD
  const addProjectContactAction = async (
    projectId: string,
    contactId: string,
    role: string,
    customRole: string | null,
    isPrimaryClient: boolean
  ) => {
    const optimisticId = crypto.randomUUID();
    const now = new Date().toISOString();
    const contact = contacts.find(c => c.id === contactId);
    const optimistic: ProjectContact = {
      id: optimisticId,
      project_id: projectId,
      contact_id: contactId,
      role,
      custom_role: customRole,
      is_primary_client: isPrimaryClient,
      created_at: now,
      contact,
    };

    setProjectContacts(prev => {
      let updated = [...prev];
      // If setting as primary, unset existing primary on this project
      if (isPrimaryClient) {
        updated = updated.map(pc =>
          pc.project_id === projectId && pc.is_primary_client
            ? { ...pc, is_primary_client: false }
            : pc
        );
      }
      return [...updated, optimistic];
    });

    try {
      const newPc = await addProjectContactQuery(supabase, projectId, contactId, role, customRole, isPrimaryClient);
      setProjectContacts(prev => prev.map(pc => pc.id === optimisticId ? newPc : pc));
    } catch (err) {
      setProjectContacts(prev => prev.filter(pc => pc.id !== optimisticId));
      toast('error', 'Failed to add contact to project');
    }
  };

  const updateProjectContactAction = async (
    pcId: string,
    projectId: string,
    updates: Partial<Pick<ProjectContact, 'role' | 'custom_role' | 'is_primary_client'>>
  ) => {
    const prev = projectContacts;
    setProjectContacts(pcs => {
      let updated = pcs.map(pc =>
        pc.id === pcId ? { ...pc, ...updates } : pc
      );
      // If setting as primary, unset existing primary on this project
      if (updates.is_primary_client) {
        updated = updated.map(pc =>
          pc.project_id === projectId && pc.id !== pcId && pc.is_primary_client
            ? { ...pc, is_primary_client: false }
            : pc
        );
      }
      return updated;
    });

    try {
      await updateProjectContactQuery(supabase, pcId, projectId, updates);
    } catch (err) {
      setProjectContacts(prev);
      toast('error', 'Failed to update project contact');
    }
  };

  const removeProjectContactAction = async (pcId: string, _projectId: string) => {
    const prev = projectContacts;
    setProjectContacts(pcs => pcs.filter(pc => pc.id !== pcId));

    try {
      await removeProjectContactQuery(supabase, pcId);
    } catch (err) {
      setProjectContacts(prev);
      toast('error', 'Failed to remove contact from project');
    }
  };

  // Lead CRUD
  const addLead = async (lead: Omit<Lead, 'id' | 'created_at' | 'updated_at'>) => {
    // Auto-create contact when creating a lead
    let contactId = lead.contact_id;
    if (!contactId) {
      const newContact = await addContact({
        name: lead.name,
        email: lead.email || '',
        phone: lead.phone || '',
        company: lead.company || '',
        notes: '',
        color: '#6366F1',
      });
      if (newContact) {
        contactId = newContact.id;
      }
    }

    const optimisticId = crypto.randomUUID();
    const now = new Date().toISOString();
    const optimistic: Lead = {
      ...lead,
      id: optimisticId,
      contact_id: contactId || null,
      created_at: now,
      updated_at: now,
    };

    setLeads(prev => [optimistic, ...prev]);

    try {
      const newLead = await insertLead(supabase, { ...lead, contact_id: contactId || null, created_by: teamMemberId });
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
    const prevInteractions = leadInteractions;
    const prevProposals = leadProposals;
    setLeads(l => l.filter(lead => lead.id !== id));
    setLeadInteractions(i => i.filter(int => int.lead_id !== id));
    setLeadProposals(p => p.filter(prop => prop.lead_id !== id));

    try {
      await removeLead(supabase, id);
    } catch (err) {
      setLeads(prev);
      setLeadInteractions(prevInteractions);
      setLeadProposals(prevProposals);
      toast('error', 'Failed to delete lead');
    }
  };

  const convertLeadAction = async (leadId: string, projectName: string, projectColor: string, projectDescription: string) => {
    const lead = leads.find(l => l.id === leadId);
    if (!lead) return;

    const optimisticProjectId = crypto.randomUUID();
    const optimisticPcId = crypto.randomUUID();
    const now = new Date().toISOString();

    // If lead has no contact, we'll create one
    let optimisticContactId = lead.contact_id;
    let optimisticContact: Contact | undefined;
    if (!optimisticContactId) {
      optimisticContactId = crypto.randomUUID();
      optimisticContact = {
        id: optimisticContactId,
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
      setContacts(prev => [optimisticContact!, ...prev]);
    }

    const existingContact = contacts.find(c => c.id === optimisticContactId);

    const optimisticProject: Project = {
      id: optimisticProjectId,
      name: projectName,
      description: projectDescription,
      color: projectColor,
      status: 'active',
      start_date: null,
      due_date: null,
      member_ids: [],
      created_by: teamMemberId,
      created_at: now,
      updated_at: now,
    };

    const optimisticPc: ProjectContact = {
      id: optimisticPcId,
      project_id: optimisticProjectId,
      contact_id: optimisticContactId!,
      role: 'Client',
      custom_role: null,
      is_primary_client: true,
      created_at: now,
      contact: optimisticContact || existingContact,
    };

    setProjects(prev => [optimisticProject, ...prev]);
    setProjectContacts(prev => [...prev, optimisticPc]);
    setLeads(prev => prev.map(l =>
      l.id === leadId ? { ...l, status: 'won' as const, contact_id: optimisticContactId, updated_at: now } : l
    ));

    try {
      const result = await convertLeadQuery(supabase, lead, projectName, projectColor, projectDescription, teamMemberId);
      // Replace optimistic contact if we created one
      if (optimisticContact) {
        setContacts(prev => prev.map(c => c.id === optimisticContactId ? result.contact : c));
      }
      setProjects(prev => prev.map(p => p.id === optimisticProjectId ? result.project : p));
      setProjectContacts(prev => prev.map(pc => pc.id === optimisticPcId ? result.projectContact : pc));
      setLeads(prev => prev.map(l => l.id === leadId ? result.lead : l));
    } catch (err) {
      // Rollback
      if (optimisticContact) {
        setContacts(prev => prev.filter(c => c.id !== optimisticContactId));
      }
      setProjects(prev => prev.filter(p => p.id !== optimisticProjectId));
      setProjectContacts(prev => prev.filter(pc => pc.id !== optimisticPcId));
      setLeads(prev => prev.map(l =>
        l.id === leadId ? lead : l
      ));
      toast('error', 'Failed to convert lead');
    }
  };

  // Lead Interaction CRUD
  const addLeadInteraction = async (interaction: Omit<LeadInteraction, 'id' | 'created_at' | 'updated_at'>) => {
    const optimisticId = crypto.randomUUID();
    const now = new Date().toISOString();
    const optimistic: LeadInteraction = {
      ...interaction,
      id: optimisticId,
      created_at: now,
      updated_at: now,
    };

    setLeadInteractions(prev => [optimistic, ...prev]);

    try {
      const newInteraction = await insertLeadInteraction(supabase, { ...interaction, created_by: teamMemberId });
      setLeadInteractions(prev => prev.map(i => i.id === optimisticId ? newInteraction : i));
    } catch (err) {
      setLeadInteractions(prev => prev.filter(i => i.id !== optimisticId));
      toast('error', 'Failed to add interaction');
    }
  };

  const updateLeadInteraction = async (id: string, updates: Partial<LeadInteraction>) => {
    const prev = leadInteractions;
    setLeadInteractions(i => i.map(int =>
      int.id === id ? { ...int, ...updates, updated_at: new Date().toISOString() } : int
    ));

    try {
      await patchLeadInteraction(supabase, id, updates);
    } catch (err) {
      setLeadInteractions(prev);
      toast('error', 'Failed to update interaction');
    }
  };

  const deleteLeadInteraction = async (id: string) => {
    const prev = leadInteractions;
    setLeadInteractions(i => i.filter(int => int.id !== id));

    try {
      await removeLeadInteraction(supabase, id);
    } catch (err) {
      setLeadInteractions(prev);
      toast('error', 'Failed to delete interaction');
    }
  };

  // Lead Proposal CRUD
  const addLeadProposal = async (proposal: Omit<LeadProposal, 'id' | 'created_at' | 'updated_at'>) => {
    const optimisticId = crypto.randomUUID();
    const now = new Date().toISOString();
    const optimistic: LeadProposal = {
      ...proposal,
      id: optimisticId,
      created_at: now,
      updated_at: now,
    };

    setLeadProposals(prev => [optimistic, ...prev]);

    try {
      const newProposal = await insertLeadProposal(supabase, { ...proposal, created_by: teamMemberId });
      setLeadProposals(prev => prev.map(p => p.id === optimisticId ? newProposal : p));
    } catch (err) {
      setLeadProposals(prev => prev.filter(p => p.id !== optimisticId));
      toast('error', 'Failed to add proposal');
    }
  };

  const updateLeadProposal = async (id: string, updates: Partial<LeadProposal>) => {
    const prev = leadProposals;
    setLeadProposals(p => p.map(prop =>
      prop.id === id ? { ...prop, ...updates, updated_at: new Date().toISOString() } : prop
    ));

    try {
      await patchLeadProposal(supabase, id, updates);
    } catch (err) {
      setLeadProposals(prev);
      toast('error', 'Failed to update proposal');
    }
  };

  const deleteLeadProposal = async (id: string) => {
    const prev = leadProposals;
    setLeadProposals(p => p.filter(prop => prop.id !== id));

    try {
      await removeLeadProposal(supabase, id);
    } catch (err) {
      setLeadProposals(prev);
      toast('error', 'Failed to delete proposal');
    }
  };

  // Helpers
  const getProject = (id: string) => projects.find(p => p.id === id);
  const getTasksByProject = (projectId: string) => tasks.filter(t => t.project_id === projectId);
  const getTeamMember = (id: string) => team.find(m => m.id === id);
  const getContact = (id: string) => contacts.find(c => c.id === id);
  const getContactsByProject = (projectId: string) => projectContacts.filter(pc => pc.project_id === projectId);
  const getPrimaryClient = (projectId: string) => projectContacts.find(pc => pc.project_id === projectId && pc.is_primary_client);
  const getProjectsByContact = (contactId: string) => {
    const projectIds = projectContacts
      .filter(pc => pc.contact_id === contactId)
      .map(pc => pc.project_id);
    return projects.filter(p => projectIds.includes(p.id));
  };
  const getLead = (id: string) => leads.find(l => l.id === id);
  const getInteractionsByLead = (leadId: string) =>
    leadInteractions
      .filter(i => i.lead_id === leadId)
      .sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
  const getProposalsByLead = (leadId: string) =>
    leadProposals.filter(p => p.lead_id === leadId);
  const getUpcomingFollowUps = (leadId: string) =>
    leadInteractions
      .filter(i => i.lead_id === leadId && i.type === 'follow_up' && !i.completed && i.scheduled_at)
      .sort((a, b) => new Date(a.scheduled_at!).getTime() - new Date(b.scheduled_at!).getTime());

  return (
    <AppContext.Provider value={{
      projects,
      tasks,
      team,
      contacts,
      projectContacts,
      leads,
      leadInteractions,
      leadProposals,
      activities,
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
      updateSubtask,
      reorderSubtasks: reorderSubtasksAction,
      deleteSubtask,
      addComment,
      updateComment,
      deleteComment,
      addTeamMember,
      updateTeamMember,
      deleteTeamMember,
      addContact,
      updateContact,
      deleteContact,
      addProjectContact: addProjectContactAction,
      updateProjectContact: updateProjectContactAction,
      removeProjectContact: removeProjectContactAction,
      addLead,
      updateLead,
      deleteLead,
      convertLead: convertLeadAction,
      addLeadInteraction,
      updateLeadInteraction,
      deleteLeadInteraction,
      addLeadProposal,
      updateLeadProposal,
      deleteLeadProposal,
      getProject,
      getTasksByProject,
      getTeamMember,
      getContact,
      getContactsByProject,
      getPrimaryClient,
      getProjectsByContact,
      getLead,
      getInteractionsByLead,
      getProposalsByLead,
      getUpcomingFollowUps,
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
