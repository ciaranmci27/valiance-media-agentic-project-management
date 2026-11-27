import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { assertHourApprovalsOn, readHourApprovals, setHourApprovals } from '@/lib/api/money-api';

export const dynamic = 'force-dynamic';

const hourApprovalsSchema = z.object({ auto_approve_human_hours: z.boolean() }).strict();

/**
 * Whether people's finished hours approve as they are logged (true, the
 * default) or wait for someone who approves time. Agent hours always wait;
 * an Owner's own never do. Exists while Time tracking and Client invoicing
 * or Team pay are on.
 */
export const GET = withApi(async ({ supabase, access }) => {
  assertHourApprovalsOn(access);
  return success(await readHourApprovals(supabase));
}, { permission: 'settings.manage' });

/** Turns auto-approval of people's hours on or off (Settings > Billing > Hour approvals). Entries already logged keep their status. */
export const PATCH = withApi(async ({ supabase, access, body, apiKeyId, teamMemberId }) => {
  assertHourApprovalsOn(access);
  const { auto_approve_human_hours } = body as z.infer<typeof hourApprovalsSchema>;
  const { before, after } = await setHourApprovals(supabase, auto_approve_human_hours);
  logAudit(supabase, {
    method: 'PATCH',
    endpoint: '/api/v1/time/hour-approvals',
    entityType: 'business_settings',
    apiKeyId,
    teamMemberId,
    requestBody: body,
    beforeSnapshot: before,
    afterSnapshot: after,
    statusCode: 200,
  });
  return success(after);
}, { schema: hourApprovalsSchema, permission: 'settings.manage' });
