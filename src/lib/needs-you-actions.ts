'use client';

import { useMemo } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { createClient } from '@/lib/supabase/client';
import { invalidateTables, peekRead, setReadData } from '@/lib/query-cache';
import { blockedCommentsRead, decidedQuestionsRead, mySnoozesRead, openQuestionsRead } from '@/lib/reads';
import { demoDecidedQuestions } from '@/lib/demo-agents-home';
import { demoMarkDone, demoMarkGroupDone, demoMarkGroupRead, demoMarkRead, demoSnooze, demoUnsnooze } from '@/lib/demo-notifications';
import type { QuestionView } from '@/lib/questions';
import type { Snooze, SnoozeKind } from '@/lib/notifications';
import type { AiReadiness } from '@/lib/types';

/**
 * The one action layer for what waits on a person: answer a question,
 * approve or reject an approval, withdraw one, accept or decline a
 * suggestion, reply to an agent stuck on a task, snooze anything, and mark notifications read or done. Every
 * surface (a question card, Needs you rows, My Tasks, the notifications
 * page, later the bell's popover) acts through these, so each action has
 * one behaviour everywhere. Headless: no markup, no toasts.
 *
 * - Who may act is decided on the server (the question routes, row
 *   security on suggestions and notifications); nothing here decides it.
 * - optimistic (the default) takes the item off every list at once and puts
 *   it back if the server refuses; a card that shows its own outcome line
 *   first passes optimistic: false and the list refreshes after.
 * - Someone else got there first (409): the item leaves, and the result
 *   says who handled it ("Already answered by Mia."), never an error.
 */

export type ActionResult<T> =
  | { status: 'done'; data: T }
  /** Decided, withdrawn or reviewed meanwhile by someone else: the item has left. */
  | { status: 'handled'; message: string }
  | { status: 'failed'; message: string };

export interface ActionOptions {
  /** Take the item off the lists before the server answers (default true). */
  optimistic?: boolean;
}

/** A refused write, with its HTTP status. */
export class ActionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** POSTs (or DELETEs) JSON to a workspace route and answers its data, or throws ActionError with the server's words. */
export async function sendJson<T>(path: string, body: unknown, method: 'POST' | 'PATCH' | 'DELETE' = 'POST'): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as { data?: T; error?: string | { message?: string } } | null;
  if (!response.ok || !payload || payload.data === undefined) {
    const message = typeof payload?.error === 'string' ? payload.error : payload?.error?.message;
    throw new ActionError(message || 'Something went wrong. Try again.', response.status);
  }
  return payload.data;
}

function failure<T>(error: unknown, fallback: string): ActionResult<T> {
  if (error instanceof ActionError && error.status === 409) return { status: 'handled', message: error.message };
  return { status: 'failed', message: error instanceof Error && error.message ? error.message : fallback };
}

/** Takes a question off the open list; answers how to put it back where it was. */
function removeOpenQuestion(isDemo: boolean, id: string): () => void {
  const read = openQuestionsRead(isDemo);
  const before = peekRead(read);
  const index = before?.findIndex((q) => q.id === id) ?? -1;
  const removed = index >= 0 ? before![index] : null;
  setReadData(read, (open) => (open ?? []).filter((q) => q.id !== id));
  return () => {
    if (!removed) return;
    setReadData(read, (open) => {
      const list = open ?? [];
      if (list.some((q) => q.id === id)) return list;
      const next = [...list];
      next.splice(Math.min(index, next.length), 0, removed);
      return next;
    });
  };
}

/** The demo writes nothing: a decision moves the question from the open list to Decided in the browser. */
export function demoDecide(question: QuestionView, memberId: string | null, body: { choice?: string; text?: string }): QuestionView {
  const now = new Date().toISOString();
  const decided: QuestionView = {
    ...question,
    status: 'answered',
    answer_choice: body.choice ?? null,
    answer_text: body.text ?? null,
    answered_by: memberId,
    answered_by_name: null,
    answered_at: now,
    can_answer: false,
    can_cancel: false,
    ...(question.kind === 'approval' ? { decision: body.choice === 'approve' ? 'approved' : 'rejected', decided_by: memberId, decided_via: 'app' } : {}),
  };
  setReadData(openQuestionsRead(true), (open) => (open ?? []).filter((q) => q.id !== question.id));
  setReadData(decidedQuestionsRead(true), (list) => [decided, ...(list ?? demoDecidedQuestions())]);
  return decided;
}

const QUESTION_TABLES = ['questions', 'team_member_notifications'];

