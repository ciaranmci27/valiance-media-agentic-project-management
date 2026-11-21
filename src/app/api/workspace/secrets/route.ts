import { NextResponse, type NextRequest } from 'next/server';
import { afterResponse } from '@/lib/api/after-response';
import { foreignOrigin, isDemoWorkspace, requireOwner } from '@/lib/api/owner-route';
import { appKeyState } from '@/lib/crypto/app-key';
import { clearSecret, SECRET_NAMES, SecretError, secretStatuses, writeSecret, type SecretName } from '@/lib/secrets/store';

/**
 * Integration secrets set in the app (Settings > Email > Receiving, Settings
 * > Updates). Owner only. Answers where each one comes from (the app, the
 * host, or nowhere) and when it was saved, never a value. POST saves one,
 * DELETE removes one (the host's variable, if any, answers again).
 */

const isName = (value: unknown): value is SecretName => typeof value === 'string' && (SECRET_NAMES as readonly string[]).includes(value);

async function state(service: Parameters<typeof secretStatuses>[0]) {
  return { appKey: appKeyState(), secrets: await secretStatuses(service) };
}

function audit(service: Parameters<typeof secretStatuses>[0], memberId: string, method: 'POST' | 'DELETE', name: SecretName) {
  afterResponse('workspace secrets audit', async () => {
    const { error } = await service.from('api_audit_log').insert({
      method, endpoint: '/api/workspace/secrets', entity_type: 'workspace_secrets', team_member_id: memberId,
      // The name only: a secret's value never reaches the audit log.
      request_body: { name }, before_snapshot: null, after_snapshot: null, status_code: 200, via: 'app',
    });
    if (error) throw error;
  });
}

export async function GET() {
  if (isDemoWorkspace()) return NextResponse.json({ error: 'The demo workspace has no database.' }, { status: 403 });
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  try {
    return NextResponse.json({ data: await state(auth.data.service) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

async function change(request: NextRequest, method: 'POST' | 'DELETE') {
  if (isDemoWorkspace()) return NextResponse.json({ error: 'The demo workspace has no database.' }, { status: 403 });
  if (foreignOrigin(request)) return NextResponse.json({ error: 'Cross-site request refused' }, { status: 403 });
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => null) as { name?: unknown; value?: unknown } | null;
  if (!isName(body?.name)) return NextResponse.json({ error: 'Unknown setting' }, { status: 400 });
  try {
    if (method === 'POST') {
      if (typeof body?.value !== 'string') return NextResponse.json({ error: 'Enter a value.' }, { status: 422 });
      await writeSecret(auth.data.service, body.name, body.value, auth.data.memberId);
    } else {
      await clearSecret(auth.data.service, body.name);
    }
    audit(auth.data.service, auth.data.memberId, method, body.name);
    return NextResponse.json({ data: await state(auth.data.service) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const status = error instanceof SecretError ? error.status : 500;
    return NextResponse.json({ error: (error as Error).message }, { status });
  }
}

export async function POST(request: NextRequest) {
  return change(request, 'POST');
}

export async function DELETE(request: NextRequest) {
  return change(request, 'DELETE');
}
