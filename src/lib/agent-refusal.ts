/**
 * The plain words for a database refusal to give an agent work from the app
 * (pm.guard_agent_assignment: agent_not_available or agent_ask_first, with a
 * hint), or null for any other error. Pure, so the screens show the reason
 * instead of a generic failure.
 */
/** Whether an error is the database refusing to give an agent work (not any other failure). */
export function isAgentRefusal(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && /agent_(?:not_available|ask_first):/.test(message);
}

/** Whether the refusal is "asks its managers first": the server can ask them. */
export function isAskFirstRefusal(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && /agent_ask_first:/.test(message);
}

export function agentRefusalWords(error: unknown): string | null {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== 'string') return null;
  const match = /agent_(?:not_available|ask_first): ([^\n]+)/.exec(message);
  if (!match) return null;
  const hint = (error as { hint?: unknown } | null)?.hint;
  const sentence = match[1].trim().replace(/^./, (first) => first.toUpperCase()).replace(/\.?$/, '.');
  return typeof hint === 'string' && hint.trim() ? `${sentence} ${hint.trim()}` : sentence;
}
