import { inboxRoute, readBody } from '@/lib/inbound-email/inbox-route';
import { addClientSender, listClientSenders } from '@/lib/inbound-email/inbox-settings-service';
import { clientSenderSchema } from '@/lib/inbound-email/schemas';

export const dynamic = 'force-dynamic';

/** Client email addresses: mail from one maps to this project. Lists the project's contact addresses too. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute((ctx) => listClientSenders(ctx, id));
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => addClientSender(ctx, id, (await readBody(request, clientSenderSchema)).address), 201);
}
