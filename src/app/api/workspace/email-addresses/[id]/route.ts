import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { removeYourAddress, updateYourAddress } from '@/lib/communications/inbox-settings-service';
import { yourAddressPatchSchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => updateYourAddress(ctx, id, await readBody(request, yourAddressPatchSchema)));
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => {
    await removeYourAddress(ctx, id);
    return { removed: true };
  });
}
