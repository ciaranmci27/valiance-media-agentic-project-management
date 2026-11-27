import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { AccessContext } from '@/lib/access-control';
import { actionCannotSentence, actionSentence, showsSentence } from '@/lib/question-actions-text';
import { accessAllows, accessAllowsProject, resolveMemberAccess } from './access';
import { activeGroupMembers } from './groups';
import { ApiError, forbidden } from './errors';

/**
 * Answers that do the thing (pilot finding 2026-11-27): a question or an
 * approval may carry an action from the app's whitelist, which the app
 * performs when it is answered with the choice that does it (on_choice; an
 * approval's approve), with the permissions of whoever answers. No dead end:
 * the person taps once and the thing is done.
 *
 * - Checked when it is asked: its details must be valid and point at
 *   something live, and the one asked must be able to do it (a group: a
 *   person in it), else 422 asked_cannot_perform. The question then lists it
 *   in proposed_actions with asked_may_perform, so an orchestrator recommends
 *   only steps the person can take.
 * - Checked again when answered: an answer that would do it from someone who
 *   cannot is 403 cannot_perform_action (nothing is recorded). Done, the
 *   question records performed { type, status, by, at, result }.
 *
 * The whitelist, each with its safe fields and the permission it needs:
 * - project.update: details { project_id, time_tracking_enabled }; needs
 *   projects.manage and the project in reach.
 * The app's existing approvals that act on decision (template_run, a
 * template draft; agent.use, ask-first) keep their own paths.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

export const PERFORMABLE_ACTION_TYPES = ['project.update'] as const;
export type PerformableActionType = (typeof PERFORMABLE_ACTION_TYPES)[number];

/** project.update's safe fields: what an answer may change on a project. */
export const PROJECT_UPDATE_FIELDS = ['time_tracking_enabled'] as const;

const projectUpdateDetails = z.object({
  project_id: z.uuid('action.details.project_id must be a project id'),
  time_tracking_enabled: z.boolean(),
}).strict();

export const isPerformableType = (type: unknown): type is PerformableActionType =>
  typeof type === 'string' && (PERFORMABLE_ACTION_TYPES as readonly string[]).includes(type);

/** What a question stores: the action, the choice that does it. */
export interface Performs {
  type: PerformableActionType;
  details: Record<string, unknown>;
  on_choice: string;
  summary?: string;
}

/** What a question shows: the action and whether the one asked may do it. */
export interface ProposedAction {
  type: string;
  summary: string | null;
  details: Record<string, unknown>;
  /** The answer that does it: an approval's approve, or one of a question's choices. */
  on_choice: string;
  /** Whether whoever it is asked of (a group: a person in it) may do it. */
  asked_may_perform: boolean;
  /** Why not, in a few words, when they may not. */
  reason?: string;
  /**
   * What answering with on_choice does, composed by the app from the type and
   * details (never the agent's summary): "Approving turns time tracking on for
   * Acme Site." Shown on the choice that acts, before anyone answers.
   */
  sentence: string;
  /** Whether the one reading may do it themselves; their answer with on_choice is refused when not. */
  you_may_perform?: boolean;
  /** Said instead of sentence to a reader who may not do it, in plain words. */
  you_cannot?: string;
}

/** Who is reading a question: their own verdict and the project name they may see. */
export interface ActionReader {
  access: AccessContext;
  channel: 'app' | 'api';
  scopes?: string[];
}

const invalid = (message: string, details?: Record<string, unknown>) => new ApiError(422, 'VALIDATION_ERROR', message, details);

