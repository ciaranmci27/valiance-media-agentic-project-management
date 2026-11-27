import { NextRequest, NextResponse } from 'next/server';
import { createPmClient } from '@/lib/supabase/pm-client';
import { checkPortalPin, pinFailureResponse } from '@/lib/portal-pin';
import { enabledModuleSet } from '@/lib/modules/server';
import { portalFileLinks } from '@/lib/portal-file-links';

export const dynamic = 'force-dynamic';

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return createPmClient(url, key || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}

/**
 * Fresh links for the files an open portal page shows (its project files,
 * invoice PDFs and update attachments live in private buckets and their
 * links last an hour). The page asks before they run out, and when a picture
 * fails to load. Same checks as the portal itself (module, token, PIN), and
 * no analytics event: it is not a visit.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token: rawToken } = await params;
  const token = rawToken.toLowerCase();
  const supabase = getServiceClient();
  const headers = { 'Cache-Control': 'no-store' };

  const modules = await enabledModuleSet(supabase);
  if (!modules.has('portal')) return NextResponse.json({ error: 'Portal not found' }, { status: 404, headers });

  const { data: settings } = await supabase
    .from('portal_settings')
    .select('*, project:projects!inner(id)')
    .eq('token', token)
    .is('project.deleted_at', null)
    .maybeSingle();
  if (!settings || !settings.enabled) return NextResponse.json({ error: 'Portal not found' }, { status: 404, headers });

  const pinCheck = await checkPortalPin({ supabase, request, token, settings });
  if (!pinCheck.ok) return pinFailureResponse(pinCheck);

  return NextResponse.json(await portalFileLinks(supabase, settings, modules), { headers });
}
