import type { SupabaseClient } from '@supabase/supabase-js';
import { appKeyState } from '@/lib/crypto/app-key';

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
  // Checked for its shape too (64 hex characters): a wrong value counts as not set.
  { name: 'APP_ENCRYPTION_KEY', required: true, purpose: 'Encrypts saved passwords, credentials and integration secrets.' },
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
    set: item.name === 'APP_ENCRYPTION_KEY'
      ? appKeyState(env) === 'set'
      : isSet(item.name) || (item.name === 'SUPABASE_DB_URL' && isSet('DATABASE_URL')),
  }));
}

/** The three settings without which the app cannot reach its database at all (the static setup page). */
export const SUPABASE_VARS = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

export function supabaseConnected(env: Record<string, string | undefined>): boolean {
  return SUPABASE_VARS.every((name) => typeof env[name] === 'string' && env[name]!.trim() !== '');
}

export interface ServerCheck {
  name: string;
  purpose: string;
  /** For APP_ENCRYPTION_KEY: set, but not 64 hex characters. */
  invalid: boolean;
}

/**
 * What the wizard's "Connect your server" step lists before anyone can make
 * an account: the required settings still missing (the Supabase three have
 * their own page, since without them nothing loads). Names and purposes only.
 */
export function missingServerSettings(env: Record<string, string | undefined>): ServerCheck[] {
  return envChecks(env, { crons: false })
    .filter((item) => item.required && !item.set && !(SUPABASE_VARS as readonly string[]).includes(item.name))
    .map((item) => ({
      name: item.name,
      purpose: item.purpose,
      invalid: item.name === 'APP_ENCRYPTION_KEY' && appKeyState(env) === 'invalid',
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
