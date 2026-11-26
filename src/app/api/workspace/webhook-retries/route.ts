import { NextResponse, type NextRequest } from 'next/server';
import { isModuleEnabled } from '@/lib/access-control';
import { foreignOrigin, isDemoWorkspace, requireOwner } from '@/lib/api/owner-route';
import {
  ensureWebhookRetries,
  turnOffWebhookRetries,
  turnOnWebhookRetries,
  webhookRetriesState,
  WebhookRetriesError,
} from '@/lib/webhooks/retries';

/**
 * Webhook retries (Settings > Developers > Webhooks). Owner only. They are on
 * by default: GET turns them on by itself once everything they need is there
 * (unless an Owner turned them off) and answers the state. POST turns them on
 * (a new scheduler secret, saved in the app and in Supabase Vault); DELETE
 * turns them off, and they stay off until an Owner turns them on again.
 */

const fail = (error: unknown) => NextResponse.json(
  { error: (error as Error).message },
  { status: error instanceof WebhookRetriesError ? error.status : 500 },
);
const answer = (data: unknown) => NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } });

export async function GET() {
  if (isDemoWorkspace()) return NextResponse.json({ error: 'The demo workspace has no database.' }, { status: 403 });
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  try {
    if (isModuleEnabled(auth.data.access, 'webhooks')) await ensureWebhookRetries(auth.data.service);
    return answer(await webhookRetriesState(auth.data.service));
  } catch (error) {
    return fail(error);
  }
}

async function change(request: NextRequest, on: boolean) {
  if (isDemoWorkspace()) return NextResponse.json({ error: 'The demo workspace has no database.' }, { status: 403 });
  if (foreignOrigin(request)) return NextResponse.json({ error: 'Cross-site request refused' }, { status: 403 });
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { service, memberId } = auth.data;
  try {
    return answer(on ? await turnOnWebhookRetries(service, memberId) : await turnOffWebhookRetries(service, memberId));
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: NextRequest) {
  return change(request, true);
}

export async function DELETE(request: NextRequest) {
  return change(request, false);
}
