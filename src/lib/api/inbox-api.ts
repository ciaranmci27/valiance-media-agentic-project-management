import { InboxError, type InboxContext } from '@/lib/communications/inbox-service';
import { isModuleEnabled } from '@/lib/access-control';
import { logAudit } from './audit';
import { ApiError, moduleOff } from './errors';
import type { ApiContext } from './middleware';

/**
 * The Inbox over the API (/api/v1/inbox/threads, plan items, reply points,
 * sender rules): the same functions the app's session routes call
 * (lib/communications), given the key's view. Every rule they check is read
 * on the api channel, with the key's scopes for permissions a key carries
 * (InboxContext.scopes), and which inboxes the key reads or acts on is the
 * one rule in inbox-visibility.ts. Their InboxErrors answer as ApiErrors with
 * the same status and words.
 */

type Caller = Pick<ApiContext, 'supabase' | 'access' | 'teamMemberId' | 'scopes'>;

/** The InboxContext for a key: writes go through its actor client, logged as its member. */
export function inboxContextOf(ctx: Caller): InboxContext {
  return { service: ctx.supabase, access: ctx.access, memberId: ctx.teamMemberId, scopes: ctx.scopes };
}

const CODES: Record<number, string> = {
  400: 'BAD_REQUEST', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 422: 'VALIDATION_ERROR',
};

/** Runs an Inbox function for a key: its InboxError becomes the API's error, same status, same message. */
export async function inboxApi<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof InboxError) {
      throw new ApiError(error.status, CODES[error.status] ?? 'INTERNAL_ERROR', error.message, { reason: error.reason ?? `inbox_${error.status}` });
    }
    throw error;
  }
}

/**
 * The audit line for a person's Inbox decision over the API. Ids only, never
 * a body or a snapshot: the audit log is read by Owners and Admins and must
 * not quote anyone's mail (a personal inbox's least of all, inbox-audit.ts).
 */
export function auditInboxDecision(
  ctx: Pick<ApiContext, 'supabase' | 'apiKeyId' | 'teamMemberId'>,
  entry: { method: string; endpoint: string; entityType: string; entityId: string; statusCode?: number },
): void {
  logAudit(ctx.supabase, {
    method: entry.method,
    endpoint: entry.endpoint,
    entityType: entry.entityType,
    entityId: entry.entityId,
    apiKeyId: ctx.apiKeyId,
    teamMemberId: ctx.teamMemberId,
    statusCode: entry.statusCode ?? 200,
  });
}

/**
 * The audit line for an Inbox setup write over the API (Settings > Email, a
 * project's email): what was asked and what it saved. Settings only, never
 * mail, so the body and the saved row are kept.
 */
export function auditInboxSetup(
  ctx: Pick<ApiContext, 'supabase' | 'apiKeyId' | 'teamMemberId'>,
  entry: { method: string; endpoint: string; entityType: string; entityId?: string | null; body?: unknown; after?: unknown; statusCode?: number },
): void {
  logAudit(ctx.supabase, {
    method: entry.method,
    endpoint: entry.endpoint,
    entityType: entry.entityType,
    entityId: entry.entityId ?? undefined,
    apiKeyId: ctx.apiKeyId,
    teamMemberId: ctx.teamMemberId,
    requestBody: entry.body,
    afterSnapshot: entry.after,
    statusCode: entry.statusCode ?? 200,
  });
}

/**
 * The Inbox's settings that live on another path (a project's email, your
 * own inbox): refused while the Inbox is switched off, as the app's routes
 * refuse them. Routes under /api/v1/inbox get this from their permission.
 */
export function assertInboxOn(access: ApiContext['access']): void {
  if (!isModuleEnabled(access, 'inbox')) throw moduleOff('inbox');
}
