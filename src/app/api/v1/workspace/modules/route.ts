import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { auditSettingsForKey, readWorkspaceModules, saveWorkspaceModules } from '@/lib/api/workspace-settings';
import { MODULE_IDS } from '@/lib/modules/registry';

export const dynamic = 'force-dynamic';

const modulesSchema = z.object({
  modules: z.array(z.enum(MODULE_IDS)).max(MODULE_IDS.length * 2),
  completeSetup: z.boolean().optional(),
}).strict();

/**
 * Settings > Features over the API: which parts of the app the workspace
 * uses, and whether first-run setup is finished. Owner only, by role (a
 * switch hides parts of the app from everyone), on a key that carries
 * settings.manage. The same writer as Settings: a module whose requirements
 * are off stays off. Answers { modules, setupCompleted, setupCompletedAt }.
 */
export const GET = withApi(async ({ supabase, access }) => {
  assertOwnerCaller(access, 'sees which features are on');
  return success(await readWorkspaceModules(supabase));
}, { permission: 'settings.manage' });

export const PUT = withApi<z.infer<typeof modulesSchema>>(async ({ supabase, access, body, teamMemberId, apiKeyId }) => {
  assertOwnerCaller(access, 'switches features on or off');
  const modules = MODULE_IDS.filter((id) => body.modules.includes(id));
  const saved = await saveWorkspaceModules(supabase, teamMemberId, { modules, completeSetup: body.completeSetup });
  auditSettingsForKey(supabase, '/api/v1/workspace/modules', { apiKeyId, teamMemberId }, saved.audit);
  return success(saved.data);
}, { permission: 'settings.manage', schema: modulesSchema });
