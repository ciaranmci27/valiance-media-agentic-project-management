import type { InboxQuestion, InboxTriage } from './inbox-types';

/** The longest answer a person can send the agent (the answer endpoint's limit). */
export const ANSWER_MAX = 2000;

/**
 * The decisions an agent's triage asks for, as choices a person picks from.
 * A triage with `questions` uses them as sent; an older one has only the
 * one-line question_for_human, whose "Proposed default: ..." (the agent's
 * rules always write one) becomes the single choice beside "Something else".
 */
export function decisionsOf(triage: Pick<InboxTriage, 'question_for_human' | 'questions'>): { questions: InboxQuestion[]; legacy: boolean } {
  // Stored questions passed the API's checks; a pick out of range still falls back to the first choice.
  if (triage.questions?.length) {
    return {
      questions: triage.questions.map((q) => ({ ...q, recommended: q.recommended >= 0 && q.recommended < q.options.length ? q.recommended : 0 })),
      legacy: false,
    };
  }
  const text = (triage.question_for_human ?? '').trim();
  if (!text) return { questions: [], legacy: true };
  // The last "Proposed default:" wins; a bare "default:" only when there is none (never "default-branch").
  const proposed = [...text.matchAll(/\s*\bproposed\s+default\s*:\s*/gi)].pop();
  const match = proposed ?? /\s*\bdefault\s*:\s*/i.exec(text);
  if (!match) return { questions: [{ question: text, options: [], recommended: 0 }], legacy: true };
  // "(Proposed default: x)" in brackets loses them on both sides; a closing bracket of the choice's own stays.
  const before = text.slice(0, match.index).trim();
  const bracketed = before.endsWith('(');
  const question = bracketed ? before.slice(0, -1).trim() : before;
  const fallback = text.slice(match.index + match[0].length).trim().replace(bracketed ? /\.?\)\.?$/ : /\.$/, '').trim();
  return {
    questions: [{ question: question || text, options: fallback ? [{ label: capitalize(fallback) }] : [], recommended: 0 }],
    legacy: true,
  };
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** What was picked for one question: an option's index, or "something else" with its text. */
export type DecisionPick = { option: number } | { other: string };

/**
 * One answer the agent reads in one go: each question with what was picked,
 * then the note and the reply draft asked for, if any. Taking the agent's own
 * default on an older question reads as "Go with your proposed default.",
 * which its rules treat as exactly that.
 */
export function composeAnswer(input: {
  questions: InboxQuestion[];
  legacy: boolean;
  picks: DecisionPick[];
  note?: string;
  draft?: { instructions: string } | null;
}): string {
  const { questions, legacy, picks } = input;
  const note = input.note?.trim() ?? '';
  const lines: string[] = [];
  if (legacy) {
    const pick = picks[0];
    lines.push(pick && 'other' in pick ? pick.other.trim() : 'Go with your proposed default.');
  } else {
    questions.forEach((question, index) => {
      const pick = picks[index];
      const chosen = !pick ? question.options[question.recommended]?.label
        : 'other' in pick ? pick.other.trim() : question.options[pick.option]?.label;
      const prefix = questions.length > 1 ? `${index + 1}. ` : '';
      lines.push(`${prefix}${question.question} → ${chosen ?? ''}`.trim());
    });
  }
  if (note) lines.push(`Also: ${note}`);
  // What the draft should say travels with the draft request, so the answer stays short.
  if (input.draft) lines.push('I asked for a reply draft too.');
  return lines.join('\n\n');
}
