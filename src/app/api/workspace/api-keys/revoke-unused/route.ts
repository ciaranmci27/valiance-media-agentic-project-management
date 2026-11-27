import { revokeUnusedKeys, revokeUnusedSchema } from '@/lib/api/key-hygiene';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * Revoke unused keys (Settings > Developers): { dry_run: true } (the
 * default) lists the keys you may manage that were never used or not used
 * for 90 days; { dry_run: false, key_ids } revokes exactly those from the
 * preview that are still unused (lib/api/key-hygiene.ts).
 */
export async function POST(request: Request) {
  return workspaceRoute(request, async ({ service, memberId, access }) => {
    const body = await readWorkspaceBody(request, revokeUnusedSchema);
    return revokeUnusedKeys(service, { memberId, access, apiKeyId: null, endpoint: '/api/workspace/api-keys/revoke-unused', via: 'app' }, body);
  }, { noStore: true });
}
