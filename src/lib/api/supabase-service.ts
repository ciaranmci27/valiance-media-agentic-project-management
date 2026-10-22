import { createClient, SupabaseClient } from '@supabase/supabase-js';

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
    serviceClient = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  } else {
    serviceClient = createClient(url, key);
  }

  return serviceClient;
}

/**
 * The service client for a write made on someone's behalf. It names the
 * person in request headers so the team activity log can say who did it; the
 * database honours them only for the service role, and leaves agents out.
 * With no member it is the plain service client.
 */
export function getActorClient(memberId: string | null | undefined, via: ActorVia): SupabaseClient {
  if (!memberId) return getServiceClient();
  const cacheKey = `${memberId}:${via}`;
  const cached = actorClients.get(cacheKey);
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key && process.env.NODE_ENV === 'production') {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required in production');
  }
  const client = createClient(url, key ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-actor-member-id': memberId, 'x-actor-via': via } },
  });
  actorClients.set(cacheKey, client);
  return client;
}
