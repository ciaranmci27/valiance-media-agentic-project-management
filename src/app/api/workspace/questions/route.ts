import { listQuestions } from '@/lib/api/questions';
import { questionsRoute } from '@/lib/api/questions-session';

export const dynamic = 'force-dynamic';

/** How many open questions the screens hold at once. */
const OPEN_LIMIT = 200;

/**
 * The open questions the signed-in member can see, oldest first: ones they
 * asked, ones they were asked, and ones on tasks and projects they can open.
 * The task panel, the cards, My Tasks and the sidebar count all read this.
 */
export async function GET() {
  return questionsRoute(async (ctx) =>
    (await listQuestions(ctx, { status: 'open', offset: 0, limit: OPEN_LIMIT, oldestFirst: true })).rows);
}
