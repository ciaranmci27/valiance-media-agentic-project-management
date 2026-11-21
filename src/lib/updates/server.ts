import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSessionAccess } from '@/lib/api/access';
import { afterResponse } from '@/lib/api/after-response';
import { currentVersion } from './config';
import type { AuditEntry, UpdatesDeps } from './handlers';
import { recordedMigrations } from './database';

/**
 * The update routes' real dependencies: the signed-in session (never an API
 * key or MCP), the app's own audit row, and the host's environment.
 */
export function updatesDeps(): UpdatesDeps {
  let service: SupabaseClient | null = null;
  return {
    env: {
      PM_GITHUB_TOKEN: process.env.PM_GITHUB_TOKEN,
      PM_GITHUB_REPO: process.env.PM_GITHUB_REPO,
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
        const [settings, applied] = await Promise.all([
          client.from('business_settings').select('*').limit(1).maybeSingle(),
          client.from('app_migrations').select('name'),
        ]);
        if (settings.error) throw settings.error;
        const raw = (settings.data as { auto_migrate?: unknown } | null)?.auto_migrate;
        return {
          switchOn: typeof raw === 'boolean' ? raw : null,
          applied: recordedMigrations({ data: applied.data as Array<{ name: string }> | null, error: applied.error }),
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
        const { error } = await client.from('api_audit_log').insert({
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