/** Validates an action's details for its type and that what it names is live. */
export async function validatePerforms(db: SupabaseClient, input: { type: string; details?: Record<string, unknown>; summary?: string }, onChoice: string): Promise<Performs> {
  if (!isPerformableType(input.type)) {
    throw invalid(`action.type ${input.type} is not one the app performs: ${PERFORMABLE_ACTION_TYPES.join(', ')}`, { reason: 'action_not_performable', types: PERFORMABLE_ACTION_TYPES });
  }
  const parsed = projectUpdateDetails.safeParse(input.details ?? {});
  if (!parsed.success) {
    throw invalid(`project.update takes details { project_id, ${PROJECT_UPDATE_FIELDS.join(', ')} }`, {
      reason: 'invalid_action_details', fields: PROJECT_UPDATE_FIELDS, issues: parsed.error.issues.map((issue) => issue.message),
    });
  }
  const { data, error } = await db.from('projects').select('id').eq('id', parsed.data.project_id).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  if (!data) throw invalid('action.details.project_id must be a live project', { reason: 'action_project_not_found' });
  return { type: input.type, details: parsed.data, on_choice: onChoice, ...(input.summary ? { summary: input.summary } : {}) };
}

/** Whether a member, by their access on a channel (and a key's scopes on the API), may do it; why not when not. */
export function mayPerform(performs: Performs, access: AccessContext, channel: 'app' | 'api', scopes?: string[]): { allowed: boolean; reason?: string } {
  const projectId = String(performs.details.project_id ?? '');
  const holds = accessAllows(access, 'projects.manage', channel) && (channel === 'app' || (scopes ?? []).includes('projects.manage'));
  if (!holds) return { allowed: false, reason: 'needs projects.manage' };
  if (!accessAllowsProject(access, projectId, channel)) return { allowed: false, reason: 'project out of reach' };
  return { allowed: true };
}

/** Whether a member may do it when they answer in the app (how a person answers). */
async function memberMayPerform(db: SupabaseClient, memberId: string, performs: Performs): Promise<{ allowed: boolean; reason?: string }> {
  const access = await resolveMemberAccess(db, memberId);
  if (!access || access.status !== 'active') return { allowed: false, reason: 'not active' };
  // An agent asked answers with its own key.
  return mayPerform(performs, access, access.role === 'agent' ? 'api' : 'app', access.role === 'agent' ? access.api_permissions : undefined);
}

/** Whether whoever a question is asked of may do it: a member, or any person in a group. */
export async function askedMayPerform(db: SupabaseClient, performs: Performs, to: { asked_to: string | null; asked_to_group?: string | null }, exclude?: string): Promise<{ allowed: boolean; reason?: string }> {
  if (to.asked_to) return memberMayPerform(db, to.asked_to, performs);
  if (!to.asked_to_group) return { allowed: false, reason: 'no one asked' };
  const people = (await activeGroupMembers(db, to.asked_to_group, { peopleOnly: true })).filter((m) => m.id !== exclude);
  let reason: string | undefined;
  for (const person of people) {
    const verdict = await memberMayPerform(db, person.id, performs);
    if (verdict.allowed) return verdict;
    reason = verdict.reason;
  }
  return { allowed: false, reason: reason ?? 'no one in the group' };
}

/** The name of the project an action changes, live, or null. */
async function actionProjectName(db: SupabaseClient, performs: Performs): Promise<string | null> {
  const projectId = performs.details.project_id;
  if (typeof projectId !== 'string') return null;
  const { data, error } = await db.from('projects').select('name').eq('id', projectId).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  return (data as { name?: string } | null)?.name ?? null;
}

/** The sentence a person reads before answering with the choice that acts. */
export async function actionSentenceFor(db: SupabaseClient, row: Row, performs: Performs): Promise<string> {
  return actionSentence(performs, { approval: row.kind === 'approval', projectName: await actionProjectName(db, performs) });
}

/**
 * The proposed action a question shows, with the app's sentence for it and,
 * for the one reading, whether they may do it (said in words when not). The
 * project is named only to a reader it is in reach of.
 */
