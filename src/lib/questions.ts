import { z } from 'zod';

/**
 * Questions: one member (an agent or a person) asks another and gets the
 * answer back, on a task, on a project, or on nothing. The same shape for the
 * API, MCP and the screens. Client-safe: no server code here.
 *
 * An answer is a choice, free text, or both:
 * - no choices: free text is the answer;
 * - choices with allow_other: a choice, your own words, or both;
 * - choices without allow_other: a choice is required, and text rides along
 *   as a note.
 *
 * An approval is a question of kind 'approval': an agent asks a person to
 * approve an action (a deploy, an email, a spend, a delete, a merge) before
 * it does it. Its choices are always approve and reject, text is an optional
 * note, and it carries the action ({ type, summary, details? }). Only the
 * member asked, or the Owner, decides one. The fields only approvals have
 * (kind, action, decision, decided_by) appear only on approvals, so a plain
 * question reads exactly as it always has.
 */

export const QUESTION_STATUSES = ['open', 'answered', 'cancelled', 'expired'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export const QUESTION_MAX = 2000;
export const ANSWER_MAX = 5000;
export const CHOICE_MAX = 200;
export const CHOICES_MAX = 10;

const choice = z.string().trim().min(1, 'A choice cannot be empty').max(CHOICE_MAX, `A choice is at most ${CHOICE_MAX} characters`);

export const askQuestionSchema = z.object({
  question: z.string().trim().min(1, 'question cannot be empty').max(QUESTION_MAX, `question is at most ${QUESTION_MAX} characters`),
  task_id: z.uuid('task_id must be a uuid').nullable().optional(),
  project_id: z.uuid('project_id must be a uuid').nullable().optional(),
  asked_to: z.uuid('asked_to must be a team member id').optional(),
  choices: z.array(choice).min(1, 'Send 1 to 10 choices, or leave choices out').max(CHOICES_MAX, `At most ${CHOICES_MAX} choices`)
    .refine((list) => new Set(list.map((c) => c.toLowerCase())).size === list.length, 'Each choice must be different')
    .optional(),
  allow_other: z.boolean().optional(),
  expires_at: z.iso.datetime({ offset: true, message: 'expires_at must be an ISO 8601 time' }).optional(),
}).strict();
export type AskQuestionInput = z.infer<typeof askQuestionSchema>;

export const QUESTION_KINDS = ['question', 'approval'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/** An approval's two choices, in the order the screens show them. */
export const APPROVAL_CHOICES = ['approve', 'reject'] as const;
export type ApprovalChoice = (typeof APPROVAL_CHOICES)[number];
export type ApprovalDecision = 'approved' | 'rejected';

export const APPROVAL_SUMMARY_MAX = 300;
/** The action's details, as compact JSON. */
export const APPROVAL_DETAILS_MAX = 4000;

/**
 * What an approval is for. type names the kind of action in your own words
 * (deploy, send_email, spend, delete_data, merge, ...); summary says exactly
 * what will happen, in one line a person can approve; details carries
 * anything else (an amount, a recipient, a PR link) as JSON.
 */
export const approvalActionSchema = z.object({
  type: z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,62}$/, 'action.type is lowercase letters, numbers, dots, dashes and underscores (for example deploy or send_email), at most 63 characters'),
  summary: z.string().trim().min(1, 'action.summary cannot be empty').max(APPROVAL_SUMMARY_MAX, `action.summary is at most ${APPROVAL_SUMMARY_MAX} characters`),
  details: z.record(z.string(), z.unknown())
    .refine((details) => JSON.stringify(details).length <= APPROVAL_DETAILS_MAX, `action.details is at most ${APPROVAL_DETAILS_MAX} characters of JSON`)
    .optional(),
}).strict();
export type ApprovalAction = z.infer<typeof approvalActionSchema>;

export const requestApprovalSchema = z.object({
  action: approvalActionSchema,
  /** Context for the person deciding; the action's summary when left out. */
  question: z.string().trim().min(1, 'question cannot be empty').max(QUESTION_MAX, `question is at most ${QUESTION_MAX} characters`).optional(),
  task_id: z.uuid('task_id must be a uuid').nullable().optional(),
  project_id: z.uuid('project_id must be a uuid').nullable().optional(),
  asked_to: z.uuid('asked_to must be a team member id').optional(),
  expires_at: z.iso.datetime({ offset: true, message: 'expires_at must be an ISO 8601 time' }).optional(),
}).strict();
export type RequestApprovalInput = z.infer<typeof requestApprovalSchema>;

