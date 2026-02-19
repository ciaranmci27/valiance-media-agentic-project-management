import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import type { PortalData } from '@/lib/types';
import {
  demoPortalSettings, demoPortalFiles, demoProjects, demoTasks,
  demoLeads, demoLeadProposals, demoProjectContacts,
} from '@/lib/demo-data';

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    // Fallback to anon key for demo mode or when service key isn't set
    return createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  }
  return createClient(url, key);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  // Demo mode: return mock data for demo tokens
  const isDemo = process.env.NEXT_PUBLIC_DEMO_MODE === 'true' || request.nextUrl.searchParams.get('demo') === 'true';
  if (isDemo) {
    return handleDemoMode(token, request);
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
      // Fetch minimal branding for the PIN screen
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

  // Fetch project
  const { data: project } = await supabase
    .from('projects')
    .select('name, color, description')
    .eq('id', settings.project_id)
    .single();

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Fetch task counts for progress
  const { data: tasks } = await supabase
    .from('tasks')
    .select('status')
    .eq('project_id', settings.project_id);

  const totalTasks = tasks?.length || 0;
  const doneTasks = tasks?.filter((t: any) => t.status === 'done').length || 0;
  const percent = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  // Fetch proposals via project contacts → leads → lead_proposals
  let proposals: PortalData['proposals'] = [];
  if (settings.show_proposals) {
    // Get contacts linked to this project
    const { data: projectContacts } = await supabase
      .from('project_contacts')
      .select('contact_id')
      .eq('project_id', settings.project_id);

    if (projectContacts && projectContacts.length > 0) {
      const contactIds = projectContacts.map((pc: any) => pc.contact_id);

      // Find leads linked to those contacts
      const { data: leads } = await supabase
        .from('leads')
        .select('id')
        .in('contact_id', contactIds);

      if (leads && leads.length > 0) {
        const leadIds = leads.map((l: any) => l.id);

        const { data: leadProposals } = await supabase
          .from('lead_proposals')
          .select('id, title, description, estimated_value, status')
          .in('lead_id', leadIds)
          .order('created_at', { ascending: false });

        proposals = (leadProposals || []).map((p: any) => ({
          id: p.id,
          title: p.title,
          description: p.description,
          estimated_value: p.estimated_value,
          status: p.status,
        }));
      }
    }
  }

  // Fetch portal files
  let files: PortalData['files'] = [];
  if (settings.show_files) {
    const { data: portalFiles } = await supabase
      .from('portal_files')
      .select('id, name, file_url, file_size, mime_type')
      .eq('project_id', settings.project_id)
      .order('created_at', { ascending: false });

    files = (portalFiles || []).map((f: any) => ({
      id: f.id,
      name: f.name,
      file_url: f.file_url,
      file_size: f.file_size,
      mime_type: f.mime_type,
    }));
  }

  const portalData: PortalData = {
    project: {
      name: project.name,
      color: project.color,
      description: project.description,
    },
    settings: {
      welcome_message: settings.welcome_message,
      logo_url: settings.logo_url,
      accent_color: settings.accent_color,
      show_progress: settings.show_progress,
      show_proposals: settings.show_proposals,
      show_files: settings.show_files,
    },
    progress: {
      total_tasks: totalTasks,
      done_tasks: doneTasks,
      percent,
    },
    proposals,
    files,
  };

  return NextResponse.json(portalData);
}

function handleDemoMode(token: string, request: NextRequest) {
  // Look up portal settings by token from demo data
  const settings = demoPortalSettings.find(ps => ps.token === token);
  if (!settings || !settings.enabled) {
    return NextResponse.json({ error: 'Portal not found' }, { status: 404 });
  }

  const project = demoProjects.find(p => p.id === settings.project_id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

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
          project_name: project.name || '',
        },
      }, { status: 401 });
    }
  }

  // Build progress from demo tasks
  const tasks = demoTasks.filter(t => t.project_id === settings.project_id);
  const totalTasks = tasks.length;
  const doneTasks = tasks.filter(t => t.status === 'done').length;
  const percent = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  // Build proposals from demo data via project contacts → leads → lead proposals
  let proposals: PortalData['proposals'] = [];
  if (settings.show_proposals) {
    const projectContactIds = demoProjectContacts
      .filter(pc => pc.project_id === settings.project_id)
      .map(pc => pc.contact_id);

    const leadIds = demoLeads
      .filter(l => l.contact_id && projectContactIds.includes(l.contact_id))
      .map(l => l.id);

    proposals = demoLeadProposals
      .filter(p => leadIds.includes(p.lead_id))
      .map(p => ({
        id: p.id,
        title: p.title,
        description: p.description,
        estimated_value: p.estimated_value,
        status: p.status,
      }));
  }

  // Build files from demo data
  const files: PortalData['files'] = settings.show_files
    ? demoPortalFiles
        .filter(f => f.project_id === settings.project_id)
        .map(f => ({ id: f.id, name: f.name, file_url: f.file_url, file_size: f.file_size, mime_type: f.mime_type }))
    : [];

  const portalData: PortalData = {
    project: { name: project.name, color: project.color, description: project.description },
    settings: {
      welcome_message: settings.welcome_message,
      logo_url: settings.logo_url,
      accent_color: settings.accent_color,
      show_progress: settings.show_progress,
      show_proposals: settings.show_proposals,
      show_files: settings.show_files,
    },
    progress: { total_tasks: totalTasks, done_tasks: doneTasks, percent },
    proposals,
    files,
  };

  return NextResponse.json(portalData);
}
