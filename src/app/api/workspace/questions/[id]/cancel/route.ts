import { cancelQuestion } from '@/lib/api/questions';
import { questionsRoute, readQuestionBody } from '@/lib/api/questions-session';
import { cancelQuestionSchema } from '@/lib/questions';

export const dynamic = 'force-dynamic';

/** Withdraws an open question from the screen: whoever asked it, the Owner, or a team manager. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return questionsRoute(async (ctx) => {
    await readQuestionBody(request, cancelQuestionSchema);
    return cancelQuestion(ctx, id);
  }, { write: true });
}
