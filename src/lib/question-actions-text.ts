/**
 * The words for an answer that does something: a question or approval that
 * carries an action from the app's whitelist (src/lib/api/question-actions.ts).
 * The app composes them from the action's type and details, never from the
 * agent's own text, so the person answering reads exactly what their choice
 * will do before they tap it ("Approving turns time tracking on for Acme
 * Site."). Pure, so the server, the screens and the demo say the same thing.
 */

export interface ActionForWords {
  type: string;
  details: Record<string, unknown>;
  /** The answer that does it: an approval's approve, or one of a question's choices. */
  on_choice: string;
}

export interface ActionWordsContext {
  /** An approval reads "Approving ...", a question "Choosing "Yes" ...". */
  approval: boolean;
  /** The project the action changes, when the reader may see its name; null names it without one. */
  projectName: string | null;
}

/** What the action does, as "turns ..." (does) and "turn ..." (do). */
function effect(action: ActionForWords, projectName: string | null): { does: string; do: string } {
  const place = projectName ?? 'a project you cannot open';
  if (action.type === 'project.update') {
    if (action.details.time_tracking_enabled === true) return { does: `turns time tracking on for ${place}`, do: `turn time tracking on for ${place}` };
    if (action.details.time_tracking_enabled === false) return { does: `turns time tracking off for ${place}`, do: `turn time tracking off for ${place}` };
    return { does: `changes ${place}`, do: `change ${place}` };
  }
  return { does: 'changes something in the app', do: 'change something in the app' };
}

const answering = (action: ActionForWords, approval: boolean) => (approval ? 'Approving' : `Choosing "${action.on_choice}"`);

/** The one sentence shown on the choice that acts: "Approving turns time tracking on for Acme Site." */
export function actionSentence(action: ActionForWords, context: ActionWordsContext): string {
  return `${answering(action, context.approval)} ${effect(action, context.projectName).does}.`;
}

/** Why the reader may not do it, in plain words, from the server's reason. */
function whyNot(reason: string | undefined, projectName: string | null): string {
  if (reason === 'needs projects.manage') return 'you cannot manage projects';
  if (reason === 'project out of reach') return projectName ? `you are not on ${projectName}` : 'you are not on that project';
  if (reason === 'not active') return 'your account is not active';
  return 'you are not allowed to';
}

/**
 * Said instead, to a reader who may answer but cannot do the action: the
 * choice that does it is off for them ("You cannot turn time tracking on for
 * Acme Site (you cannot manage projects), so approving is not open to you.").
 */
export function actionCannotSentence(action: ActionForWords, context: ActionWordsContext & { reason?: string }): string {
  const choice = context.approval ? 'approving' : `choosing "${action.on_choice}"`;
  return `You cannot ${effect(action, context.projectName).do} (${whyNot(context.reason, context.projectName)}), so ${choice} is not open to you.`;
}

/** Text reduced to its words, so a sentence still matches after a chat app's quotes, case or punctuation. */
export function plainWords(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Whether a message shows the sentence, word for word (quotes, case and punctuation aside). */
export function showsSentence(message: string, sentence: string): boolean {
  const want = plainWords(sentence);
  return want.length > 0 && ` ${plainWords(message)} `.includes(` ${want} `);
}
