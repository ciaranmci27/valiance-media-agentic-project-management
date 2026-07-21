import type { SupabaseClient } from '@supabase/supabase-js';

const MAX_REQUESTS = 120;

export async function checkRateLimit(
  supabase: SupabaseClient,
  apiKeyId: string,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const { data, error } = await supabase.rpc('consume_api_rate_limit', {
    p_api_key_id: apiKeyId,
    p_limit: MAX_REQUESTS,
    p_window_seconds: 60,
  }).single();
  if (error) throw error;
  const result = data as { allowed: boolean; remaining: number; reset_at: string };
  return {
    allowed: result.allowed,
    remaining: result.remaining,
    resetAt: new Date(result.reset_at).getTime(),
  };
}
