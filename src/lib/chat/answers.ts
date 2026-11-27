import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveMemberAccess } from '@/lib/api/access';
import { ApiError } from '@/lib/api/errors';
import { getActorClient } from '@/lib/api/supabase-service';
import { answerQuestion } from '@/lib/api/questions';
import { approvalDetailRows } from '@/lib/questions';
import { kickWebhooks } from '@/lib/webhooks/kick';
import type { ChatAdapter, ChatCredentials, ParsedInbound } from './providers/adapter';

/**
 * Answering from chat (20261127004100_chat_answers.sql). When the app
 * delivers a question or an approval to a person's own chat (the delivery
 * point, lib/notification-delivery), the message carries buttons: Approve
 * and Reject, or the question's choices. Pressing one answers it as that
 * person, exactly as the app would:
 *
 * - The provider proved the press is real before this runs (Telegram's
 *   secret token header, Slack's signing secret within its time window:
 *   adapter.verify).
 * - Each button is a single-use token, stored hashed, bound to the question,
 *   the person, the choice and the connection; every button on one message
 *   shares a batch, and the first press uses them all, so a replay does
 *   nothing. Tokens end after 7 days (or with the question).
 * - The chat account that pressed must be the person's own verified linked
 *   account on that provider (and Slack workspace); anyone else's press is
 *   refused and uses nothing.
 * - The answer goes through answerQuestion with the person's own access, so
 *   every rule holds (who may answer, who may decide an approval, an
 *   action they must be able to perform); an approval is recorded with
 *   decided_via chat.
 * - The message is then edited to say what happened ("Approved: Deploy 214
 *   redirect rules"), or "Already answered by Mia." when someone got there
 *   first; the buttons go.
 *
 * This is a person-only action: there is no REST route or MCP tool for it,
 * because it only answers what a person already may answer in the app, by
 * the person's own hand in their own chat. Agents answer through
 * POST /api/v1/questions/{id}/answer.
 */

export const ANSWER_TOKEN_DAYS = 7;
/** The most buttons one message carries (Slack's actions block shows five comfortably). */
export const ANSWER_BUTTONS_MAX = 5;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

export const hashAnswerToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface AnswerButtons {
  batch: string;
  buttons: { label: string; token: string; style?: 'primary' | 'danger' }[];
  /**
   * What the message must also say before these buttons may go with it: an
   * approval's summary and every detail row, whole (as approvalReady asks of
   * every screen). Empty for a question: its choices are the buttons.
   */
  body: string;
  /** One button per row (a question's choices, readable on a phone); Approve and Reject sit side by side. */
  stacked: boolean;
}

/** What an approval approves, as the chat message says it: the summary, then each detail row whole. */
export function approvalBody(action: { summary?: string | null; details?: Record<string, unknown> | null } | null | undefined): string {
  const rows = approvalDetailRows(action as Parameters<typeof approvalDetailRows>[0], { all: true }).rows;
  return [`Approve: ${String(action?.summary ?? '').trim() || 'this request'}`, ...rows.map((row) => `${row.key}: ${row.value}`)].join('\n');
}

/**
 * The buttons for a question delivered to a person on a connection, or null
 * when it is not one to answer from chat: not open, not theirs to answer,
 * a written answer only, too many choices, a template draft to review, or an
 * approval whose summary and detail rows do not fit in `room` characters of
 * the message (then it goes with its link only and is read in full in the
 * app before Approve works, as on every screen).
 */
export async function answerButtonsFor(service: SupabaseClient, input: { questionId: string; memberId: string; connectionId: string; room: number }): Promise<AnswerButtons | null> {
  const { data, error } = await service.from('questions')
    .select('id, kind, status, asked_to, asked_to_group, asked_by, choices, allow_other, action, expires_at')
    .eq('id', input.questionId).maybeSingle();
  if (error || !data) return null;
  const question = data as Row;
  if (question.status !== 'open' || question.asked_by === input.memberId) return null;
  let forThem = question.asked_to === input.memberId;
  if (!forThem && question.asked_to_group) {
    const { data: member } = await service.from('group_members').select('member_id').eq('group_id', question.asked_to_group).eq('member_id', input.memberId).maybeSingle();
    forThem = !!member;
  }
  if (!forThem) return null;
  let choices: { label: string; choice: string; style?: 'primary' | 'danger' }[];
  let body = '';
  if (question.kind === 'approval') {
    if (question.action?.type === 'template_run') return null;
    // Approve only under a message that says, whole, what is approved.
    body = approvalBody(question.action);
    if (body.length > input.room) return null;
    choices = [{ label: 'Approve', choice: 'approve', style: 'primary' }, { label: 'Reject', choice: 'reject', style: 'danger' }];
  } else {
    const list = Array.isArray(question.choices) ? (question.choices as string[]) : [];
    if (list.length === 0 || list.length > ANSWER_BUTTONS_MAX) return null;
    choices = list.map((choice) => ({ label: choice, choice }));
  }
  const ends = Date.now() + ANSWER_TOKEN_DAYS * 86_400_000;
  const expiresAt = new Date(question.expires_at ? Math.min(ends, Date.parse(question.expires_at)) : ends).toISOString();
  const batch = randomUUID();
  const buttons = choices.map((entry) => ({ ...entry, token: randomBytes(16).toString('base64url') }));
  const { error: insertError } = await service.from('chat_answer_tokens').insert(buttons.map((button) => ({
    token_hash: hashAnswerToken(button.token), batch, question_id: question.id, member_id: input.memberId,
    connection_id: input.connectionId, choice: button.choice, expires_at: expiresAt,
  })));
  // Before 20261127004100 there is nowhere to keep tokens: the message goes without buttons.
  if (insertError) return null;
  return { batch, buttons: buttons.map(({ label, token, style }) => ({ label, token, ...(style ? { style } : {}) })), body, stacked: question.kind !== 'approval' };
}

