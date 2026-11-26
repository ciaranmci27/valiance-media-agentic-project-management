import { accessAllows } from '@/lib/api/access';
import { ApiError, forbidden, notFound } from '@/lib/api/errors';
import { workspaceRoute } from '@/lib/api/workspace-route';
import { openWebhookSecret, sealStoredWebhookSecret, sealWebhookSecret } from '@/lib/webhooks/secret';
import { generateWebhookSecret } from '@/lib/webhooks/sign';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An endpoint's signing secret, opened, for Settings > Developers to reveal
 * or copy: secrets sealed at rest need the server's APP_ENCRYPTION_KEY.
 * A plaintext secret read with the key set is sealed in place (compare-and-swap).
 * Needs webhooks.manage. Never cached. Answers { secret }; 409
 * secret_unreadable when it is sealed and the key is missing or changed.
 */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  return workspaceRoute(request, async ({ service, access }) => {
    if (!accessAllows(access, 'webhooks.manage', 'app')) throw forbidden('Webhook secrets need Manage webhooks', { reason: 'missing_permission' });
    if (!UUID.test(id)) throw notFound('Webhook endpoint');
    const { data, error } = await service.from('webhook_endpoints').select('id, secret').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) throw notFound('Webhook endpoint');
    const stored = (data as { secret: string }).secret;
    let secret: string;
    try {
      secret = openWebhookSecret(id, stored);
    } catch {
      throw new ApiError(409, 'CONFLICT', 'This secret is encrypted and APP_ENCRYPTION_KEY is missing or changed', { reason: 'secret_unreadable' });
    }
    // A plaintext secret read with the key set is sealed in place; a failure there never stops the reveal.
    await sealStoredWebhookSecret(service, id, stored).catch((e) => console.error('[webhooks] could not seal a signing secret', id, e));
    return { secret };
  }, { noStore: true });
}

/**
 * A new signing secret for the endpoint (Settings > Developers, New signing
 * secret), for when the old one may have leaked: the endpoint keeps its id,
 * filters and delivery history. Sealed at rest when the host has
 * APP_ENCRYPTION_KEY. The old secret stops at once: deliveries from now on
 * are signed with the new one. Needs webhooks.manage. Answers { secret },
 * shown once (it can be revealed again from the row).
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  return workspaceRoute(request, async ({ service, access }) => {
    if (!accessAllows(access, 'webhooks.manage', 'app')) throw forbidden('Webhook secrets need Manage webhooks', { reason: 'missing_permission' });
    if (!UUID.test(id)) throw notFound('Webhook endpoint');
    const secret = generateWebhookSecret();
    const { data, error } = await service.from('webhook_endpoints').update({ secret: sealWebhookSecret(id, secret) }).eq('id', id).select('id');
    if (error) throw error;
    if (!data?.length) throw notFound('Webhook endpoint');
    return { secret };
  }, { noStore: true });
}
