import { NextResponse, type NextRequest } from 'next/server';
import { foreignOrigin, isDemoWorkspace, requireOwner } from '@/lib/api/owner-route';
import { auditSettingsInApp, readWorkspaceModules, saveWorkspaceModules, settingsErrorResponse } from '@/lib/api/workspace-settings';
import { MODULE_IDS } from '@/lib/modules/registry';
import { parseModuleList } from '@/lib/modules/server';

/**
 * Settings > Features: which parts of the app the workspace uses, and whether
 * the Owner finished first-run setup. Owner only, by role rather than by a
 * permission: a switch hides parts of the app from everyone. Every signed-in
 * member reads the switches through their access context; only this route
 * and its API twin (/api/v1/workspace/modules) write them, through one writer
 * (lib/api/workspace-settings.ts) that keeps dependencies whole and records
 * the change.
 */

export async function GET() {
  if (isDemoWorkspace()) return NextResponse.json({ error: 'The demo workspace has no database.' }, { status: 403 });
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  try {
    return NextResponse.json({ data: await readWorkspaceModules(auth.data.service) });
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

  let body: { modules?: unknown; completeSetup?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Send a JSON body' }, { status: 400 });
  }
  const parsed = parseModuleList(body?.modules);
  if (!parsed) return NextResponse.json({ error: `Modules must be a list of: ${MODULE_IDS.join(', ')}` }, { status: 400 });
  if (body.completeSetup !== undefined && typeof body.completeSetup !== 'boolean') {
    return NextResponse.json({ error: 'completeSetup must be true or false' }, { status: 400 });
  }

  try {
    const saved = await saveWorkspaceModules(service, memberId, { modules: parsed, completeSetup: body.completeSetup as boolean | undefined });
    // The app's own audit row (via 'app'), with the set as it was and as it is.
    auditSettingsInApp(service, memberId, '/api/workspace/modules', saved.audit);
    return NextResponse.json({ data: saved.data });
  } catch (error) {
    return settingsErrorResponse(error);
  }
}
