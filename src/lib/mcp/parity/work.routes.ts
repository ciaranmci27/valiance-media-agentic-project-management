import 'server-only';
import type { HttpMethod } from '../core';
import * as tasksReorder from '@/app/api/v1/tasks/reorder/route';
import * as subtasksReorder from '@/app/api/v1/tasks/[id]/subtasks/reorder/route';
import * as taskMessages from '@/app/api/v1/tasks/[id]/messages/route';
import * as agentRoles from '@/app/api/v1/agents/roles/route';
import * as activityLabels from '@/app/api/v1/agent-activities/[id]/labels/route';

/** The smaller task, group, agent and time actions: route modules not already wired elsewhere (routes.ts merges these). */
export const WORK_ROUTE_MODULES: Record<string, Partial<Record<HttpMethod, unknown>>> = {
  '/api/v1/tasks/reorder': tasksReorder,
  '/api/v1/tasks/{id}/subtasks/reorder': subtasksReorder,
  '/api/v1/tasks/{id}/messages': taskMessages,
  '/api/v1/agents/roles': agentRoles,
  '/api/v1/agent-activities/{id}/labels': activityLabels,
};
