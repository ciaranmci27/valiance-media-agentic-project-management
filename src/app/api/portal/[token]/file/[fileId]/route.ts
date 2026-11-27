import { createClient } from '@supabase/supabase-js';
import { createPmClient } from '@/lib/supabase/pm-client';
import { NextRequest, NextResponse } from 'next/server';
import { demoPortalSettings, demoEntityFiles, demoProjects } from '@/lib/demo-data';
import type { Brand } from '@/lib/brand';
import { getBrand } from '@/lib/brand/server';
import { recordPortalEvent, getOrCreateSessionId } from '@/lib/portal-analytics';
import { checkPortalPin, pinFailureResponse } from '@/lib/portal-pin';
import { enabledModuleSet } from '@/lib/modules/server';
import { signStoredFileUrl } from '@/lib/storage/sign-stored-file';
import { portalShownMime } from '@/lib/portal-uploads';

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    return createPmClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  }
  return createPmClient(url, key);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; fileId: string }> }
) {
  const { token: rawToken, fileId } = await params;
  const token = rawToken.toLowerCase();
  const brand = await getBrand();

  // Demo mode
  const isDemo = process.env.NEXT_PUBLIC_DEMO_MODE === 'true' || request.nextUrl.searchParams.get('demo') === 'true';
  if (isDemo) {
    return handleDemoMode(token, fileId, request, brand);
  }

  const supabase = getServiceClient();

  // With the Client portal switched off every link answers like an unknown one.
  const modules = await enabledModuleSet(supabase);
  if (!modules.has('portal')) {
    return NextResponse.json({ error: 'Portal not found' }, { status: 404 });
  }

  // Find portal settings by token
  const { data: settings, error: settingsError } = await supabase
    .from('portal_settings')
    .select('*, project:projects!inner(id)')
    .eq('token', token)
    // A project in Trash has no portal; it comes back when the project is restored.
    .is('project.deleted_at', null)
    .maybeSingle();

  if (settingsError || !settings) {
    return NextResponse.json({ error: 'Portal not found' }, { status: 404 });
  }

  if (!settings.enabled) {
    return NextResponse.json({ error: 'Portal is disabled' }, { status: 404 });
  }

  const pinCheck = await checkPortalPin({ supabase, request, token, settings });
  if (!pinCheck.ok) {
    const { data: proj } = await supabase
      .from('projects')
      .select('name')
      .eq('id', settings.project_id)
      .is('deleted_at', null)
      .single();

    return pinFailureResponse(pinCheck, {
      branding: {
        logo_url: settings.logo_url || '',
        accent_color: settings.accent_color || brand.colors.brand[500],
        project_name: proj?.name || '',
      },
    });
  }

  // Fetch the file: must be an external entity file for this project
  const { data: file } = await supabase
    .from('entity_files')
    .select('id, name, file_url, file_size, mime_type, uploaded_by')
    .eq('id', fileId)
    .eq('entity_type', 'project')
    .eq('entity_id', settings.project_id)
    .eq('visibility', 'external')
    .is('deleted_at', null)
    .maybeSingle();

  if (!file) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  await recordPortalEvent({
    supabase,
    request,
    token,
    portalSettingsId: settings.id,
    projectId: settings.project_id,
    sessionId: getOrCreateSessionId(request),
    eventType: 'file_download',
    metadata: { file_id: file.id },
  });

  // Portal files live in a private bucket: the visitor gets a link that lasts an hour.
  const fileUrl = (await signStoredFileUrl(supabase, file.file_url, 3600)) ?? file.file_url;
  // A web page opens as a page only when the team added it; a visitor's never does (portal-uploads.ts).
  return NextResponse.json({ file_url: fileUrl, name: file.name, mime_type: portalShownMime(file) });
}

function handleDemoMode(token: string, fileId: string, request: NextRequest, brand: Brand) {
  const settings = demoPortalSettings.find(ps => ps.token === token);
  if (!settings || !settings.enabled) {
    return NextResponse.json({ error: 'Portal not found' }, { status: 404 });
  }

  const project = demoProjects.find(p => p.id === settings.project_id);

  // Check PIN (prefer header, fall back to query param)
  if (settings.pin) {
    const pin = request.headers.get('x-portal-pin');
    if (!pin || pin !== settings.pin) {
      return NextResponse.json({
        error: pin ? 'Invalid PIN' : 'PIN required',
        pin_required: true,
        branding: {
          logo_url: settings.logo_url || '',
          accent_color: settings.accent_color || brand.colors.brand[500],
          project_name: project?.name || '',
        },
      }, { status: 401 });
    }
  }

  // Find the file in demo entity files: must be external + project type + matching project
  const file = demoEntityFiles.find(
    f => f.id === fileId && f.entity_type === 'project' && f.entity_id === settings.project_id && f.visibility === 'external'
  );
  if (!file) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  return NextResponse.json({ file_url: file.file_url, name: file.name, mime_type: file.mime_type });
}
