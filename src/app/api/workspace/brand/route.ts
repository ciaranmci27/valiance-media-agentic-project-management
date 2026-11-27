import { NextResponse, type NextRequest } from 'next/server';
import { foreignOrigin, isDemoWorkspace, requireOwner } from '@/lib/api/owner-route';
import {
  auditSettingsInApp,
  readWorkspaceBrand,
  saveWorkspaceBrand,
  setSidebarProjects,
  settingsErrorResponse,
} from '@/lib/api/workspace-settings';

/**
 * Settings > Workspace > Brand: the name, colors and sidebar options (logos
 * upload on /api/workspace/brand/logo). Owner only. Everyone reads the brand
 * through the page render (getBrand); only this route, its API twin
 * (/api/v1/workspace/brand) and the logo route write it, and each write
 * expires the cached brand at once (lib/api/workspace-settings.ts).
 */

export async function GET() {
  if (isDemoWorkspace()) return NextResponse.json({ error: 'The demo workspace has no database.' }, { status: 403 });
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  try {
    return NextResponse.json({ data: await readWorkspaceBrand(auth.data.service) });
  } catch (error) {
    return settingsErrorResponse(error);
  }
}

async function save(request: NextRequest, write: typeof saveWorkspaceBrand) {
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
    const saved = await write(service, memberId, body);
    auditSettingsInApp(service, memberId, '/api/workspace/brand', saved.audit);
    return NextResponse.json({ data: saved.data });
  } catch (error) {
    return settingsErrorResponse(error);
  }
}

/** The whole brand form. */
export async function PUT(request: NextRequest) {
  return save(request, saveWorkspaceBrand);
}

/**
 * Sets how the sidebar shows projects (the Projects item's style and, when
 * sent, the active projects section), and nothing else: the setup wizard
 * picks them from the preset without sending the whole brand form.
 */
export async function PATCH(request: NextRequest) {
  return save(request, setSidebarProjects);
}