export async function proposedActions(db: SupabaseClient, row: Row, reader?: ActionReader): Promise<ProposedAction[]> {
  const performs = row.performs as Performs | null | undefined;
  if (!performs || !isPerformableType(performs.type)) return [];
  const [verdict, name] = await Promise.all([
    askedMayPerform(db, performs, { asked_to: row.asked_to, asked_to_group: row.asked_to_group }, row.asked_by),
    actionProjectName(db, performs),
  ]);
  const projectId = String(performs.details.project_id ?? '');
  const projectName = !reader || accessAllowsProject(reader.access, projectId, reader.channel) ? name : null;
  const words = { approval: row.kind === 'approval', projectName };
  const yours = reader ? mayPerform(performs, reader.access, reader.channel, reader.scopes) : null;
  return [{
    type: performs.type,
    summary: performs.summary ?? (row.action?.summary as string | undefined) ?? null,
    details: performs.details,
    on_choice: performs.on_choice,
    asked_may_perform: verdict.allowed,
    ...(verdict.reason && !verdict.allowed ? { reason: verdict.reason } : {}),
    sentence: actionSentence(performs, words),
    ...(yours ? { you_may_perform: yours.allowed } : {}),
    ...(yours && !yours.allowed ? { you_cannot: actionCannotSentence(performs, { ...words, reason: yours.reason }) } : {}),
  }];
}

/**
 * An agent answering for a person (X-Act-For, or a personal assistant) with
 * the choice that acts: the person is in a chat, not looking at the app, so
 * they must have been shown what it does first. One of the agent's chat
 * messages to them since the question was asked must carry the app's
 * sentence, word for word; else 409 action_not_shown with the sentence to send.
 */
export async function assertActionShownInChat(db: SupabaseClient, input: {
  row: Row; performs: Performs; agentId: string; personId: string; personName?: string | null;
}): Promise<void> {
  const sentence = await actionSentenceFor(db, input.row, input.performs);
  const { data, error } = await db.from('chat_messages').select('text')
    .eq('agent_id', input.agentId).eq('member_id', input.personId).eq('direction', 'outbound').neq('status', 'failed')
    .gte('created_at', input.row.created_at).order('created_at', { ascending: false }).limit(200);
  // A database without chat (no table yet): nothing was shown.
  if (error && error.code !== '42P01' && error.code !== 'PGRST205') throw error;
  if (((data ?? []) as { text: string | null }[]).some((message) => showsSentence(message.text ?? '', sentence))) return;
  throw new ApiError(409, 'CONFLICT', `Show ${input.personName ?? 'the person'} what this answer does before you answer for them. Send them this line in chat, word for word, and answer once they confirm: ${sentence}`, {
    reason: 'action_not_shown', sentence,
    hint: 'Send them the sentence in chat (reply_in_chat or send_chat_message), then answer again.',
  });
}

export function cannotPerform(performs: Performs, reason: string | undefined): ApiError {
  return forbidden(`Answering "${performs.on_choice}" would ${describe(performs)}, and you cannot do that (${reason ?? 'not allowed'}).`, {
    reason: 'cannot_perform_action', action_type: performs.type, why: reason ?? null,
    hint: 'Answer with another choice, or ask someone who can.',
  });
}

function describe(performs: Performs): string {
  return performs.details.time_tracking_enabled === true ? 'turn time tracking on for the project'
    : performs.details.time_tracking_enabled === false ? 'turn time tracking off for the project' : 'change the project';
}

/** Does it, as the answerer (their access was checked before the answer was recorded). Answers what changed. */
export async function performAction(db: SupabaseClient, performs: Performs): Promise<Record<string, unknown>> {
  const changes: Row = {};
  for (const field of PROJECT_UPDATE_FIELDS) if (performs.details[field] !== undefined) changes[field] = performs.details[field];
  const { data, error } = await db.from('projects').update(changes).eq('id', performs.details.project_id).is('deleted_at', null).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new ApiError(409, 'CONFLICT', 'The project this answer changes is gone (in Trash).', { reason: 'action_project_not_found' });
  return { project_id: performs.details.project_id, ...changes };
}