export interface NeedsYouActions {
  /** Answers a question: a choice, words, or both. */
  answer: (question: QuestionView, body: { choice?: string; text?: string }, options?: ActionOptions) => Promise<ActionResult<QuestionView>>;
  /** Approves or rejects an approval, with an optional note. */
  decide: (question: QuestionView, decision: 'approve' | 'reject', note?: string, options?: ActionOptions) => Promise<ActionResult<QuestionView>>;
  /** Withdraws a question or approval request (the asker, the Owner or a team manager). */
  cancel: (question: QuestionView, options?: ActionOptions) => Promise<ActionResult<QuestionView>>;
  /** Accepts a suggested task, making the task. */
  acceptSuggestion: (id: string, overrides?: SuggestionOverrides) => Promise<ActionResult<true>>;
  /** Declines a suggestion: quietly, or with a reason the agent learns from. */
  declineSuggestion: (id: string, reason?: string) => Promise<ActionResult<true>>;
  /** Replies to an agent's blocked comment on its task: the reply answers it, so it leaves Needs you. */
  replyToBlocked: (block: { taskId: string; commentId: string }, text: string) => Promise<ActionResult<true>>;
  /** Hides an item until a time. */
  snooze: (kind: SnoozeKind, id: string, until: Date) => Promise<ActionResult<Snooze>>;
  /** Brings a snoozed item back now. */
  unsnooze: (kind: SnoozeKind, id: string) => Promise<ActionResult<true>>;
  /** Marks notifications read (every unread one with 'all', one group's with { group }). */
  markRead: (ids: readonly string[] | 'all' | { group: string }) => Promise<ActionResult<true>>;
  /** Marks notifications done, read too (every open Update with 'all', one group's with { group }), or not done again. */
  markDone: (ids: readonly string[] | 'all' | { group: string }, done?: boolean) => Promise<ActionResult<{ updated: number }>>;
}

export type SuggestionOverrides = { priority?: string; assigned_to?: string | null; due_date?: string | null; project_id?: string; task_type?: string | null; ai_readiness?: AiReadiness | null };

/** What the action layer acts with: who, whether this is the demo, and the store's suggestion writes. */
export interface ActionDeps {
  isDemoMode: boolean;
  teamMemberId: string | null;
  approveSuggestion: (id: string, overrides: SuggestionOverrides, reviewedBy: string) => Promise<boolean>;
  declineSuggestion: (id: string, reviewedBy: string) => Promise<boolean>;
  rejectSuggestion: (id: string, reason: string | undefined, reviewedBy: string) => Promise<boolean>;
  /** The store's comment write (optimistic on the task; answers whether the server kept it). */
  addComment: (taskId: string, text: string, userId: string) => Promise<boolean>;
}

