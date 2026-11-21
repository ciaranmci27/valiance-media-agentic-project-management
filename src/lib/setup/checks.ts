import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Day-one checks for a fresh install, shown in the setup wizard: which
 * environment variables are set (true or false only, never a value), whether
 * Supabase exposes the communications schema the Inbox lives in, and whether
 * an SMTP account can send invitation emails.
 */

export interface EnvCheck {
  name: string;
  set: boolean;
  /** Required: the app is broken without it. Otherwise one feature waits on it. */
  required: boolean;
  /** What it is for, in a few words. */
  purpose: string;
}

const ENV_VARS: Array<Omit<EnvCheck, 'set'>> = [
  { name: 'NEXT_PUBLIC_SUPABASE_URL', required: true, purpose: 'Connects the app to your Supabase project.' },
  { name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', required: true, purpose: 'Signs people in.' },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', required: true, purpose: 'Lets the server create accounts and send invites.' },
  { name: 'NEXT_PUBLIC_APP_URL', required: true, purpose: 'The address used in emails and invite links.' },
  { name: 'PROJECT_CREDENTIALS_ENCRYPTION_KEY', required: false, purpose: 'Encrypts saved project credentials.' },
  { name: 'SMTP_ENCRYPTION_KEY', required: false, purpose: 'Encrypts email account passwords, for sending email.' },
  // DATABASE_URL counts too (envChecks). Without it, each update's database changes are applied by hand.
  { name: 'SUPABASE_DB_URL', required: false, purpose: 'Applies the database changes in each update when it deploys.' },
];

const CRON_VAR: Omit<EnvCheck, 'set'> = {
  name: 'CRON_SECRET',
  required: false,
  purpose: 'Runs the scheduled jobs (email retention, billing digests). Without it they stay off.',
};

/** True or false per variable; a blank value counts as not set. Values never leave this function. */
export function envChecks(env: Record<string, string | undefined>, options: { crons: boolean }): EnvCheck[] {
  const list = options.crons ? [...ENV_VARS, CRON_VAR] : ENV_VARS;
  const isSet = (name: string) => typeof env[name] === 'string' && env[name]!.trim() !== '';
  return list.map((item) => ({
    ...item,
    set: isSet(item.name) || (item.name === 'SUPABASE_DB_URL' && isSet('DATABASE_URL')),
  }));
}

export type SchemaState = 'ready' | 'not_exposed' | 'missing' | 'unknown';

/** Whether Supabase's API serves the communications schema (PGRST106 when it is not exposed). */
export async function communicationsSchemaState(service: SupabaseClient): Promise<SchemaState> {
  try {
    const { error } = await service.schema('communications').from('inboxes').select('id').limit(1);
    if (!error) return 'ready';
    if (error.code === 'PGRST106') return 'not_exposed';
    if (['42P01', 'PGRST205', '3F000'].includes(error.code ?? '')) return 'missing';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
