import type { SupabaseClient } from '@supabase/supabase-js';
import { logAudit } from '@/lib/api/audit';
import { inboxOwnerOf } from './inbox-visibility';

type AuditParams = Parameters<typeof logAudit>[1];

/**
 * The audit line for a write on an inbox's mail (a triage, a plan, a reply
 * draft, an attachment label). The audit log is read with audit.read (Owners
 * and Admins), so it must never hold a personal inbox's mail: for one, only
 * the ids and the outcome are kept (`outcome`), never the request body or a
 * snapshot that quotes the email. A shared inbox's line is kept in full, as
 * before.
 */
export async function logInboxAudit(
  supabase: SupabaseClient,
  inboxId: string,
  params: AuditParams,
  outcome: Record<string, unknown>,
): Promise<void> {
  const owner = await inboxOwnerOf(supabase, inboxId).catch(() => 'unknown' as const);
  // An inbox we could not look up is treated as personal: the log loses detail, never privacy.
  if (owner === null) {
    logAudit(supabase, params);
    return;
  }
  logAudit(supabase, {
    ...params,
    requestBody: undefined,
    beforeSnapshot: undefined,
    afterSnapshot: { personal_inbox: true, ...outcome },
  });
}
