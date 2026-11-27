import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { permissionLabel } from '@/lib/access-control';
import { splitSetupScopes } from '@/lib/ai-setup';
import { agentTemplateRegistry } from './agent-registries';
import { ApiError, forbidden } from './errors';
import { currentAiSetup } from './request-context';

/**
 * What an AI setup session may hand out on its own, and what waits on the
 * Owner (deep security review of 2.0.50, finding 8; rules in
 * lib/ai-setup.ts). Outside a session nothing here changes anything.
 *
 * - A key a session makes for an agent carries at most the agent's template
 *   powers (403 ai_setup_scope_outside_template otherwise, before anything
 *   is made). The confirm powers (money, people, settings, acting for
 *   someone, keys, webhooks, credentials) are left off the key and wait as
 *   one Allow on the setup screen (pm.ai_setup_confirms); the answer says so
 *   in needs_owner_confirm.
 * - A webhook a session adds to an address no live webhook uses yet is made
 *   switched off and waits for the same Allow.
 * Allowing is the signed-in Owner's alone (POST
 * /api/workspace/ai-setup/confirms/{id}); it never passes through an agent
 * or an API key, since its whole point is a person saying yes.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

export interface SetupScopeCap {
  /** What the key may carry now. */
  granted: string[];
  /** What waits on the Owner's Allow (left off the key). */
  confirm: string[];
}

/** What the answer to a session's call says about what waits. */
export interface NeedsOwnerConfirm {
  id: string | null;
  scopes?: string[];
  host?: string;
  message: string;
}

const missingConfirms = (error: { code?: string; message?: string } | null) =>
  !!error && (['42P01', 'PGRST205', '42703', 'PGRST204'].includes(error.code ?? '') || /ai_setup_confirms|ai_setup_session_id/.test(error.message ?? ''));

/** The template an agent was set up from (team_members.agent_template_key), or null. */
async function templateOfAgent(service: SupabaseClient, agentId: string): Promise<string | null> {
  const { data, error } = await service.from('team_members').select('agent_template_key').eq('id', agentId).maybeSingle();
  if (error) return null;
  return ((data as Row | null)?.agent_template_key as string | null | undefined) ?? null;
}

/**
 * In a session: the scopes a key for this agent may carry now and those that
 * wait, from the template named (a hire) or the agent's own. Throws 403
 * ai_setup_scope_outside_template for anything else. Outside a session,
 * every scope passes and nothing waits.
 */
export async function capSetupScopes(service: SupabaseClient, scopes: string[], from: { templateKey: string | null } | { agentId: string }): Promise<SetupScopeCap> {
  if (!currentAiSetup()) return { granted: [...new Set(scopes)], confirm: [] };
  const templateKey = 'templateKey' in from ? from.templateKey : await templateOfAgent(service, from.agentId);
  const templates = await agentTemplateRegistry(service);
  const template = templateKey ? templates.find((t) => t.key === templateKey) ?? null : null;
  // A blank agent (no template) gets at most what some template would give: never an Owner-wide list.
  const ceiling = template ? template.scopes : [...new Set(templates.flatMap((t) => t.scopes))];
  const split = splitSetupScopes(scopes, ceiling);
  if (split.refused.length) {
    throw forbidden(template
      ? `While setting up with AI, a key carries at most its template's powers. Not in the ${template.label} template: ${split.refused.map(permissionLabel).join(', ')}.`
      : `While setting up with AI, a key for an agent with no template carries only powers some template gives. Leave these out, or apply a template that has them: ${split.refused.map(permissionLabel).join(', ')}.`, {
      reason: 'ai_setup_scope_outside_template',
      outside_template: split.refused,
      template: template?.key ?? null,
      template_scopes: ceiling,
      hint: 'Leave them out. The Owner adds anything else on the agent\'s Access after the session.',
    });
  }
  return { granted: split.granted, confirm: split.confirm };
}

/** Records what waits on the Owner; null when it cannot be recorded (no session row, or a database before it). */
export async function recordSetupConfirm(service: SupabaseClient, row: {
  kind: 'key_scopes' | 'webhook'; agentId: string | null; apiKeyId?: string | null; webhookEndpointId?: string | null; scopes?: string[]; host?: string | null;
}): Promise<NeedsOwnerConfirm | null> {
  const session = currentAiSetup();
  if (!session?.sessionId) return null;
  const { data, error } = await service.from('ai_setup_confirms').insert({
    session_id: session.sessionId,
    member_id: session.memberId,
    agent_id: row.agentId,
    kind: row.kind,
    api_key_id: row.apiKeyId ?? null,
    webhook_endpoint_id: row.webhookEndpointId ?? null,
    scopes: row.scopes ?? [],
    host: row.host ?? null,
  }).select('id').single();
  if (error) {
    if (missingConfirms(error)) return null;
    throw error;
  }
  const id = (data as Row).id as string;
  return row.kind === 'key_scopes'
    ? { id, scopes: row.scopes, message: `The key was made without ${(row.scopes ?? []).map(permissionLabel).join(', ')}. They wait for the Owner's Allow on the setup screen; tell them to look there.` }
    : { id, host: row.host ?? undefined, message: `The webhook to ${row.host} was made switched off. It waits for the Owner's Allow on the setup screen; tell them to look there.` };
}

/**
 * In a session, key powers that wait could not be recorded (no readable
 * session): the key is still made without them, and the answer says to ask
 * the Owner to add them by hand.
 */
export function unrecordedConfirm(scopes: string[]): NeedsOwnerConfirm {
  return { id: null, scopes, message: `The key was made without ${scopes.map(permissionLabel).join(', ')}. Ask the Owner to add them on the agent's Access.` };
}

/** A webhook address's host, lower case. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    throw new ApiError(422, 'VALIDATION_ERROR', 'url must be a web address', { reason: 'invalid_url' });
  }
}

/** Whether another live webhook already sends to this host (a session adding one there needs no Allow). */
export async function hostInUse(service: SupabaseClient, host: string, exceptId?: string): Promise<boolean> {
  let query = service.from('webhook_endpoints').select('url').eq('is_active', true);
  if (exceptId) query = query.neq('id', exceptId);
  const { data, error } = await query.limit(1000);
  if (error) throw error;
  return ((data ?? []) as Row[]).some((row) => {
    try { return new URL(String(row.url)).host.toLowerCase() === host; } catch { return false; }
  });
}
