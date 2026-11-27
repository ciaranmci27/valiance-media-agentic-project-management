import 'server-only';
import type { HttpMethod } from '../core';
import * as senderRule from '@/app/api/v1/inbox/sender-rules/[id]/route';
import * as threads from '@/app/api/v1/inbox/threads/route';
import * as thread from '@/app/api/v1/inbox/threads/[threadId]/route';
import * as count from '@/app/api/v1/inbox/count/route';
import * as handled from '@/app/api/v1/inbox/threads/[threadId]/handled/route';
import * as sendBack from '@/app/api/v1/inbox/threads/[threadId]/send-back/route';
import * as moveToInbox from '@/app/api/v1/inbox/threads/[threadId]/move-to-inbox/route';
import * as answer from '@/app/api/v1/inbox/threads/[threadId]/answer/route';
import * as draft from '@/app/api/v1/inbox/threads/[threadId]/draft/route';
import * as draftCopied from '@/app/api/v1/inbox/threads/[threadId]/draft/copied/route';
import * as agentWork from '@/app/api/v1/inbox/threads/[threadId]/agent-work/route';
import * as agentWorkRestore from '@/app/api/v1/inbox/threads/[threadId]/agent-work/restore/route';
import * as addAll from '@/app/api/v1/inbox/threads/[threadId]/add-all/route';
import * as nothingToDo from '@/app/api/v1/inbox/threads/[threadId]/nothing-to-do/route';
import * as nothingToDoUndo from '@/app/api/v1/inbox/threads/[threadId]/nothing-to-do/undo/route';
import * as threadProjects from '@/app/api/v1/inbox/threads/[threadId]/projects/route';
import * as threadProject from '@/app/api/v1/inbox/threads/[threadId]/projects/[projectId]/route';
import * as threadLinks from '@/app/api/v1/inbox/threads/[threadId]/links/route';
import * as planItemAccept from '@/app/api/v1/inbox/plan-items/[id]/accept/route';
import * as planItemDismiss from '@/app/api/v1/inbox/plan-items/[id]/dismiss/route';
import * as planItemUndo from '@/app/api/v1/inbox/plan-items/[id]/undo/route';
import * as planItemRestore from '@/app/api/v1/inbox/plan-items/[id]/restore/route';
import * as planUndo from '@/app/api/v1/inbox/plans/[id]/undo/route';
import * as replyPointResolve from '@/app/api/v1/inbox/reply-points/[id]/resolve/route';

/** Inbox setup, rules and a person's decisions: the v1 route module behind each tool path (routes.ts merges these). */
export const INBOX_ROUTE_MODULES: Record<string, Partial<Record<HttpMethod, unknown>>> = {
  '/api/v1/inbox/sender-rules/{id}': senderRule,
  '/api/v1/inbox/threads': threads,
  '/api/v1/inbox/threads/{threadId}': thread,
  '/api/v1/inbox/count': count,
  '/api/v1/inbox/threads/{threadId}/handled': handled,
  '/api/v1/inbox/threads/{threadId}/send-back': sendBack,
  '/api/v1/inbox/threads/{threadId}/move-to-inbox': moveToInbox,
  '/api/v1/inbox/threads/{threadId}/answer': answer,
  '/api/v1/inbox/threads/{threadId}/draft': draft,
  '/api/v1/inbox/threads/{threadId}/draft/copied': draftCopied,
  '/api/v1/inbox/threads/{threadId}/agent-work': agentWork,
  '/api/v1/inbox/threads/{threadId}/agent-work/restore': agentWorkRestore,
  '/api/v1/inbox/threads/{threadId}/add-all': addAll,
  '/api/v1/inbox/threads/{threadId}/nothing-to-do': nothingToDo,
  '/api/v1/inbox/threads/{threadId}/nothing-to-do/undo': nothingToDoUndo,
  '/api/v1/inbox/threads/{threadId}/projects': threadProjects,
  '/api/v1/inbox/threads/{threadId}/projects/{projectId}': threadProject,
  '/api/v1/inbox/threads/{threadId}/links': threadLinks,
  '/api/v1/inbox/plan-items/{id}/accept': planItemAccept,
  '/api/v1/inbox/plan-items/{id}/dismiss': planItemDismiss,
  '/api/v1/inbox/plan-items/{id}/undo': planItemUndo,
  '/api/v1/inbox/plan-items/{id}/restore': planItemRestore,
  '/api/v1/inbox/plans/{id}/undo': planUndo,
  '/api/v1/inbox/reply-points/{id}/resolve': replyPointResolve,
};
