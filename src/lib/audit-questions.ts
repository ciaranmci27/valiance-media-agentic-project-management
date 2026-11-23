/**
 * An auditing agent's question selection is stored as a project context entry
 * starting with AUDIT_QUESTIONS: (for example "AUDIT_QUESTIONS: a, b, c. why").
 * Entries written before 2.0.10 start with the older GREG_QUESTIONS:, still
 * read until agents write the new prefix.
 */
export const AUDIT_SELECTION_PREFIXES = ['AUDIT_QUESTIONS:', 'GREG_QUESTIONS:'] as const;

/** The prefix an entry starts with, or null when it is not a question selection. */
export function auditSelectionPrefix(content: string): string | null {
  return AUDIT_SELECTION_PREFIXES.find((prefix) => content.startsWith(prefix)) ?? null;
}
