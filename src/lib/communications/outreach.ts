/**
 * Outreach is someone selling to us: cold pitches, agencies, lead-gen,
 * recruiters, partnership offers. When the agent reads an email as outreach
 * the app files it in Filtered, unless something guards it. Pure, so the
 * guardrails test as a table (scripts/verify-triage-policy.ts).
 *
 * Never filtered:
 * - a client, a client's colleague, a teammate, the owner, or a live lead
 *   (someone who wants to buy from us is a lead, never outreach);
 * - a sender a person asked to always read in full (an always rule, or
 *   Move to Inbox);
 * - anything about money, an account problem or security;
 * - a conversation someone on our side wrote in, or one already linked to a task.
 */
import type { MailTopic, SortAction } from './sorting';
import type { Speaker } from './triage-policy';

export const TRIAGE_CATEGORIES = ['work', 'fyi', 'outreach'] as const;
export type TriageCategory = typeof TRIAGE_CATEGORIES[number];

export interface OutreachFacts {
  speaker: Speaker;
  sortAction: SortAction | null;
  topic: MailTopic | null;
  /** A teammate or the owner wrote in this conversation. */
  ourSideWrote: boolean;
  /** Some email in this conversation is linked to a task. */
  hasTasks: boolean;
}

export type OutreachPlacement = { filter: true } | { filter: false; kept: string };

const KNOWN: Partial<Record<Speaker, string>> = {
  owner: 'it is from you',
  teammate: 'it is from a teammate',
  client: 'the sender is a client',
  client_colleague: 'the conversation is on a client project',
  prospect: 'the sender is a lead',
};

export function outreachPlacement(facts: OutreachFacts): OutreachPlacement {
  const known = KNOWN[facts.speaker];
  if (known) return { filter: false, kept: known };
  if (facts.sortAction === 'always') return { filter: false, kept: 'a rule says to always read this sender' };
  if (facts.topic === 'money' || facts.topic === 'account_risk' || facts.topic === 'security') {
    return { filter: false, kept: 'it is about money, an account or security' };
  }
  if (facts.ourSideWrote) return { filter: false, kept: 'someone on our side wrote in this conversation' };
  if (facts.hasTasks) return { filter: false, kept: 'the conversation is linked to a task' };
  return { filter: true };
}

/** The line a filtered pitch shows in its thread. */
export function outreachReason(agentName: string): string {
  return `${agentName} filtered this: it reads as someone selling to you.`;
}
