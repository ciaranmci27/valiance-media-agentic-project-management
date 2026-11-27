import { z } from 'zod';
import { isModuleEnabled } from '@/lib/access-control';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { ApiError } from '@/lib/api/errors';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { currentAuditVia } from '@/lib/api/request-context';
import {
  ensureWebhookRetries,
  turnOffWebhookRetries,
  turnOnWebhookRetries,
  webhookRetriesState,
  WebhookRetriesError,
} from '@/lib/webhooks/retries';

export const dynamic = 'force-dynamic';

const retriesSchema = z.object({ on: z.boolean() }).strict();

const CODES: Record<number, string> = { 409: 'CONFLICT', 503: 'SERVICE_UNAVAILABLE' };

/** What retries need and lack, in the same words Settings shows. */
function asApiError(error: unknown): unknown {
  if (!(error instanceof WebhookRetriesError)) return error;
  return new ApiError(error.status, CODES[error.status] ?? 'INTERNAL_ERROR', error.message, { reason: 'webhook_retries' });
}

/**
 * Webhook retries (Settings > Developers > Webhooks) over the API. Owner
 * only, by role, on a key that carries settings.manage. They are on by
 * default: GET turns them on by itself once everything they need is there
 * (unless an Owner turned them off) and answers the state. PUT { on: true }
 * turns them on (a new scheduler secret, kept by the server and never
 * answered); { on: false } turns them off until an Owner turns them on again.
 * Answers { on, source, turnedOff, appKey, appUrl, vault }.
 */
export const GET = withApi(async ({ supabase, access }) => {
  assertOwnerCaller(access, 'sees webhook retries');
  try {
    if (isModuleEnabled(access, 'webhooks')) await ensureWebhookRetries(supabase);
    return success(await webhookRetriesState(supabase));
  } catch (error) {
    throw asApiError(error);
  }
}, { permission: 'settings.manage' });

export const PUT = withApi<z.infer<typeof retriesSchema>>(async ({ supabase, access, body, teamMemberId, apiKeyId }) => {
  assertOwnerCaller(access, 'turns webhook retries on or off');
  const source = { endpoint: '/api/v1/workspace/webhook-retries', via: currentAuditVia(), apiKeyId };
  try {
    return success(body.on ? await turnOnWebhookRetries(supabase, teamMemberId, source) : await turnOffWebhookRetries(supabase, teamMemberId, source));
  } catch (error) {
    throw asApiError(error);
  }
}, { permission: 'settings.manage', schema: retriesSchema });
