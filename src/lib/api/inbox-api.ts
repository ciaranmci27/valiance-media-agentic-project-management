import { InboxError, type InboxContext } from '@/lib/communications/inbox-service';
import { logAudit } from './audit';
import { ApiError } from './errors';
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
