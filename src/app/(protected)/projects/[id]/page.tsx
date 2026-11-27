'use client';

import { Fragment, useState, useEffect, type ReactNode } from 'react';
import { useCardUnread } from '@/components/tasks/TaskUnread';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useApp, defaultFilters } from '@/lib/store';
import { Header } from '@/components/layout/Header';
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';
import { ProjectForm } from '@/components/projects/ProjectForm';
import { ProjectContactsPanel } from '@/components/projects/ProjectContactsPanel';
import { ClientPortalTab } from '@/components/projects/ClientPortalTab';
import { CommunicationTab } from '@/components/projects/CommunicationTab';
import { TimeTrackingPanel } from '@/components/projects/TimeTrackingPanel';
import { CredentialsPanel } from '@/components/projects/CredentialsPanel';
import InvoicesPanel from '@/components/projects/InvoicesPanel';
import { ProjectOverview } from '@/components/projects/ProjectOverview';
import { projectTrashMessage } from '@/components/projects/trash-message';
import { ProjectTabs, projectPanelId, projectTabId, type ProjectTab } from '@/components/projects/ProjectTabs';
import { EmptyCard } from '@/components/projects/TabLayout';
import { ProjectTaskViews } from '@/components/projects/ProjectTaskViews';
import { InitiativesTab } from '@/components/initiatives/InitiativesTab';
import { RowActionsMenu } from '@/components/ui/RowActionsMenu';
import { FileAttachments } from '@/components/ui/FileAttachments';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { useTaskUrlParam } from '@/lib/use-task-url';
import { Edit, Trash2, Clock } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useTrashTask } from '@/components/tasks/useTrashTask';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { warmRead, warmReads } from '@/lib/query-cache';
import {
  agentTemplatesRead, encryptionStatusRead, inboxLandingRead, projectAgentsRead, projectBillingRunsRead, projectBriefRead, projectForecastRead,
  projectInitiativesRead, projectPaymentsRead, useBillingToday,
} from '@/lib/reads';
import { INITIATIVE_LABEL } from '@/lib/initiatives';
import { isRunning } from '@/lib/time-entry-utils';
import { hasPermission, canOpenInbox, isModuleEnabled } from '@/lib/access-control';
import { ProjectAgentsTab } from '@/components/agent/ProjectAgentsTab';
import { BriefTab } from '@/components/projects/BriefTab';
import { useCustomProjectTabs } from '@/lib/extensions/hooks';

