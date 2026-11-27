import type { AccessContext } from '@/lib/access-control';
import { forbidden } from './errors';

/**
 * A person's own decisions over the API (owner decision 2026-11-27): marking
 * an Inbox conversation handled or Not a task, moving it back, answering a
 * decision card, drafts, plan items, Add all, send back, a reply owed done.
 * A person's own key, or their connected AI tool, acts as that person and
 * may make them. An agent never may, company or personal, acting for someone
 * or not: it is not the person, so the decision would not be theirs.
 */
export function assertPersonCaller(access: AccessContext): void {
  if (access.role === 'agent') {
    throw forbidden('Only a person makes this decision', {
      reason: 'people_only',
      hint: "Use the person's own API key or their connected AI tool. An agent can ask them with ask_human instead.",
    });
  }
}

/**
 * Workspace switches an Owner holds in the app by role, not by a permission
 * (Settings > Features, Brand, Region, Security, Assistants, the pause on
 * every agent). Over the API the same: the key's member must be an Owner,
 * and the route's withApi permission still has to be on the key.
 */
export function assertOwnerCaller(access: AccessContext, what: string): void {
  if (access.role !== 'owner') {
    throw forbidden(`Only an Owner ${what}`, { reason: 'owner_only', hint: "Use an Owner's own API key or connected AI tool." });
  }
}
