import { NextResponse, type NextRequest } from 'next/server';
import { afterResponse } from '@/lib/api/after-response';
import { foreignOrigin, isDemoWorkspace, isSchemaMissing, migrationMissing, requireOwner } from '@/lib/api/owner-route';
import { moneyFormatPattern } from '@/lib/format';
import { DEFAULT_REGION, parseRegionInput, sameRegion, type Region } from '@/lib/region';
import { expireRegion, readStoredRegion } from '@/lib/region/server';

/**
 * Settings > Workspace > Region: the currency, locale and week start. Owner
 * only. Everyone reads the region through the page render (getRegion); only
 * this route writes it, and each write expires the cached region at once.
 */

function payload(region: Region) {
  return { data: { region, defaults: DEFAULT_REGION } };
}

export async function GET() {
  if (isDemoWorkspace()) return NextResponse.json({ error: 'The demo workspace has no database.' }, { status: 403 });
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  try {
    const stored = await readStoredRegion(auth.data.service);
    if (!stored.tableReady) return migrationMissing();
    return NextResponse.json(payload(stored.region));
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
  const parsed = parseRegionInput(body);
  if (parsed.error !== null) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const region = parsed.data;

  let before;
  try {
    before = await readStoredRegion(service);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
  if (!before.tableReady) return migrationMissing();
  if (sameRegion(before.region, region)) return NextResponse.json(payload(region));

  const { error } = await service.from('workspace_region').upsert({
    id: true,
    currency: region.currency,
    locale: region.locale,
    week_start: region.weekStart,
    // How the database writes amounts in activity lines, Trash and billing notices.
    money_format: moneyFormatPattern(region.currency, region.locale),
    updated_by: memberId,
  }, { onConflict: 'id' });
  if (error) return isSchemaMissing(error) ? migrationMissing() : NextResponse.json({ error: error.message }, { status: 500 });

  expireRegion();

  afterResponse('workspace region audit', async () => {
    const { error: auditError } = await service.from('api_audit_log').insert({
      method: 'PUT',
      endpoint: '/api/workspace/region',
      entity_type: 'workspace_region',
      team_member_id: memberId,
      request_body: region,
      before_snapshot: before.region,
      after_snapshot: region,
      status_code: 200,
      via: 'app',
    });
    if (auditError) throw auditError;
  });

  return NextResponse.json(payload(region));
}
