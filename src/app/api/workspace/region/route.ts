import { NextResponse, type NextRequest } from 'next/server';
import { foreignOrigin, isDemoWorkspace, requireOwner } from '@/lib/api/owner-route';
import { auditSettingsInApp, readWorkspaceRegion, saveWorkspaceRegion, settingsErrorResponse } from '@/lib/api/workspace-settings';

/**
 * Settings > Workspace > Region: the currency, locale and week start. Owner
 * only. Everyone reads the region through the page render (getRegion); only
 * this route and its API twin (/api/v1/workspace/region) write it, through
 * one writer (lib/api/workspace-settings.ts) that expires the cached region
 * at once.
 */

export async function GET() {
  if (isDemoWorkspace()) return NextResponse.json({ error: 'The demo workspace has no database.' }, { status: 403 });
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  try {
    return NextResponse.json({ data: await readWorkspaceRegion(auth.data.service) });
  } catch (error) {
    return settingsErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  if (isDemoWorkspace()) return NextResponse.json({ error: 'The demo workspace has no database. Changes last until you reload.' }, { status: 403 });
  if (foreignOrigin(request)) return NextResponse.json({ error: 'Cross-site request refused' }, { status: 403 });
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { memberId, service } = auth.data;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Send a JSON body' }, { status: 400 });
  }
  try {
    const saved = await saveWorkspaceRegion(service, memberId, body);
    auditSettingsInApp(service, memberId, '/api/workspace/region', saved.audit);
    return NextResponse.json({ data: saved.data });
  } catch (error) {
    return settingsErrorResponse(error);
  }
}
