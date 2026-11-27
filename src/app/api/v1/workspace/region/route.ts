import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { auditSettingsForKey, patchWorkspaceRegion, readWorkspaceRegion } from '@/lib/api/workspace-settings';

export const dynamic = 'force-dynamic';

const regionPatchSchema = z.object({
  currency: z.string().optional(),
  locale: z.string().optional(),
  weekStart: z.union([z.literal(0), z.literal(1), z.literal(6)]).optional(),
}).strict().refine((body) => Object.values(body).some((value) => value !== undefined), 'Send currency, locale or weekStart');

/**
 * Settings > Workspace > Region over the API: the currency (ISO 4217), locale
 * (a language tag) and week start (1 Monday, 0 Sunday, 6 Saturday). Owner
 * only, by role, on a key that carries settings.manage. PATCH changes only
 * the fields sent, by the same checks and writer as Settings, which expires
 * the cached region at once. Answers { region, defaults }.
 */
export const GET = withApi(async ({ supabase, access }) => {
  assertOwnerCaller(access, 'sees the region settings');
  return success(await readWorkspaceRegion(supabase));
}, { permission: 'settings.manage' });

export const PATCH = withApi<z.infer<typeof regionPatchSchema>>(async ({ supabase, access, body, teamMemberId, apiKeyId }) => {
  assertOwnerCaller(access, 'changes the region');
  const saved = await patchWorkspaceRegion(supabase, teamMemberId, body);
  auditSettingsForKey(supabase, '/api/v1/workspace/region', { apiKeyId, teamMemberId }, saved.audit);
  return success(saved.data);
}, { permission: 'settings.manage', schema: regionPatchSchema });
