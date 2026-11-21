import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireSessionAccess } from '@/lib/api/access';
import { afterResponse } from '@/lib/api/after-response';
import { currentVersion } from './config';
import type { AuditEntry, UpdatesDeps } from './handlers';

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
      NEXT_PUBLIC_DEMO_MODE: process.env.NEXT_PUBLIC_DEMO_MODE,
      DEMO_MODE: process.env.DEMO_MODE,
    },
    currentVersion,
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
