import { NextResponse, type NextRequest } from 'next/server';
import { afterResponse } from '@/lib/api/after-response';
import { foreignOrigin, isDemoWorkspace, isSchemaMissing, migrationMissing, requireOwner } from '@/lib/api/owner-route';
import { DEFAULT_BRAND, resolveBrand, type BrandSettings } from '@/lib/brand';
import { expireBrand, readStoredBrand } from '@/lib/brand/server';
import { parseBrandInput } from '@/lib/brand/validate';

/**
 * Settings > Workspace > Brand: the name, colors and sidebar options (logos
 * upload on /api/workspace/brand/logo). Owner only. Everyone reads the brand
 * through the page render (getBrand); only this route and the logo route
 * write it, and each write expires the cached brand at once.
 */

function payload(settings: BrandSettings) {
  return { data: { settings, brand: resolveBrand(settings), defaults: DEFAULT_BRAND } };
}

export async function GET() {
  if (isDemoWorkspace()) return NextResponse.json({ error: 'The demo workspace has no database.' }, { status: 403 });
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  try {
    const stored = await readStoredBrand(auth.data.service);
    if (!stored.tableReady) return migrationMissing();
    return NextResponse.json(payload(stored.settings));
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
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
  const parsed = parseBrandInput(body);
  if (parsed.error !== null) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const input = parsed.data;

  let before;
  try {
    before = await readStoredBrand(service);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
  if (!before.tableReady) return migrationMissing();

  const { error } = await service.from('workspace_brand').upsert({
    id: true,
    name: input.name,
    tagline: input.tagline,
    description: input.description,
    brand_color: input.brandColor,
    brand_shades: input.brandShades,
    accent_color: input.accentColor,
    invert_logo_in_sidebar: input.invertLogoInSidebar,
    show_name_under_logo: input.showNameUnderLogo,
    // Written only when it changes, so an install that has not run this
    // release's migration yet can still save the rest of its brand.
    ...(input.sidebarProjects !== undefined && input.sidebarProjects !== before.settings.sidebarProjects
      ? { sidebar_projects: input.sidebarProjects } : {}),
    updated_by: memberId,
  }, { onConflict: 'id' });
  if (error) return isSchemaMissing(error) ? migrationMissing() : NextResponse.json({ error: error.message }, { status: 500 });

  expireBrand();
  const settings: BrandSettings = { ...before.settings, ...input };

  afterResponse('workspace brand audit', async () => {
    const { error: auditError } = await service.from('api_audit_log').insert({
      method: 'PUT',
      endpoint: '/api/workspace/brand',
      entity_type: 'workspace_brand',
      team_member_id: memberId,
      request_body: input,
      before_snapshot: before.settings,
      after_snapshot: settings,
      status_code: 200,
      via: 'app',
    });
    if (auditError) throw auditError;
  });

  return NextResponse.json(payload(settings));
}

/**
 * Sets how the sidebar lists projects, and nothing else: the setup wizard
 * picks it from the preset without sending the whole brand form.
 */
export async function PATCH(request: NextRequest) {
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
  const style = (body as { sidebarProjects?: unknown } | null)?.sidebarProjects;
  if (style !== 'list' && style !== 'menu') return NextResponse.json({ error: 'sidebarProjects must be list or menu' }, { status: 400 });

  let before;
  try {
    before = await readStoredBrand(service);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
  if (!before.tableReady) return migrationMissing();
  if (before.settings.sidebarProjects === style) return NextResponse.json(payload(before.settings));

  const { error } = await service.from('workspace_brand').upsert(
    { id: true, sidebar_projects: style, updated_by: memberId },
    { onConflict: 'id' },
  );
  if (error) return isSchemaMissing(error) ? migrationMissing() : NextResponse.json({ error: error.message }, { status: 500 });

  expireBrand();
  const settings: BrandSettings = { ...before.settings, sidebarProjects: style };
  afterResponse('workspace brand audit', async () => {
    const { error: auditError } = await service.from('api_audit_log').insert({
      method: 'PATCH',
      endpoint: '/api/workspace/brand',
      entity_type: 'workspace_brand',
      team_member_id: memberId,
      request_body: { sidebarProjects: style },
      before_snapshot: before.settings,
      after_snapshot: settings,
      status_code: 200,
      via: 'app',
    });
    if (auditError) throw auditError;
  });
  return NextResponse.json(payload(settings));
}
