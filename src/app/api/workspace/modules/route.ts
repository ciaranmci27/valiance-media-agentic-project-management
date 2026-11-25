import { insertAuditRows } from '@/lib/api/audit';
import { NextResponse, type NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { foreignOrigin, isDemoWorkspace, isSchemaMissing, migrationMissing, requireOwner } from '@/lib/api/owner-route';
import { afterResponse } from '@/lib/api/after-response';
import { MODULE_IDS, normalizeModules, type ModuleId } from '@/lib/modules/registry';
import { parseModuleList } from '@/lib/modules/server';

/**
 * Settings > Features: which parts of the app the workspace uses, and whether
 * the Owner finished first-run setup. Owner only, by role rather than by a
 * permission: a switch hides parts of the app from everyone. Every signed-in
 * member reads the switches through their access context; only this route
 * writes them, keeping dependencies whole and recording the change.
 */


interface WorkspaceModulesState {
  modules: ModuleId[];
  setupCompleted: boolean;
  /** When setup was finished or skipped, for the Dashboard's Getting started list. */
  setupCompletedAt: string | null;
}

type Loaded =
  | { state: WorkspaceModulesState; rows: Set<string>; settingsId: string | null; error: null }
  | { state: null; rows: null; settingsId: null; error: NextResponse };

async function loadState(service: SupabaseClient): Promise<Loaded> {
  const [modules, settings] = await Promise.all([
    service.from('workspace_modules').select('module_id, enabled'),
    service.from('business_settings').select('id, setup_completed_at').limit(1).maybeSingle(),
  ]);
  const failure = modules.error || settings.error;
  if (failure) {
    return {
      state: null, rows: null, settingsId: null,
      error: isSchemaMissing(failure) ? migrationMissing() : NextResponse.json({ error: failure.message }, { status: 500 }),
    };
  }
  const rows = modules.data || [];
  // A module with no row yet (added by a newer release before its seed ran) is on.
  const off = new Set(rows.filter((row) => row.enabled === false).map((row) => row.module_id as string));
  return {
    state: {
      modules: MODULE_IDS.filter((id) => !off.has(id)),
      setupCompleted: !!settings.data?.setup_completed_at,
      setupCompletedAt: (settings.data?.setup_completed_at as string | null | undefined) ?? null,
    },
    rows: new Set(rows.map((row) => row.module_id as string)),
    settingsId: (settings.data?.id as string | undefined) ?? null,
    error: null,
  };
}

export async function GET() {
  if (isDemoWorkspace()) return NextResponse.json({ error: 'The demo workspace has no database.' }, { status: 403 });
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const loaded = await loadState(auth.data.service);
  if (loaded.error) return loaded.error;
  return NextResponse.json({ data: loaded.state });
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
  // Dependencies kept whole: a module whose requirements are off stays off.
  const next = normalizeModules(parsed);

  const before = await loadState(service);
  if (before.error) return before.error;
  const wanted = new Set(next);
  const was = new Set(before.state.modules);

  // Every row ends in its new state. A row is written when it changes or is
  // missing, so updated_by names whoever last switched that module.
  const writes = MODULE_IDS
    .filter((id) => !before.rows.has(id) || was.has(id) !== wanted.has(id))
    .map((id) => ({ module_id: id, enabled: wanted.has(id), updated_by: memberId }));
  if (writes.length > 0) {
    const { error } = await service.from('workspace_modules').upsert(writes, { onConflict: 'module_id' });
    if (error) return isSchemaMissing(error) ? migrationMissing() : NextResponse.json({ error: error.message }, { status: 500 });
  }

  let setupCompleted = before.state.setupCompleted;
  let setupCompletedAt = before.state.setupCompletedAt;
  if (body.completeSetup && !setupCompleted) {
    const stamp = { setup_completed_at: new Date().toISOString() };
    const { error } = before.settingsId
      ? await service.from('business_settings').update(stamp).eq('id', before.settingsId)
      : await service.from('business_settings').insert(stamp);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    setupCompleted = true;
    setupCompletedAt = stamp.setup_completed_at;
  }

  const after: WorkspaceModulesState = { modules: next, setupCompleted, setupCompletedAt };
  // The app's own audit row (via 'app'), with the set as it was and as it is.
  afterResponse('workspace modules audit', async () => {
    const { error } = await insertAuditRows(service, {
      method: 'PUT',
      endpoint: '/api/workspace/modules',
      entity_type: 'workspace_modules',
      team_member_id: memberId,
      request_body: { modules: parsed, completeSetup: body.completeSetup ?? false },
      before_snapshot: before.state,
      after_snapshot: after,
      status_code: 200,
      via: 'app',
    });
    if (error) throw error;
  });

  return NextResponse.json({ data: after });
}
