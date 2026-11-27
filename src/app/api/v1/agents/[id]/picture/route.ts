import type { NextRequest } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { notFound } from '@/lib/api/errors';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { requireManageAgent } from '@/lib/api/agent-owners';
import { patchAgent } from '@/lib/api/agent-workspace';
import { PHOTO_BODY_BYTES, readPhoto, storePhoto } from '@/lib/api/photo-upload';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * Uploads an agent's picture (Hire flow, the agent's page): multipart, one
 * field named file, PNG or JPG up to 2 MB. Who may is who may change the
 * agent (an Owner, team.manage, or one of its owners), checked before the
 * file is stored; then the picture is set as update_agent sets avatar_url.
 * REST only: MCP sets a picture by link with update_agent.
 *
 * Permission: team.read (or team.manage), with the AI agents module on.
 */
export const POST = (request: NextRequest, context: Context) => withApi<unknown, { id: string }>(async ({ supabase, params, access, scopes, apiKeyId, teamMemberId }) => {
  requireAgentsEnabled(access);
  const caller = { memberId: teamMemberId, access, scopes };
  const { data: agent, error } = await supabase.from('team_members').select('id').eq('id', params.id).eq('role', 'agent').maybeSingle();
  if (error) throw error;
  if (!agent) throw notFound('Agent');
  await requireManageAgent(supabase, caller, params.id);
  const url = await storePhoto(supabase, `team/${params.id}.jpg`, await readPhoto(request));
  const result = await patchAgent(supabase, caller, params.id, { avatar_url: url });
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/agents/${params.id}/picture`, entityType: 'team_member', entityId: params.id, apiKeyId, teamMemberId, afterSnapshot: { avatar: url }, statusCode: 200 });
  return success(result.agent);
}, { permission: 'team.read', maxBodyBytes: PHOTO_BODY_BYTES })(request, context);
