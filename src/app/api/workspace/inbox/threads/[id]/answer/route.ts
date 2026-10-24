import { inboxRoute, readBody } from '@/lib/inbound-email/inbox-route';
import { answerAgentQuestion } from '@/lib/inbound-email/inbox-service';
import { answerQuestionSchema } from '@/lib/inbound-email/schemas';

export const dynamic = 'force-dynamic';

/** A person answers the agent's question on an email; the email goes back to the agent with it. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return inboxRoute(async (ctx) => {
    const body = await readBody(request, answerQuestionSchema);
    return answerAgentQuestion(ctx, id, body.message_id ?? null, body.answer);
  });
}
