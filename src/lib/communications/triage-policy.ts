/**
 * The triage policy: for each item of an agent's plan, whether the app
 * applies it, applies it as unsure (shown as unsure, one tap to undo),
 * proposes it (it waits for a person) or rejects it. Pure: the caller
 * gathers the facts (who is speaking, the project's scope source, who set a
 * field) and stores the decision with its reason.
 *
 * The rules, in order (app/COMMUNICATIONS.md, Triage plans):
 * 1. Some items need a particular speaker: only Ciaran mutes a conversation;
 *    only Ciaran or a teammate undoes an earlier item. Nothing a client says
 *    deletes or reverts anything.
 * 2. Ciaran writing to Ashley is an instruction: applied. His own mail copied
 *    to the inbox yields only his promises, what he waits on and context; his
 *    forward with no note only links and context.
 * 3. A suspicious message, or an untrusted sender, only proposes. An unknown
 *    sender proposes anything about money, access or the account.
 * 4. A blind copy applies nothing but filing; broadcast mail only feeds
 *    account risk, money and context.
 * 5. Strangers and prospects reach no client work: their items propose.
 * 6. A finished project takes no new tasks; a project outside the message's
 *    scope is proposed, never refused.
 * 7. Each type's own rule: facts and mappings and leads propose; field
 *    changes are unsure when the agent set the old value, proposed when a
 *    person did.
 * 8. Low confidence, or work aimed at someone other than Ciaran or the
 *    agency, applies as unsure.
 */

export const PLAN_ITEM_TYPES = [
  'create_task', 'update_task', 'comment', 'attach_file',
  'add_reminder', 'update_reminder', 'complete_reminder',
  'link_task', 'file_project', 'reply_owed', 'revert_item', 'mute_conversation',
  'add_context', 'propose_mapping', 'create_lead', 'log_interaction', 'ask',
] as const;
export type PlanItemType = typeof PLAN_ITEM_TYPES[number];

export const PLAN_INTENTS = [
  'new_work', 'change', 'handoff', 'waiting_on', 'commitment', 'reply_owed',
  'owner_instruction', 'new_business', 'money', 'account_risk', 'context', 'noise',
] as const;
export type PlanIntent = typeof PLAN_INTENTS[number];

export const ADDRESSEES = ['ciaran', 'agency', 'teammate', 'client', 'other'] as const;
export type Addressee = typeof ADDRESSEES[number];

export type Speaker = 'owner' | 'teammate' | 'client' | 'client_colleague' | 'prospect' | 'vendor' | 'machine' | 'stranger';
export type Trust = 'trusted' | 'untrusted' | 'unknown';
export type Delivery = 'direct' | 'group' | 'cc' | 'bcc' | 'forwarded' | 'broadcast';
export type Decision = 'apply' | 'apply_unsure' | 'propose' | 'reject';

export interface PolicyMessage {
  speaker: Speaker;
  trust: Trust;
  delivery: Delivery | null;
  /** Ashley's address is a main recipient, or she is named. */
  addressedToAshley: boolean;
  /** The plan marks the message as an attack or an impostor. */
  suspicious: boolean;
  /** Ciaran forwarded something without a note of his own. */
  ownerForwardWithoutNote?: boolean;
}

export interface PolicyItem {
  type: PlanItemType;
  intent: PlanIntent;
  addressee: Addressee;
  confidence: 'sure' | 'unsure';
  /** The item names a project (or acts on a task, which has one). */
  hasProject: boolean;
  /** How the message may touch that project (scope_source), null when it may not. */
  projectSource: string | null;
  projectStatus?: 'active' | 'completed' | 'archived' | null;
  /** update_task: the fields it changes. */
  changes?: string[];
  /** update_task: a person (not an agent) set a field it changes. */
  changesPersonSet?: boolean;
  /** update_task description, revert_item: the target is the agent's own and no person touched it since. */
  targetUntouched?: boolean;
  /** update_task: a teammate moving their own task to in_review. */
  teammateOwnReview?: boolean;
}

export interface PolicyDecision {
  decision: Decision;
  reason: string;
}

const OWNER_COPIED_INTENTS: PlanIntent[] = ['commitment', 'waiting_on', 'context'];
const FILING_TYPES: PlanItemType[] = ['link_task', 'file_project'];
const SENSITIVE_INTENTS: PlanIntent[] = ['money', 'account_risk'];
/** Fields an email never changes on its own: they wait for a person. */
const PERSON_FIELDS = ['assignee_ids', 'status', 'ai_readiness', 'acceptance_criteria', 'readiness'];

const decided = (decision: Decision, reason: string): PolicyDecision => ({ decision, reason });

