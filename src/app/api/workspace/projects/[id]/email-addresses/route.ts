import { inboxRoute, readBody } from '@/lib/inbound-email/inbox-route';
import { addProjectAddress, listProjectAddresses } from '@/lib/inbound-email/inbox-settings-service';
import { projectAddressSchema } from '@/lib/inbound-email/schemas';

export const dynamic = 'force-dynamic';

/** The project's own email addresses: mail to one lands in its inbox, filed on this project. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute((ctx) => listProjectAddresses(ctx, id));
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => addProjectAddress(ctx, id, await readBody(request, projectAddressSchema)), 201);
}
