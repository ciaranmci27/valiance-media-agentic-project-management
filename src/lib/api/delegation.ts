import type { SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { intersectAccess, type AccessContext } from '@/lib/access-control';
import { ACT_FOR_PROOF_MINUTES, DELEGATION_TOKEN_PREFIX, DELEGATION_TTL_SECONDS, type DelegationGrant, type MintDelegationInput } from '@/lib/delegation';
import { accessAllows, resolveMemberAccess } from './access';
import { requireAgentsEnabled } from './agents';
import { afterResponse } from './after-response';
import { hashApiKey } from './crypto';
import { ApiError, forbidden, notFound, unauthorized } from './errors';
import { groupsMigrationPending, missingGroupsSchema } from './groups';
import { findIdentity, identityKey } from './identities';

/**
 * Delegation tokens: one agent acting for one person (X-Act-For).
 *
 * - Minted by the agent's key (agents.act_for) for a verified identity of the
 *   person who asked (POST /api/v1/delegations), or by a signed-in person
 *   for a named agent (POST /api/workspace/delegations). Refused (403) when
 *   the identity is unknown or unverified, the person is suspended or is an
 *   agent, or the agent may not act for anyone.
 * - A token is random; only its hash is stored, with the agent and person it
 *   binds, so it can be revoked. It lasts DELEGATION_TTL_SECONDS.
 * - Checking one (withApi, the MCP server): it must exist, be live, belong to
 *   the key's own agent, and the key must still carry agents.act_for. Else
 *   401 with reason act_for_invalid. A suspended person is 403
 *   principal_suspended. What the request may then do is intersectAccess of
 *   the agent and the person.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

function fail(error: { code?: string; message?: string } | null | undefined): never {
  if (missingGroupsSchema(error)) throw groupsMigrationPending();
  throw error;
}

const actForInvalid = (message: string) => unauthorized(message, {
  reason: 'act_for_invalid',
  hint: 'Mint a new token with POST /api/v1/delegations, using this same key, and send it as X-Act-For.',
});

async function insertToken(service: SupabaseClient, row: {
  agentId: string;
  principal: { id: string; name: string };
  identityId: string | null;
  mintedVia: 'identity' | 'session';
  createdBy: string | null;
  createdByKeyId: string | null;
}): Promise<DelegationGrant> {
  const token = `${DELEGATION_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
  const expiresAt = new Date(Date.now() + DELEGATION_TTL_SECONDS * 1000).toISOString();
  const { data, error } = await service.from('delegation_tokens').insert({
    token_hash: await hashApiKey(token),
    agent_id: row.agentId,
    principal_id: row.principal.id,
    identity_id: row.identityId,
    minted_via: row.mintedVia,
    created_by: row.createdBy,
    created_by_key_id: row.createdByKeyId,
    expires_at: expiresAt,
  }).select('id').single();
  if (error) fail(error);
  return { id: (data as Row).id, token, header: 'X-Act-For', agent_id: row.agentId, principal: row.principal, expires_at: expiresAt };
}

/** The person a token may name: an active member who is not an agent. */
async function principalFor(service: SupabaseClient, memberId: string): Promise<{ id: string; name: string }> {
  const { data, error } = await service.from('team_members').select('id, name, role, status').eq('id', memberId).maybeSingle();
  if (error) throw error;
  const row = data as Row | null;
  if (!row) throw forbidden('This account is not verified for any member', { reason: 'identity_not_verified' });
  if (row.status === 'suspended') throw forbidden('The person this account belongs to is suspended', { reason: 'principal_suspended' });
  if (row.role === 'agent') throw forbidden('An agent acts for a person, never for another agent', { reason: 'principal_is_agent' });
  return { id: row.id, name: row.name };
}

/**
 * Whether a chat message from this linked account reached this agent in the
 * last ACT_FOR_PROOF_MINUTES (pm.chat_messages, inbound, routed to it).
 */
export async function wroteLately(service: SupabaseClient, agentId: string, identityId: string): Promise<boolean> {
  const since = new Date(Date.now() - ACT_FOR_PROOF_MINUTES * 60_000).toISOString();
  const { data, error } = await service.from('chat_messages').select('id')
    .eq('direction', 'inbound').eq('agent_id', agentId).eq('identity_id', identityId).gte('created_at', since).limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * The agent's key mints a token for the verified identity of the person who
 * asked it, only when that account wrote to this agent in chat in the last
 * ACT_FOR_PROOF_MINUTES (403 act_for_no_recent_message otherwise).
 */
export async function mintForIdentity(
  service: SupabaseClient,
  agent: { memberId: string; access: AccessContext; keyId: string },
  input: MintDelegationInput,
): Promise<DelegationGrant> {
  if (agent.access.role !== 'agent') {
    throw forbidden('Only an agent\'s key acts for someone', { reason: 'not_an_agent' });
  }
  if (agent.access.principal_id) {
    throw forbidden('A request that already acts for someone cannot mint another token', { reason: 'already_acting_for' });
  }
  const identity = await findIdentity(service, identityKey(input));
  if (!identity || !identity.verified_at) {
    throw forbidden('This account is not verified for any member: ask them to link it first', {
      reason: 'identity_not_verified',
      hint: 'POST /api/v1/identities/link-requests gives a one-time link the person opens while signed in.',
    });
  }
  if (identity.member_id === agent.memberId) throw forbidden('An agent cannot act for itself', { reason: 'principal_is_agent' });
  const principal = await principalFor(service, identity.member_id);
  // Proof the person is asking now: a chat message from this account reached this agent lately.
  if (!(await wroteLately(service, agent.memberId, identity.id as string))) {
    throw forbidden(`This person has not written to you in chat in the last ${ACT_FOR_PROOF_MINUTES} minutes, so you cannot act for them`, {
      reason: 'act_for_no_recent_message',
      within_minutes: ACT_FOR_PROOF_MINUTES,
      hint: 'Mint a pass right after their chat message reaches you (GET /api/v1/chat/messages), or they let you act for them from the app while signed in.',
    });
  }
  return insertToken(service, {
    agentId: agent.memberId, principal, identityId: identity.id, mintedVia: 'identity', createdBy: agent.memberId, createdByKeyId: agent.keyId,
  });
}

/** A signed-in person lets a named agent act for them. The agent must be allowed to act for people. */
export async function mintForSession(
  service: SupabaseClient,
  person: { memberId: string; access: AccessContext },
  agentId: string,
): Promise<DelegationGrant> {
  requireAgentsEnabled(person.access);
  if (person.access.role === 'agent') throw forbidden('An agent acts for a person, never for another agent', { reason: 'principal_is_agent' });
  const { data, error } = await service.from('team_members').select('id, role, status').eq('id', agentId).maybeSingle();
  if (error) throw error;
  const agent = data as Row | null;
  if (!agent || agent.role !== 'agent') throw notFound('Agent');
  if (agent.status === 'suspended') throw forbidden('This agent is suspended', { reason: 'agent_suspended' });
  const agentAccess = await resolveMemberAccess(service, agentId);
  // Another person's personal agent never acts for you.
  if (agentAccess?.principal_id && agentAccess.principal_id !== person.memberId) {
    throw forbidden('This is someone else\'s personal agent', { reason: 'delegate_only' });
  }
  if (!agentAccess || !accessAllows(agentAccess, 'agents.act_for', 'api')) {
    throw forbidden('This agent may not act for people: an Owner grants it Act for a person first', { reason: 'agent_cannot_act_for', needs: 'agents.act_for' });
  }
  const principal = await principalFor(service, person.memberId);
  return insertToken(service, {
    agentId, principal, identityId: null, mintedVia: 'session', createdBy: person.memberId, createdByKeyId: null,
  });
}

export interface ActingFor {
  principalId: string;
  tokenId: string;
  access: AccessContext;
}

/**
 * Checks an X-Act-For token against the key it came with, and answers who it
 * acts for and the access the request then has (the agent's and the
 * person's together).
 */
export async function verifyActFor(
  service: SupabaseClient,
  token: string,
  key: { id: string; team_member_id: string; scopes: string[] | null },
  agentAccess: AccessContext,
): Promise<ActingFor> {
  const value = token.trim();
  if (!value.startsWith(DELEGATION_TOKEN_PREFIX) || value.length > 200) throw actForInvalid('X-Act-For is not a delegation token');
  const { data, error } = await service.from('delegation_tokens').select('id, agent_id, principal_id, expires_at, revoked_at')
    .eq('token_hash', await hashApiKey(value)).maybeSingle();
  if (missingGroupsSchema(error)) throw groupsMigrationPending();
  if (error) throw error;
  const row = data as Row | null;
  if (!row) throw actForInvalid('X-Act-For is not a valid delegation token');
  if (row.revoked_at) throw actForInvalid('This delegation token was revoked');
  if (new Date(row.expires_at).getTime() <= Date.now()) throw actForInvalid('This delegation token expired');
  // Bound to one agent: another agent's key never borrows it.
  if (row.agent_id !== key.team_member_id) throw actForInvalid('This delegation token belongs to another agent');
  // A personal agent already acts for its person (its access is theirs and
  // its own together): a token may only name that same person.
  if (agentAccess.principal_id) {
    if (row.principal_id !== agentAccess.principal_id) {
      throw forbidden('A personal agent acts only for the person it works for', { reason: 'delegate_only' });
    }
    return { principalId: row.principal_id, tokenId: row.id, access: agentAccess };
  }
  const scopes = Array.isArray(key.scopes) ? key.scopes : [];
  if (!scopes.includes('agents.act_for') || !accessAllows(agentAccess, 'agents.act_for', 'api')) {
    throw new ApiError(403, 'FORBIDDEN', 'Acting for someone needs agents.act_for on both this key and its agent', {
      reason: 'missing_key_scope', required: ['agents.act_for'], grant_on: 'api_key_and_member_role',
    });
  }
  const principalAccess = await resolveMemberAccess(service, row.principal_id);
  if (!principalAccess || principalAccess.status !== 'active') {
    throw forbidden('The person this token acts for is suspended', { reason: 'principal_suspended' });
  }
  afterResponse('delegation last_used_at', async () => {
    await service.from('delegation_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', row.id);
  });
  return { principalId: row.principal_id, tokenId: row.id, access: intersectAccess(agentAccess, principalAccess) };
}

/** The agent revokes one of its own tokens. */
export async function revokeDelegation(service: SupabaseClient, agentId: string, tokenId: string): Promise<{ id: string; revoked_at: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(tokenId)) throw notFound('Delegation');
  const revokedAt = new Date().toISOString();
  const { data, error } = await service.from('delegation_tokens').update({ revoked_at: revokedAt })
    .eq('id', tokenId).eq('agent_id', agentId).is('revoked_at', null).select('id').maybeSingle();
  if (error) fail(error);
  if (!data) throw notFound('Delegation');
  return { id: tokenId, revoked_at: revokedAt };
}
