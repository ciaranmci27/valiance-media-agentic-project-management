/**
 * Database updates: whether a release's migrations apply on their own when
 * the host deploys it, and whether the ones this build carries have landed.
 *
 * Production builds apply pending migrations before the new code goes live
 * (scripts/build.ts) when three things hold:
 * - the host has the database connection string (SUPABASE_DB_URL, or
 *   DATABASE_URL): a secret, so it lives in the host, never in the app;
 * - an Owner has not turned it off in Settings > Updates (business_settings
 *   .auto_migrate, on by default);
 * - the host does not say MIGRATE_ON_DEPLOY=false (an override for hosts
 *   that must never migrate from a build).
 * The build carries the names of its migration files (PM_MIGRATIONS, set by
 * next.config.ts), so the app can compare them with what the database
 * recorded (public.app_migrations) and say plainly when some did not land.
 */

export type DatabaseMode = 'automatic' | 'manual' | 'not_set_up';

export interface DatabaseUpdates {
  /** automatic: deploys apply them; manual: someone runs npm run db:migrate; not_set_up: no connection string. */
  mode: DatabaseMode;
  /** The Owner's switch; null when the database does not have it yet (its migration has not run). */
  switchOn: boolean | null;
  /** MIGRATE_ON_DEPLOY=false on the host turns automatic updates off whatever the switch says. */
  hostOff: boolean;
  /** Migration files this build carries that the database has not recorded. Null when it keeps no record. */
  pending: string[] | null;
}

export type DatabaseEnv = Partial<Record<'SUPABASE_DB_URL' | 'DATABASE_URL' | 'MIGRATE_ON_DEPLOY' | 'PM_MIGRATIONS', string | undefined>>;

/** The host has a connection string the build can migrate with. Says yes or no, never the value. */
export function connectionSet(env: DatabaseEnv): boolean {
  return Boolean(env.DATABASE_URL?.trim() || env.SUPABASE_DB_URL?.trim());
}

export function hostTurnedOff(env: DatabaseEnv): boolean {
  return env.MIGRATE_ON_DEPLOY?.trim().toLowerCase() === 'false';
}

/** The mode the next production deploy will follow. A switch not there yet counts as on, its default. */
export function databaseMode(env: DatabaseEnv, switchOn: boolean | null): DatabaseMode {
  if (!connectionSet(env)) return 'not_set_up';
  return switchOn === false || hostTurnedOff(env) ? 'manual' : 'automatic';
}

/** The migration names this build carries, in run order (core files, then custom/...). */
export function carriedMigrations(env: DatabaseEnv): string[] {
  return (env.PM_MIGRATIONS ?? '').split(',').map((name) => name.trim()).filter(Boolean);
}

/** What the database has not recorded of what this build carries. Null when nothing is recorded at all. */
export function pendingMigrations(carried: string[], applied: string[] | null): string[] | null {
  if (applied === null) return null;
  const done = new Set(applied);
  return carried.filter((name) => !done.has(name));
}

/**
 * What the migration runner recorded, from a read of public.app_migrations.
 * No table, or an empty one (the runner started but never recorded a
 * baseline), is no record: null, so nothing is called pending. Any other
 * failure is a real read error and is thrown, so the page says it could not read.
 */
export function recordedMigrations(read: { data: Array<{ name: string }> | null; error: { code?: string | null; message?: string | null } | null }): string[] | null {
  if (read.error) {
    // Only "the table is not there"; a permission error names the table too, and is a real failure.
    const missing = ['42P01', 'PGRST205'].includes(read.error.code ?? '') || /does not exist|could not find the table/i.test(read.error.message ?? '');
    if (missing) return null;
    throw new Error(read.error.message ?? 'Could not read the migration record');
  }
  const names = (read.data ?? []).map((row) => row.name);
  return names.length ? names : null;
}

export function databaseUpdates(env: DatabaseEnv, read: { switchOn: boolean | null; applied: string[] | null }): DatabaseUpdates {
  return {
    mode: databaseMode(env, read.switchOn),
    switchOn: read.switchOn,
    hostOff: hostTurnedOff(env),
    pending: pendingMigrations(carriedMigrations(env), read.applied),
  };
}
