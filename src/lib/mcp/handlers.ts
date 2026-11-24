import 'server-only';
import type { NextRequest } from 'next/server';
import type { HttpMethod } from './core';
import * as projects from '@/app/api/v1/projects/route';
import * as project from '@/app/api/v1/projects/[id]/route';
import * as projectContext from '@/app/api/v1/projects/[id]/context/route';
import * as projectGoals from '@/app/api/v1/projects/[id]/goals/route';
import * as projectTime from '@/app/api/v1/projects/[id]/time-entries/route';
import * as timePause from '@/app/api/v1/projects/[id]/time-entries/[entryId]/pause/route';
import * as timeResume from '@/app/api/v1/projects/[id]/time-entries/[entryId]/resume/route';
import * as timeStop from '@/app/api/v1/projects/[id]/time-entries/[entryId]/stop/route';
import * as tasks from '@/app/api/v1/tasks/route';
import * as task from '@/app/api/v1/tasks/[id]/route';
import * as taskBrief from '@/app/api/v1/tasks/[id]/brief/route';
import * as nextTask from '@/app/api/v1/tasks/next/route';
import * as taskClaim from '@/app/api/v1/tasks/[id]/claim/route';
import * as taskClaimExtend from '@/app/api/v1/tasks/[id]/claim/extend/route';
import * as taskComments from '@/app/api/v1/tasks/[id]/comments/route';
import * as taskReviews from '@/app/api/v1/tasks/[id]/reviews/route';
import * as taskFiles from '@/app/api/v1/tasks/[id]/files/route';
import * as taskFileUrl from '@/app/api/v1/tasks/[id]/files/[fileId]/url/route';
import * as taskSubtasks from '@/app/api/v1/tasks/[id]/subtasks/route';
import * as taskSubtask from '@/app/api/v1/tasks/[id]/subtasks/[subtaskId]/route';
import * as taskCriteria from '@/app/api/v1/tasks/[id]/acceptance-criteria/route';
import * as taskCriterion from '@/app/api/v1/tasks/[id]/acceptance-criteria/[criterionId]/route';
import * as suggestions from '@/app/api/v1/task-suggestions/route';
import * as suggestion from '@/app/api/v1/task-suggestions/[id]/route';
import * as notifications from '@/app/api/v1/notifications/route';
import * as questions from '@/app/api/v1/questions/route';
import * as question from '@/app/api/v1/questions/[id]/route';
import * as questionAnswer from '@/app/api/v1/questions/[id]/answer/route';
import * as questionCancel from '@/app/api/v1/questions/[id]/cancel/route';
import * as approvals from '@/app/api/v1/approvals/route';
import * as approval from '@/app/api/v1/approvals/[id]/route';
import * as reminders from '@/app/api/v1/reminders/route';
import * as reminder from '@/app/api/v1/reminders/[id]/route';
import * as agentActivities from '@/app/api/v1/agent-activities/route';
import * as agentHeartbeat from '@/app/api/v1/agents/heartbeat/route';
import * as agentRuns from '@/app/api/v1/agents/runs/route';
import * as agentRun from '@/app/api/v1/agents/runs/[id]/route';
import * as agentRunFinish from '@/app/api/v1/agents/runs/[id]/finish/route';
import * as teamMembers from '@/app/api/v1/team-members/route';
import * as teamMember from '@/app/api/v1/team-members/[id]/route';
import * as leads from '@/app/api/v1/leads/route';
import * as lead from '@/app/api/v1/leads/[id]/route';
import * as leadInteractions from '@/app/api/v1/leads/[id]/interactions/route';
import * as contacts from '@/app/api/v1/contacts/route';
import * as agents from '@/app/api/v1/agents/route';
import * as agentSetup from '@/app/api/v1/agents/[id]/setup/route';
import * as agentProjects from '@/app/api/v1/agents/[id]/projects/route';
import * as agentContext from '@/app/api/v1/agents/[id]/context/route';
import * as agentExport from '@/app/api/v1/agents/[id]/export/route';
import * as agentTemplate from '@/app/api/v1/agents/[id]/template/route';
import * as agentImport from '@/app/api/v1/agents/import/route';
import * as myContext from '@/app/api/v1/agents/me/context/route';
import * as agentTemplates from '@/app/api/v1/agent-templates/route';
import * as apiKeys from '@/app/api/v1/api-keys/route';
import * as apiKeyRevoke from '@/app/api/v1/api-keys/[id]/revoke/route';
import * as webhookEndpoints from '@/app/api/v1/webhook-endpoints/route';
import * as webhookEndpoint from '@/app/api/v1/webhook-endpoints/[id]/route';
import * as inboxMessages from '@/app/api/v1/inbox/messages/route';
import * as inboxMessage from '@/app/api/v1/inbox/messages/[id]/route';
import * as inboxContext from '@/app/api/v1/inbox/messages/[id]/context/route';
import * as inboxPlan from '@/app/api/v1/inbox/messages/[id]/plan/route';
import * as inboxTriage from '@/app/api/v1/inbox/messages/[id]/triage/route';
import * as inboxTasks from '@/app/api/v1/inbox/messages/[id]/tasks/route';
import * as inboxAttachment from '@/app/api/v1/inbox/messages/[id]/attachments/[aid]/route';
import * as inboxAttachmentUrl from '@/app/api/v1/inbox/messages/[id]/attachments/[aid]/url/route';
import * as inboxQueue from '@/app/api/v1/inbox/queue/route';
import * as inboxQuestions from '@/app/api/v1/inbox/questions/route';
import * as inboxReplyDrafts from '@/app/api/v1/inbox/reply-drafts/route';
import * as inboxReplyDraft from '@/app/api/v1/inbox/reply-drafts/[id]/route';
import * as inboxSenderRules from '@/app/api/v1/inbox/sender-rules/route';
import * as inboxSenders from '@/app/api/v1/inbox/senders/route';
import * as inboxUnsummarized from '@/app/api/v1/inbox/triage/unsummarized/route';
import * as inboxMarkSummarized from '@/app/api/v1/inbox/triage/mark-summarized/route';
import * as inboxSignal from '@/app/api/v1/inbox/signal/route';

