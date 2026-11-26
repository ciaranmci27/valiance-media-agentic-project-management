import { listQuestions } from '@/lib/api/questions';
import { questionsRoute } from '@/lib/api/questions-session';
import type { QuestionView } from '@/lib/questions';

export const dynamic = 'force-dynamic';

/** How many other open questions (not asked to the member) the screens hold at once, newest kept. */
const OPEN_LIMIT = 200;
/** Asked to the member: read a page at a time, every one (bounded far past any real queue). */
const ASKED_PAGE = 500;
const ASKED_PAGES_MAX = 10;
/** How many decided questions the Decided view lists. */
const DECIDED_LIMIT = 60;

/**
 * The open questions the signed-in member can see, oldest first: ones they
 * asked, ones they were asked, and ones on tasks and projects they can open.
 * The task panel, the cards, My Tasks and the sidebar count all read this.
 * Every question asked to the member (or a group they are in) is included,
 * however many; the rest are the newest OPEN_LIMIT, so a busy workspace
 * never pushes a question waiting on this person off the list.
 *
 * ?view=decided: questions and approvals answered lately (newest first), for
 * the Agents page's Decided view.
 */
export async function GET(request: Request) {
  const view = new URL(request.url).searchParams.get('view');
  if (view === 'decided') {
    return questionsRoute(async (ctx) =>
      (await listQuestions(ctx, { status: 'answered', offset: 0, limit: DECIDED_LIMIT })).rows);
  }
  return questionsRoute(async (ctx) => {
    const askedToMe: QuestionView[] = [];
    for (let page = 0; page < ASKED_PAGES_MAX; page++) {
      const { rows, total } = await listQuestions(ctx, {
        status: 'open', askedTo: ctx.memberId, offset: page * ASKED_PAGE, limit: ASKED_PAGE, oldestFirst: true,
      });
      askedToMe.push(...rows);
      if (rows.length < ASKED_PAGE || (page + 1) * ASKED_PAGE >= total) break;
    }
    const others = (await listQuestions(ctx, { status: 'open', offset: 0, limit: OPEN_LIMIT })).rows;
    const byId = new Map<string, QuestionView>();
    for (const question of [...askedToMe, ...others]) byId.set(question.id, question);
    return [...byId.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  });
}
