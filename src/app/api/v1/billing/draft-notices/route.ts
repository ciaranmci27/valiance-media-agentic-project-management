import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { accessAllowsProject } from '@/lib/api/access';
import { getSiteUrl } from '@/lib/email/templates/shared';
import { getRegion } from '@/lib/region/server';

export const dynamic = 'force-dynamic';


/**
 * Invoice drafts made by the retainer or billing jobs that the PM agent has
 * not passed on yet, oldest first, in projects the key can open. For the
 * agent's "invoice drafted" message to the owner: read only, nothing here
 * sends an invoice. A draft already sent or deleted is not listed.
 */
export const GET = withApi(async ({ supabase, access }) => {
  const { data, error } = await supabase
    .from('billing_draft_notices')
    .select('invoice_id, project_id, summary, created_at, project_invoices(*)')
    .is('relayed_at', null)
    // A draft in Trash comes back without its invoice and is left out below.
    .is('project_invoices.deleted_at', null)
    .order('created_at');
  if (error) throw error;
  type Row = {
    invoice_id: string; project_id: string; summary: string; created_at: string;
    project_invoices: { invoice_number: string; amount: number | string; currency: string | null; status: string; date: string; due_date: string | null } | null;
  };
  const rows = ((data ?? []) as unknown as Row[])
    .filter((row) => row.project_invoices?.status === 'draft' && accessAllowsProject(access, row.project_id, 'api'));
  const projectIds = [...new Set(rows.map((row) => row.project_id))];
  const { data: projects, error: projectsError } = projectIds.length
    ? await supabase.from('projects').select('id, name').in('id', projectIds).is('deleted_at', null)
    : { data: [], error: null };
  if (projectsError) throw projectsError;
  const names = new Map((projects ?? []).map((project) => [project.id as string, project.name as string]));
  const { currency: workspaceCurrency } = await getRegion();
  // Drafts in a project in Trash went to Trash with it.
  return success(rows.filter((row) => names.has(row.project_id)).map((row) => ({
    invoice_id: row.invoice_id,
    invoice_number: row.project_invoices?.invoice_number ?? null,
    project_id: row.project_id,
    project_name: names.get(row.project_id) ?? null,
    amount: Number(row.project_invoices?.amount ?? 0),
    currency: row.project_invoices?.currency || workspaceCurrency,
    date: row.project_invoices?.date ?? null,
    due_date: row.project_invoices?.due_date ?? null,
    summary: row.summary,
    link: `${getSiteUrl().replace(/\/$/, '')}/projects/${row.project_id}?tab=invoices`,
    drafted_at: row.created_at,
  })));
}, { permission: 'invoices.read' });
