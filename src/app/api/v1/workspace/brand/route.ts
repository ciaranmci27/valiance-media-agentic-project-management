import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { auditSettingsForKey, patchWorkspaceBrand, readWorkspaceBrand } from '@/lib/api/workspace-settings';

export const dynamic = 'force-dynamic';

const text = z.string().nullable().optional();
const brandPatchSchema = z.object({
  name: text,
  tagline: text,
  description: text,
  brandColor: text,
  accentColor: text,
  brandShades: z.record(z.string(), z.string()).nullable().optional(),
  invertLogoInSidebar: z.boolean().optional(),
  showNameUnderLogo: z.boolean().optional(),
  sidebarProjects: z.enum(['list', 'menu']).optional(),
  sidebarActiveProjects: z.boolean().optional(),
}).strict().refine((body) => Object.values(body).some((value) => value !== undefined), 'Send at least one field');

/**
 * Settings > Workspace > Brand over the API: the name, tagline, description,
 * colors and sidebar options (logos upload in Settings). Owner only, by role,
 * on a key that carries settings.manage. PATCH changes only the fields sent
 * (null puts a text or color back to the default) by the same checks and
 * writer as Settings, and the app shows the change on the next page load.
 * Answers { settings, brand (resolved, with defaults filled in), defaults }.
 */
export const GET = withApi(async ({ supabase, access }) => {
  assertOwnerCaller(access, 'sees the brand settings');
  return success(await readWorkspaceBrand(supabase));
}, { permission: 'settings.manage' });

export const PATCH = withApi<z.infer<typeof brandPatchSchema>>(async ({ supabase, access, body, teamMemberId, apiKeyId }) => {
  assertOwnerCaller(access, 'changes the brand');
  const saved = await patchWorkspaceBrand(supabase, teamMemberId, body);
  auditSettingsForKey(supabase, '/api/v1/workspace/brand', { apiKeyId, teamMemberId }, saved.audit);
  return success(saved.data);
}, { permission: 'settings.manage', schema: brandPatchSchema });
