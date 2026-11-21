import { getServiceClient } from '@/lib/api/supabase-service';
import { internalAuthorization, privateHeaders, readSmallJson, snapshotInput } from '@/lib/webhooks/internal-auth';
import { MODULE_OFF, moduleOffMessage } from '@/lib/api/errors';
import { moduleEnabled } from '@/lib/modules/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request) {
  const denied = internalAuthorization(request, 'snapshot');
  if (denied) return denied;
  let args: ReturnType<typeof snapshotInput>;
  try { args = snapshotInput(await readSmallJson(request)); }
  catch { return Response.json({ error: 'Use snapshot_id (UUID) and an optional integer cursor.' }, { status: 400, headers: privateHeaders }); }
  try {
    // Invoices are Billing and finance; switched off, the accounting tool reads nothing.
    if (!(await moduleEnabled(getServiceClient(), 'billing'))) {
      return Response.json({ error: moduleOffMessage('billing'), code: MODULE_OFF, module: 'billing' }, { status: 403, headers: privateHeaders });
    }
    const { data, error } = await getServiceClient().rpc('invoice_accounting_snapshot', args).abortSignal(AbortSignal.timeout(45_000));
    if (error) {
      const expired = error.message.includes('INVOICE_SNAPSHOT_EXPIRED');
      const invalid = error.message.includes('INVOICE_SNAPSHOT_INPUT');
      return Response.json({ error: expired ? 'Snapshot expired. Start a new snapshot.' : invalid ? 'Invalid snapshot cursor.' : 'Snapshot unavailable. Retry with the same snapshot_id.' }, { status: expired ? 410 : invalid ? 400 : 503, headers: privateHeaders });
    }
    return Response.json(data, { headers: privateHeaders });
  } catch { return Response.json({ error: 'Snapshot unavailable. Retry with the same snapshot_id.' }, { status: 503, headers: privateHeaders }); }
}
