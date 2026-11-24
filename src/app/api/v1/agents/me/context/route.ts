import { API_ENDPOINT_PERMISSIONS } from '@/lib/access-control';
import { withApi } from '@/lib/api/middleware';
import { buildContextPack, contextPackResponse } from '@/lib/api/agent-context';

/**
 * The calling key's own context pack, generated now from its real setup:
 * who its member is, the key's scopes in plain words, the agent's rules, its
 * projects, the MCP tools this key sees, the house conventions, its health
 * reporting and webhooks. pm_guide adds it as `context`.
 *
 * format=json (default) answers { pack, markdown }, format=pack { pack } and
 * format=markdown { markdown }; format=md answers the
 * Markdown as an AGENTS.md file, format=skill as a SKILL.md file, for a
 * harness to drop into its repo. Never cached.
 *
 * Permission: any API scope the key carries and its member holds: every key
 * may read its own setup.
 */
export const GET = withApi(async ({ supabase, access, scopes, permissions, apiKeyId, teamMemberId, searchParams }) => {
  const { data: keyRow } = await supabase.from('api_keys').select('name').eq('id', apiKeyId).maybeSingle();
  const pack = await buildContextPack(supabase, { memberId: teamMemberId, access, scopes }, {
    memberId: teamMemberId,
    key: { id: apiKeyId, name: (keyRow as { name?: string } | null)?.name ?? null, scopes, readOnly: permissions === 'read_only', source: 'this_key' },
    mode: 'self',
  });
  return contextPackResponse(pack, searchParams.get('format'));
}, { permission: [...API_ENDPOINT_PERMISSIONS] });
