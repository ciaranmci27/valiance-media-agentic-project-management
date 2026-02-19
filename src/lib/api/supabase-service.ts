import { createClient, SupabaseClient } from '@supabase/supabase-js';

let serviceClient: SupabaseClient | null = null;

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
