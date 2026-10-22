'use client';

import { useState, useEffect, useRef, type ReactNode } from 'react';
import { Popover } from '@/components/ui/Popover';
import { TaskFilterControl, UNASSIGNED_FILTER_ID } from '@/components/tasks/TaskFilterControl';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useApp, defaultFilters } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { BoardView } from '@/components/views/BoardView';
import { ListView } from '@/components/views/ListView';
import { CalendarView } from '@/components/views/CalendarView';
import { TaskForm } from '@/components/tasks/TaskForm';
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';
import { ProjectForm } from '@/components/projects/ProjectForm';
import { ProjectContactsPanel } from '@/components/projects/ProjectContactsPanel';
import { ClientPortalTab } from '@/components/projects/ClientPortalTab';
import { CommunicationTab } from '@/components/projects/CommunicationTab';
import { TimeTrackingPanel } from '@/components/projects/TimeTrackingPanel';
import { CredentialsPanel } from '@/components/projects/CredentialsPanel';
import InvoicesPanel from '@/components/projects/InvoicesPanel';
import { ProjectOverview } from '@/components/projects/ProjectOverview';
import { ProjectTabs, projectPanelId, projectTabId, type ProjectTab } from '@/components/projects/ProjectTabs';
import { SubNav, TabToolbar } from '@/components/projects/TabLayout';
import { RowActionsMenu } from '@/components/ui/RowActionsMenu';
import { FileAttachments } from '@/components/ui/FileAttachments';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
import { toast } from '@/components/ui/Toast';
import { useTaskUrlParam } from '@/lib/use-task-url';
import {
  Plus, LayoutGrid, List, Calendar,
  Edit, ChevronRight,
} from 'lucide-react';
import { Task, ViewMode } from '@/lib/types';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useAuth } from '@/lib/auth-context';
import { hasPermission, canEditTask, canManageAllTasks, canBeAssignedInProject } from '@/lib/access-control';

