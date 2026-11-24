import { adminLinkIdentities, memberAllIdentities } from '@/lib/api/identities';
import { ApiError } from '@/lib/api/errors';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { adminLinkSchema } from '@/lib/identities';

export const dynamic = 'force-dynamic';

/** Every account linked to one member (member_id), verified or not, for an Owner or team.manage. Answers { identities }. */
export async function GET(request: Request) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const memberId = new URL(request.url).searchParams.get('member_id');
    if (!memberId) throw new ApiError(422, 'VALIDATION_ERROR', 'member_id is required', { reason: 'member_id_required' });
    return { identities: await memberAllIdentities(service, caller, memberId) };
  });
}

/**
 * Links accounts to members in bulk (an Owner or team.manage), up to 500 at
 * once: verified (method admin) unless verified is false. One already linked
 * to someone else refuses the whole call (409 identity_linked_elsewhere).
 * Answers { linked, created, updated }.
 */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, caller }) => {
    const body = await readWorkspaceBody(request, adminLinkSchema);
    return adminLinkIdentities(service, caller, body);
  });
}
