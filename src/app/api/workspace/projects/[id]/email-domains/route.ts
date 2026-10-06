import { inboxRoute, readBody } from '@/lib/inbound-email/inbox-route';
import { addClientDomain, listClientDomains } from '@/lib/inbound-email/inbox-settings-service';
import { clientDomainSchema } from '@/lib/inbound-email/schemas';

export const dynamic = 'force-dynamic';

/** Client email domains: mail from any address at one maps to this project. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute((ctx) => listClientDomains(ctx, id));
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => addClientDomain(ctx, id, (await readBody(request, clientDomainSchema)).domain), 201);
}
