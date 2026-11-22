import { createClient, type SupabaseClient, type SupabaseClientOptions } from '@supabase/supabase-js';
import { PM_DB } from './schema';

/**
 * A supabase-js client on the app's schema (pm). Typed as the plain client
 * the app passes around: the schema is a runtime setting, the tables are the
 * same.
 */
export function createPmClient(url: string, key: string, options: Omit<SupabaseClientOptions<'public'>, 'db'> = {}): SupabaseClient {
  return createClient(url, key, { ...options, db: PM_DB } as unknown as SupabaseClientOptions<'public'>) as unknown as SupabaseClient;
}