/** The action layer for the signed-in person. */
export function useNeedsYouActions(): NeedsYouActions {
  const { approveSuggestion, declineSuggestion, rejectSuggestion, addComment } = useApp();
  const { teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  return useMemo(
    () => createNeedsYouActions({ isDemoMode, teamMemberId: teamMemberId ?? null, approveSuggestion, declineSuggestion, rejectSuggestion, addComment }),
    [approveSuggestion, declineSuggestion, rejectSuggestion, addComment, teamMemberId, isDemoMode],
  );
}

/** The actions, outside React (the hook memoizes them; tests call this directly). */
export function createNeedsYouActions(deps: ActionDeps): NeedsYouActions {
  const { isDemoMode, teamMemberId, approveSuggestion, declineSuggestion, rejectSuggestion, addComment } = deps;
  const decideQuestion = async (question: QuestionView, body: { choice?: string; text?: string }, options: ActionOptions = {}): Promise<ActionResult<QuestionView>> => {
    if (isDemoMode) return { status: 'done', data: demoDecide(question, teamMemberId ?? null, body) };
    const restore = options.optimistic === false ? null : removeOpenQuestion(false, question.id);
    try {
      const data = await sendJson<QuestionView>(`/api/workspace/questions/${question.id}/answer`, body);
      // Live sync does this too; a write it misses still refreshes the lists and the bell.
      invalidateTables(QUESTION_TABLES);
      return { status: 'done', data };
    } catch (error) {
      const result = failure<QuestionView>(error, 'Could not send the answer');
      if (result.status === 'failed') restore?.();
      // Handled elsewhere: fetch the lists again so the item leaves with the server's state.
      else invalidateTables(QUESTION_TABLES);
      return result;
    }
  };

  const actions: NeedsYouActions = {
    answer: decideQuestion,
    decide: (question, decision, note, options) =>
      decideQuestion(question, { choice: decision, ...(note?.trim() ? { text: note.trim() } : {}) }, options),
    cancel: async (question, options = {}) => {
      if (isDemoMode) {
        setReadData(openQuestionsRead(true), (open) => (open ?? []).filter((q) => q.id !== question.id));
        return { status: 'done', data: { ...question, status: 'cancelled' } };
      }
      const restore = options.optimistic === false ? null : removeOpenQuestion(false, question.id);
      try {
        const data = await sendJson<QuestionView>(`/api/workspace/questions/${question.id}/cancel`, {});
        invalidateTables(QUESTION_TABLES);
        return { status: 'done', data };
      } catch (error) {
        const result = failure<QuestionView>(error, 'Could not cancel the question');
        if (result.status === 'failed') restore?.();
        else invalidateTables(QUESTION_TABLES);
        return result;
      }
    },
    // The store's suggestion writes are already optimistic with rollback,
    // checked by row security, and resync a row someone else reviewed.
    acceptSuggestion: async (id, overrides = {}) => (await approveSuggestion(id, overrides, teamMemberId || ''))
      ? { status: 'done', data: true }
      : { status: 'failed', message: 'Could not approve the suggestion' },
    declineSuggestion: async (id, reason) => {
      const ok = reason?.trim()
        ? await rejectSuggestion(id, reason.trim(), teamMemberId || '')
        : await declineSuggestion(id, teamMemberId || '');
      return ok ? { status: 'done', data: true } : { status: 'failed', message: 'Could not decline the suggestion' };
    },
    replyToBlocked: async ({ taskId, commentId }, text) => {
      const words = text.trim();
      if (!words) return { status: 'failed', message: 'Write a reply first' };
      if (!teamMemberId) return { status: 'failed', message: 'Sign in to reply' };
      // The demo works its blocks out from its tasks, so the reply itself clears it there.
      const read = isDemoMode ? null : blockedCommentsRead();
      const before = read ? peekRead(read) : undefined;
      if (read) setReadData(read, (list) => (list ?? []).filter((b) => b.comment_id !== commentId));
      const ok = await addComment(taskId, words, teamMemberId);
      if (!ok) {
        if (read) setReadData(read, () => before ?? []);
        return { status: 'failed', message: 'Could not send the reply' };
      }
      if (read) invalidateTables(['task_comments']);
      return { status: 'done', data: true };
    },
    snooze: async (kind, id, until) => {
      const snooze: Snooze = { item_kind: kind, item_id: id, until: until.toISOString() };
      const read = mySnoozesRead(isDemoMode);
      const before = peekRead(read);
      const put = (list: Snooze[] | undefined) => [...(list ?? []).filter((s) => !(s.item_kind === kind && s.item_id === id)), snooze];
      if (isDemoMode) {
        demoSnooze(snooze);
        setReadData(read, put);
        invalidateTables(['member_snoozes']);
        return { status: 'done', data: snooze };
      }
      setReadData(read, put);
      try {
        const data = await sendJson<Snooze>('/api/workspace/notifications/snoozes', snooze);
        invalidateTables(['member_snoozes']);
        return { status: 'done', data };
      } catch (error) {
        setReadData(read, () => before ?? []);
        return failure<Snooze>(error, 'Could not snooze it');
      }
    },
    unsnooze: async (kind, id) => {
      const read = mySnoozesRead(isDemoMode);
      const before = peekRead(read);
      setReadData(read, (list) => (list ?? []).filter((s) => !(s.item_kind === kind && s.item_id === id)));
      if (isDemoMode) {
        demoUnsnooze(kind, id);
        invalidateTables(['member_snoozes']);
        return { status: 'done', data: true };
      }
      try {
        await sendJson('/api/workspace/notifications/snoozes', { item_kind: kind, item_id: id }, 'DELETE');
        invalidateTables(['member_snoozes']);
        return { status: 'done', data: true };
      } catch (error) {
        setReadData(read, () => before ?? []);
        return failure<true>(error, 'Could not bring it back');
      }
    },
    markRead: async (ids) => {
      if (isDemoMode) {
        if (typeof ids === 'object' && 'group' in ids) demoMarkGroupRead(ids.group);
        else demoMarkRead(ids);
      } else if (typeof ids === 'object' && 'group' in ids) {
        try {
          await sendJson('/api/workspace/notifications', { group_key: ids.group });
        } catch {
          invalidateTables(['team_member_notifications']);
          return { status: 'failed', message: 'Could not mark it read' };
        }
      } else {
        // Row security keeps this to the person's own notifications.
        const query = createClient().from('team_member_notifications').update({ is_read: true });
        const { error } = await (ids === 'all' ? query.eq('is_read', false) : query.in('id', [...ids]));
        if (error) {
          invalidateTables(['team_member_notifications']);
          return { status: 'failed', message: 'Could not mark it read' };
        }
      }
      // Written after the write commits, so every read refetches the new truth.
      invalidateTables(['team_member_notifications']);
      return { status: 'done', data: true };
    },
    markDone: async (ids, done = true) => {
      if (isDemoMode) {
        if (typeof ids === 'object' && 'group' in ids) demoMarkGroupDone(ids.group);
        else demoMarkDone(ids, done);
        invalidateTables(['team_member_notifications']);
        return { status: 'done', data: { updated: ids === 'all' || !Array.isArray(ids) ? 0 : ids.length } };
      }
      try {
        const body = ids === 'all' ? { all: true } : 'group' in ids ? { group_key: ids.group } : { ids: [...ids], done };
        const data = await sendJson<{ updated: number }>('/api/workspace/notifications/done', body);
        invalidateTables(['team_member_notifications']);
        return { status: 'done', data };
      } catch (error) {
        invalidateTables(['team_member_notifications']);
        return failure<{ updated: number }>(error, 'Could not mark it done');
      }
    },
  };
  return actions;
}
