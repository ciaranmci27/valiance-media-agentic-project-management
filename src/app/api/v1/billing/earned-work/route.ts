import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { accessAllowsProject } from '@/lib/api/access';
import { paymentRuleError } from '@/lib/api/invoice-payments';

export const dynamic = 'force-dynamic';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

type EarnedRow = {
  project_id: string;
  kind: 'time' | 'scheduled';
  earned_from: string;
  earned_to: string;
  amount: number | string;
  hours?: number | string;
  retainer_id?: string;
  retainer_name?: string;
  billing_timing?: 'advance' | 'arrears';
  draft_invoice_id?: string | null;
};

/**
 * Work earned in a date range, per project, for accrual accounting
 * (billing_earned_work): approved time by day, and retainer periods that have
 * started with no issued invoice yet. Projects the key cannot open are left out.
 */
export const GET = withApi(async ({ supabase, searchParams, access }) => {
  const from = searchParams.get('from') ?? '';
  const to = searchParams.get('to') ?? '';
  if (!DAY.test(from) || !DAY.test(to)) throw badRequest('from and to are required as YYYY-MM-DD');

  const { data, error } = await supabase.rpc('billing_earned_work', { p_from: from, p_to: to });
  const ruleError = paymentRuleError(error);
  if (ruleError) throw ruleError;
  if (error && /date\/time|invalid input syntax for type date/i.test(error.message)) throw badRequest('from and to must be real dates');
  if (error) throw error;

  const rows = ((data ?? []) as EarnedRow[]).filter((row) => accessAllowsProject(access, row.project_id, 'api'));
  const projectIds = [...new Set(rows.map((row) => row.project_id))];
  const [{ data: projects, error: projectError }, { data: zone, error: zoneError }] = await Promise.all([
    projectIds.length
      ? supabase.from('projects').select('id, name').in('id', projectIds).is('deleted_at', null)
      : Promise.resolve({ data: [], error: null }),
    supabase.rpc('workspace_timezone'),
  ]);
  if (projectError) throw projectError;
  if (zoneError) throw zoneError;
  const names = new Map(((projects ?? []) as { id: string; name: string }[]).map((project) => [project.id, project.name]));

  const byProject = new Map<string, { project: { id: string; name: string }; time: unknown[]; scheduled: unknown[] }>();
  for (const row of rows) {
    // Work in a project in Trash went to Trash with it.
    if (!names.has(row.project_id)) continue;
    let entry = byProject.get(row.project_id);
    if (!entry) {
      entry = { project: { id: row.project_id, name: names.get(row.project_id) ?? '' }, time: [], scheduled: [] };
      byProject.set(row.project_id, entry);
    }
    if (row.kind === 'time') {
      entry.time.push({ date: row.earned_from, hours: Number(row.hours), amount: Number(row.amount) });
    } else {
      entry.scheduled.push({
        retainer_id: row.retainer_id,
        retainer_name: row.retainer_name,
        billing_timing: row.billing_timing,
        period_start: row.earned_from,
        period_end: row.earned_to,
        amount: Number(row.amount),
        draft_invoice_id: row.draft_invoice_id ?? null,
      });
    }
  }
  return success({
    from,
    to,
    timezone: (zone as string | null) ?? 'UTC',
    projects: [...byProject.values()].sort((a, b) => a.project.name.localeCompare(b.project.name)),
  });
}, { permission: 'invoices.read' });
