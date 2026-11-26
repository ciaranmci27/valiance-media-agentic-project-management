import { NextResponse } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { hireAgent } from '@/lib/api/agent-workspace';
import { appUrlFor } from '@/lib/team/invite';
import { hireAgentSchema, type HireAgent } from '@/lib/schemas/agent-workspaces';

/**
 * Hires an agent in one call, exactly as the Hire an agent screen does
 * (POST /api/workspace/agents, hireAgent): the agent with no sign-in, its
 * template's role, profile and rules, its owners (the caller when none are
 * named), project access and assignments with settings checked against the
 * template, optionally a key (its secret in this answer only; a scope the
 * agent role lacks is given to this agent first, by an Owner only:
 * scopes_beyond_role), and how its host connects. Everything is checked
 * before the first write; a failure after it undoes what the call made
 * (reason hire_incomplete). The key it makes carries only scopes the calling
 * key may grant. Never cached; no Idempotency-Key (the answer holds a secret).
 *
 * Permission: team.manage, by an Owner, with the AI agents module on.
 */
export const POST = withApi<HireAgent>(async ({ supabase, body, access, scopes, apiKeyId, teamMemberId, origin }) => {
  const caller = { memberId: teamMemberId, access, scopes };
  const result = await hireAgent(supabase, caller, caller, body, appUrlFor(origin), { apiKeyId });
  return NextResponse.json({ success: true, data: result }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
}, { schema: hireAgentSchema, permission: 'team.manage', returnsSecret: true });
