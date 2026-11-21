import { NextResponse, type NextRequest } from 'next/server';
import { afterResponse } from '@/lib/api/after-response';
import { foreignOrigin, isDemoWorkspace, requireOwner } from '@/lib/api/owner-route';
import { encryptionStatus, reencryptAll } from '@/lib/crypto/reencrypt';

/**
 * Settings > Workspace > Encryption. GET: whether the app key is set, which
 * older keys the host still has, and how many saved values still use them.
 * POST: move them onto the app key. Owner only.
 */

export async function GET() {
  if (isDemoWorkspace()) return NextResponse.json({ error: 'The demo workspace has no database.' }, { status: 403 });
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  try {
    return NextResponse.json({ data: await encryptionStatus(auth.data.service) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (isDemoWorkspace()) return NextResponse.json({ error: 'The demo workspace has no database.' }, { status: 403 });
  if (foreignOrigin(request)) return NextResponse.json({ error: 'Cross-site request refused' }, { status: 403 });
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  try {
    const result = await reencryptAll(auth.data.service);
    afterResponse('workspace encryption audit', async () => {
      const { error } = await auth.data.service.from('api_audit_log').insert({
        method: 'POST', endpoint: '/api/workspace/encryption', entity_type: 'workspace_encryption', team_member_id: auth.data.memberId,
        request_body: {}, before_snapshot: null,
        after_snapshot: { moved: result.moved, failed: { smtp: result.failed.smtp.length, credentials: result.failed.credentials.length }, remaining: result.status.remaining },
        status_code: 200, via: 'app',
      });
      if (error) throw error;
    });
    return NextResponse.json({ data: result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 409 });
  }
}
