import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import type { PortalData } from '@/lib/types';
import {
  demoPortalSettings, demoPortalFiles, demoPortalUpdates, demoPortalUpdateAttachments,
  demoProjects, demoTasks,
  demoLeads, demoLeadProposals, demoProjectContacts, demoTimeEntries,
  demoTeam, demoProjectInvoices,
} from '@/lib/demo-data';
import { siteConfig } from '@/site-config';

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
          accent_color: settings.accent_color || siteConfig.colors.brand[500],
          project_name: proj?.name || '',
          welcome_message: settings.welcome_message || '',
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

  // Fetch time entries with member names (exclude running timers)
  let hours: PortalData['hours'] = { total_hours: 0, entries: [] };
  if (settings.show_hours) {
    const { data: timeEntries } = await supabase
      .from('project_time_entries')
      .select('id, start_time, end_time, description, member_id')
      .eq('project_id', settings.project_id)
      .not('end_time', 'is', null)
      .order('start_time', { ascending: false });

    if (timeEntries && timeEntries.length > 0) {
      const memberIds = [...new Set(timeEntries.map((te: any) => te.member_id))];
      const { data: members } = await supabase
        .from('team_members')
        .select('id, name')
        .in('id', memberIds);

      const memberMap = new Map((members || []).map((m: any) => [m.id, m.name]));

      const computeHours = (start: string, end: string) =>
        (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000;

      hours = {
        total_hours: timeEntries.reduce((sum: number, te: any) => sum + computeHours(te.start_time, te.end_time), 0),
        entries: timeEntries.map((te: any) => ({
          id: te.id,
          start_time: te.start_time,
          end_time: te.end_time,
          hours: computeHours(te.start_time, te.end_time),
          description: te.description,
          member_name: memberMap.get(te.member_id) || 'Unknown',
        })),
      };
    }
  }

  // Fetch client-submitted credentials
  let credentials_submitted: PortalData['credentials_submitted'] = [];
  if (settings.show_credentials) {
    const { data: creds } = await supabase
      .from('project_credentials')
      .select('id, label, category, created_at, updated_at')
      .eq('project_id', settings.project_id)
      .eq('submitted_by_client', true)
      .order('created_at', { ascending: false });
    credentials_submitted = (creds || []).map((c: any) => ({
      id: c.id,
      label: c.label,
      category: c.category,
      created_at: c.created_at,
      updated_at: c.updated_at,
    }));
  }
  const credentials_submitted_count = credentials_submitted.length;

  // Fetch invoices
  let invoices: PortalData['invoices'] = [];
  if (settings.show_invoices) {
    const { data: invoiceData } = await supabase
      .from('project_invoices')
      .select('id, invoice_number, amount, status, date, due_date, paid_date, description, file_url, file_name, file_size, mime_type')
      .eq('project_id', settings.project_id)
      .neq('status', 'draft')
      .order('date', { ascending: false });
    invoices = invoiceData || [];
  }

  // Fetch portal updates with author names and attachments
  let updates: PortalData['updates'] = [];
  if (settings.show_updates) {
    const { data: portalUpdates } = await supabase
      .from('portal_updates')
      .select('id, title, content, update_type, author_id, pinned, created_at')
      .eq('project_id', settings.project_id)
      .order('created_at', { ascending: false });

    if (portalUpdates && portalUpdates.length > 0) {
      const authorIds = [...new Set(portalUpdates.map((u: any) => u.author_id).filter(Boolean))];
      const { data: authors } = authorIds.length > 0
        ? await supabase.from('team_members').select('id, name').in('id', authorIds)
        : { data: [] };

      const authorMap = new Map((authors || []).map((a: any) => [a.id, a.name]));

      // Fetch attachments for all updates
      const updateIds = portalUpdates.map((u: any) => u.id);
      const { data: allAttachments } = await supabase
        .from('portal_update_attachments')
        .select('id, update_id, name, file_url, file_size, mime_type')
        .in('update_id', updateIds)
        .order('created_at', { ascending: true });

      const attachmentMap = new Map<string, typeof allAttachments>();
      for (const att of allAttachments || []) {
        const list = attachmentMap.get(att.update_id) || [];
        list.push(att);
        attachmentMap.set(att.update_id, list);
      }

      updates = portalUpdates.map((u: any) => ({
        id: u.id,
        title: u.title,
        content: u.content,
        update_type: u.update_type,
        author_name: authorMap.get(u.author_id) || 'Team',
        pinned: u.pinned,
        created_at: u.created_at,
        attachments: (attachmentMap.get(u.id) || []).map((a: any) => ({
          id: a.id,
          name: a.name,
          file_url: a.file_url,
          file_size: a.file_size,
          mime_type: a.mime_type,
        })),
      }));
    }
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
      show_hours: settings.show_hours,
      show_updates: settings.show_updates ?? true,
      show_credentials: settings.show_credentials ?? false,
      show_invoices: settings.show_invoices ?? false,
    },
    progress: {
      total_tasks: totalTasks,
      done_tasks: doneTasks,
      percent,
    },
    proposals,
    files,
    hours,
    updates,
    credentials_submitted_count,
    credentials_submitted,
    invoices,
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
          accent_color: settings.accent_color || siteConfig.colors.brand[500],
          project_name: project.name || '',
          welcome_message: settings.welcome_message || '',
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

  // Build hours from demo data (exclude running timers)
  let hours: PortalData['hours'] = { total_hours: 0, entries: [] };
  if (settings.show_hours) {
    const projectEntries = demoTimeEntries.filter(te => te.project_id === settings.project_id && te.end_time !== null);
    const computeHours = (start: string, end: string) =>
      (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000;
    hours = {
      total_hours: projectEntries.reduce((sum, te) => sum + computeHours(te.start_time, te.end_time!), 0),
      entries: projectEntries.map(te => {
        const member = demoTeam.find(m => m.id === te.member_id);
        return {
          id: te.id,
          start_time: te.start_time,
          end_time: te.end_time!,
          hours: computeHours(te.start_time, te.end_time!),
          description: te.description,
          member_name: member?.name || 'Unknown',
        };
      }),
    };
  }

  // Build updates from demo data
  let updates: PortalData['updates'] = [];
  if (settings.show_updates !== false) {
    updates = demoPortalUpdates
      .filter(u => u.project_id === settings.project_id)
      .map(u => {
        const author = demoTeam.find(m => m.id === u.author_id);
        const attachments = demoPortalUpdateAttachments
          .filter(a => a.update_id === u.id)
          .map(a => ({ id: a.id, name: a.name, file_url: a.file_url, file_size: a.file_size, mime_type: a.mime_type }));
        return {
          id: u.id,
          title: u.title,
          content: u.content,
          update_type: u.update_type,
          author_name: author?.name || 'Team',
          pinned: u.pinned,
          created_at: u.created_at,
          attachments,
        };
      });
  }

  // Build invoices from demo data (exclude drafts)
  const invoices: PortalData['invoices'] = settings.show_invoices
    ? demoProjectInvoices
        .filter(i => i.project_id === settings.project_id && i.status !== 'draft')
        .map(i => ({ id: i.id, invoice_number: i.invoice_number, amount: i.amount, status: i.status, date: i.date, due_date: i.due_date, paid_date: i.paid_date, description: i.description, file_url: i.file_url, file_name: i.file_name, file_size: i.file_size, mime_type: i.mime_type }))
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
      show_hours: settings.show_hours,
      show_updates: settings.show_updates ?? true,
      show_credentials: settings.show_credentials ?? false,
      show_invoices: settings.show_invoices ?? false,
    },
    progress: { total_tasks: totalTasks, done_tasks: doneTasks, percent },
    proposals,
    files,
    hours,
    updates,
    credentials_submitted_count: 0,
    credentials_submitted: [],
    invoices,
  };

  return NextResponse.json(portalData);
}
