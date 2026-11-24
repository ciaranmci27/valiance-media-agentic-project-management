import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { currentApiKeyId, currentPrincipalId } from './request-context';
import { createPmClient } from '@/lib/supabase/pm-client';

let serviceClient: SupabaseClient | null = null;
const actorClients = new Map<string, SupabaseClient>();

export type ActorVia = 'app' | 'api' | 'mcp';

export function getServiceClient(): SupabaseClient {
  if (serviceClient) return serviceClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY is required in production');
    }
    // Fallback to anon key for demo/dev only
    serviceClient = createPmClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  } else {
    serviceClient = createPmClient(url, key);
  }

  return serviceClient;
}

/**
 * The service client for a write made on someone's behalf. It names the
 * person in request headers so the team activity log can say who did it, and
 * the API key when there is one (inside an API request it is found on its
 * own), so a task it creates records the key; the database honours both only
 * for the service role, and leaves agents out of the log. With no member and
 * no key it is the plain service client. Inside a request that acts for a
 * person (X-Act-For) it names them too, and what it writes is stamped with
 * their principal_id.
 */
export function getActorClient(
  memberId: string | null | undefined,
  via: ActorVia,
  keyId: string | null = currentApiKeyId(),
  principalId: string | null = via === 'app' ? null : currentPrincipalId(),
): SupabaseClient {
  if (!memberId && !keyId) return getServiceClient();
  const cacheKey = `${memberId ?? ''}:${via}:${keyId ?? ''}:${principalId ?? ''}`;
  const cached = actorClients.get(cacheKey);
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key && process.env.NODE_ENV === 'production') {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required in production');
  }
  const client = createPmClient(url, key ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        ...(memberId ? { 'x-actor-member-id': memberId } : {}),
        'x-actor-via': via,
        ...(keyId && via !== 'app' ? { 'x-actor-key-id': keyId } : {}),
        ...(principalId ? { 'x-actor-principal-id': principalId } : {}),
      },
    },
  });
  // One per agent and person would grow without bound in a large company: a
  // client that acts for someone lives for its request only.
  if (!principalId) actorClients.set(cacheKey, client);
  return client;
}