export function decideItem(message: PolicyMessage, item: PolicyItem): PolicyDecision {
  // An item that is noise has nothing to do.
  if (item.intent === 'noise') return decided('reject', 'Noise produces nothing.');

  // 1. Items that need a particular speaker.
  const instruction = message.speaker === 'owner' && message.addressedToAshley && !message.ownerForwardWithoutNote;
  if (item.type === 'mute_conversation' && !instruction) return decided('reject', 'Only Ciaran mutes a conversation.');
  if (item.type === 'revert_item' && !instruction && message.speaker !== 'teammate') {
    return decided('reject', 'Only Ciaran or a teammate undoes earlier work; a client\'s cancel is a comment and a reply owed.');
  }

  // 2. Ciaran.
  if (message.speaker === 'owner') {
    if (instruction) {
      if (item.projectStatus && item.projectStatus !== 'active' && item.type === 'create_task') {
        return decided('propose', 'The project is finished; Ciaran confirms a new task on it.');
      }
      return decided('apply', 'Ciaran asked for it.');
    }
    if (message.ownerForwardWithoutNote) {
      return [...FILING_TYPES, 'add_context'].includes(item.type)
        ? decided('apply', 'Context from Ciaran\'s forward.')
        : decided('reject', 'A forward with no note is context: nothing is created from what it quotes.');
    }
    return OWNER_COPIED_INTENTS.includes(item.intent) || FILING_TYPES.includes(item.type)
      ? decided(item.confidence === 'unsure' ? 'apply_unsure' : 'apply', 'From Ciaran\'s own mail.')
      : decided('reject', 'Ciaran\'s own copied mail only yields his promises, what he waits on, and context.');
  }

  // 3. Trust.
  if (message.suspicious) return decided('propose', 'The message looks suspicious, so nothing applies on its own.');
  if (message.trust === 'untrusted') return decided('propose', 'The sender is not verified, so nothing applies on its own.');
  if (message.trust === 'unknown' && SENSITIVE_INTENTS.includes(item.intent) && message.speaker !== 'machine') {
    return decided('propose', 'Money or account matters from an unverified sender wait for Ciaran.');
  }

  // 4. Delivery.
  if (message.delivery === 'bcc' && !FILING_TYPES.includes(item.type)) {
    return decided('reject', 'A blind copy is filed and summarised, nothing more.');
  }
  if (message.delivery === 'broadcast' && !SENSITIVE_INTENTS.includes(item.intent)
    && !(['context'] as PlanIntent[]).includes(item.intent) && !FILING_TYPES.includes(item.type)) {
    return decided('reject', 'Bulk mail feeds account risk, money and context only.');
  }

  // 5. Strangers and prospects.
  if (message.speaker === 'stranger' && !['ask', 'propose_mapping', 'create_lead', 'reply_owed'].includes(item.type)) {
    return decided('propose', 'An unknown sender reaches no client work until Ciaran says so.');
  }
  if (message.speaker === 'prospect' && ['create_task', 'update_task', 'revert_item'].includes(item.type)) {
    return decided('propose', 'A prospect is not a client yet.');
  }

  // 6. The project.
  if (item.type === 'create_task' && item.projectStatus && item.projectStatus !== 'active') {
    return decided('reject', 'A finished project takes no new tasks: raise a reply owed decision instead.');
  }
  if (item.hasProject && item.projectSource === null && !['reply_owed', 'ask'].includes(item.type)) {
    return decided('propose', 'This message may not touch that project on its own; Ciaran confirms it.');
  }

  // 7. The type's own rule.
  let decision: PolicyDecision;
  switch (item.type) {
    case 'add_context':
    case 'propose_mapping':
    case 'create_lead':
      decision = decided('propose', 'Facts, mappings and leads wait for Ciaran.');
      break;
    case 'update_task': {
      const changes = item.changes ?? [];
      if (item.teammateOwnReview && changes.length === 1 && changes[0] === 'status') {
        decision = decided('apply_unsure', 'A teammate reported their own task ready for review.');
      } else if (changes.some((field) => PERSON_FIELDS.includes(field))) {
        decision = decided('propose', 'Assignment, readiness and status change only with Ciaran.');
      } else if (changes.includes('description') && !item.targetUntouched) {
        decision = decided('reject', 'Only the agent\'s own untouched draft has its description rewritten; comment instead.');
      } else if (item.changesPersonSet) {
        decision = decided('propose', 'A person set what this changes.');
      } else {
        decision = decided('apply_unsure', 'Changes what the agent set.');
      }
      break;
    }
    case 'revert_item':
      decision = item.targetUntouched === false
        ? decided('propose', 'A person has worked on it since.')
        : decided('apply', 'Undone as asked.');
      break;
    default:
      decision = decided('apply', 'Within scope.');
  }

  // 8. Unsure: low confidence, or work aimed at someone else.
  if (decision.decision === 'apply' && (item.confidence === 'unsure' || ['teammate', 'client', 'other'].includes(item.addressee))) {
    return decided('apply_unsure', item.confidence === 'unsure' ? 'Applied, not sure.' : 'Applied; it is aimed at someone other than Ciaran.');
  }
  return decision;
}