export const APPROVAL_DETAIL_KEY_MAX = 60;
export const APPROVAL_DETAIL_VALUE_MAX = 200;
export const APPROVAL_DETAIL_ROWS_MAX = 20;

/** An action type as a label: send_email reads "Send email". */
export function approvalTypeLabel(type: string): string {
  const words = type.replace(/[_.-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * An approval's details as rows a person reads before deciding: each key with
 * its value as plain text (a string as it is, anything else as compact JSON),
 * cut to a bounded length. At most 20 rows; hidden counts the rest. The
 * screens render these as text, never as markup.
 */
export function approvalDetailRows(action: Pick<ApprovalAction, 'details'> | null | undefined): { rows: { key: string; value: string }[]; hidden: number } {
  const entries = Object.entries(action?.details ?? {});
  const rows = entries.slice(0, APPROVAL_DETAIL_ROWS_MAX).map(([key, value]) => ({
    key: cut(key, APPROVAL_DETAIL_KEY_MAX),
    value: cut(typeof value === 'string' ? value : JSON.stringify(value) ?? String(value), APPROVAL_DETAIL_VALUE_MAX),
  }));
  return { rows, hidden: Math.max(0, entries.length - rows.length) };
}

/** The decision an approval's answer carries: approved, rejected, or none yet. */
export function approvalDecision(answerChoice: string | null | undefined): ApprovalDecision | null {
  if (answerChoice === 'approve') return 'approved';
  if (answerChoice === 'reject') return 'rejected';
  return null;
}

export const answerQuestionSchema = z.object({
  choice: z.string().trim().min(1).max(CHOICE_MAX).optional(),
  text: z.string().trim().min(1, 'text cannot be empty').max(ANSWER_MAX, `text is at most ${ANSWER_MAX} characters`).optional(),
}).strict().refine((a) => a.choice !== undefined || a.text !== undefined, { message: 'Send choice, text, or both' });
export type AnswerQuestionInput = z.infer<typeof answerQuestionSchema>;

export const cancelQuestionSchema = z.object({}).strict();

/** A question as the API and the screens show it. */
export interface QuestionView {
  id: string;
  project_id: string | null;
  project_name: string | null;
  task_id: string | null;
  task_title: string | null;
  asked_by: string;
  asked_by_name: string | null;
  asked_to: string;
  asked_to_name: string | null;
  question: string;
  choices: string[] | null;
  allow_other: boolean;
  /** An open question past expires_at reads as expired. */
  status: QuestionStatus;
  answer_choice: string | null;
  answer_text: string | null;
  answered_by: string | null;
  answered_by_name: string | null;
  answered_at: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  /** For the member reading it: may they answer, may they cancel. */
  can_answer: boolean;
  can_cancel: boolean;
  /** Approvals only: absent on a plain question. */
  kind?: 'approval';
  action?: ApprovalAction;
  /** approved or rejected once decided (the answer's choice), else null. */
  decision?: ApprovalDecision | null;
  /** Who decided (answered_by), once decided. */
  decided_by?: string | null;
  decided_by_name?: string | null;
}

/** The status a reader sees: an open question past its expiry is expired. */
export function effectiveQuestionStatus(row: { status: string; expires_at?: string | null }, now = Date.now()): QuestionStatus {
  if (row.status === 'open' && row.expires_at && new Date(row.expires_at).getTime() <= now) return 'expired';
  return (QUESTION_STATUSES as readonly string[]).includes(row.status) ? row.status as QuestionStatus : 'open';
}

/** Whether free text is accepted as the answer on its own. */
export function textAnswers(question: Pick<QuestionView, 'choices' | 'allow_other'>): boolean {
  return !question.choices?.length || question.allow_other;
}

/** The answer in one plain line: "Yes", "Yes: ship Friday", or the text. */
export function answerLine(question: Pick<QuestionView, 'answer_choice' | 'answer_text'>): string {
  if (question.answer_choice && question.answer_text) return `${question.answer_choice}: ${question.answer_text}`;
  return question.answer_choice ?? question.answer_text ?? '';
}