/** Records which message a batch of buttons is on, so a press can edit it. */
export async function recordAnswerMessage(service: SupabaseClient, batch: string, conversationId: string, messageId: string | null): Promise<void> {
  await service.from('chat_answer_tokens').update({ conversation_id: conversationId, external_message_id: messageId }).eq('batch', batch);
}

/** What happened, in one line on the message. */
function outcomeLine(view: Row, choice: string): string {
  const what = String(view.action?.summary ?? view.question ?? '').slice(0, 300);
  if (view.kind === 'approval') return `${choice === 'approve' ? 'Approved' : 'Rejected'}: ${what}`;
  return `Answered "${choice}": ${what}`;
}

export type ButtonOutcome = 'answered' | 'already_handled' | 'not_allowed' | 'expired' | 'used' | 'wrong_person' | 'unknown';

/**
 * A press of an answer button, verified by the caller (handleChatInbound,
 * the Slack actions route). Answers what happened; never throws for a press
 * it can explain.
 */
export async function handleAnswerButton(
  service: SupabaseClient,
  connection: Row,
  adapter: ChatAdapter,
  credentials: ChatCredentials,
  press: Extract<ParsedInbound, { kind: 'button' }>,
): Promise<{ outcome: ButtonOutcome; line: string }> {
  const reply = async (outcome: ButtonOutcome, line: string, edit: { conversationId: string | null; messageId: string | null } | null = null) => {
    if (press.callbackId && adapter.acknowledge) await adapter.acknowledge(credentials, press.callbackId, line);
    const conversationId = edit?.conversationId ?? press.conversationId;
    const messageId = edit?.messageId ?? press.messageId;
    if (edit && conversationId && messageId && adapter.editMessage) {
      try {
        await adapter.editMessage(credentials, { conversationId, messageId, text: line });
      } catch (error) {
        console.error(`[chat] could not edit an answered message on connection ${connection.id}`, (error as Error)?.message);
      }
    }
    return { outcome, line };
  };

  const { data } = await service.from('chat_answer_tokens').select('*').eq('token_hash', hashAnswerToken(press.token)).maybeSingle();
  const token = data as Row | null;
  if (!token || token.connection_id !== connection.id) return reply('unknown', 'This button is no longer valid. Answer in the app.');

  // Only the person it was sent to, on their own verified account here.
  let identity = service.from('member_identities').select('id')
    .eq('member_id', token.member_id).eq('provider', adapter.identityProvider).eq('external_id', press.userId).not('verified_at', 'is', null);
  identity = adapter.hasWorkspaces ? identity.eq('workspace_id', press.workspaceId ?? '') : identity.is('workspace_id', null);
  const { data: mine } = await identity.limit(1);
  if (!((mine ?? []) as Row[]).length) return reply('wrong_person', 'This button is for someone else.');

  if (token.used_at) return reply('used', 'Already answered from this message.');
  if (Date.parse(token.expires_at) <= Date.now()) {
    return reply('expired', 'This button has expired. Answer in the app.', { conversationId: token.conversation_id, messageId: token.external_message_id });
  }
  // The first press uses every button on the message: a second press or a replay finds none left.
  const { data: claimed } = await service.from('chat_answer_tokens').update({ used_at: new Date().toISOString() })
    .eq('batch', token.batch).is('used_at', null).select('id');
  if (!((claimed ?? []) as Row[]).length) return reply('used', 'Already answered from this message.');

  const where = { conversationId: token.conversation_id, messageId: token.external_message_id };
  const access = await resolveMemberAccess(service, token.member_id);
  // The app's session gate keeps out a suspended person; here nothing else would, so it is checked first.
  if (!access || access.status !== 'active' || access.role === 'agent') {
    return reply('not_allowed', 'You can no longer answer this from chat. Open the app to see why.', where);
  }
  try {
    const view = await answerQuestion(
      { db: getActorClient(token.member_id, 'app'), access, memberId: token.member_id, channel: 'app', via: 'chat' },
      token.question_id,
      { choice: token.choice },
    );
    kickWebhooks(access);
    return reply('answered', outcomeLine(view as unknown as Row, token.choice), where);
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 409) return reply('already_handled', error.message, where);
    if (error instanceof ApiError && (error.statusCode === 403 || error.statusCode === 422 || error.statusCode === 404)) {
      return reply('not_allowed', 'You can no longer answer this from chat. Open the app to see why.', where);
    }
    // Nothing was decided: the buttons work again for a retry.
    await service.from('chat_answer_tokens').update({ used_at: null }).eq('batch', token.batch);
    throw error;
  }
}
