import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { notFound } from '@/lib/api/errors';
import { apiKeyAllows } from '@/lib/api/access';
import { API_ENDPOINT_PERMISSIONS, type AccessContext } from '@/lib/access-control';
import { assembleTeamProfile } from '@/lib/team/profile';

export const dynamic = 'force-dynamic';

/**
 * A team member's profile (their page on Team), assembled by the app's own
 * rules (lib/team/profile.ts) on the API channel: what the key carries and
 * its member holds there. Full for yourself or with team.manage (hours with
 * Time on and time.read_all, usage for people), a colleague's view with
 * team.read; someone out of reach is 404, never 403. The activity section is
 * left out over the API: read it from GET /api/v1/activities.
 *
 * Permission: team.read (or team.manage).
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params, access, scopes }) => {
  // The profile reads its rules as app grants: here they are what the key carries and its member holds on the API.
  const view: AccessContext = { ...access, app_permissions: API_ENDPOINT_PERMISSIONS.filter((permission) => apiKeyAllows(access, scopes, permission)) };
  const profile = await assembleTeamProfile({ service: supabase, reader: supabase, access: view, targetId: params.id, withoutActivity: true });
  if (!profile) throw notFound('Team member');
  return success(profile);
}, { permission: 'team.read' });