type ProjectTabKey = 'overview' | 'tasks' | 'time' | 'communication' | 'portal' | 'billing' | 'files' | 'credentials';
const DEFAULT_TAB: ProjectTabKey = 'overview';

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const projectId = params.id as string;
  const { access, teamMemberId } = useAuth();
  const canManageProject = hasPermission(access, 'projects.manage');
  // Membership has its own grant; either one opens the project form (members
  // only mode when that is all the viewer holds).
  const canManageMembers = hasPermission(access, 'project_members.manage');
  const canOpenProjectForm = canManageProject || canManageMembers;
  const canManageTasks = canManageAllTasks(access);
  const canCreateTasks = hasPermission(access, 'tasks.create');
  const canReadContacts = hasPermission(access, 'contacts.read') || hasPermission(access, 'contacts.read_all');
  const canReadFiles = hasPermission(access, 'files.read');
  const canReadPortal = hasPermission(access, 'portal.read') || hasPermission(access, 'portal.manage');
  const canReadCommunications = hasPermission(access, 'communications.read') || hasPermission(access, 'communications.manage');
  const canReadInbox = hasPermission(access, 'inbound_email.read') || hasPermission(access, 'inbound_email.manage');
  const canReadCredentials = hasPermission(access, 'credentials.reveal_shared') || hasPermission(access, 'credentials.manage');
  const canReadInvoices = hasPermission(access, 'invoices.read') || hasPermission(access, 'invoices.manage');
  const canReadTime = hasPermission(access, 'time.manage_own') || hasPermission(access, 'time.read_all') || hasPermission(access, 'time.manage_all');

  const {
    getProject, getTasksByProject,
    team,
    deleteTask, deleteProject, updateTask, reorderTasks, filters, setFilters,
    tasks, loading,
  } = useApp();

  useEffect(() => { setFilters(defaultFilters); }, []);

  const [viewMode, setViewMode] = useState<ViewMode>('board');
  const [isTaskFormOpen, setIsTaskFormOpen] = useState(false);
  const [isEditProjectOpen, setIsEditProjectOpen] = useState(false);
  const [isContactsPanelOpen, setIsContactsPanelOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ type: 'task' | 'project' | 'bulk'; id: string } | null>(null);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [showBulkMenu, setShowBulkMenu] = useState(false);
  const bulkMenuRef = useRef<HTMLDivElement>(null);
  const [taskFormDueDate, setTaskFormDueDate] = useState<string | null>(null);
  // Clearing due dates wipes data with no undo, so it confirms first; it
  // already cost real due dates to an accidental click.
  const [confirmClearDueDates, setConfirmClearDueDates] = useState(false);
  // Tabs mount on first visit and then stay mounted (hidden), so a half-typed
  // timer note or an open email thread survives a trip to another tab.
  const [visitedTabs, setVisitedTabs] = useState<Set<ProjectTabKey>>(() => new Set());

  const project = getProject(projectId);

  // Unfiltered tasks for stats / progress bar
  const allProjectTasks = getTasksByProject(projectId);

  // Tabs the viewer can open. A tab with nothing they may read is left out,
  // rather than shown empty.
  const timeTrackingOn = !!project && (project.time_tracking_enabled ?? project.hourly_tracking) && canReadTime;
  // Ordered by how a project is run: the work, the client, the money, then
  // the project's assets.
  const allTabs: (ProjectTab<ProjectTabKey> & { visible: boolean })[] = [
    { key: 'overview', label: 'Overview', visible: true },
    { key: 'tasks', label: 'Tasks', visible: true },
    { key: 'time', label: 'Time tracking', visible: !!timeTrackingOn },
    { key: 'communication', label: 'Communication', visible: canReadInbox || canReadCommunications },
    { key: 'portal', label: 'Client portal', visible: canReadPortal },
    { key: 'billing', label: 'Billing', visible: canReadInvoices },
    { key: 'files', label: 'Files', visible: canReadFiles },
    { key: 'credentials', label: 'Credentials', visible: canReadCredentials },
  ];
  const tabs: ProjectTab<ProjectTabKey>[] = allTabs.filter(t => t.visible);

  // The open tab is the URL's ?tab=, so a tab can be linked to and survives a
  // reload. An unknown or hidden tab falls back to the default.
  const requestedTab = searchParams.get('tab');
  const activeTab = tabs.find(t => t.key === requestedTab)?.key ?? DEFAULT_TAB;

  // Native pushState, which Next syncs into useSearchParams: a tab switch is
  // instant and adds a history entry, with no server round trip for the page.
  const pushQuery = (next: URLSearchParams) => {
    const query = next.toString();
    window.history.pushState(null, '', query ? `${pathname}?${query}` : pathname);
  };
  // `view` picks a view inside a tab (Communication's Inbox or Sent); it only
  // means something to the tab it was set for, so a tab switch drops it.
  const setActiveTab = (key: ProjectTabKey, view?: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (key === DEFAULT_TAB) next.delete('tab');
    else next.set('tab', key);
    if (view) next.set('view', view);
    else next.delete('view');
    pushQuery(next);
  };
  const activeView = searchParams.get('view');
  const setActiveView = (view: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set('view', view);
    pushQuery(next);
  };

  // Recorded during render (React's "adjust state on change" pattern), so a
  // tab reached by the back button is remembered too, not only clicked ones.
  if (!visitedTabs.has(activeTab)) setVisitedTabs(new Set(visitedTabs).add(activeTab));

  // Renders a tab's panel once it has been opened, hidden while another tab is.
  const tabPanel = (key: ProjectTabKey, children: ReactNode) =>
    (key === activeTab || visitedTabs.has(key)) && (
      <div
        role="tabpanel"
        id={projectPanelId(key)}
        aria-labelledby={projectTabId(key)}
        hidden={key !== activeTab}
        className="px-4 lg:px-6 pt-5 pb-4 lg:pb-6"
      >
        {children}
      </div>
    );

  // The open task is the URL's ?task=, so every task link opens the panel,
  // here or from anywhere else, and the address bar can be copied as a link.
  const { taskId: viewingTaskId, openTask: setViewingTaskId, closeTask: closeViewingTask } = useTaskUrlParam();

  // Derive viewingTask from store so it stays in sync with subtask/comment changes
  const viewingTask = viewingTaskId
    ? allProjectTasks.find(t => t.id === viewingTaskId) || null
    : null;

  useEffect(() => {
    if (!viewingTaskId || loading || allProjectTasks.some(t => t.id === viewingTaskId)) return;
    const elsewhere = tasks.find(t => t.id === viewingTaskId);
    if (elsewhere) {
      // A link with the wrong project still lands on the task.
      router.replace(`/projects/${elsewhere.project_id}?task=${elsewhere.id}`, { scroll: false });
      return;
    }
    toast('error', 'That task no longer exists, or you do not have access to it');
    closeViewingTask();
  }, [viewingTaskId, loading, allProjectTasks, tasks, router, closeViewingTask]);

  // Filtered tasks for the views
  let projectTasks = [...allProjectTasks];
  if (filters.status.length > 0) {
    projectTasks = projectTasks.filter(t => filters.status.includes(t.status));
  }
  if (filters.priority.length > 0) {
    projectTasks = projectTasks.filter(t => filters.priority.includes(t.priority));
  }
  if (filters.assigneeIds.length > 0) {
    projectTasks = projectTasks.filter(t =>
      (filters.assigneeIds.includes(UNASSIGNED_FILTER_ID) && t.assignee_ids.length === 0) ||
      t.assignee_ids.some(id => filters.assigneeIds.includes(id)));
  }
  if (filters.tags.length > 0) {
    projectTasks = projectTasks.filter(t => t.tags.some(tag => filters.tags.includes(tag)));
  }
  if (filters.search) {
    const search = filters.search.toLowerCase();
    projectTasks = projectTasks.filter(t =>
      t.title.toLowerCase().includes(search) ||
      t.description.toLowerCase().includes(search)
    );
  }

  if (!project) {
    return (
      <div className="animate-fadeIn min-h-screen">
        <Header title="Project Not Found" />
        <div className="p-6 text-center">
          <p className="text-zinc-400 mb-4">This project doesn&apos;t exist</p>
          <Link href="/projects">
            <Button variant="secondary">Back to Projects</Button>
          </Link>
        </div>
      </div>
    );
  }

  const handleViewTask = (task: Task) => {
    setViewingTaskId(task.id);
  };

  const handleEditTask = (task: Task) => {
    closeViewingTask();
    setEditingTask(task);
    setIsTaskFormOpen(true);
  };

  const handleDeleteTask = (id: string) => {
    setConfirmDelete({ type: 'task', id });
  };

  // Recomputes sort_order for a status column after a drag. The drop index
  // refers to the filtered (visible) list, but the whole unfiltered column is
  // resequenced so hidden tasks keep a valid, stable position.
  const reorderColumn = (taskId: string, status: Task['status'], visibleIndex: number) => {
    const bySort = (a: Task, b: Task) => (a.sort_order ?? 0) - (b.sort_order ?? 0);
    const task = allProjectTasks.find(t => t.id === taskId);
    if (!task) return;

    const visibleSiblings = projectTasks
      .filter(t => t.id !== taskId && t.status === status)
      .sort(bySort);
    const allSiblings = allProjectTasks
      .filter(t => t.id !== taskId && t.status === status)
      .sort(bySort);

    // Map the visible drop position onto the unfiltered column: insert before
    // the visible task now at that position, or at the end of the column.
    const clamped = Math.min(visibleIndex, visibleSiblings.length);
    const anchor = visibleSiblings[clamped];
    const insertAt = anchor ? allSiblings.findIndex(t => t.id === anchor.id) : allSiblings.length;
    allSiblings.splice(insertAt, 0, task);

    // Each element still carries its pre-drag sort_order, so only rows whose
    // position actually changed are written
    reorderTasks(
      allSiblings
        .map((t, idx) => ({ task: t, sort_order: idx }))
        .filter(({ task: t, sort_order }) => (t.sort_order ?? 0) !== sort_order)
        .map(({ task: t, sort_order }) => ({ id: t.id, sort_order }))
    );
  };

  const handleStatusChange = (taskId: string, newStatus: Task['status'], targetIndex?: number) => {
    updateTask(taskId, { status: newStatus });

    // If a drop position was specified, reorder within the target column
    if (targetIndex !== undefined) {
      reorderColumn(taskId, newStatus, targetIndex);
    }
  };

  const handleReorder = (taskId: string, newIndex: number) => {
    const task = allProjectTasks.find(t => t.id === taskId);
    if (!task) return;
    reorderColumn(taskId, task.status, newIndex);
  };

  const handleCloseTaskForm = () => {
    setIsTaskFormOpen(false);
    setEditingTask(null);
    setTaskFormDueDate(null);
  };

  const toggleTaskSelection = (taskId: string) => {
    setSelectedTaskIds(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const selectableTaskIds = projectTasks
    .filter(t => canEditTask(access, t, teamMemberId))
    .map(t => t.id);
  const allSelectableSelected = selectableTaskIds.length > 0
    && selectableTaskIds.every(id => selectedTaskIds.has(id));

  const selectAllTasks = () => {
    setSelectedTaskIds(allSelectableSelected ? new Set() : new Set(selectableTaskIds));
  };

  // Every write is awaited, so the toast reports what actually saved. Tasks
  // that failed stay selected, ready for a retry on just those.
  const runBulk = async (verb: 'Updated' | 'Deleted', write: (id: string) => Promise<boolean>) => {
    const ids = [...selectedTaskIds];
    setShowBulkMenu(false);
    const results = await Promise.all(ids.map(write));
    const failedIds = ids.filter((_, index) => !results[index]);
    const saved = ids.length - failedIds.length;
    const count = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`;
    setSelectedTaskIds(new Set(failedIds));
    if (failedIds.length === 0) {
      toast('success', `${verb} ${count(saved)}`);
    } else if (saved === 0) {
      toast('error', `Couldn't ${verb === 'Deleted' ? 'delete' : 'update'} ${count(failedIds.length)}`);
    } else {
      toast('error', `${verb} ${count(saved)}. ${count(failedIds.length)} failed and ${failedIds.length === 1 ? 'is' : 'are'} still selected.`);
    }
  };

  const bulkUpdateStatus = (status: Task['status']) =>
    runBulk('Updated', id => updateTask(id, { status }, { silent: true }));

  const bulkUpdatePriority = (priority: Task['priority']) =>
    runBulk('Updated', id => updateTask(id, { priority }, { silent: true }));

  const bulkAssign = (memberId: string | null) =>
    runBulk('Updated', id => updateTask(id, { assignee_ids: memberId ? [memberId] : [] }, { silent: true }));

  const bulkSetDueDate = (date: string | null) =>
    runBulk('Updated', id => updateTask(id, { due_date: date }, { silent: true }));

  const bulkDelete = () => {
    setConfirmDelete({ type: 'bulk', id: 'bulk' });
  };

  const clearSelection = () => {
    setSelectedTaskIds(new Set());
    setShowBulkMenu(false);
  };

  const executeDelete = () => {
    if (!confirmDelete) return;
    if (confirmDelete.type === 'task') {
      deleteTask(confirmDelete.id);
    } else if (confirmDelete.type === 'bulk') {
      void runBulk('Deleted', id => deleteTask(id, { silent: true }));
    } else {
      deleteProject(confirmDelete.id);
      toast('success', 'Project deleted');
      router.push('/projects');
    }
  };

  const viewModes: { id: ViewMode; icon: typeof LayoutGrid; label: string }[] = [
    { id: 'board', icon: LayoutGrid, label: 'Board' },
    { id: 'list', icon: List, label: 'List' },
    { id: 'calendar', icon: Calendar, label: 'Calendar' },
  ];

  return (
    <div className="animate-fadeIn min-h-screen">
      {/* Header: the name and the actions that apply on every tab. Status,
          dates, people and progress are on the Overview. */}
      <Header
        title={project.name}
        actions={
          <>
            {canManageProject && (
              <RowActionsMenu
                label="Project actions"
                triggerClassName="liquid-glass !p-0 w-9 h-9 flex items-center justify-center !text-zinc-300"
                // No Delete here: the delete route hard-deletes and cascades
                // through tasks, time, invoices and credentials. It comes back
                // as a soft delete (archive + restore) once that exists.
                actions={[
                  { label: 'Edit project', icon: <Edit size={14} />, onClick: () => setIsEditProjectOpen(true) },
                ]}
              />
            )}
          </>
        }
      />


      <div className="px-4 lg:px-6 pt-4">
        <ProjectTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
      </div>

      {tabPanel('overview', (
        <ProjectOverview
          projectId={projectId}
          onOpenTask={setViewingTaskId}
          onOpenTab={setActiveTab}
          onOpenContacts={() => setIsContactsPanelOpen(true)}
          onEditProject={() => setIsEditProjectOpen(true)}
          can={{
            manageProject: canManageProject,
            time: timeTrackingOn,
            inbox: canReadInbox,
            invoices: canReadInvoices,
            portal: canReadPortal,
            contacts: canReadContacts,
          }}
        />
      ))}

      {tabPanel('tasks', <>
        {/* Tasks toolbar: the shared tab toolbar, search first */}
        <TabToolbar
          search={{
            value: filters.search,
            onChange: v => setFilters({ ...filters, search: v }),
            placeholder: 'Search tasks',
          }}
          filters={allProjectTasks.length > 0 && (
            <SubNav
              label="Task view"
              active={viewMode}
              onChange={setViewMode}
              items={viewModes.map(mode => ({ key: mode.id, label: mode.label, icon: mode.icon, hideLabelOnMobile: true }))}
            />
          )}
          extra={<>
            {/* Selection is a desktop-only gesture: the mobile cards have no
                checkboxes, so offering Select all there would select rows the
                user cannot see or unpick individually. */}
            {selectableTaskIds.length > 0 && viewMode === 'list' && (
              <button
                onClick={selectAllTasks}
                className="hidden lg:inline text-xs text-brand-300 hover:text-brand-300 transition-colors"
              >
                {allSelectableSelected ? 'Deselect all' : 'Select all'}
              </button>
            )}
            {/* Bulk Actions (desktop-only, like the selection that feeds it) */}
            {selectedTaskIds.size > 0 && (
              <div ref={bulkMenuRef} className="relative hidden lg:block">
                <button
                  onClick={() => setShowBulkMenu(!showBulkMenu)}
                  className="h-9 flex items-center gap-2 px-3 text-sm bg-brand-500/15 text-brand-300 border border-brand-500/30 rounded-lg hover:bg-brand-500/15 transition-colors"
                >
                  {selectedTaskIds.size} selected
                  <ChevronRight size={14} className="rotate-90" />
                </button>
                <Popover
                  anchorRef={bulkMenuRef}
                  open={showBulkMenu}
                  onClose={() => setShowBulkMenu(false)}
                  align="start"
                  width={248}
                  className="bg-surface-raised rounded-lg shadow-xl border border-white/[0.08] py-1 max-h-[70vh] overflow-y-auto"
                >
                  {/* Same escape hatch the filter panel offers: back out of a
                      half-committed bulk edit in one click. */}
                  <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/[0.06] mb-1">
                    <span className="text-xs font-medium text-zinc-300">{selectedTaskIds.size} selected</span>
                    <button
                      onClick={clearSelection}
                      className="text-xs text-brand-300 hover:text-brand-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 rounded"
                    >
                      Clear selection
                    </button>
                  </div>
                  <p className="px-3 py-1.5 text-xs font-medium text-zinc-400 uppercase">Set Status</p>
                  <div className="grid grid-cols-2 gap-1 px-2 pb-1">
                    {(['todo', 'in_progress', 'in_review', 'done'] as const).map(s => (
                      <button key={s} onClick={() => bulkUpdateStatus(s)} className="text-left px-2 py-1.5 text-sm text-zinc-300 rounded-md hover:bg-white/[0.06]">
                        {s.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}
                      </button>
                    ))}
                  </div>
                  <div className="border-t border-white/[0.06] my-1" />
                  <p className="px-3 py-1.5 text-xs font-medium text-zinc-400 uppercase">Set Priority</p>
                  <div className="grid grid-cols-2 gap-1 px-2 pb-1">
                    {(['low', 'medium', 'high', 'urgent'] as const).map(p => (
                      <button key={p} onClick={() => bulkUpdatePriority(p)} className="text-left px-2 py-1.5 text-sm text-zinc-300 rounded-md hover:bg-white/[0.06]">
                        {p.charAt(0).toUpperCase() + p.slice(1)}
                      </button>
                    ))}
                  </div>
                  {canManageTasks && <>
                    <div className="border-t border-white/[0.06] my-1" />
                    <p className="px-3 py-1.5 text-xs font-medium text-zinc-400 uppercase">Assign To</p>
                    {team.filter(m => canBeAssignedInProject(m, project)).map(member => (
                      <button key={member.id} onClick={() => bulkAssign(member.id)} className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/[0.03]">
                        <Avatar name={member.name} src={member.avatar || undefined} size="xs" />
                        {member.name}
                      </button>
                    ))}
                    <button onClick={() => bulkAssign(null)} className="w-full text-left px-3 py-1.5 text-sm text-zinc-400 hover:bg-white/[0.03]">
                      Unassign all
                    </button>
                  </>}
                  <div className="border-t border-white/[0.06] my-1" />
                  <p className="px-3 py-1.5 text-xs font-medium text-zinc-400 uppercase">Due Date</p>
                  <div className="px-3 pb-1.5">
                    <DateInput value="" onChange={v => { if (v) bulkSetDueDate(v); }} />
                  </div>
                  <button onClick={() => { setShowBulkMenu(false); setConfirmClearDueDates(true); }} className="w-full text-left px-3 py-1.5 text-sm text-zinc-400 hover:bg-white/[0.03]">
                    Clear due date
                  </button>
                  {canManageTasks && <>
                    <div className="border-t border-white/[0.06] my-1" />
                    <button onClick={bulkDelete} className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/15">
                      Delete selected
                    </button>
                  </>}
                </Popover>
              </div>
            )}
          </>}
          actions={<>
            {allProjectTasks.length > 0 && <TaskFilterControl tasks={allProjectTasks} />}
          </>}
          primary={canCreateTasks && (
            <Button onClick={() => setIsTaskFormOpen(true)} icon={<Plus size={16} />} className="whitespace-nowrap">
              <span className="hidden sm:inline">Add task</span>
            </Button>
          )}
        />

        {/* Task Views */}
        {projectTasks.length === 0 ? (
          <div className="glass-card rounded-xl flex flex-col items-center justify-center p-8 text-center">
            <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center mb-3">
              <LayoutGrid size={18} className="text-zinc-500" />
            </div>
            <p className="text-sm font-medium text-zinc-400">No tasks yet</p>
            <p className="text-xs text-zinc-500 mt-1">Create your first task to get started</p>
          </div>
        ) : (
          <>
            {viewMode === 'board' && (
              <BoardView
                tasks={projectTasks}
                onViewTask={handleViewTask}
                onEditTask={handleEditTask}
                onDeleteTask={handleDeleteTask}
                onStatusChange={handleStatusChange}
                onReorder={handleReorder}
              />
            )}

            {viewMode === 'list' && (
              <ListView
                tasks={projectTasks}
                onViewTask={handleViewTask}
                onEditTask={handleEditTask}
                onDeleteTask={handleDeleteTask}
                selectedIds={selectedTaskIds}
                onToggleSelect={toggleTaskSelection}
                onStatusChange={handleStatusChange}
                onReorder={handleReorder}
              />
            )}

            {viewMode === 'calendar' && (
              <CalendarView
                tasks={projectTasks}
                onViewTask={handleViewTask}
                onEditTask={handleEditTask}
                onAddTask={canCreateTasks ? (date) => { setTaskFormDueDate(date); setIsTaskFormOpen(true); } : undefined}
              />
            )}
          </>
        )}
      </>)}

      {tabPanel('time', <TimeTrackingPanel projectId={projectId} projectColor={project.color} />)}

      {tabPanel('communication', (
        <CommunicationTab
          projectId={projectId}
          view={activeTab === 'communication' ? activeView : null}
          onViewChange={setActiveView}
          canReadInbox={canReadInbox}
          canReadSent={canReadCommunications}
          onOpenPortal={() => setActiveTab('portal')}
        />
      ))}

      {tabPanel('portal', (
        <ClientPortalTab
          projectId={projectId}
          view={activeTab === 'portal' ? activeView : null}
          onViewChange={setActiveView}
        />
      ))}

      {tabPanel('billing', <InvoicesPanel projectId={projectId} projectColor={project.color} />)}

      {tabPanel('files', <FileAttachments entityType="project" entityId={projectId} layout="grid" />)}

      {tabPanel('credentials', <CredentialsPanel projectId={projectId} />)}

      {/* Edit Project Modal */}
      {canOpenProjectForm && <ProjectForm
        isOpen={isEditProjectOpen}
        onClose={() => setIsEditProjectOpen(false)}
        project={project}
      />}

      {/* Task Form Modal */}
      <TaskForm
        isOpen={isTaskFormOpen}
        onClose={handleCloseTaskForm}
        projectId={projectId}
        task={editingTask}
        initialDueDate={taskFormDueDate || undefined}
      />

      {/* Contacts Panel Modal */}
      {canReadContacts && <ProjectContactsPanel
        isOpen={isContactsPanelOpen}
        onClose={() => setIsContactsPanelOpen(false)}
        projectId={projectId}
      />}

      {/* Task Detail Panel */}
      <TaskDetailPanel
        task={viewingTask}
        onClose={closeViewingTask}
        onEdit={handleEditTask}
        onDelete={handleDeleteTask}
      />

      {/* Confirm Delete Dialog */}
      <ConfirmDialog
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={executeDelete}
        title={confirmDelete?.type === 'project' ? 'Delete Project' : confirmDelete?.type === 'bulk' ? 'Delete Selected Tasks' : 'Delete Task'}
        message={
          confirmDelete?.type === 'project'
            ? 'This will permanently delete the project and all its tasks. This action cannot be undone.'
            : confirmDelete?.type === 'bulk'
            ? `This will permanently delete ${selectedTaskIds.size} selected tasks. This action cannot be undone.`
            : 'This will permanently delete this task and all its subtasks and comments. This action cannot be undone.'
        }
        confirmLabel="Delete"
        variant="danger"
      />

      {/* Confirm Clear Due Dates: destructive but recoverable by re-entering
          dates, so the softer variant without double-confirm. */}
      <ConfirmDialog
        isOpen={confirmClearDueDates}
        onClose={() => setConfirmClearDueDates(false)}
        onConfirm={() => {
          setConfirmClearDueDates(false);
          bulkSetDueDate(null);
        }}
        title="Clear Due Dates"
        message={`This will remove the due date from ${selectedTaskIds.size} selected ${selectedTaskIds.size === 1 ? 'task' : 'tasks'}.`}
        confirmLabel="Clear due dates"
        variant="default"
      />
    </div>
  );
}
