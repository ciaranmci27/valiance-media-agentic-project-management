import { createClient } from '@supabase/supabase-js';
import { NextRequest, NextResponse } from 'next/server';
import type { PortalData, PortalSectionKey } from '@/lib/types';
import { DEFAULT_SECTION_ORDER } from '@/lib/types';
import {
  demoPortalSettings, demoPortalUpdates, demoPortalUpdateAttachments,
  demoProjects, demoEntityFiles,
  demoTimeEntries,
  demoTeam, demoProjectInvoices,
} from '@/lib/demo-data';
import { siteConfig } from '@/site-config';

function computeTimelineProgress(
  startDate: string | null,
  dueDate: string | null,
  status: string,
): { percent: number; days_remaining: number | null; is_overdue: boolean } | null {
  if (status === 'completed') return { percent: 100, days_remaining: 0, is_overdue: false };
  if (!startDate || !dueDate) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  const total = due.getTime() - start.getTime();
  const elapsed = now.getTime() - start.getTime();
  if (total <= 0) return { percent: 100, days_remaining: 0, is_overdue: false };
  const percent = Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));
  const daysRemaining = Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  return { percent, days_remaining: daysRemaining, is_overdue: daysRemaining < 0 };
}

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
  const { token: rawToken } = await params;
  const token = rawToken.toLowerCase();

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

  // Check PIN if required (prefer header, fall back to query param)
  if (settings.pin) {
    const pin = request.headers.get('x-portal-pin');
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
    .select('name, color, description, start_date, due_date, status, hourly_tracking, hourly_rate')
    .eq('id', settings.project_id)
    .single();

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Compute timeline-based progress
  const timelineProgress = computeTimelineProgress(project.start_date, project.due_date, project.status);

  // Fetch external entity files for this project
  let files: PortalData['files'] = [];
  if (settings.show_files) {
    const { data: entityFiles } = await supabase
      .from('entity_files')
      .select('id, name, file_url, file_size, mime_type')
      .eq('entity_type', 'project')
      .eq('entity_id', settings.project_id)
      .eq('visibility', 'external')
      .order('created_at', { ascending: false });

    files = (entityFiles || []).map((f: any) => ({
      id: f.id,
      name: f.name,
      file_url: f.file_url,
      file_size: f.file_size,
      mime_type: f.mime_type,
    }));
  }

  // Fetch time entries with member names (exclude running timers)
  // Always fetch when show_hours OR (show_invoices + hourly_tracking) for billing calculations
  const needsHours = settings.show_hours || (settings.show_invoices && project.hourly_tracking);
  let hours: PortalData['hours'] = { total_hours: 0, entries: [] };
  if (needsHours) {
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
        entries: settings.show_hours ? timeEntries.map((te: any) => ({
          id: te.id,
          start_time: te.start_time,
          end_time: te.end_time,
          hours: computeHours(te.start_time, te.end_time),
          description: te.description,
          member_name: memberMap.get(te.member_id) || 'Unknown',
        })) : [],
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
      .select('id, invoice_number, amount, status, invoice_type, date, due_date, paid_date, description, file_url, file_name, file_size, mime_type')
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
      start_date: project.start_date,
      due_date: project.due_date,
      status: project.status,
    },
    settings: {
      welcome_message: settings.welcome_message,
      logo_url: settings.logo_url,
      accent_color: settings.accent_color,
      show_progress: settings.show_progress,
      show_files: settings.show_files,
      show_hours: settings.show_hours,
      show_updates: settings.show_updates ?? true,
      show_credentials: settings.show_credentials ?? false,
      show_invoices: settings.show_invoices ?? false,
      section_order: (settings.section_order as PortalSectionKey[] | null) ?? [...DEFAULT_SECTION_ORDER],
    },
    progress: timelineProgress ?? { percent: 0, days_remaining: null, is_overdue: false },
    files,
    hours,
    updates,
    billing: project.hourly_tracking ? {
      hourly_tracking: true,
      hourly_rate: project.hourly_rate ?? 0,
      total_hours: hours.total_hours,
      billable_total: (project.hourly_rate ?? 0) * hours.total_hours,
    } : null,
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
          project_name: project.name || '',
          welcome_message: settings.welcome_message || '',
        },
      }, { status: 401 });
    }
  }

  // Compute timeline-based progress from demo project dates
  const demoProgress = computeTimelineProgress(project.start_date, project.due_date, project.status);

  // Build files from external entity files for this project
  const files: PortalData['files'] = settings.show_files
    ? demoEntityFiles
        .filter(f => f.entity_type === 'project' && f.entity_id === settings.project_id && f.visibility === 'external')
        .map(f => ({ id: f.id, name: f.name, file_url: f.file_url, file_size: f.file_size, mime_type: f.mime_type }))
    : [];

  // Build hours from demo data (exclude running timers)
  // Always compute when show_hours OR (show_invoices + hourly_tracking) for billing calculations
  const demoNeedsHours = settings.show_hours || (settings.show_invoices && project.hourly_tracking);
  let hours: PortalData['hours'] = { total_hours: 0, entries: [] };
  if (demoNeedsHours) {
    const projectEntries = demoTimeEntries.filter(te => te.project_id === settings.project_id && te.end_time !== null);
    const computeHours = (start: string, end: string) =>
      (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000;
    hours = {
      total_hours: projectEntries.reduce((sum, te) => sum + computeHours(te.start_time, te.end_time!), 0),
      entries: settings.show_hours ? projectEntries.map(te => {
        const member = demoTeam.find(m => m.id === te.member_id);
        return {
          id: te.id,
          start_time: te.start_time,
          end_time: te.end_time!,
          hours: computeHours(te.start_time, te.end_time!),
          description: te.description,
          member_name: member?.name || 'Unknown',
        };
      }) : [],
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
        .map(i => ({ id: i.id, invoice_number: i.invoice_number, amount: i.amount, status: i.status, invoice_type: i.invoice_type, date: i.date, due_date: i.due_date, paid_date: i.paid_date, description: i.description, file_url: i.file_url, file_name: i.file_name, file_size: i.file_size, mime_type: i.mime_type }))
    : [];

  const portalData: PortalData = {
    project: {
      name: project.name,
      color: project.color,
      description: project.description,
      start_date: project.start_date,
      due_date: project.due_date,
      status: project.status,
    },
    settings: {
      welcome_message: settings.welcome_message,
      logo_url: settings.logo_url,
      accent_color: settings.accent_color,
      show_progress: settings.show_progress,
      show_files: settings.show_files,
      show_hours: settings.show_hours,
      show_updates: settings.show_updates ?? true,
      show_credentials: settings.show_credentials ?? false,
      show_invoices: settings.show_invoices ?? false,
      section_order: settings.section_order ?? [...DEFAULT_SECTION_ORDER],
    },
    progress: demoProgress ?? { percent: 0, days_remaining: null, is_overdue: false },
    files,
    hours,
    updates,
    billing: project.hourly_tracking ? {
      hourly_tracking: true,
      hourly_rate: project.hourly_rate ?? 0,
      total_hours: hours.total_hours,
      billable_total: (project.hourly_rate ?? 0) * hours.total_hours,
    } : null,
    credentials_submitted_count: 0,
    credentials_submitted: [],
    invoices,
  };

  return NextResponse.json(portalData);
}
