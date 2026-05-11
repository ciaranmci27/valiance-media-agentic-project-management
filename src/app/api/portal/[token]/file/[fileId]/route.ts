import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { demoPortalSettings, demoEntityFiles, demoProjects } from '@/lib/demo-data';
import { siteConfig } from '@/site-config';
import { recordPortalEvent, getOrCreateSessionId } from '@/lib/portal-analytics';

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    return createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  }
  return createClient(url, key);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; fileId: string }> }
) {
  const { token: rawToken, fileId } = await params;
  const token = rawToken.toLowerCase();

  // Demo mode
  const isDemo = process.env.NEXT_PUBLIC_DEMO_MODE === 'true' || request.nextUrl.searchParams.get('demo') === 'true';
  if (isDemo) {
    return handleDemoMode(token, fileId, request);
  }

  const supabase = getServiceClient();

  // Find portal settings by token
  const { data: settings, error: settingsError } = await supabase
    .from('portal_settings')
    .select('*')
    .eq('token', token)
    .maybeSingle();

  if (settingsError || !settings) {
    return NextResponse.json({ error: 'Portal not found' }, { status: 404 });
  }

  if (!settings.enabled) {
    return NextResponse.json({ error: 'Portal is disabled' }, { status: 404 });
  }

  // Check PIN if required (prefer header, fall back to query param)
  if (settings.pin) {
    const pin = request.headers.get('x-portal-pin');
    if (!pin || pin !== settings.pin) {
      const { data: proj } = await supabase
        .from('projects')
        .select('name')
        .eq('id', settings.project_id)
        .single();

      return NextResponse.json({
        error: pin ? 'Invalid PIN' : 'PIN required',
        pin_required: true,
        branding: {
          logo_url: settings.logo_url || '',
          accent_color: settings.accent_color || siteConfig.colors.brand[500],
          project_name: proj?.name || '',
        },
      }, { status: 401 });
    }
  }

  // Fetch the file: must be an external entity file for this project
  const { data: file } = await supabase
    .from('entity_files')
    .select('id, name, file_url, file_size, mime_type')
    .eq('id', fileId)
    .eq('entity_type', 'project')
    .eq('entity_id', settings.project_id)
    .eq('visibility', 'external')
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

  return NextResponse.json({ file_url: file.file_url, name: file.name, mime_type: file.mime_type });
}

function handleDemoMode(token: string, fileId: string, request: NextRequest) {
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
          accent_color: settings.accent_color || siteConfig.colors.brand[500],
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
