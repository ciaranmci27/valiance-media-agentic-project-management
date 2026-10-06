import { inboxRoute, readBody } from '@/lib/inbound-email/inbox-route';
import { removeProjectAddress, updateProjectAddress } from '@/lib/inbound-email/inbox-settings-service';
import { projectAddressPatchSchema } from '@/lib/inbound-email/schemas';

export const dynamic = 'force-dynamic';

/** A person edits an address in place (a new routing address retires the old one) or turns it on or off. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; addressId: string }> }) {
  const { id, addressId } = await params;
  return inboxRoute(async (ctx) => updateProjectAddress(ctx, id, addressId, await readBody(request, projectAddressPatchSchema)));
}

/** A person removes an address; threads it filed keep their project. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; addressId: string }> }) {
  const { id, addressId } = await params;
  return inboxRoute(async (ctx) => {
    await removeProjectAddress(ctx, id, addressId);
    return { removed: true };
  });
}
