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
import * as taskComments from '@/app/api/v1/tasks/[id]/comments/route';
import * as taskReviews from '@/app/api/v1/tasks/[id]/reviews/route';
import * as taskSubtasks from '@/app/api/v1/tasks/[id]/subtasks/route';
import * as taskSubtask from '@/app/api/v1/tasks/[id]/subtasks/[subtaskId]/route';
import * as taskCriteria from '@/app/api/v1/tasks/[id]/acceptance-criteria/route';
import * as taskCriterion from '@/app/api/v1/tasks/[id]/acceptance-criteria/[criterionId]/route';
import * as suggestions from '@/app/api/v1/task-suggestions/route';
import * as suggestion from '@/app/api/v1/task-suggestions/[id]/route';
import * as notifications from '@/app/api/v1/notifications/route';
import * as agentActivities from '@/app/api/v1/agent-activities/route';
import * as teamMembers from '@/app/api/v1/team-members/route';
import * as leads from '@/app/api/v1/leads/route';
import * as lead from '@/app/api/v1/leads/[id]/route';
import * as leadInteractions from '@/app/api/v1/leads/[id]/interactions/route';
import * as contacts from '@/app/api/v1/contacts/route';

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
  '/api/v1/tasks/{id}/comments': taskComments,
  '/api/v1/tasks/{id}/reviews': taskReviews,
  '/api/v1/tasks/{id}/subtasks': taskSubtasks,
  '/api/v1/tasks/{id}/subtasks/{subtaskId}': taskSubtask,
  '/api/v1/tasks/{id}/acceptance-criteria': taskCriteria,
  '/api/v1/tasks/{id}/acceptance-criteria/{criterionId}': taskCriterion,
  '/api/v1/task-suggestions': suggestions,
  '/api/v1/task-suggestions/{id}': suggestion,
  '/api/v1/notifications': notifications,
  '/api/v1/agent-activities': agentActivities,
  '/api/v1/team-members': teamMembers,
  '/api/v1/leads': leads,
  '/api/v1/leads/{id}': lead,
  '/api/v1/leads/{id}/interactions': leadInteractions,
  '/api/v1/contacts': contacts,
};

export function routeHandler(path: string, method: HttpMethod): RouteHandler | null {
  const handler = ROUTE_MODULES[path]?.[method];
  return typeof handler === 'function' ? (handler as RouteHandler) : null;
}
