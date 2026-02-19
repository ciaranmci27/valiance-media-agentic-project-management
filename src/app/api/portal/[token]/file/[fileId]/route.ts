import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import { demoPortalSettings, demoPortalFiles, demoProjects } from '@/lib/demo-data';

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
  const { token, fileId } = await params;

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

  // Check PIN if required
  if (settings.pin) {
    const pin = request.nextUrl.searchParams.get('pin');
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
          accent_color: settings.accent_color || '#6366F1',
          project_name: proj?.name || '',
        },
      }, { status: 401 });
    }
  }

  // Fetch the file and verify it belongs to the portal's project
  const { data: file } = await supabase
    .from('portal_files')
    .select('id, name, file_url, file_size, mime_type')
    .eq('id', fileId)
    .eq('project_id', settings.project_id)
    .maybeSingle();

  if (!file) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  return NextResponse.json({ file_url: file.file_url, name: file.name, mime_type: file.mime_type });
}

function handleDemoMode(token: string, fileId: string, request: NextRequest) {
  const settings = demoPortalSettings.find(ps => ps.token === token);
  if (!settings || !settings.enabled) {
    return NextResponse.json({ error: 'Portal not found' }, { status: 404 });
  }

  const project = demoProjects.find(p => p.id === settings.project_id);

  // Check PIN
  if (settings.pin) {
    const pin = request.nextUrl.searchParams.get('pin');
    if (!pin || pin !== settings.pin) {
      return NextResponse.json({
        error: pin ? 'Invalid PIN' : 'PIN required',
        pin_required: true,
        branding: {
          logo_url: settings.logo_url || '',
          accent_color: settings.accent_color || '#6366F1',
          project_name: project?.name || '',
        },
      }, { status: 401 });
    }
  }

  // Find the file in demo data, scoped to this project
  const file = demoPortalFiles.find(f => f.id === fileId && f.project_id === settings.project_id);
  if (!file) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  return NextResponse.json({ file_url: file.file_url, name: file.name, mime_type: file.mime_type });
}
