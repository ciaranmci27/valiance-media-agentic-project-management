'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Project, Task, TeamMember, FilterState, ViewMode, Subtask, Comment, Contact, ProjectContact, Lead, LeadInteraction, LeadProposal, LeadField, LeadContact, Activity, PortalSettings, PortalUpdate, PortalUpdateAttachment, EntityFile, EntityFileType, ApiKey, NotificationCategory, ProjectGoal, TaskSuggestion, AgentActivity, TimeEntry, ProjectCredentialListItem, CredentialPayload, CredentialCategory, ProjectInvoice, InvoiceStatus, DEFAULT_SECTION_ORDER } from './types';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { generatePortalSlug } from '@/lib/portal-slug';
import {
  demoTeam, demoContacts, demoProjects, demoProjectContacts, demoTasks,
  demoLeads, demoLeadInteractions, demoLeadProposals, demoLeadFields,
  demoLeadContacts, demoActivities,
  demoPortalSettings, demoPortalUpdates, demoPortalUpdateAttachments, demoEntityFiles, demoTimeEntries,
  demoProjectGoals, demoTaskSuggestions, demoAgentActivity, demoProjectInvoices,
} from '@/lib/demo-data';
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
  fetchLeadFields,
  upsertLeadField,
  removeLeadField as removeLeadFieldQuery,
  fetchAllLeadContacts,
  addLeadContact as addLeadContactQuery,
  updateLeadContact as updateLeadContactQuery,
  removeLeadContact as removeLeadContactQuery,
  fetchActivities,
  fetchAllPortalSettings,
  upsertPortalSettings as upsertPortalSettingsQuery,
  updatePortalSlug as updatePortalSlugQuery,

  fetchAllPortalUpdates,
  insertPortalUpdate as insertPortalUpdateQuery,
  patchPortalUpdate as patchPortalUpdateQuery,
  removePortalUpdate as removePortalUpdateQuery,
  fetchAllPortalUpdateAttachments,
  insertPortalUpdateAttachments as insertPortalUpdateAttachmentsQuery,
  removePortalUpdateAttachment as removePortalUpdateAttachmentQuery,
  fetchAllEntityFiles,
  insertEntityFile as insertEntityFileQuery,
  renameEntityFile as renameEntityFileQuery,
  removeEntityFile as removeEntityFileQuery,
  updateEntityFileVisibility as updateEntityFileVisibilityQuery,
  fetchApiKeys,
  insertApiKey as insertApiKeyQuery,
  revokeApiKey as revokeApiKeyQuery,
  fetchGoals,
  insertGoal as insertGoalQuery,
  patchGoal as patchGoalQuery,
  archiveGoal as archiveGoalQuery,
  fetchTaskSuggestions,
  approveTaskSuggestion as approveTaskSuggestionQuery,
  rejectTaskSuggestion as rejectTaskSuggestionQuery,
  requestInfoTaskSuggestion as requestInfoTaskSuggestionQuery,
  fetchAgentActivity,
  fetchAllTimeEntries,
  insertTimeEntry as insertTimeEntryQuery,
  patchTimeEntry as patchTimeEntryQuery,
  removeTimeEntry as removeTimeEntryQuery,
  fetchAllProjectCredentials,
  fetchAllProjectInvoices,
  insertProjectInvoice as insertProjectInvoiceQuery,
  patchProjectInvoice as patchProjectInvoiceQuery,
  removeProjectInvoice as removeProjectInvoiceQuery,
} from '@/lib/supabase/queries';
import { toast } from '@/components/ui/Toast';
import { siteConfig } from '@/site-config';

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
  leadFields: LeadField[];
  leadContacts: LeadContact[];
  activities: Activity[];
  portalSettings: PortalSettings[];
  portalUpdates: PortalUpdate[];
  entityFiles: EntityFile[];
  apiKeys: ApiKey[];
  timeEntries: TimeEntry[];
  projectCredentials: ProjectCredentialListItem[];
  projectInvoices: ProjectInvoice[];
  loading: boolean;

  // Filters
  filters: FilterState;
  setFilters: (filters: FilterState) => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;

  // Project CRUD
  addProject: (project: Omit<Project, 'id' | 'created_at' | 'updated_at'>) => Promise<Project | undefined>;
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
  upsertLocalTeamMember: (member: TeamMember) => void;

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

  // Lead Field CRUD
  setLeadField: (leadId: string, fieldKey: string, value: string) => void;
  deleteLeadField: (id: string, leadId: string) => void;

  // Lead Contact CRUD
  addLeadContact: (leadId: string, contactId: string, role: string, customRole: string | null, isPrimaryClient: boolean) => void;
  updateLeadContact: (lcId: string, leadId: string, updates: Partial<Pick<LeadContact, 'role' | 'custom_role' | 'is_primary_client'>>) => void;
  removeLeadContact: (lcId: string, leadId: string) => void;

  // Portal Settings CRUD
  upsertPortalSettings: (projectId: string, settings: Partial<Omit<PortalSettings, 'id' | 'project_id' | 'created_at' | 'updated_at'>>) => void;
  updatePortalSlug: (projectId: string, newSlug: string) => Promise<void>;

  // Portal Update CRUD
  addPortalUpdate: (update: Omit<PortalUpdate, 'id' | 'created_at' | 'updated_at'>, attachments?: { name: string; file_url: string; file_size: number; mime_type: string }[]) => void;
  updatePortalUpdate: (id: string, updates: Partial<Pick<PortalUpdate, 'title' | 'content' | 'update_type' | 'pinned'>>, newAttachments?: { name: string; file_url: string; file_size: number; mime_type: string }[], removedAttachmentIds?: string[]) => void;
  deletePortalUpdate: (id: string) => void;
  getPortalUpdates: (projectId: string) => PortalUpdate[];

  // Portal Update Attachment CRUD
  portalUpdateAttachments: PortalUpdateAttachment[];
  getPortalUpdateAttachments: (updateId: string) => PortalUpdateAttachment[];
  deletePortalUpdateAttachment: (id: string) => void;

  // Entity File CRUD
  addEntityFile: (file: Omit<EntityFile, 'id' | 'created_at' | 'updated_at'>) => void;
  renameEntityFile: (id: string, name: string) => void;
  deleteEntityFile: (id: string) => void;
  updateEntityFileVisibility: (id: string, visibility: 'internal' | 'external') => void;
  getEntityFiles: (entityType: EntityFileType, entityId: string) => EntityFile[];

  // API Key CRUD
  addApiKey: (name: string, keyHash: string, keyPrefix: string, permissions?: string, teamMemberId?: string | null) => Promise<ApiKey | undefined>;
  revokeApiKey: (id: string) => void;

  // Agent data (conditionally loaded when NEXT_PUBLIC_ENABLE_AGENTS=true)
  projectGoals: ProjectGoal[];
  taskSuggestions: TaskSuggestion[];
  agentActivity: AgentActivity[];

  // Project Goal CRUD
  addGoal: (goal: { project_id: string; title: string; description?: string; target_date?: string | null; status?: string }) => Promise<ProjectGoal | undefined>;
  updateGoal: (id: string, updates: Partial<ProjectGoal>) => void;
  archiveGoal: (id: string) => void;

  // Task Suggestion review actions
  approveSuggestion: (id: string, taskOverrides: { priority?: string; assigned_to?: string | null; due_date?: string | null; project_id?: string; task_type?: string | null }, reviewedBy: string) => void;
  rejectSuggestion: (id: string, reason: string | undefined, reviewedBy: string) => void;
  requestInfoOnSuggestion: (id: string, infoRequest: string, reviewedBy: string) => void;
  bulkApproveSuggestions: (ids: string[]) => void;
  bulkRejectSuggestions: (ids: string[], reason?: string) => void;

  // Agent helpers
  getGoalsByProject: (projectId: string) => ProjectGoal[];
  getSuggestionsByGoal: (goalId: string) => TaskSuggestion[];
  getPendingSuggestionCount: () => number;

  // Time Entry CRUD
  addTimeEntry: (entry: Omit<TimeEntry, 'id' | 'created_at' | 'updated_at'>) => void;
  updateTimeEntry: (id: string, updates: Partial<Pick<TimeEntry, 'member_id' | 'start_time' | 'end_time' | 'description'>>) => void;
  deleteTimeEntry: (id: string) => void;
  getTimeEntriesByProject: (projectId: string) => TimeEntry[];
  startTimer: (projectId: string, memberId: string, description?: string) => void;
  stopTimer: (projectId: string) => void;
  getRunningTimer: (projectId: string) => TimeEntry | undefined;

  // Credential CRUD
  addCredential: (projectId: string, data: { label: string; category: string; username: string; password: string; url: string; notes: string }) => Promise<ProjectCredentialListItem | undefined>;
  updateCredential: (id: string, data: { label?: string; category?: string; username?: string; password?: string; url?: string; notes?: string }) => Promise<void>;
  deleteCredential: (id: string) => void;
  revealCredential: (id: string) => Promise<CredentialPayload | null>;
  getCredentialsByProject: (projectId: string) => ProjectCredentialListItem[];

  // Invoice CRUD
  addInvoice: (invoice: Omit<ProjectInvoice, 'id' | 'created_at' | 'updated_at'>) => Promise<ProjectInvoice | undefined>;
  updateInvoice: (id: string, updates: Partial<ProjectInvoice>) => void;
  deleteInvoice: (id: string) => void;
  getInvoicesByProject: (projectId: string) => ProjectInvoice[];
  getInvoicesByContact: (contactId: string) => ProjectInvoice[];

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
  getFieldsByLead: (leadId: string) => LeadField[];
  getLeadFieldValue: (leadId: string, fieldKey: string) => string | undefined;
  getContactsByLead: (leadId: string) => LeadContact[];
  getPrimaryLeadContact: (leadId: string) => LeadContact | undefined;
  getPortalSettings: (projectId: string) => PortalSettings | undefined;
}

