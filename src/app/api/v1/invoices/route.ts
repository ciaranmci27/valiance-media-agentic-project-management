import { withApi } from '@/lib/api/middleware';
import { paginated } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { parsePagination } from '@/lib/api/pagination';
import { accessAllows } from '@/lib/api/access';
import { invoiceTotals, normalizedInvoiceLines, outstandingOf, serializePayment } from '@/lib/api/invoice-payments';
import { INVOICE_STATUSES, type ProjectInvoice } from '@/lib/types';
import { postgrestList, trashedProjectIds } from '@/lib/supabase/trash';

export const dynamic = 'force-dynamic';

interface Row extends ProjectInvoice {
  invoice_payments: Record<string, unknown>[] | null;
  projects: { id: string; name: string; billing_email: string | null; tax_rate: number | string | null } | null;
}

/**
 * Every invoice the key can see, across projects, for an accounting tool:
 * normalized lines that sum to the amount, tax, the total owed, payments and
 * what is outstanding, the project, and the customer (the project's primary
 * client contact and billing email). Oldest first, so paging is stable.
 */
export const GET = withApi(async ({ supabase, searchParams, access }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const statuses = (searchParams.get('status') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (statuses.some((status) => !(INVOICE_STATUSES as readonly string[]).includes(status))) {
    throw badRequest(`status must be one or more of ${INVOICE_STATUSES.join(', ')}`);
  }
  const updatedSince = searchParams.get('updated_since');
  if (updatedSince && Number.isNaN(Date.parse(updatedSince))) throw badRequest('updated_since must be an ISO date-time');
  const projectId = searchParams.get('project_id');

  // Which projects: all with projects.read_all, else the member's own.
  const allProjects = accessAllows(access, 'projects.read_all', 'api');
  let projectIds: string[] | null = null;
  if (!allProjects) projectIds = accessAllows(access, 'projects.read', 'api') ? access.project_ids : [];
  if (projectId) projectIds = projectIds === null || projectIds.includes(projectId) ? [projectId] : [];
  if (projectIds && projectIds.length === 0) return paginated([], { page, limit, total: 0 });

  let query = supabase
    .from('project_invoices')
    .select('*, invoice_payments(*), projects(id, name, billing_email, tax_rate)', { count: 'exact' })
    .is('deleted_at', null)
    .is('invoice_payments.deleted_at', null);
  if (projectIds) query = query.in('project_id', projectIds);
  // Invoices of a project in Trash went to Trash with it.
  const trashed = await trashedProjectIds(supabase);
  if (trashed.length) query = query.not('project_id', 'in', postgrestList(trashed));
  if (statuses.length) query = query.in('status', statuses);
  if (updatedSince) query = query.gte('updated_at', new Date(updatedSince).toISOString());
  const { data, count, error } = await query
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  const rows = (data ?? []) as unknown as Row[];

  const pageProjects = [...new Set(rows.map((row) => row.project_id))];
  const [totals, contacts] = await Promise.all([
    invoiceTotals(supabase, rows.map((row) => row.id)),
    pageProjects.length
      ? supabase
          .from('project_contacts')
          .select('project_id, contact_id, contact:contacts!inner(id, name, email, company)')
          .eq('is_primary_client', true)
          .in('project_id', pageProjects)
          // A contact in Trash is no longer the customer.
          .is('contact.deleted_at', null)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (contacts.error) throw contacts.error;
  type ContactRow = { project_id: string; contact: { id: string; name: string; email: string; company: string } | null };
  const primary = new Map(((contacts.data ?? []) as unknown as ContactRow[]).map((row) => [row.project_id, row.contact]));

  const invoices = rows.map((row) => {
    const sums = totals.get(row.id);
    const amount = Number(row.amount) || 0;
    const total = sums?.total ?? amount;
    const contact = primary.get(row.project_id) ?? null;
    return {
      id: row.id,
      invoice_number: row.invoice_number,
      status: row.status,
      date: row.date,
      due_date: row.due_date,
      paid_date: row.paid_date,
      description: row.description,
      amount,
      tax_rate: row.projects?.tax_rate == null ? null : Number(row.projects.tax_rate),
      tax_amount: Math.round((total - amount) * 100) / 100,
      total,
      paid_total: sums?.paid_total ?? 0,
      outstanding: outstandingOf(sums),
      lines: normalizedInvoiceLines(row),
      payments: (row.invoice_payments ?? [])
        .map(serializePayment)
        .sort((a, b) => a.paid_date.localeCompare(b.paid_date) || a.created_at.localeCompare(b.created_at)),
      project: { id: row.project_id, name: row.projects?.name ?? '' },
      customer: {
        contact_id: contact?.id ?? null,
        name: contact?.name ?? null,
        company: contact?.company || null,
        email: contact?.email || null,
        billing_email: row.projects?.billing_email || null,
      },
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });
  return paginated(invoices, { page, limit, total: count || 0 });
}, { permission: 'invoices.read' });
