import { answerQuestion } from '@/lib/api/questions';
import { questionsRoute, readQuestionBody } from '@/lib/api/questions-session';
import { answerQuestionSchema } from '@/lib/questions';

export const dynamic = 'force-dynamic';

/** Answers a question from the screen: a choice, text, or both. Same rules as the API. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return questionsRoute(async (ctx) => answerQuestion(ctx, id, await readQuestionBody(request, answerQuestionSchema)));
}