export const defaultFilters: FilterState = {
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
  const [leadFields, setLeadFields] = useState<LeadField[]>([]);
  const [leadContacts, setLeadContacts] = useState<LeadContact[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [portalSettings, setPortalSettings] = useState<PortalSettings[]>([]);
  const [portalUpdates, setPortalUpdates] = useState<PortalUpdate[]>([]);
  const [portalUpdateAttachments, setPortalUpdateAttachments] = useState<PortalUpdateAttachment[]>([]);
  const [entityFiles, setEntityFiles] = useState<EntityFile[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [projectCredentials, setProjectCredentials] = useState<ProjectCredentialListItem[]>([]);
  const [projectInvoices, setProjectInvoices] = useState<ProjectInvoice[]>([]);
  const [projectGoals, setProjectGoals] = useState<ProjectGoal[]>([]);
  const [taskSuggestions, setTaskSuggestions] = useState<TaskSuggestion[]>([]);
  const [agentActivityList, setAgentActivityList] = useState<AgentActivity[]>([]);
  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [viewMode, setViewMode] = useState<ViewMode>('board');
  const [loading, setLoading] = useState(true);

  const { user, teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const supabase = createClient();
  const skipSupabase = isDemoMode;

  // Fire-and-forget notification helper — uses upsert RPC for dedup
  const allMemberIds = () => team.map(m => m.id);
  const adminMemberIds = () => team.filter(m => m.role === 'admin').map(m => m.id);

  const notify = (userIds: string[], title: string, message: string, link: string | null, entityType: string | null, entityId: string | null, category: NotificationCategory) => {
    if (skipSupabase) return;
    const recipients = userIds.filter(id => {
      if (id === teamMemberId) return false;
      const member = team.find(m => m.id === id);
      if (member?.notification_prefs?.[category] === false) return false;
      return true;
    });
    for (const userId of recipients) {
      supabase.rpc('upsert_notification', {
        p_user_id: userId,
        p_title: title,
        p_message: message || '',
        p_link: link,
        p_entity_type: entityType,
        p_entity_id: entityId,
      }).then(() => {}, () => {});
    }
  };

  // Helper: get actor name for notification messages
  const actorName = () => {
    const actor = team.find(m => m.id === teamMemberId);
    return actor?.name || 'Someone';
  };

  // Fetch all data from Supabase on mount (or load demo data)
  useEffect(() => {
    if (isDemoMode) {
      setProjects([...demoProjects]);
      setTasks([...demoTasks]);
      setTeam([...demoTeam]);
      setContacts([...demoContacts]);
      setProjectContacts([...demoProjectContacts]);
      setLeads([...demoLeads]);
      setLeadInteractions([...demoLeadInteractions]);
      setLeadProposals([...demoLeadProposals]);
      setLeadFields([...demoLeadFields]);
      setLeadContacts([...demoLeadContacts]);
      setActivities([...demoActivities]);
      setPortalSettings([...demoPortalSettings]);
      setPortalUpdates([...demoPortalUpdates]);
      setPortalUpdateAttachments([...demoPortalUpdateAttachments]);
      setEntityFiles([...demoEntityFiles]);
      setTimeEntries([...demoTimeEntries]);
      setProjectInvoices([...demoProjectInvoices]);
      setProjectCredentials([]);
      if (process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true') {
        setProjectGoals([...demoProjectGoals]);
        setTaskSuggestions([...demoTaskSuggestions]);
        setAgentActivityList([...demoAgentActivity]);
      }
      setLoading(false);
      return;
    }

    if (!user) {
      setLoading(false);
      return;
    }

    const loadData = async () => {
      try {
        const [projectsData, tasksData, teamData, contactsData, projectContactsData, leadsData, leadInteractionsData, leadProposalsData, leadFieldsData, leadContactsData, activitiesData, portalSettingsData, portalUpdatesData, portalUpdateAttachmentsData, entityFilesData, apiKeysData, timeEntriesData, projectCredentialsData, projectInvoicesData] = await Promise.all([
          fetchProjects(supabase),
          fetchTasks(supabase),
          fetchTeamMembers(supabase),
          fetchContacts(supabase),
          fetchAllProjectContacts(supabase),
          fetchLeads(supabase),
          fetchLeadInteractions(supabase),
          fetchLeadProposals(supabase),
          fetchLeadFields(supabase),
          fetchAllLeadContacts(supabase),
          fetchActivities(supabase),
          fetchAllPortalSettings(supabase),
          fetchAllPortalUpdates(supabase),
          fetchAllPortalUpdateAttachments(supabase),
          fetchAllEntityFiles(supabase),
          fetchApiKeys(supabase),
          fetchAllTimeEntries(supabase),
          fetchAllProjectCredentials(supabase),
          fetchAllProjectInvoices(supabase),
        ]);

        setProjects(projectsData);
        setTasks(tasksData);
        setTeam(teamData);
        setContacts(contactsData);
        setProjectContacts(projectContactsData);
        setLeads(leadsData);
        setLeadInteractions(leadInteractionsData);
        setLeadProposals(leadProposalsData);
        setLeadFields(leadFieldsData);
        setLeadContacts(leadContactsData);
        setActivities(activitiesData);
        setPortalSettings(portalSettingsData);
        setPortalUpdates(portalUpdatesData);
        setPortalUpdateAttachments(portalUpdateAttachmentsData);
        setEntityFiles(entityFilesData);
        setApiKeys(apiKeysData);
        setTimeEntries(timeEntriesData);
        setProjectCredentials(projectCredentialsData);
        setProjectInvoices(projectInvoicesData);

        // Conditionally load agent data when feature is enabled
        if (process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true') {
          try {
            const [goalsData, suggestionsData, activityData] = await Promise.all([
              fetchGoals(supabase),
              fetchTaskSuggestions(supabase),
              fetchAgentActivity(supabase),
            ]);
            setProjectGoals(goalsData);
            setTaskSuggestions(suggestionsData);
            setAgentActivityList(activityData);
          } catch (agentErr) {
            console.error('Failed to load agent data:', agentErr);
          }
        }
      } catch (err) {
        console.error('Failed to load data:', err);
        toast('error', 'Failed to load data from server');
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [user, isDemoMode]);

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
    if (skipSupabase) return optimistic;

    try {
      const newProject = await insertProject(supabase, { ...project, created_by: teamMemberId }, memberIds);
      setProjects(prev => prev.map(p => p.id === optimisticId ? newProject : p));
      notify(allMemberIds(), `New project: "${newProject.name}"`, `${actorName()} created a new project.`, `/projects/${newProject.id}`, 'project', newProject.id, 'project_created');
      return newProject;
    } catch (err) {
      setProjects(prev => prev.filter(p => p.id !== optimisticId));
      toast('error', 'Failed to create project');
      return undefined;
    }
  };

  const updateProject = async (id: string, updates: Partial<Project>) => {
    const prev = projects;
    const projectBefore = projects.find(p => p.id === id);
    setProjects(p => p.map(proj =>
      proj.id === id ? { ...proj, ...updates, updated_at: new Date().toISOString() } : proj
    ));
    if (skipSupabase) return;

    try {
      await patchProject(supabase, id, updates, updates.member_ids);

      // Auto-sync portal slug when project name changes
      if (updates.name && updates.name !== projectBefore?.name) {
        const portalExists = portalSettings.find(ps => ps.project_id === id);
        if (portalExists) {
          const newSlug = generatePortalSlug(updates.name);
          updatePortalSlugAction(id, newSlug);
        }
      }

      if (projectBefore) {
        notify(allMemberIds(), `"${projectBefore.name}" was updated`, `${actorName()} updated the project.`, `/projects/${id}`, 'project', id, 'project_updates');

        // Notify when autonomous agents are toggled
        if (updates.autonomous_enabled !== undefined && updates.autonomous_enabled !== projectBefore.autonomous_enabled) {
          const action = updates.autonomous_enabled ? 'enabled' : 'disabled';
          notify(adminMemberIds(), `Autonomous agents ${action} on "${projectBefore.name}"`, `${actorName()} ${action} autonomous agents for this project.`, '/agent', 'project', id, 'agent_autonomous');
        }
      }
    } catch (err) {
      setProjects(prev);
      toast('error', 'Failed to update project');
    }
  };

  const deleteProject = async (id: string) => {
    const prev = projects;
    const prevTasks = tasks;
    const prevPc = projectContacts;
    const deletedProject = projects.find(p => p.id === id);
    setProjects(p => p.filter(proj => proj.id !== id));
    setTasks(t => t.filter(task => task.project_id !== id));
    setProjectContacts(pc => pc.filter(p => p.project_id !== id));
    if (skipSupabase) return;

    try {
      await removeProject(supabase, id);
      if (deletedProject) {
        notify(allMemberIds(), `Project "${deletedProject.name}" was archived`, `${actorName()} archived the project.`, '/projects', 'project', id, 'project_deleted');
      }
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
    if (skipSupabase) return;

    try {
      const newTask = await insertTask(supabase, { ...task, created_by: teamMemberId }, assigneeIds);
      setTasks(prev => prev.map(t => t.id === optimisticId ? newTask : t));
      const project = projects.find(p => p.id === task.project_id);
      notify(allMemberIds(), `New task: "${newTask.title}"`, `${actorName()} created a task${project ? ` in ${project.name}` : ''}.`, `/projects/${task.project_id}`, 'task', newTask.id, 'task_created');
    } catch (err) {
      setTasks(prev => prev.filter(t => t.id !== optimisticId));
      toast('error', 'Failed to create task');
    }
  };

  const updateTask = async (id: string, updates: Partial<Task>) => {
    const prev = tasks;
    const existingTask = tasks.find(t => t.id === id);
    setTasks(t => t.map(task =>
      task.id === id ? { ...task, ...updates, updated_at: new Date().toISOString() } : task
    ));
    if (skipSupabase) return;

    try {
      await patchTask(supabase, id, updates, updates.assignee_ids);

      if (existingTask) {
        const project = projects.find(p => p.id === existingTask.project_id);
        const projectLink = `/projects/${existingTask.project_id}`;

        if (updates.status && updates.status !== existingTask.status) {
          const statusLabel = updates.status.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase());
          notify(allMemberIds(), `"${existingTask.title}" moved to ${statusLabel}`, `${actorName()} updated the task status.`, projectLink, 'task', id, 'task_status');
        } else if (updates.assignee_ids) {
          const newAssignees = updates.assignee_ids.filter(aid => !existingTask.assignee_ids.includes(aid));
          if (newAssignees.length > 0) {
            notify(allMemberIds(), `"${existingTask.title}" assignees changed`, `${actorName()} updated task assignments${project ? ` in ${project.name}` : ''}.`, projectLink, 'task', id, 'task_assignments');
          }
          notify(allMemberIds(), `"${existingTask.title}" was updated`, `${actorName()} updated the task.`, projectLink, 'task', id, 'task_updates');
        } else {
          notify(allMemberIds(), `"${existingTask.title}" was updated`, `${actorName()} updated the task.`, projectLink, 'task', id, 'task_updates');
        }
      }
    } catch (err) {
      setTasks(prev);
      toast('error', 'Failed to update task');
    }
  };

  const deleteTask = async (id: string) => {
    const prev = tasks;
    const deletedTask = tasks.find(t => t.id === id);
    setTasks(t => t.filter(task => task.id !== id));
    if (skipSupabase) return;

    try {
      await removeTask(supabase, id);
      if (deletedTask) {
        notify(allMemberIds(), `Task "${deletedTask.title}" was deleted`, `${actorName()} deleted a task.`, deletedTask.project_id ? `/projects/${deletedTask.project_id}` : null, 'task', id, 'task_deleted');
      }
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
    if (skipSupabase) return;

    try {
      const newSubtask = await insertSubtask(supabase, taskId, title);
      setTasks(prev => prev.map(t =>
        t.id === taskId
          ? { ...t, subtasks: t.subtasks.map(s => s.id === optimisticId ? newSubtask : s) }
          : t
      ));

      const task = tasks.find(t => t.id === taskId);
      if (task) {
        notify(allMemberIds(), `"${task.title}" was updated`, `${actorName()} added a subtask.`, `/projects/${task.project_id}`, 'task', taskId, 'task_subtasks');
      }
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
    if (skipSupabase) return;

    try {
      await toggleSubtaskCompleted(supabase, subtaskId, newCompleted);

      const parentTask = tasks.find(t => t.id === taskId);
      if (parentTask) {
        const msg = newCompleted ? `${actorName()} completed a subtask.` : `${actorName()} reopened a subtask.`;
        notify(allMemberIds(), `"${parentTask.title}" was updated`, msg, `/projects/${parentTask.project_id}`, 'task', taskId, 'task_subtasks');
      }
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
    if (skipSupabase) return;

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
    if (skipSupabase) return;

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
    if (skipSupabase) return;

    try {
      await removeSubtask(supabase, subtaskId);
      const task = tasks.find(t => t.id === taskId);
      if (task) {
        notify(allMemberIds(), `"${task.title}" was updated`, `${actorName()} removed a subtask.`, `/projects/${task.project_id}`, 'task', taskId, 'task_subtasks');
      }
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
    if (skipSupabase) return;

    try {
      const newComment = await insertComment(supabase, taskId, userId, text);
      setTasks(prev => prev.map(t =>
        t.id === taskId
          ? { ...t, comments: t.comments.map(c => c.id === optimisticId ? newComment : c) }
          : t
      ));

      // Notify task assignees about the new comment (dedup key = parent task)
      const task = tasks.find(t => t.id === taskId);
      if (task) {
        const preview = text.length > 60 ? text.slice(0, 60) + '...' : text;
        notify(allMemberIds(), `New comment on "${task.title}"`, `${actorName()}: "${preview}"`, `/projects/${task.project_id}`, 'task', taskId, 'task_comments');
      }
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
    if (skipSupabase) return;

    try {
      await patchComment(supabase, commentId, text);
      const task = tasks.find(t => t.id === taskId);
      if (task) {
        const preview = text.length > 60 ? text.slice(0, 60) + '...' : text;
        notify(allMemberIds(), `Comment edited on "${task.title}"`, `${actorName()}: "${preview}"`, `/projects/${task.project_id}`, 'task', taskId, 'task_comments');
      }
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
    if (skipSupabase) return;

    try {
      await removeComment(supabase, commentId);
      const task = tasks.find(t => t.id === taskId);
      if (task) {
        notify(allMemberIds(), `Comment removed on "${task.title}"`, `${actorName()} deleted a comment.`, `/projects/${task.project_id}`, 'task', taskId, 'task_comments');
      }
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
    if (skipSupabase) return;

    try {
      const newMember = await insertTeamMember(supabase, member);
      setTeam(prev => prev.map(m => m.id === optimisticId ? newMember : m));

      // Notify all existing team members
      notify(
        allMemberIds(),
        'New team member joined',
        `${member.name} was added to the team as ${member.role === 'admin' ? 'an admin' : `a ${member.role}`}.`,
        '/team', 'member', newMember.id,
        'team_members'
      );
    } catch (err) {
      setTeam(prev => prev.filter(m => m.id !== optimisticId));
      toast('error', 'Failed to add team member');
    }
  };

  const updateTeamMember = async (id: string, updates: Partial<TeamMember>) => {
    const prev = team;
    setTeam(t => t.map(m => m.id === id ? { ...m, ...updates } : m));
    if (skipSupabase) return;

    try {
      await patchTeamMember(supabase, id, updates);
    } catch (err) {
      setTeam(prev);
      toast('error', 'Failed to update team member');
    }
  };

  const deleteTeamMember = async (id: string) => {
    const prev = team;
    const removedMember = team.find(m => m.id === id);
    setTeam(t => t.filter(m => m.id !== id));
    if (skipSupabase) return;

    try {
      await removeTeamMember(supabase, id);
      if (removedMember) {
        notify(allMemberIds(), `${removedMember.name} was removed from the team`, `${actorName()} removed a team member.`, '/team', 'member', id, 'team_members');
      }
    } catch (err) {
      setTeam(prev);
      toast('error', 'Failed to remove team member');
    }
  };

  const upsertLocalTeamMember = (member: TeamMember) => {
    setTeam(prev => {
      const idx = prev.findIndex(m => m.id === member.id);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = member;
        return updated;
      }
      return [...prev, member];
    });
    notify(
      allMemberIds(),
      'New team member joined',
      `${member.name} was added to the team as ${member.role === 'admin' ? 'an admin' : `a ${member.role}`}.`,
      '/team', 'member', member.id,
      'team_members'
    );
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
    if (skipSupabase) return optimistic;

    try {
      const newContact = await insertContact(supabase, { ...contact, created_by: teamMemberId });
      setContacts(prev => prev.map(c => c.id === optimisticId ? newContact : c));
      notify(allMemberIds(), `New contact: "${newContact.name}"`, `${actorName()} added a new contact.`, null, 'contact', newContact.id, 'contact_created');
      return newContact;
    } catch (err) {
      setContacts(prev => prev.filter(c => c.id !== optimisticId));
      toast('error', 'Failed to create contact');
      return undefined;
    }
  };

  const updateContact = async (id: string, updates: Partial<Contact>) => {
    const prev = contacts;
    const existingContact = contacts.find(c => c.id === id);
    setContacts(c => c.map(contact =>
      contact.id === id ? { ...contact, ...updates, updated_at: new Date().toISOString() } : contact
    ));
    if (skipSupabase) return;

    try {
      await patchContact(supabase, id, updates);

      if (existingContact) {
        notify(allMemberIds(), `Contact "${existingContact.name}" was updated`, `${actorName()} updated the contact.`, null, 'contact', id, 'contact_updates');
      }
    } catch (err) {
      setContacts(prev);
      toast('error', 'Failed to update contact');
    }
  };

  const deleteContact = async (id: string) => {
    const prev = contacts;
    const deletedContact = contacts.find(c => c.id === id);
    setContacts(c => c.filter(contact => contact.id !== id));
    if (skipSupabase) return;

    try {
      await removeContact(supabase, id);
      if (deletedContact) {
        notify(allMemberIds(), `Contact "${deletedContact.name}" was deleted`, `${actorName()} removed a contact.`, null, 'contact', id, 'contact_deleted');
      }
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
    if (skipSupabase) return;

    try {
      const newPc = await addProjectContactQuery(supabase, projectId, contactId, role, customRole, isPrimaryClient);
      setProjectContacts(prev => prev.map(pc => pc.id === optimisticId ? newPc : pc));

      const project = projects.find(p => p.id === projectId);
      if (project) {
        notify(allMemberIds(), `"${project.name}" contacts updated`, `${actorName()} linked a contact.`, `/projects/${projectId}`, 'project', projectId, 'project_contacts');
      }
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
    if (skipSupabase) return;

    try {
      await updateProjectContactQuery(supabase, pcId, projectId, updates);

      const project = projects.find(p => p.id === projectId);
      if (project) {
        notify(allMemberIds(), `"${project.name}" contacts updated`, `${actorName()} updated a contact role.`, `/projects/${projectId}`, 'project', projectId, 'project_contacts');
      }
    } catch (err) {
      setProjectContacts(prev);
      toast('error', 'Failed to update project contact');
    }
  };

  const removeProjectContactAction = async (pcId: string, projectId: string) => {
    const prev = projectContacts;
    setProjectContacts(pcs => pcs.filter(pc => pc.id !== pcId));
    if (skipSupabase) return;

    try {
      await removeProjectContactQuery(supabase, pcId);

      const project = projects.find(p => p.id === projectId);
      if (project) {
        notify(allMemberIds(), `"${project.name}" contacts updated`, `${actorName()} removed a contact.`, `/projects/${projectId}`, 'project', projectId, 'project_contacts');
      }
    } catch (err) {
      setProjectContacts(prev);
      toast('error', 'Failed to remove contact from project');
    }
  };

  // Lead CRUD
  const addLead = async (lead: Omit<Lead, 'id' | 'created_at' | 'updated_at'>) => {
    const memberIds = lead.member_ids || [];

    const optimisticId = crypto.randomUUID();
    const now = new Date().toISOString();
    const optimistic: Lead = {
      ...lead,
      id: optimisticId,
      member_ids: memberIds,
      contact_id: lead.contact_id || null,
      created_at: now,
      updated_at: now,
    };

    setLeads(prev => [optimistic, ...prev]);
    if (skipSupabase) return;

    try {
      // insertLead auto-creates a contact + lead_contacts junction when no contact_id is provided
      const newLead = await insertLead(supabase, { ...lead, contact_id: lead.contact_id || null, created_by: teamMemberId }, memberIds);
      setLeads(prev => prev.map(l => l.id === optimisticId ? newLead : l));

      // Refresh contacts so the auto-created contact appears in the UI
      if (!lead.contact_id && newLead.contact_id) {
        const freshContacts = await fetchContacts(supabase);
        setContacts(freshContacts);
        const freshLeadContacts = await fetchAllLeadContacts(supabase);
        setLeadContacts(freshLeadContacts);
      }

      notify(allMemberIds(), `New lead "${lead.name}" created`, `${actorName()} created a new lead.`, `/leads/${newLead.id}`, 'lead', newLead.id, 'lead_created');
    } catch (err) {
      setLeads(prev => prev.filter(l => l.id !== optimisticId));
      toast('error', 'Failed to create lead');
    }
  };

  const updateLead = async (id: string, updates: Partial<Lead>) => {
    const prevLeads = leads;
    const prevContacts = contacts;
    const currentLead = leads.find(l => l.id === id);

    setLeads(l => l.map(lead =>
      lead.id === id ? { ...lead, ...updates, updated_at: new Date().toISOString() } : lead
    ));

    // Sync identity fields to the linked primary contact
    const identityFields: Partial<Contact> = {};
    if (updates.name !== undefined) identityFields.name = updates.name;
    if (updates.email !== undefined) identityFields.email = updates.email;
    if (updates.phone !== undefined) identityFields.phone = updates.phone;
    if (updates.company !== undefined) identityFields.company = updates.company;

    const contactId = updates.contact_id !== undefined ? updates.contact_id : currentLead?.contact_id;
    const hasIdentityUpdates = Object.keys(identityFields).length > 0;

    if (hasIdentityUpdates && contactId) {
      setContacts(c => c.map(contact =>
        contact.id === contactId ? { ...contact, ...identityFields, updated_at: new Date().toISOString() } : contact
      ));
    }
    if (skipSupabase) return;

    try {
      await patchLead(supabase, id, updates, updates.member_ids);
      // Sync identity fields to linked contact in DB
      if (hasIdentityUpdates && contactId) {
        try {
          await patchContact(supabase, contactId, identityFields);
        } catch {
          // Non-critical: lead update succeeded
        }
      }

      if (currentLead) {
        if (updates.status && updates.status !== currentLead.status) {
          const statusLabel = updates.status.charAt(0).toUpperCase() + updates.status.slice(1);
          notify(allMemberIds(), `Lead "${currentLead.name}" moved to ${statusLabel}`, `${actorName()} updated the lead status.`, `/leads/${id}`, 'lead', id, 'lead_status');
        } else {
          notify(allMemberIds(), `Lead "${currentLead.name}" was updated`, `${actorName()} updated the lead.`, `/leads/${id}`, 'lead', id, 'lead_updates');
        }
      }
    } catch (err) {
      setLeads(prevLeads);
      if (hasIdentityUpdates && contactId) {
        setContacts(prevContacts);
      }
      toast('error', 'Failed to update lead');
    }
  };

  const deleteLead = async (id: string) => {
    const prev = leads;
    const deletedLead = leads.find(l => l.id === id);
    const prevInteractions = leadInteractions;
    const prevProposals = leadProposals;
    const prevFields = leadFields;
    const prevLeadContacts = leadContacts;
    setLeads(l => l.filter(lead => lead.id !== id));
    setLeadInteractions(i => i.filter(int => int.lead_id !== id));
    setLeadProposals(p => p.filter(prop => prop.lead_id !== id));
    setLeadFields(f => f.filter(field => field.lead_id !== id));
    setLeadContacts(lc => lc.filter(c => c.lead_id !== id));
    if (skipSupabase) return;

    try {
      await removeLead(supabase, id);
      if (deletedLead) {
        notify(allMemberIds(), `Lead "${deletedLead.name}" was deleted`, `${actorName()} removed a lead.`, null, 'lead', id, 'lead_deleted');
      }
    } catch (err) {
      setLeads(prev);
      setLeadInteractions(prevInteractions);
      setLeadProposals(prevProposals);
      setLeadFields(prevFields);
      setLeadContacts(prevLeadContacts);
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
        avatar_url: '',
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
      hourly_tracking: false,
      hourly_rate: null,
      fixed_price: null,
      autonomous_enabled: false,
      member_ids: lead.member_ids || [],
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
    if (skipSupabase) return;

    try {
      const result = await convertLeadQuery(supabase, lead, projectName, projectColor, projectDescription, teamMemberId);
      // Replace optimistic contact if we created one
      if (optimisticContact) {
        setContacts(prev => prev.map(c => c.id === optimisticContactId ? result.contact : c));
      }
      setProjects(prev => prev.map(p => p.id === optimisticProjectId ? result.project : p));
      setProjectContacts(prev => prev.map(pc => pc.id === optimisticPcId ? result.projectContact : pc));
      setLeads(prev => prev.map(l => l.id === leadId ? result.lead : l));
      // Add additional project contacts from lead contacts
      if (result.additionalProjectContacts && result.additionalProjectContacts.length > 0) {
        setProjectContacts(prev => [...prev, ...result.additionalProjectContacts]);
      }

      notify(allMemberIds(), `Lead "${lead.name}" converted to project`, `${actorName()} converted the lead.`, `/leads/${leadId}`, 'lead', leadId, 'lead_conversions');
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
    if (skipSupabase) return;

    try {
      const newInteraction = await insertLeadInteraction(supabase, { ...interaction, created_by: teamMemberId });
      setLeadInteractions(prev => prev.map(i => i.id === optimisticId ? newInteraction : i));

      const lead = leads.find(l => l.id === interaction.lead_id);
      if (lead) {
        const typeLabel = interaction.type.replace('_', ' ');
        notify(allMemberIds(), `New ${typeLabel} on lead "${lead.name}"`, `${actorName()} logged a ${typeLabel}.`, `/leads/${interaction.lead_id}`, 'lead', interaction.lead_id, 'lead_interactions');
      }
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
    if (skipSupabase) return;

    try {
      await patchLeadInteraction(supabase, id, updates);

      const interaction = leadInteractions.find(i => i.id === id);
      if (interaction) {
        const lead = leads.find(l => l.id === interaction.lead_id);
        if (lead) {
          notify(allMemberIds(), `Lead "${lead.name}" was updated`, `${actorName()} updated an interaction.`, `/leads/${lead.id}`, 'lead', lead.id, 'lead_interactions');
        }
      }
    } catch (err) {
      setLeadInteractions(prev);
      toast('error', 'Failed to update interaction');
    }
  };

  const deleteLeadInteraction = async (id: string) => {
    const prev = leadInteractions;
    const deletedInteraction = leadInteractions.find(i => i.id === id);
    setLeadInteractions(i => i.filter(int => int.id !== id));
    if (skipSupabase) return;

    try {
      await removeLeadInteraction(supabase, id);
      if (deletedInteraction) {
        const lead = leads.find(l => l.id === deletedInteraction.lead_id);
        if (lead) {
          notify(allMemberIds(), `Lead "${lead.name}" interaction removed`, `${actorName()} deleted an interaction.`, `/leads/${lead.id}`, 'lead', lead.id, 'lead_interactions');
        }
      }
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
    if (skipSupabase) return;

    try {
      const newProposal = await insertLeadProposal(supabase, { ...proposal, created_by: teamMemberId });
      setLeadProposals(prev => prev.map(p => p.id === optimisticId ? newProposal : p));

      const lead = leads.find(l => l.id === proposal.lead_id);
      if (lead) {
        notify(allMemberIds(), `New proposal for "${lead.name}"`, `${actorName()} added a proposal.`, `/leads/${proposal.lead_id}`, 'lead', proposal.lead_id, 'lead_proposals');
      }
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
    if (skipSupabase) return;

    try {
      await patchLeadProposal(supabase, id, updates);

      const proposal = leadProposals.find(p => p.id === id);
      if (proposal) {
        const lead = leads.find(l => l.id === proposal.lead_id);
        if (lead) {
          notify(allMemberIds(), `Lead "${lead.name}" proposal updated`, `${actorName()} updated a proposal.`, `/leads/${lead.id}`, 'lead', lead.id, 'lead_proposals');
        }
      }
    } catch (err) {
      setLeadProposals(prev);
      toast('error', 'Failed to update proposal');
    }
  };

  const deleteLeadProposal = async (id: string) => {
    const prev = leadProposals;
    const deletedProposal = leadProposals.find(p => p.id === id);
    setLeadProposals(p => p.filter(prop => prop.id !== id));
    if (skipSupabase) return;

    try {
      await removeLeadProposal(supabase, id);
      if (deletedProposal) {
        const lead = leads.find(l => l.id === deletedProposal.lead_id);
        if (lead) {
          notify(allMemberIds(), `Lead "${lead.name}" proposal removed`, `${actorName()} deleted a proposal.`, `/leads/${lead.id}`, 'lead', lead.id, 'lead_proposals');
        }
      }
    } catch (err) {
      setLeadProposals(prev);
      toast('error', 'Failed to delete proposal');
    }
  };

  // Lead Field CRUD
  const setLeadFieldAction = async (leadId: string, fieldKey: string, value: string) => {
    const existing = leadFields.find(f => f.lead_id === leadId && f.field_key === fieldKey);
    const now = new Date().toISOString();

    if (existing) {
      // Update existing
      const prev = leadFields;
      setLeadFields(f => f.map(field =>
        field.id === existing.id ? { ...field, value, updated_at: now } : field
      ));
      if (skipSupabase) return;

      try {
        const updated = await upsertLeadField(supabase, leadId, fieldKey, value);
        setLeadFields(f => f.map(field =>
          field.id === existing.id ? updated : field
        ));
        const lead = leads.find(l => l.id === leadId);
        if (lead) notify(allMemberIds(), `Lead "${lead.name}" was updated`, `${actorName()} updated lead details.`, `/leads/${leadId}`, 'lead', leadId, 'lead_updates');
      } catch (err) {
        setLeadFields(prev);
        toast('error', 'Failed to update field');
      }
    } else {
      // Create new
      const optimisticId = crypto.randomUUID();
      const optimistic: LeadField = {
        id: optimisticId,
        lead_id: leadId,
        field_key: fieldKey,
        value,
        created_at: now,
        updated_at: now,
      };

      setLeadFields(prev => [...prev, optimistic]);
      if (skipSupabase) return;

      try {
        const created = await upsertLeadField(supabase, leadId, fieldKey, value);
        setLeadFields(prev => prev.map(f => f.id === optimisticId ? created : f));
        const lead = leads.find(l => l.id === leadId);
        if (lead) notify(allMemberIds(), `Lead "${lead.name}" was updated`, `${actorName()} updated lead details.`, `/leads/${leadId}`, 'lead', leadId, 'lead_updates');
      } catch (err) {
        setLeadFields(prev => prev.filter(f => f.id !== optimisticId));
        toast('error', 'Failed to add field');
      }
    }
  };

  const deleteLeadFieldAction = async (id: string, leadId: string) => {
    const prev = leadFields;
    setLeadFields(f => f.filter(field => field.id !== id));
    if (skipSupabase) return;

    try {
      await removeLeadFieldQuery(supabase, id);
      const lead = leads.find(l => l.id === leadId);
      if (lead) {
        notify(allMemberIds(), `Lead "${lead.name}" field removed`, `${actorName()} removed a lead field.`, `/leads/${leadId}`, 'lead', leadId, 'lead_updates');
      }
    } catch (err) {
      setLeadFields(prev);
      toast('error', 'Failed to remove field');
    }
  };

  // Lead Contact CRUD
  const addLeadContactAction = async (
    leadId: string,
    contactId: string,
    role: string,
    customRole: string | null,
    isPrimaryClient: boolean
  ) => {
    const optimisticId = crypto.randomUUID();
    const now = new Date().toISOString();
    const contact = contacts.find(c => c.id === contactId);
    const optimistic: LeadContact = {
      id: optimisticId,
      lead_id: leadId,
      contact_id: contactId,
      role,
      custom_role: customRole,
      is_primary_client: isPrimaryClient,
      created_at: now,
      contact,
    };

    setLeadContacts(prev => {
      let updated = [...prev];
      if (isPrimaryClient) {
        updated = updated.map(lc =>
          lc.lead_id === leadId && lc.is_primary_client
            ? { ...lc, is_primary_client: false }
            : lc
        );
      }
      return [...updated, optimistic];
    });

    // If setting as primary, also update lead.contact_id
    if (isPrimaryClient) {
      setLeads(prev => prev.map(l =>
        l.id === leadId ? { ...l, contact_id: contactId, updated_at: now } : l
      ));
    }
    if (skipSupabase) return;

    try {
      const newLc = await addLeadContactQuery(supabase, leadId, contactId, role, customRole, isPrimaryClient);
      setLeadContacts(prev => prev.map(lc => lc.id === optimisticId ? newLc : lc));
      if (isPrimaryClient) {
        await patchLead(supabase, leadId, { contact_id: contactId });
      }

      const lead = leads.find(l => l.id === leadId);
      if (lead) {
        notify(allMemberIds(), `Lead "${lead.name}" contacts updated`, `${actorName()} linked a contact.`, `/leads/${leadId}`, 'lead', leadId, 'lead_contacts');
      }
    } catch (err) {
      setLeadContacts(prev => prev.filter(lc => lc.id !== optimisticId));
      if (isPrimaryClient) {
        const lead = leads.find(l => l.id === leadId);
        if (lead) setLeads(prev => prev.map(l => l.id === leadId ? lead : l));
      }
      toast('error', 'Failed to add contact to lead');
    }
  };

  const updateLeadContactAction = async (
    lcId: string,
    leadId: string,
    updates: Partial<Pick<LeadContact, 'role' | 'custom_role' | 'is_primary_client'>>
  ) => {
    const prev = leadContacts;
    const prevLeads = leads;
    setLeadContacts(lcs => {
      let updated = lcs.map(lc =>
        lc.id === lcId ? { ...lc, ...updates } : lc
      );
      if (updates.is_primary_client) {
        updated = updated.map(lc =>
          lc.lead_id === leadId && lc.id !== lcId && lc.is_primary_client
            ? { ...lc, is_primary_client: false }
            : lc
        );
      }
      return updated;
    });

    // If setting as primary, update lead.contact_id
    if (updates.is_primary_client) {
      const lc = leadContacts.find(l => l.id === lcId);
      if (lc) {
        setLeads(ls => ls.map(l =>
          l.id === leadId ? { ...l, contact_id: lc.contact_id, updated_at: new Date().toISOString() } : l
        ));
      }
    }
    if (skipSupabase) return;

    try {
      await updateLeadContactQuery(supabase, lcId, leadId, updates);
      if (updates.is_primary_client) {
        const lc = leadContacts.find(l => l.id === lcId);
        if (lc) await patchLead(supabase, leadId, { contact_id: lc.contact_id });
      }

      const lead = leads.find(l => l.id === leadId);
      if (lead) {
        notify(allMemberIds(), `Lead "${lead.name}" contacts updated`, `${actorName()} updated a contact role.`, `/leads/${leadId}`, 'lead', leadId, 'lead_contacts');
      }
    } catch (err) {
      setLeadContacts(prev);
      setLeads(prevLeads);
      toast('error', 'Failed to update lead contact');
    }
  };

  const removeLeadContactAction = async (lcId: string, leadId: string) => {
    const prev = leadContacts;
    const prevLeads = leads;
    const removingLc = leadContacts.find(lc => lc.id === lcId);
    setLeadContacts(lcs => lcs.filter(lc => lc.id !== lcId));

    // If removing primary, clear lead.contact_id
    if (removingLc?.is_primary_client) {
      setLeads(ls => ls.map(l =>
        l.id === leadId ? { ...l, contact_id: null, updated_at: new Date().toISOString() } : l
      ));
    }
    if (skipSupabase) return;

    try {
      await removeLeadContactQuery(supabase, lcId);
      if (removingLc?.is_primary_client) {
        await patchLead(supabase, leadId, { contact_id: null });
      }

      const lead = leads.find(l => l.id === leadId);
      if (lead) {
        notify(allMemberIds(), `Lead "${lead.name}" contacts updated`, `${actorName()} removed a contact.`, `/leads/${leadId}`, 'lead', leadId, 'lead_contacts');
      }
    } catch (err) {
      setLeadContacts(prev);
      setLeads(prevLeads);
      toast('error', 'Failed to remove contact from lead');
    }
  };

  // Portal Settings CRUD
  const upsertPortalSettingsAction = async (
    projectId: string,
    settings: Partial<Omit<PortalSettings, 'id' | 'project_id' | 'created_at' | 'updated_at'>>
  ) => {
    const existing = portalSettings.find(ps => ps.project_id === projectId);
    const now = new Date().toISOString();

    if (existing) {
      const prev = portalSettings;
      setPortalSettings(ps => ps.map(s =>
        s.project_id === projectId ? { ...s, ...settings, updated_at: now } : s
      ));
      if (skipSupabase) return;

      try {
        const updated = await upsertPortalSettingsQuery(supabase, projectId, settings);
        setPortalSettings(ps => ps.map(s => s.project_id === projectId ? updated : s));
        if (settings.enabled !== undefined && settings.enabled !== existing.enabled) {
          const project = projects.find(p => p.id === projectId);
          const action = settings.enabled ? 'enabled' : 'disabled';
          notify(allMemberIds(), `Portal ${action} for "${project?.name || 'project'}"`, `${actorName()} ${action} the client portal.`, `/projects/${projectId}`, 'project', projectId, 'portal_settings');
        }
      } catch (err) {
        setPortalSettings(prev);
        toast('error', 'Failed to update portal settings');
      }
    } else {
      const optimisticId = crypto.randomUUID();
      const project = projects.find(p => p.id === projectId);
      const token = generatePortalSlug(project?.name || projectId);
      const optimistic: PortalSettings = {
        id: optimisticId,
        project_id: projectId,
        enabled: settings.enabled ?? false,
        token,
        pin: settings.pin ?? null,
        welcome_message: settings.welcome_message ?? '',
        logo_url: settings.logo_url ?? '',
        accent_color: settings.accent_color ?? siteConfig.colors.brand[500],
        show_progress: settings.show_progress ?? true,
        show_files: settings.show_files ?? true,
        show_hours: settings.show_hours ?? true,
        show_updates: settings.show_updates ?? true,
        show_credentials: settings.show_credentials ?? false,
        show_invoices: settings.show_invoices ?? false,
        section_order: settings.section_order ?? [...DEFAULT_SECTION_ORDER],
        created_at: now,
        updated_at: now,
      };

      setPortalSettings(prev => [...prev, optimistic]);
      if (skipSupabase) return;

      try {
        const created = await upsertPortalSettingsQuery(supabase, projectId, settings);
        setPortalSettings(prev => prev.map(s => s.id === optimisticId ? created : s));
      } catch (err) {
        setPortalSettings(prev => prev.filter(s => s.id !== optimisticId));
        toast('error', 'Failed to create portal settings');
      }
    }
  };

  const updatePortalSlugAction = async (projectId: string, newSlug: string) => {
    const existing = portalSettings.find(ps => ps.project_id === projectId);
    if (!existing) return;

    const normalized = newSlug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '');
    if (!normalized) return;

    // Optimistic update
    const prev = portalSettings;
    setPortalSettings(ps => ps.map(s =>
      s.project_id === projectId ? { ...s, token: normalized, updated_at: new Date().toISOString() } : s
    ));
    if (skipSupabase) return;

    try {
      const updated = await updatePortalSlugQuery(supabase, projectId, newSlug);
      setPortalSettings(ps => ps.map(s => s.project_id === projectId ? updated : s));
    } catch (err) {
      setPortalSettings(prev);
      toast('error', 'Failed to update portal slug');
    }
  };

  // Portal Update CRUD
  const addPortalUpdate = async (
    update: Omit<PortalUpdate, 'id' | 'created_at' | 'updated_at'>,
    attachments?: { name: string; file_url: string; file_size: number; mime_type: string }[]
  ) => {
    const optimisticId = crypto.randomUUID();
    const now = new Date().toISOString();
    const optimistic: PortalUpdate = {
      ...update,
      id: optimisticId,
      created_at: now,
      updated_at: now,
    };

    setPortalUpdates(prev => [optimistic, ...prev]);

    // Optimistic attachments
    const optimisticAttachments: PortalUpdateAttachment[] = (attachments || []).map(a => ({
      id: crypto.randomUUID(),
      update_id: optimisticId,
      name: a.name,
      file_url: a.file_url,
      file_size: a.file_size,
      mime_type: a.mime_type,
      uploaded_by: teamMemberId,
      created_at: now,
      updated_at: now,
    }));
    if (optimisticAttachments.length > 0) {
      setPortalUpdateAttachments(prev => [...prev, ...optimisticAttachments]);
    }

    if (skipSupabase) return;

    try {
      const created = await insertPortalUpdateQuery(supabase, update);
      setPortalUpdates(prev => prev.map(u => u.id === optimisticId ? created : u));

      // Insert real attachments with the real update ID
      if (attachments && attachments.length > 0) {
        const realAttachments = await insertPortalUpdateAttachmentsQuery(supabase, attachments.map(a => ({
          update_id: created.id,
          name: a.name,
          file_url: a.file_url,
          file_size: a.file_size,
          mime_type: a.mime_type,
          uploaded_by: teamMemberId,
        })));
        setPortalUpdateAttachments(prev => [
          ...prev.filter(a => a.update_id !== optimisticId),
          ...realAttachments,
        ]);
      }

      notify(allMemberIds(), `New portal update: "${update.title}"`, `${actorName()} posted a portal update.`, `/projects/${update.project_id}`, 'project', update.project_id, 'portal_updates');
    } catch (err) {
      setPortalUpdates(prev => prev.filter(u => u.id !== optimisticId));
      setPortalUpdateAttachments(prev => prev.filter(a => a.update_id !== optimisticId));
      toast('error', 'Failed to add update');
    }
  };

  const updatePortalUpdate = async (
    id: string,
    updates: Partial<Pick<PortalUpdate, 'title' | 'content' | 'update_type' | 'pinned'>>,
    newAttachments?: { name: string; file_url: string; file_size: number; mime_type: string }[],
    removedAttachmentIds?: string[]
  ) => {
    const prev = portalUpdates;
    const prevAttachments = portalUpdateAttachments;
    const existing = portalUpdates.find(u => u.id === id);
    setPortalUpdates(u => u.map(upd => upd.id === id ? { ...upd, ...updates } : upd));

    // Optimistic: remove deleted attachments
    if (removedAttachmentIds && removedAttachmentIds.length > 0) {
      setPortalUpdateAttachments(a => a.filter(att => !removedAttachmentIds.includes(att.id)));
    }

    // Optimistic: add new attachments
    const now = new Date().toISOString();
    const optimisticNew: PortalUpdateAttachment[] = (newAttachments || []).map(a => ({
      id: crypto.randomUUID(),
      update_id: id,
      name: a.name,
      file_url: a.file_url,
      file_size: a.file_size,
      mime_type: a.mime_type,
      uploaded_by: teamMemberId,
      created_at: now,
      updated_at: now,
    }));
    if (optimisticNew.length > 0) {
      setPortalUpdateAttachments(a => [...a, ...optimisticNew]);
    }

    if (skipSupabase) return;

    try {
      await patchPortalUpdateQuery(supabase, id, updates);

      // Remove attachments
      if (removedAttachmentIds) {
        for (const attId of removedAttachmentIds) {
          await removePortalUpdateAttachmentQuery(supabase, attId);
        }
      }

      // Insert new attachments
      if (newAttachments && newAttachments.length > 0) {
        const created = await insertPortalUpdateAttachmentsQuery(supabase, newAttachments.map(a => ({
          update_id: id,
          name: a.name,
          file_url: a.file_url,
          file_size: a.file_size,
          mime_type: a.mime_type,
          uploaded_by: teamMemberId,
        })));
        const optimisticIds = optimisticNew.map(o => o.id);
        setPortalUpdateAttachments(a => [
          ...a.filter(att => !optimisticIds.includes(att.id)),
          ...created,
        ]);
      }

      if (existing) {
        notify(allMemberIds(), 'Portal update edited', `${actorName()} edited a portal update.`, `/projects/${existing.project_id}`, 'project', existing.project_id, 'portal_updates');
      }
    } catch (err) {
      setPortalUpdates(prev);
      setPortalUpdateAttachments(prevAttachments);
      toast('error', 'Failed to update');
    }
  };

  const deletePortalUpdate = async (id: string) => {
    const prev = portalUpdates;
    const prevAttachments = portalUpdateAttachments;
    const existing = portalUpdates.find(u => u.id === id);
    setPortalUpdates(u => u.filter(upd => upd.id !== id));
    setPortalUpdateAttachments(a => a.filter(att => att.update_id !== id));
    if (skipSupabase) return;

    try {
      await removePortalUpdateQuery(supabase, id);
      if (existing) {
        notify(allMemberIds(), 'Portal update deleted', `${actorName()} removed a portal update.`, `/projects/${existing.project_id}`, 'project', existing.project_id, 'portal_updates');
      }
    } catch (err) {
      setPortalUpdates(prev);
      setPortalUpdateAttachments(prevAttachments);
      toast('error', 'Failed to delete update');
    }
  };

  const deletePortalUpdateAttachment = async (id: string) => {
    const prev = portalUpdateAttachments;
    setPortalUpdateAttachments(a => a.filter(att => att.id !== id));
    if (skipSupabase) return;

    try {
      await removePortalUpdateAttachmentQuery(supabase, id);
    } catch (err) {
      setPortalUpdateAttachments(prev);
      toast('error', 'Failed to delete attachment');
    }
  };

  // Credential CRUD (encryption happens server-side via internal API routes)
  const addCredential = async (
    projectId: string,
    data: { label: string; category: string; username: string; password: string; url: string; notes: string },
  ): Promise<ProjectCredentialListItem | undefined> => {
    const optimisticId = crypto.randomUUID();
    const now = new Date().toISOString();
    const optimistic: ProjectCredentialListItem = {
      id: optimisticId,
      project_id: projectId,
      label: data.label,
      category: data.category as CredentialCategory,
      submitted_by_client: false,
      submitted_by_name: '',
      created_by: teamMemberId,
      created_at: now,
      updated_at: now,
    };
    setProjectCredentials(prev => [optimistic, ...prev]);
    if (skipSupabase) return optimistic;

    try {
      const res = await fetch('/api/credentials/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, ...data, created_by: teamMemberId }),
      });
      if (!res.ok) throw new Error('Failed to create credential');
      const result = await res.json();
      setProjectCredentials(prev => prev.map(c => c.id === optimisticId ? result.data : c));
      const project = projects.find(p => p.id === projectId);
      notify(allMemberIds(), 'New credential added', `${actorName()} added a credential to "${project?.name || 'project'}".`, `/projects/${projectId}`, 'project', projectId, 'portal_settings');
      return result.data;
    } catch {
      setProjectCredentials(prev => prev.filter(c => c.id !== optimisticId));
      toast('error', 'Failed to save credential');
      return undefined;
    }
  };

  const updateCredential = async (
    id: string,
    data: { label?: string; category?: string; username?: string; password?: string; url?: string; notes?: string },
  ) => {
    const prev = projectCredentials;
    setProjectCredentials(creds =>
      creds.map(c => c.id === id ? { ...c, ...('label' in data ? { label: data.label! } : {}), ...('category' in data ? { category: data.category as CredentialCategory } : {}), updated_at: new Date().toISOString() } : c),
    );
    if (skipSupabase) return;

    try {
      const res = await fetch(`/api/credentials/${id}/update`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error();
      const result = await res.json();
      setProjectCredentials(creds => creds.map(c => c.id === id ? result.data : c));
    } catch {
      setProjectCredentials(prev);
      toast('error', 'Failed to update credential');
    }
  };

  const deleteCredential = async (id: string) => {
    const prev = projectCredentials;
    const existing = projectCredentials.find(c => c.id === id);
    setProjectCredentials(creds => creds.filter(c => c.id !== id));
    if (skipSupabase) return;

    try {
      const res = await fetch(`/api/credentials/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error();
      if (existing) {
        const project = projects.find(p => p.id === existing.project_id);
        notify(allMemberIds(), 'Credential deleted', `${actorName()} removed a credential from "${project?.name || 'project'}".`, `/projects/${existing.project_id}`, 'project', existing.project_id, 'portal_settings');
      }
    } catch {
      setProjectCredentials(prev);
      toast('error', 'Failed to delete credential');
    }
  };

  const revealCredential = async (id: string): Promise<CredentialPayload | null> => {
    if (skipSupabase) {
      return { username: 'demo_user', password: 'demo_pass', url: 'https://example.com', notes: 'Demo credential' };
    }
    try {
      const res = await fetch(`/api/credentials/${id}/reveal`);
      if (!res.ok) throw new Error();
      const result = await res.json();
      return result.data;
    } catch {
      toast('error', 'Failed to reveal credential');
      return null;
    }
  };

  // Entity File CRUD
  const addEntityFile = async (file: Omit<EntityFile, 'id' | 'created_at' | 'updated_at'>) => {
    const optimisticId = crypto.randomUUID();
    const now = new Date().toISOString();
    const optimistic: EntityFile = {
      ...file,
      visibility: file.visibility || 'internal',
      id: optimisticId,
      created_at: now,
      updated_at: now,
    };

    setEntityFiles(prev => [optimistic, ...prev]);
    if (skipSupabase) return;

    try {
      const created = await insertEntityFileQuery(supabase, file);
      setEntityFiles(prev => prev.map(f => f.id === optimisticId ? created : f));
      const link = file.entity_type === 'project' ? `/projects/${file.entity_id}` : file.entity_type === 'lead' ? `/leads/${file.entity_id}` : `/contacts/${file.entity_id}`;
      notify(allMemberIds(), `File attached to ${file.entity_type}`, `${actorName()} uploaded a file.`, link, file.entity_type, file.entity_id, 'entity_files');
    } catch (err) {
      setEntityFiles(prev => prev.filter(f => f.id !== optimisticId));
      toast('error', 'Failed to upload file');
    }
  };

  const renameEntityFile = async (id: string, name: string) => {
    const prev = entityFiles;
    setEntityFiles(f => f.map(file => file.id === id ? { ...file, name } : file));
    if (skipSupabase) return;

    try {
      await renameEntityFileQuery(supabase, id, name);
    } catch (err) {
      setEntityFiles(prev);
      toast('error', 'Failed to rename file');
    }
  };

  const deleteEntityFile = async (id: string) => {
    const prev = entityFiles;
    const existing = entityFiles.find(f => f.id === id);
    setEntityFiles(f => f.filter(file => file.id !== id));
    if (skipSupabase) return;

    try {
      await removeEntityFileQuery(supabase, id);
      if (existing) {
        const link = existing.entity_type === 'project' ? `/projects/${existing.entity_id}` : existing.entity_type === 'lead' ? `/leads/${existing.entity_id}` : `/contacts/${existing.entity_id}`;
        notify(allMemberIds(), `File removed from ${existing.entity_type}`, `${actorName()} deleted an attachment.`, link, existing.entity_type, existing.entity_id, 'entity_files');
      }
    } catch (err) {
      setEntityFiles(prev);
      toast('error', 'Failed to delete file');
    }
  };

  const updateEntityFileVisibility = async (id: string, visibility: 'internal' | 'external') => {
    const prev = entityFiles;
    setEntityFiles(f => f.map(file => file.id === id ? { ...file, visibility } : file));
    if (skipSupabase) return;

    try {
      await updateEntityFileVisibilityQuery(supabase, id, visibility);
    } catch (err) {
      setEntityFiles(prev);
      toast('error', 'Failed to update file visibility');
    }
  };

  const getEntityFiles = (entityType: EntityFileType, entityId: string) =>
    entityFiles.filter(ef => ef.entity_type === entityType && ef.entity_id === entityId);

  // Time Entry CRUD
  const addTimeEntry = async (entry: Omit<TimeEntry, 'id' | 'created_at' | 'updated_at'>) => {
    const optimisticId = crypto.randomUUID();
    const now = new Date().toISOString();
    const optimistic: TimeEntry = {
      ...entry,
      id: optimisticId,
      created_at: now,
      updated_at: now,
    };

    setTimeEntries(prev => [optimistic, ...prev]);
    if (skipSupabase) return;

    try {
      const created = await insertTimeEntryQuery(supabase, entry);
      setTimeEntries(prev => prev.map(te => te.id === optimisticId ? created : te));
      const project = projects.find(p => p.id === entry.project_id);
      notify(allMemberIds(), `Time logged on "${project?.name || 'project'}"`, `${actorName()} logged time.`, `/projects/${entry.project_id}`, 'project', entry.project_id, 'time_entries');
    } catch (err) {
      setTimeEntries(prev => prev.filter(te => te.id !== optimisticId));
      toast('error', 'Failed to add time entry');
    }
  };

  const updateTimeEntry = async (id: string, updates: Partial<Pick<TimeEntry, 'member_id' | 'start_time' | 'end_time' | 'description'>>) => {
    const prev = timeEntries;
    const existing = timeEntries.find(te => te.id === id);
    setTimeEntries(te => te.map(entry =>
      entry.id === id ? { ...entry, ...updates, updated_at: new Date().toISOString() } : entry
    ));
    if (skipSupabase) return;

    try {
      await patchTimeEntryQuery(supabase, id, updates);
      if (existing) {
        const project = projects.find(p => p.id === existing.project_id);
        notify(allMemberIds(), `Time entry updated on "${project?.name || 'project'}"`, `${actorName()} updated a time entry.`, `/projects/${existing.project_id}`, 'project', existing.project_id, 'time_entries');
      }
    } catch (err) {
      setTimeEntries(prev);
      toast('error', 'Failed to update time entry');
    }
  };

  const deleteTimeEntry = async (id: string) => {
    const prev = timeEntries;
    const existing = timeEntries.find(te => te.id === id);
    setTimeEntries(te => te.filter(entry => entry.id !== id));
    if (skipSupabase) return;

    try {
      await removeTimeEntryQuery(supabase, id);
      if (existing) {
        const project = projects.find(p => p.id === existing.project_id);
        notify(allMemberIds(), `Time entry deleted on "${project?.name || 'project'}"`, `${actorName()} removed a time entry.`, `/projects/${existing.project_id}`, 'project', existing.project_id, 'time_entries');
      }
    } catch (err) {
      setTimeEntries(prev);
      toast('error', 'Failed to delete time entry');
    }
  };

  const getTimeEntriesByProject = (projectId: string) =>
    timeEntries.filter(te => te.project_id === projectId);

  const startTimer = async (projectId: string, memberId: string, description = '') => {
    // Check if there's already a running timer for this project
    const existing = timeEntries.find(te => te.project_id === projectId && te.end_time === null);
    if (existing) {
      toast('error', 'A timer is already running for this project');
      return;
    }

    const now = new Date().toISOString();
    const entry: Omit<TimeEntry, 'id' | 'created_at' | 'updated_at'> = {
      project_id: projectId,
      member_id: memberId,
      start_time: now,
      end_time: null,
      description,
    };
    await addTimeEntry(entry);
  };

  const stopTimer = async (projectId: string) => {
    const running = timeEntries.find(te => te.project_id === projectId && te.end_time === null);
    if (!running) return;
    await updateTimeEntry(running.id, { end_time: new Date().toISOString() });
  };

  const getRunningTimer = (projectId: string) =>
    timeEntries.find(te => te.project_id === projectId && te.end_time === null);

  // API Key CRUD
  const addApiKeyAction = async (name: string, keyHash: string, keyPrefix: string, permissions = 'full', linkedTeamMemberId?: string | null): Promise<ApiKey | undefined> => {
    if (skipSupabase) return undefined;

    try {
      const newKey = await insertApiKeyQuery(supabase, {
        name,
        key_prefix: keyPrefix,
        key_hash: keyHash,
        created_by: teamMemberId,
        permissions,
        team_member_id: linkedTeamMemberId || null,
      });
      setApiKeys(prev => [newKey, ...prev]);
      notify(adminMemberIds(), `New API key created: "${name}"`, `${actorName()} generated an API key.`, '/settings', 'member', null, 'api_keys');
      return newKey;
    } catch (err) {
      toast('error', 'Failed to create API key');
      return undefined;
    }
  };

  const revokeApiKeyAction = async (id: string) => {
    const prev = apiKeys;
    const existing = apiKeys.find(k => k.id === id);
    setApiKeys(keys => keys.map(k => k.id === id ? { ...k, revoked_at: new Date().toISOString() } : k));
    if (skipSupabase) return;

    try {
      await revokeApiKeyQuery(supabase, id);
      if (existing) {
        notify(adminMemberIds(), `API key revoked: "${existing.name}"`, `${actorName()} revoked an API key.`, '/settings', 'member', null, 'api_keys');
      }
    } catch (err) {
      setApiKeys(prev);
      toast('error', 'Failed to revoke API key');
    }
  };

  // Project Goal CRUD
  const addGoalAction = async (goal: { project_id: string; title: string; description?: string; target_date?: string | null; status?: string }): Promise<ProjectGoal | undefined> => {
    const optimisticId = crypto.randomUUID();
    const now = new Date().toISOString();
    const optimistic: ProjectGoal = {
      id: optimisticId,
      project_id: goal.project_id,
      title: goal.title,
      description: goal.description || '',
      target_date: goal.target_date || null,
      status: (goal.status as ProjectGoal['status']) || 'active',
      created_by: teamMemberId,
      archived_at: null,
      created_at: now,
      updated_at: now,
    };

    setProjectGoals(prev => [optimistic, ...prev]);
    if (skipSupabase) return optimistic;

    try {
      const newGoal = await insertGoalQuery(supabase, { ...goal, created_by: teamMemberId });
      setProjectGoals(prev => prev.map(g => g.id === optimisticId ? newGoal : g));

      const project = projects.find(p => p.id === goal.project_id);
      notify(adminMemberIds(), `New goal for "${project?.name || 'project'}"`, `${actorName()} created goal "${goal.title}".`, '/agent', 'goal', newGoal.id, 'agent_goals');

      return newGoal;
    } catch (err) {
      setProjectGoals(prev => prev.filter(g => g.id !== optimisticId));
      toast('error', 'Failed to create goal');
      return undefined;
    }
  };

  const updateGoalAction = async (id: string, updates: Partial<ProjectGoal>) => {
    const prev = projectGoals;
    const goal = projectGoals.find(g => g.id === id);
    setProjectGoals(g => g.map(gl =>
      gl.id === id ? { ...gl, ...updates, updated_at: new Date().toISOString() } : gl
    ));
    if (skipSupabase) return;

    try {
      await patchGoalQuery(supabase, id, updates);

      if (goal) {
        notify(adminMemberIds(), `Goal "${goal.title}" updated`, `${actorName()} updated the goal.`, '/agent', 'goal', id, 'agent_goals');
      }
    } catch (err) {
      setProjectGoals(prev);
      toast('error', 'Failed to update goal');
    }
  };

  const archiveGoalAction = async (id: string) => {
    const prev = projectGoals;
    const goal = projectGoals.find(g => g.id === id);
    setProjectGoals(g => g.filter(gl => gl.id !== id));
    if (skipSupabase) return;

    try {
      await archiveGoalQuery(supabase, id);

      if (goal) {
        notify(adminMemberIds(), `Goal "${goal.title}" archived`, `${actorName()} archived the goal.`, '/agent', 'goal', id, 'agent_goals');
      }
    } catch (err) {
      setProjectGoals(prev);
      toast('error', 'Failed to archive goal');
    }
  };

  // Task Suggestion review actions
  const approveSuggestionAction = async (
    id: string,
    taskOverrides: { priority?: string; assigned_to?: string | null; due_date?: string | null; project_id?: string; task_type?: string | null },
    reviewedBy: string
  ) => {
    const prevSuggestions = taskSuggestions;
    const suggestion = taskSuggestions.find(s => s.id === id);
    if (!suggestion) return;

    setTaskSuggestions(s => s.map(sug =>
      sug.id === id ? { ...sug, status: 'approved' as const, reviewed_by: reviewedBy, reviewed_at: new Date().toISOString() } : sug
    ));
    if (skipSupabase) return;

    try {
      const result = await approveTaskSuggestionQuery(supabase, id, taskOverrides, reviewedBy);
      setTaskSuggestions(s => s.map(sug => sug.id === id ? result.suggestion : sug));
      setTasks(prev => [result.task, ...prev]);

      // Notify all members that a suggestion was approved
      notify(adminMemberIds(), `Suggestion "${suggestion.title}" approved`, `${actorName()} approved the suggestion and created a task.`, null, 'suggestion', id, 'agent_suggestions');
    } catch (err) {
      setTaskSuggestions(prevSuggestions);
      toast('error', 'Failed to approve suggestion');
    }
  };

  const rejectSuggestionAction = async (id: string, reason: string | undefined, reviewedBy: string) => {
    const prev = taskSuggestions;
    const suggestion = taskSuggestions.find(s => s.id === id);

    setTaskSuggestions(s => s.map(sug =>
      sug.id === id ? { ...sug, status: 'rejected' as const, reviewed_by: reviewedBy, reviewed_at: new Date().toISOString(), rejection_reason: reason || null } : sug
    ));
    if (skipSupabase) return;

    try {
      const updated = await rejectTaskSuggestionQuery(supabase, id, reason, reviewedBy);
      setTaskSuggestions(s => s.map(sug => sug.id === id ? updated : sug));

      if (suggestion) {
        notify(adminMemberIds(), `Suggestion "${suggestion.title}" rejected`, reason ? `Reason: ${reason}` : `${actorName()} rejected the suggestion.`, null, 'suggestion', id, 'agent_suggestions');
      }
    } catch (err) {
      setTaskSuggestions(prev);
      toast('error', 'Failed to reject suggestion');
    }
  };

  const requestInfoOnSuggestionAction = async (id: string, infoRequest: string, reviewedBy: string) => {
    const prev = taskSuggestions;
    const suggestion = taskSuggestions.find(s => s.id === id);
    setTaskSuggestions(s => s.map(sug =>
      sug.id === id ? { ...sug, status: 'needs_info' as const, reviewed_by: reviewedBy, reviewed_at: new Date().toISOString(), info_request: infoRequest } : sug
    ));
    if (skipSupabase) return;

    try {
      const updated = await requestInfoTaskSuggestionQuery(supabase, id, infoRequest, reviewedBy);
      setTaskSuggestions(s => s.map(sug => sug.id === id ? updated : sug));

      if (suggestion) {
        notify(adminMemberIds(), `Info requested on "${suggestion.title}"`, `${actorName()} requested more info on a suggestion.`, null, 'suggestion', id, 'agent_suggestions');
      }
    } catch (err) {
      setTaskSuggestions(prev);
      toast('error', 'Failed to request info');
    }
  };

  const bulkApproveSuggestionsAction = async (ids: string[]) => {
    for (const id of ids) {
      await approveSuggestionAction(id, {}, teamMemberId || '');
    }
  };

  const bulkRejectSuggestionsAction = async (ids: string[], reason?: string) => {
    for (const id of ids) {
      await rejectSuggestionAction(id, reason, teamMemberId || '');
    }
  };

  // Agent helpers
  const getGoalsByProject = (projectId: string) => projectGoals.filter(g => g.project_id === projectId);
  const getSuggestionsByGoal = (goalId: string) => taskSuggestions.filter(s => s.goal_id === goalId);
  const getPendingSuggestionCount = () => taskSuggestions.filter(s => s.status === 'pending').length;

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
  const getFieldsByLead = (leadId: string) =>
    leadFields.filter(f => f.lead_id === leadId);
  const getLeadFieldValue = (leadId: string, fieldKey: string) => {
    const field = leadFields.find(f => f.lead_id === leadId && f.field_key === fieldKey);
    return field?.value;
  };
  const getContactsByLead = (leadId: string) => leadContacts.filter(lc => lc.lead_id === leadId);
  const getPrimaryLeadContact = (leadId: string) => leadContacts.find(lc => lc.lead_id === leadId && lc.is_primary_client);
  const getPortalSettings = (projectId: string) => portalSettings.find(ps => ps.project_id === projectId);
  const getPortalUpdates = (projectId: string) => portalUpdates.filter(pu => pu.project_id === projectId);
  const getPortalUpdateAttachments = (updateId: string) => portalUpdateAttachments.filter(a => a.update_id === updateId);
  const getCredentialsByProject = (projectId: string) => projectCredentials.filter(c => c.project_id === projectId);

  // Invoice CRUD
  const addInvoice = async (invoice: Omit<ProjectInvoice, 'id' | 'created_at' | 'updated_at'>): Promise<ProjectInvoice | undefined> => {
    const optimisticId = crypto.randomUUID();
    const now = new Date().toISOString();
    const optimistic: ProjectInvoice = { ...invoice, id: optimisticId, created_at: now, updated_at: now };
    setProjectInvoices(prev => [optimistic, ...prev]);
    if (skipSupabase) return optimistic;

    try {
      const created = await insertProjectInvoiceQuery(supabase, invoice);
      setProjectInvoices(prev => prev.map(i => i.id === optimisticId ? created : i));
      const project = projects.find(p => p.id === invoice.project_id);
      notify(allMemberIds(), `Invoice added to "${project?.name || 'project'}"`, `${actorName()} created invoice ${invoice.invoice_number}.`, `/projects/${invoice.project_id}`, 'project', invoice.project_id, 'portal_settings');
      return created;
    } catch {
      setProjectInvoices(prev => prev.filter(i => i.id !== optimisticId));
      toast('error', 'Failed to create invoice');
      return undefined;
    }
  };

  const updateInvoice = async (id: string, updates: Partial<ProjectInvoice>) => {
    const prev = projectInvoices;
    setProjectInvoices(invoices =>
      invoices.map(i => i.id === id ? { ...i, ...updates, updated_at: new Date().toISOString() } : i),
    );
    if (skipSupabase) return;

    try {
      const updated = await patchProjectInvoiceQuery(supabase, id, updates);
      setProjectInvoices(invoices => invoices.map(i => i.id === id ? updated : i));
    } catch {
      setProjectInvoices(prev);
      toast('error', 'Failed to update invoice');
    }
  };

  const deleteInvoice = async (id: string) => {
    const prev = projectInvoices;
    const existing = projectInvoices.find(i => i.id === id);
    setProjectInvoices(invoices => invoices.filter(i => i.id !== id));
    if (skipSupabase) return;

    try {
      // Remove file from storage if present
      if (existing?.file_url) {
        const path = existing.file_url.split('/entity-files/')[1];
        if (path) {
          supabase.storage.from('entity-files').remove([decodeURIComponent(path)]).then(() => {}, () => {});
        }
      }
      await removeProjectInvoiceQuery(supabase, id);
      if (existing) {
        const project = projects.find(p => p.id === existing.project_id);
        notify(allMemberIds(), `Invoice deleted from "${project?.name || 'project'}"`, `${actorName()} removed invoice ${existing.invoice_number}.`, `/projects/${existing.project_id}`, 'project', existing.project_id, 'portal_settings');
      }
    } catch {
      setProjectInvoices(prev);
      toast('error', 'Failed to delete invoice');
    }
  };

  const getInvoicesByProject = (projectId: string) =>
    projectInvoices.filter(i => i.project_id === projectId);

  const getInvoicesByContact = (contactId: string) => {
    const contactProjectIds = projectContacts
      .filter(pc => pc.contact_id === contactId)
      .map(pc => pc.project_id);
    return projectInvoices.filter(i => contactProjectIds.includes(i.project_id));
  };

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
      leadFields,
      leadContacts,
      activities,
      portalSettings,
      portalUpdates,
      entityFiles,
      apiKeys,
      timeEntries,
      projectCredentials,
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
      upsertLocalTeamMember,
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
      setLeadField: setLeadFieldAction,
      deleteLeadField: deleteLeadFieldAction,
      addLeadContact: addLeadContactAction,
      updateLeadContact: updateLeadContactAction,
      removeLeadContact: removeLeadContactAction,
      upsertPortalSettings: upsertPortalSettingsAction,
      updatePortalSlug: updatePortalSlugAction,
      addPortalUpdate,
      updatePortalUpdate,
      deletePortalUpdate,
      getPortalUpdates,
      portalUpdateAttachments,
      getPortalUpdateAttachments,
      deletePortalUpdateAttachment,
      addEntityFile,
      renameEntityFile,
      deleteEntityFile,
      updateEntityFileVisibility,
      getEntityFiles,
      addTimeEntry,
      updateTimeEntry,
      deleteTimeEntry,
      startTimer,
      stopTimer,
      getRunningTimer,
      getTimeEntriesByProject,
      addApiKey: addApiKeyAction,
      revokeApiKey: revokeApiKeyAction,
      projectGoals,
      taskSuggestions,
      agentActivity: agentActivityList,
      addGoal: addGoalAction,
      updateGoal: updateGoalAction,
      archiveGoal: archiveGoalAction,
      approveSuggestion: approveSuggestionAction,
      rejectSuggestion: rejectSuggestionAction,
      requestInfoOnSuggestion: requestInfoOnSuggestionAction,
      bulkApproveSuggestions: bulkApproveSuggestionsAction,
      bulkRejectSuggestions: bulkRejectSuggestionsAction,
      getGoalsByProject,
      getSuggestionsByGoal,
      getPendingSuggestionCount,
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
      getFieldsByLead,
      getLeadFieldValue,
      getContactsByLead,
      getPrimaryLeadContact,
      addCredential,
      updateCredential,
      deleteCredential,
      revealCredential,
      getCredentialsByProject,
      projectInvoices,
      addInvoice,
      updateInvoice,
      deleteInvoice,
      getInvoicesByProject,
      getInvoicesByContact,
      getPortalSettings,
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
