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
