import { z } from 'zod';

/**
 * Linked identities: the accounts a member has in other systems (a Slack
 * user, a Teams user, a Telegram id, a chat email), so a chat harness can
 * ask "who is this?" and "how do I reach this person?". A chat account's
 * email is never taken to be the member's sign-in email: an identity is
 * linked only by the person confirming it signed in (link), by an Owner or
 * team manager (admin), or by a directory sync (directory, later). Only
 * verified identities resolve. Client-safe: no server code here.
 */

export const CORE_IDENTITY_PROVIDERS = ['slack', 'teams', 'telegram', 'discord', 'github', 'email'] as const;
/** slack, teams, telegram, discord, github, email, or custom.<name> for anything else. */
export const IDENTITY_PROVIDER_PATTERN = /^(slack|teams|telegram|discord|github|email|custom\.[a-z0-9][a-z0-9_-]{0,39})$/;
export const IDENTITY_VERIFY_METHODS = ['link', 'admin', 'directory'] as const;
export type IdentityVerifyMethod = (typeof IDENTITY_VERIFY_METHODS)[number];

/** How long a link request stays usable. */
export const LINK_REQUEST_TTL_MINUTES = 15;
/** Identities linked in one admin call. */
export const IDENTITY_BATCH_MAX = 500;

export const PROVIDER_LABELS: Record<string, string> = {
  slack: 'Slack',
  teams: 'Microsoft Teams',
  telegram: 'Telegram',
  discord: 'Discord',
  github: 'GitHub',
  email: 'Email',
};

/** A provider as a label: custom.mattermost reads "Mattermost". */
export function providerLabel(provider: string): string {
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider];
  const name = provider.replace(/^custom\./, '').replace(/[_-]+/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** An external id as stored: trimmed, and lowercase for email (addresses compare without case). */
export function normalizeExternalId(provider: string, externalId: string): string {
  const trimmed = externalId.trim();
  return provider === 'email' ? trimmed.toLowerCase() : trimmed;
}

/** A workspace id as stored: trimmed, and null when empty. */
export function normalizeWorkspaceId(workspaceId: string | null | undefined): string | null {
  const trimmed = workspaceId?.trim();
  return trimmed ? trimmed : null;
}

export const providerSchema = z.string().trim().regex(IDENTITY_PROVIDER_PATTERN,
  'provider is slack, teams, telegram, discord, github, email, or custom.<name> (lowercase)');
const externalId = z.string().trim().min(1, 'external_id cannot be empty').max(255);
const workspaceId = z.string().trim().max(255).nullable().optional();
const handle = z.string().trim().min(1).max(255).nullable().optional();

/** POST /api/v1/identities/link-requests: ask a person to prove an identity is theirs. */
export const linkRequestSchema = z.object({
  provider: providerSchema,
  external_id: externalId,
  workspace_id: workspaceId,
  handle,
  /** When the harness already knows who it should be: only that member may confirm. */
  member_id: z.uuid('member_id must be a team member id').optional(),
}).strict();
export type LinkRequestInput = z.infer<typeof linkRequestSchema>;

/** POST /api/v1/identities and /api/workspace/identities: an Owner or team manager links identities in bulk. */
export const adminLinkSchema = z.object({
  identities: z.array(z.object({
    member_id: z.uuid('member_id must be a team member id'),
    provider: providerSchema,
    external_id: externalId,
    workspace_id: workspaceId,
    handle,
    /** Default true. False records it unverified: it is kept, but never resolves. */
    verified: z.boolean().optional(),
  }).strict()).min(1, 'Send at least one identity').max(IDENTITY_BATCH_MAX, `At most ${IDENTITY_BATCH_MAX} at a time`),
}).strict();
export type AdminLinkInput = z.infer<typeof adminLinkSchema>;

/** POST .../identities/{id}/move: the member the account moves to. */
export const moveIdentitySchema = z.object({
  member_id: z.uuid('member_id must be a team member id'),
}).strict();
export type MoveIdentityInput = z.infer<typeof moveIdentitySchema>;

/** A linked identity as the API and the screens show it. */
export interface IdentityView {
  id: string;
  member_id: string;
  provider: string;
  external_id: string;
  workspace_id: string | null;
  handle: string | null;
  verified: boolean;
  verified_at: string | null;
  verified_method: IdentityVerifyMethod | null;
  created_at: string;
}

/** A link request as the confirm page reads it (never the token). */
export interface LinkRequestView {
  provider: string;
  provider_label: string;
  external_id: string;
  workspace_id: string | null;
  handle: string | null;
  expires_at: string;
  /** Who asked for it (the harness's agent), when known. */
  requested_by_name: string | null;
  /** The person started it themselves, by messaging a chat bot (nobody else asked). */
  from_chat: boolean;
  /** open, used, expired, or wrong_member (it names someone else). */
  state: 'open' | 'used' | 'expired' | 'wrong_member';
  /** Set when the identity is already linked to the person reading. */
  already_yours: boolean;
}
