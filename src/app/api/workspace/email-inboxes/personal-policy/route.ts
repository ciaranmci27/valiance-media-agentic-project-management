import { inboxRoute, readBody } from '@/lib/communications/inbox-route';
import { setOwnersReadPersonal } from '@/lib/communications/inbox-settings-service';
import { personalInboxPolicySchema } from '@/lib/communications/schemas';

export const dynamic = 'force-dynamic';

/** Whether Owners may read personal inboxes (business settings managers only). */
export async function PUT(request: Request) {
  return inboxRoute(async (ctx) => setOwnersReadPersonal(ctx, (await readBody(request, personalInboxPolicySchema)).owners_read_personal));
}
