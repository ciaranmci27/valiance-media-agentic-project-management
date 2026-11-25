import { insertAuditRows } from '@/lib/api/audit';
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSessionAccess } from '@/lib/api/access';
import { afterResponse } from '@/lib/api/after-response';
import { currentVersion } from './config';
import type { AuditEntry, UpdatesDeps } from './handlers';
import { recordedMigrations } from './database';
import { pmSchemasState } from '@/lib/setup/checks';
import { getServiceClient } from '@/lib/api/supabase-service';
import { clearSecretCache, readSecrets } from '@/lib/secrets/store';

/**
 * The update routes' real dependencies: the signed-in session (never an API
 * key or MCP), the app's own audit row, and the host's environment. The
 * GitHub token and repository come from Settings > Updates when an Owner saved
 * them there (sealed with the app key), else from PM_GITHUB_TOKEN and
 * PM_GITHUB_REPO.
 */
export async function updatesDeps(): Promise<UpdatesDeps> {
  let service: SupabaseClient | null = null;
  let github: { github_token: string | null; github_repo: string | null } = {
    github_token: process.env.PM_GITHUB_TOKEN ?? null,
    github_repo: process.env.PM_GITHUB_REPO ?? null,
  };
  try {
    // Owners act on what they just saved, possibly on another server instance: read fresh.
    clearSecretCache();
    github = await readSecrets(getServiceClient(), ['github_token', 'github_repo'] as const);
  } catch {
    // The database is unreachable: the environment answers, as before.
  }
  return {
    env: {
      PM_GITHUB_TOKEN: github.github_token ?? undefined,
      PM_GITHUB_REPO: github.github_repo ?? undefined,
      PM_INSTALL_ROLE: process.env.PM_INSTALL_ROLE,
      PM_SOURCE_LAYOUT: process.env.PM_SOURCE_LAYOUT,
      // Database updates: read for whether they are set, never sent anywhere.
      SUPABASE_DB_URL: process.env.SUPABASE_DB_URL,
      DATABASE_URL: process.env.DATABASE_URL,
      MIGRATE_ON_DEPLOY: process.env.MIGRATE_ON_DEPLOY,
      PM_MIGRATIONS: process.env.PM_MIGRATIONS,
      NEXT_PUBLIC_DEMO_MODE: process.env.NEXT_PUBLIC_DEMO_MODE,
      DEMO_MODE: process.env.DEMO_MODE,
    },
    currentVersion,
    database: {
      // Runs after authorize (every route checks the Owner first), so the service client is set.
      read: async () => {
        const client = service;
        if (!client) throw new Error('not authorized');
        const [settings, applied, schemas] = await Promise.all([
          client.from('business_settings').select('*').limit(1).maybeSingle(),
          client.from('app_migrations').select('name'),
          pmSchemasState(client),
        ]);
        if (settings.error) throw settings.error;
        const raw = (settings.data as { auto_migrate?: unknown } | null)?.auto_migrate;
        return {
          switchOn: typeof raw === 'boolean' ? raw : null,
          applied: recordedMigrations({ data: applied.data as Array<{ name: string }> | null, error: applied.error }),
          schemas,
        };
      },
      save: async (on: boolean) => {
        const client = service;
        if (!client) return { ok: false as const, message: 'Not authorized' };
        const row = await client.from('business_settings').select('id').limit(1).maybeSingle();
        if (row.error) return { ok: false as const, message: row.error.message };
        const write = row.data?.id
          ? await client.from('business_settings').update({ auto_migrate: on }).eq('id', row.data.id)
          : await client.from('business_settings').insert({ auto_migrate: on });
        if (write.error) {
          const missing = write.error.code === 'PGRST204' || /auto_migrate/.test(write.error.message);
          return { ok: false as const, message: missing ? 'The database does not have this setting yet. Run npm run db:migrate, then try again.' : write.error.message };
        }
        return { ok: true as const };
      },
    },
    authorize: async () => {
      const auth = await requireSessionAccess();
      if (auth.error) return { error: auth.error };
      service = auth.data.service;
      return { error: null, memberId: auth.data.memberId, role: auth.data.access.role };
    },
    audit: (entry: AuditEntry) => {
      const client = service;
      if (!client) return;
      // The app's own audit row (via 'app'), with the state before and after. Never the token.
      afterResponse('workspace updates audit', async () => {
        const { error } = await insertAuditRows(client, {
          method: entry.method,
          endpoint: entry.endpoint,
          entity_type: 'workspace_updates',
          team_member_id: entry.memberId,
          request_body: entry.request_body,
          before_snapshot: entry.before_snapshot,
          after_snapshot: entry.after_snapshot,
          status_code: entry.status_code,
          via: 'app',
        });
        if (error) throw error;
      });
    },
  };
}
