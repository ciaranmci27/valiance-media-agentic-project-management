import { runDispatch } from '@/lib/webhooks/dispatch';
import { internalAuthorization, privateHeaders } from '@/lib/webhooks/internal-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request) {
  const denied = internalAuthorization(request, 'scheduler');
  if (denied) return denied;
  try { return Response.json(await runDispatch(), { headers: privateHeaders }); }
  catch { return Response.json({ error: 'Dispatcher unavailable. Delivery leases will expire safely.' }, { status: 503, headers: privateHeaders }); }
}