export type RouteHandler = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

type RouteModule = Partial<Record<HttpMethod, unknown>>;

/**
 * The v1 route module behind each path template the tools call. Paths use
 * the folder names for their parameters ({id}, {entryId}, ...), and
 * scripts/verify-mcp.ts checks every tool's routes resolve here, so a tool
 * always runs the same handler REST does.
 */
export const ROUTE_MODULES: Record<string, RouteModule> = {
  '/api/v1/projects': projects,
  '/api/v1/projects/{id}': project,
  '/api/v1/projects/{id}/context': projectContext,
  '/api/v1/projects/{id}/goals': projectGoals,
  '/api/v1/projects/{id}/time-entries': projectTime,
  '/api/v1/projects/{id}/time-entries/{entryId}/pause': timePause,
  '/api/v1/projects/{id}/time-entries/{entryId}/resume': timeResume,
  '/api/v1/projects/{id}/time-entries/{entryId}/stop': timeStop,
  '/api/v1/tasks': tasks,
  '/api/v1/tasks/{id}': task,
  '/api/v1/tasks/{id}/brief': taskBrief,
  '/api/v1/tasks/next': nextTask,
  '/api/v1/tasks/{id}/claim': taskClaim,
  '/api/v1/tasks/{id}/claim/extend': taskClaimExtend,
  '/api/v1/tasks/{id}/comments': taskComments,
  '/api/v1/tasks/{id}/reviews': taskReviews,
  '/api/v1/tasks/{id}/files': taskFiles,
  '/api/v1/tasks/{id}/files/{fileId}/url': taskFileUrl,
  '/api/v1/tasks/{id}/subtasks': taskSubtasks,
  '/api/v1/tasks/{id}/subtasks/{subtaskId}': taskSubtask,
  '/api/v1/tasks/{id}/acceptance-criteria': taskCriteria,
  '/api/v1/tasks/{id}/acceptance-criteria/{criterionId}': taskCriterion,
  '/api/v1/task-suggestions': suggestions,
  '/api/v1/task-suggestions/{id}': suggestion,
  '/api/v1/notifications': notifications,
  '/api/v1/questions': questions,
  '/api/v1/questions/{id}': question,
  '/api/v1/questions/{id}/answer': questionAnswer,
  '/api/v1/questions/{id}/cancel': questionCancel,
  '/api/v1/approvals': approvals,
  '/api/v1/approvals/{id}': approval,
  '/api/v1/reminders': reminders,
  '/api/v1/reminders/{id}': reminder,
  '/api/v1/agent-activities': agentActivities,
  '/api/v1/agents/heartbeat': agentHeartbeat,
  '/api/v1/agents/runs': agentRuns,
  '/api/v1/agents/runs/{id}': agentRun,
  '/api/v1/agents/runs/{id}/finish': agentRunFinish,
  '/api/v1/team-members': teamMembers,
  '/api/v1/team-members/{id}': teamMember,
  '/api/v1/leads': leads,
  '/api/v1/leads/{id}': lead,
  '/api/v1/leads/{id}/interactions': leadInteractions,
  '/api/v1/contacts': contacts,
  '/api/v1/agents': agents,
  '/api/v1/agents/{id}/setup': agentSetup,
  '/api/v1/agents/{id}/projects': agentProjects,
  '/api/v1/agents/{id}/context': agentContext,
  '/api/v1/agents/{id}/export': agentExport,
  '/api/v1/agents/{id}/template': agentTemplate,
  '/api/v1/agents/import': agentImport,
  '/api/v1/agents/me/context': myContext,
  '/api/v1/agent-templates': agentTemplates,
  '/api/v1/api-keys': apiKeys,
  '/api/v1/api-keys/{id}/revoke': apiKeyRevoke,
  '/api/v1/webhook-endpoints': webhookEndpoints,
  '/api/v1/webhook-endpoints/{id}': webhookEndpoint,
  '/api/v1/inbox/messages': inboxMessages,
  '/api/v1/inbox/messages/{id}': inboxMessage,
  '/api/v1/inbox/messages/{id}/context': inboxContext,
  '/api/v1/inbox/messages/{id}/plan': inboxPlan,
  '/api/v1/inbox/messages/{id}/triage': inboxTriage,
  '/api/v1/inbox/messages/{id}/tasks': inboxTasks,
  '/api/v1/inbox/messages/{id}/attachments/{aid}': inboxAttachment,
  '/api/v1/inbox/messages/{id}/attachments/{aid}/url': inboxAttachmentUrl,
  '/api/v1/inbox/queue': inboxQueue,
  '/api/v1/inbox/questions': inboxQuestions,
  '/api/v1/inbox/reply-drafts': inboxReplyDrafts,
  '/api/v1/inbox/reply-drafts/{id}': inboxReplyDraft,
  '/api/v1/inbox/sender-rules': inboxSenderRules,
  '/api/v1/inbox/senders': inboxSenders,
  '/api/v1/inbox/triage/unsummarized': inboxUnsummarized,
  '/api/v1/inbox/triage/mark-summarized': inboxMarkSummarized,
  '/api/v1/inbox/signal': inboxSignal,
};

export function routeHandler(path: string, method: HttpMethod): RouteHandler | null {
  const handler = ROUTE_MODULES[path]?.[method];
  return typeof handler === 'function' ? (handler as RouteHandler) : null;
}
