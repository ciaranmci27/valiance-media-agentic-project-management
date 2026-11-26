import { accessAllows } from '@/lib/api/access';
import { ApiError, forbidden, notFound } from '@/lib/api/errors';
import { workspaceRoute } from '@/lib/api/workspace-route';
import { openWebhookSecret, sealStoredWebhookSecret } from '@/lib/webhooks/secret';

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