// Custom tabs (src/custom) are keyed x-<key>, so a core tab added later never collides.
type ProjectTabKey = 'overview' | 'tasks' | 'initiatives' | 'agents' | 'brief' | 'time' | 'communication' | 'portal' | 'billing' | 'files' | 'credentials' | `x-${string}`;
const DEFAULT_TAB: ProjectTabKey = 'overview';

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const projectId = params.id as string;
  const { isDemoMode } = useDemo();
  const billingToday = useBillingToday();
  const { access, teamMemberId } = useAuth();
  const canManageProject = hasPermission(access, 'projects.manage');
  // Membership has its own grant; either one opens the project form (members
  // only mode when that is all the viewer holds).
  const canManageMembers = hasPermission(access, 'project_members.manage');
  const canOpenProjectForm = canManageProject || canManageMembers;
  const canReadContacts = hasPermission(access, 'contacts.read') || hasPermission(access, 'contacts.read_all');
  const canReadFiles = hasPermission(access, 'files.read');
  const canReadPortal = hasPermission(access, 'portal.read') || hasPermission(access, 'portal.manage');
  const canReadCommunications = hasPermission(access, 'communications.read') || hasPermission(access, 'communications.manage');
  const canReadInbox = canOpenInbox(access);
  const canReadCredentials = hasPermission(access, 'credentials.reveal_shared') || hasPermission(access, 'credentials.manage');
  const canReadInvoices = hasPermission(access, 'invoices.read') || hasPermission(access, 'invoices.manage');
  const canReadTime = hasPermission(access, 'time.manage_own') || hasPermission(access, 'time.read_all') || hasPermission(access, 'time.manage_all');
  // Agents and the brief belong to the AI agents module; the brief opens with read or manage (the server takes either).
  const agentsOn = isModuleEnabled(access, 'agents');
  const canReadBrief = agentsOn && (hasPermission(access, 'project_context.read') || hasPermission(access, 'project_context.manage'));

  const {
    getProject, getTasksByProject,
    deleteProject, setFilters,
    tasks, loading, timeEntries, getInvoicesByProject, updateProject,
  } = useApp();
  const [turningOnTime, setTurningOnTime] = useState(false);
  const cardUnread = useCardUnread();
  const customTabs = useCustomProjectTabs();

  useEffect(() => { setFilters(defaultFilters); }, []);

  const [isEditProjectOpen, setIsEditProjectOpen] = useState(false);
  const [isContactsPanelOpen, setIsContactsPanelOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ type: 'project'; id: string } | null>(null);
  const trashTask = useTrashTask();
  // Tabs mount on first visit and then stay mounted (hidden), so a half-typed
  // timer note or an open email thread survives a trip to another tab.
  const [visitedTabs, setVisitedTabs] = useState<Set<ProjectTabKey>>(() => new Set());

  const project = getProject(projectId);

  // The project's tasks with their subtasks, which open in the panel.
  const everyProjectTask = tasks.filter(t => t.project_id === projectId);

  // Tabs the viewer can open. A tab with nothing they may read is left out,
  // rather than shown empty.
  const timeTrackingOn = !!project && (project.time_tracking_enabled ?? project.hourly_tracking) && canReadTime;
  // Your own timer running here (not paused): the same rule as the sidebar's pulse.
  const clockedIn = !!teamMemberId && timeEntries.some(
    (entry) => entry.project_id === projectId && entry.member_id === teamMemberId && isRunning(entry),
  );
  // Ordered by how a project is run: the work, the client, the money, then
  // the project's assets.
  // The Tasks tab says how many of the project's tasks are new or changed for you.
  const unreadTaskCount = getTasksByProject(projectId).filter((task) => !!cardUnread(task)).length;
  const allTabs: (ProjectTab<ProjectTabKey> & { visible: boolean })[] = [
    { key: 'overview', label: 'Overview', visible: true },
    { key: 'tasks', label: 'Tasks', visible: true,
      badge: { count: unreadTaskCount, label: `${unreadTaskCount} unread task${unreadTaskCount === 1 ? '' : 's'}` } },
    // Shown to anyone who can open the project; empty, it says what one is.
    { key: 'initiatives', label: INITIATIVE_LABEL.plural, visible: true,
      warm: () => void warmRead(projectInitiativesRead(projectId, isDemoMode)) },
    { key: 'agents', label: 'Agents', visible: agentsOn,
      warm: isDemoMode ? undefined : () => warmReads([projectAgentsRead(projectId), agentTemplatesRead(isDemoMode)]) },
    { key: 'brief', label: 'Brief', visible: canReadBrief,
      warm: isDemoMode ? undefined : () => void warmRead(projectBriefRead(projectId)) },
    // Shown whenever the viewer may use time, on or off for this project.
    { key: 'time', label: 'Time tracking', visible: !!project && canReadTime, live: clockedIn },
    { key: 'communication', label: 'Communication', visible: canReadInbox || canReadCommunications,
      warm: canReadInbox ? () => void warmRead(inboxLandingRead(projectId, isDemoMode)) : undefined },
    { key: 'portal', label: 'Client portal', visible: canReadPortal },
    { key: 'billing', label: 'Billing', visible: canReadInvoices,
      warm: canReadInvoices && !isDemoMode
        ? () => warmReads([
          projectForecastRead(projectId, billingToday),
          projectBillingRunsRead(projectId),
          // Only read when an API payment is shown, as the tab does.
          ...(getInvoicesByProject(projectId).some((invoice) => (invoice.payments ?? []).some((payment) => payment.recorded_via === 'api'))
            ? [projectPaymentsRead(projectId)] : []),
        ]) : undefined },
    { key: 'files', label: 'Files', visible: canReadFiles },
    { key: 'credentials', label: 'Credentials', visible: canReadCredentials,
      warm: canReadCredentials ? () => void warmRead(encryptionStatusRead) : undefined },
    // The install's own tabs, after the core ones.
    ...customTabs.map((tab) => ({ key: `x-${tab.key}` as const, label: tab.label, visible: true })),
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
    ? everyProjectTask.find(t => t.id === viewingTaskId) || null
    : null;

  useEffect(() => {
    if (!viewingTaskId || loading || everyProjectTask.some(t => t.id === viewingTaskId)) return;
    const elsewhere = tasks.find(t => t.id === viewingTaskId);
    if (elsewhere) {
      // A link with the wrong project still lands on the task.
      router.replace(`/projects/${elsewhere.project_id}?task=${elsewhere.id}`, { scroll: false });
      return;
    }
    toast('error', 'That task no longer exists, or you do not have access to it');
    closeViewingTask();
  }, [viewingTaskId, loading, everyProjectTask, tasks, router, closeViewingTask]);

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

  // A task goes to Trash at once, with Undo (Rule 6).
  const handleDeleteTask = (id: string) => {
    closeViewingTask();
    void trashTask(id);
  };

  const executeDelete = () => {
    if (!confirmDelete) return;
    router.push('/projects');
    void deleteProject(confirmDelete.id).then((moved) => {
      if (moved) toast('success', 'Project moved to Trash');
    });
  };

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
                // Delete moves the project to Trash with everything in it,
                // restorable from Settings, Trash.
                actions={[
                  { label: 'Edit project', icon: <Edit size={14} />, onClick: () => setIsEditProjectOpen(true) },
                  { label: 'Move to Trash', icon: <Trash2 size={14} />, variant: 'danger', divider: true, onClick: () => setConfirmDelete({ type: 'project', id: project.id }) },
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

      {tabPanel('tasks', (
        <ProjectTaskViews
          projectId={projectId}
          onOpenTask={setViewingTaskId}
          onDeleteTask={handleDeleteTask}
        />
      ))}

      {tabPanel('initiatives', (
        <InitiativesTab projectId={projectId} />
      ))}

      {tabPanel('time', timeTrackingOn ? (
        <TimeTrackingPanel projectId={projectId} projectColor={project.color} />
      ) : (
        // The tab stays while the Time module is on, so "add hours from a
        // project's Time tracking tab" is always true; here it says it is off.
        <EmptyCard
          icon={<Clock />}
          title="Time tracking is off for this project"
          description={canManageProject
            ? 'Turn it on to start timers and log hours here.'
            : 'Ask a project lead to turn it on to log hours here.'}
          action={canManageProject ? (
            <Button
              size="sm"
              disabled={turningOnTime}
              onClick={async () => {
                setTurningOnTime(true);
                // The same pair the project form saves from its one switch.
                const saved = await updateProject(projectId, { time_tracking_enabled: true, hourly_tracking: true });
                setTurningOnTime(false);
                if (saved) toast('success', 'Time tracking on');
              }}
            >
              Turn on time tracking
            </Button>
          ) : undefined}
        />
      ))}

      {tabPanel('communication', (
        <CommunicationTab
          projectId={projectId}
          view={activeTab === 'communication' ? activeView : null}
          onViewChange={setActiveView}
          canReadInbox={canReadInbox}
          canReadSent={canReadCommunications}
          onOpenPortal={canReadPortal ? () => setActiveTab('portal') : undefined}
          emailLink={{ thread: searchParams.get('thread'), message: searchParams.get('message'), task: searchParams.get('email_task') }}
        />
      ))}

      {tabPanel('portal', (
        <ClientPortalTab
          projectId={projectId}
          view={activeTab === 'portal' ? activeView : null}
          onViewChange={setActiveView}
        />
      ))}

      {tabPanel('agents', <ProjectAgentsTab projectId={projectId} />)}

      {tabPanel('brief', <BriefTab projectId={projectId} />)}

      {tabPanel('billing', <InvoicesPanel projectId={projectId} projectColor={project.color} />)}

      {tabPanel('files', <FileAttachments entityType="project" entityId={projectId} layout="grid" />)}

      {tabPanel('credentials', <CredentialsPanel projectId={projectId} />)}

      {customTabs.map(({ key, component: Tab }) => (
        <Fragment key={key}>{tabPanel(`x-${key}`, <Tab project={project} />)}</Fragment>
      ))}

      {/* Editing the project, in the same side panel a task opens in. */}
      {canOpenProjectForm && <ProjectForm
        isOpen={isEditProjectOpen}
        onClose={() => setIsEditProjectOpen(false)}
        project={project}
      />}

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
        onDelete={handleDeleteTask}
      />

      {/* Confirm Delete Dialog */}
      <ConfirmDialog
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={executeDelete}
        title="Move project to Trash?"
        message={projectTrashMessage(access)}
        variant="danger"
        trash
      />

    </div>
  );
}
