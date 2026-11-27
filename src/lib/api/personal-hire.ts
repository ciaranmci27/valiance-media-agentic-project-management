import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { findAgentTemplate } from '@/lib/agent-templates';
import { ASSISTANT_DEFAULT_NAME_TEMPLATE, ASSISTANT_DEFAULT_TEMPLATE, assistantNameFor } from '@/lib/personal-agents';
import { agentTemplateRegistry } from './agent-registries';
import type { AgentCaller } from './agent-owners';
import { agentEmailFor } from './agent-workspace';
import { requireAgentsEnabled } from './agents';
import { ApiError, forbidden } from './errors';
import { personalAgentsPending } from './personal-agents';

/**
 * Hire a personal assistant for one person (the hire screen's "Personal
 * assistant" path, POST /api/workspace/agents/personal and
 * POST /api/v1/assistants/for-person): the person's own agent from the
 * Personal assistant template, named "<first name>'s Assistant" unless a
 * name is given, made without a key (its harness collects it, as for
 * assistants given by role or group). One per person: when they already
 * have one, it is answered (created false) and nothing is made. An Owner
 * only, with assistants on (423 assistants_off otherwise: they would be on
 * hold from the start).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

export const hirePersonalSchema = z.object({
  person_id: z.uuid('person_id must be a team member id'),
  /** Its name; left out: "<first name>'s Assistant". */
  name: z.string().trim().min(1).max(80).optional(),
}).strict();
export type HirePersonal = z.infer<typeof hirePersonalSchema>;

export interface HirePersonalResult {
  agent: { id: string; name: string };
  person: { id: string; name: string };
  /** False: they already had one, answered as it is. */
  created: boolean;
}

export async function hirePersonalAssistant(service: SupabaseClient, caller: AgentCaller, body: HirePersonal): Promise<HirePersonalResult> {
  requireAgentsEnabled(caller.access);
  if (caller.access.role !== 'owner' || caller.access.status !== 'active') {
    throw forbidden('Only an Owner hires a personal assistant for someone', { reason: 'owner_only' });
  }
  const { data: settings, error: settingsError } = await service.from('business_settings').select('assistants_enabled').limit(1).maybeSingle();
  if (settingsError && !/assistants_enabled/.test(settingsError.message ?? '')) throw settingsError;
  if ((settings as Row | null)?.assistants_enabled !== true) {
    throw new ApiError(423, 'LOCKED', 'Assistants are off: turn them on first, or the assistant waits on hold', { reason: 'assistants_off' });
  }
  const { data: person, error: personError } = await service.from('team_members').select('id, name, role, status').eq('id', body.person_id).maybeSingle();
  if (personError) throw personError;
  const who = person as Row | null;
  if (!who || who.role === 'agent' || (who.status ?? 'active') !== 'active') {
    throw new ApiError(422, 'VALIDATION_ERROR', 'A personal assistant is for an active person on the team', { reason: 'not_a_person' });
  }
  const { data: existing, error: existingError } = await service.from('team_members').select('id, name')
    .eq('delegate_of', who.id).eq('assistant_template', ASSISTANT_DEFAULT_TEMPLATE).limit(1);
  if (existingError) {
    if (/delegate_of|assistant_template/.test(existingError.message ?? '')) throw personalAgentsPending();
    throw existingError;
  }
  const have = ((existing ?? []) as Row[])[0];
  if (have) return { agent: { id: have.id, name: have.name }, person: { id: who.id, name: who.name }, created: false };

  const template = findAgentTemplate(ASSISTANT_DEFAULT_TEMPLATE, await agentTemplateRegistry(service));
  if (!template) throw new ApiError(422, 'VALIDATION_ERROR', 'The Personal assistant template is missing', { reason: 'unknown_template' });
  const name = body.name ?? assistantNameFor(who.name, ASSISTANT_DEFAULT_NAME_TEMPLATE);
  const rules = template.rules ?? {};
  const row = {
    name,
    email: agentEmailFor(name),
    title: template.label,
    agent_role: template.role ?? 'assistant',
    agent_profile: template.profile ?? 'generic',
    description: null,
    delegate_of: who.id,
    assistant_template: template.key,
    assistant_setup_id: null,
    agent_self_assign: rules.agent_self_assign ?? false,
    agent_close_policy: rules.agent_close_policy ?? 'close',
    agent_create_policy: rules.agent_create_policy ?? 'live',
    agent_escalate_to: who.id,
  };
  const { data, error } = await service.rpc('provision_personal_agents', { p_agents: [row], p_actor: caller.memberId });
  if (error) {
    if (/provision_personal_agents|delegate_of/.test(error.message ?? '')) throw personalAgentsPending();
    throw error;
  }
  const made = ((data ?? []) as Row[])[0];
  if (!made) {
    // Made at the same moment by someone else: answer theirs.
    const { data: again } = await service.from('team_members').select('id, name').eq('delegate_of', who.id).eq('assistant_template', template.key).limit(1);
    const theirs = ((again ?? []) as Row[])[0];
    if (theirs) return { agent: { id: theirs.id, name: theirs.name }, person: { id: who.id, name: who.name }, created: false };
    throw new ApiError(500, 'INTERNAL_ERROR', 'The assistant was not made. Try again.');
  }
  return { agent: { id: made.id, name }, person: { id: who.id, name: who.name }, created: true };
}
