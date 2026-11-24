import { NextResponse } from 'next/server';
import { ZodError, type z } from 'zod';
import { requireSessionAccess } from './access';
import { ApiError } from './errors';
import { getActorClient } from './supabase-service';
import type { QuestionsContext } from './questions';
import { kickWebhooks } from '@/lib/webhooks/kick';

/**
 * The session-route shell for questions: a signed-in member, writes named as
 * them, the plain { data } / { error } shape, and the service's ApiErrors
 * mapped to their status. Who may see, answer or cancel is decided in the
 * service, by the same rules as the API. A write sends the webhook events it
 * queued (question.answered, question.cancelled) once the response is out.
 */
export async function questionsRoute<T>(
  handler: (ctx: QuestionsContext) => Promise<T>,
  options?: { write?: boolean },
): Promise<NextResponse> {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, memberId } = auth.data;
  try {
    const data = await handler({ db: getActorClient(memberId, 'app'), access, memberId, channel: 'app' });
    if (options?.write) kickWebhooks(access);
    return NextResponse.json({ data });
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    console.error('[questions] request failed:', error);
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 });
  }
}

/** The request body parsed with `schema` (an empty body reads as {}), or a 422 with the first problem. */
export async function readQuestionBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  const text = await request.text();
  let body: unknown = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(400, 'BAD_REQUEST', 'The request body must be JSON');
    }
  }
  try {
    return schema.parse(body);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const issue = error.issues[0];
    const field = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
    throw new ApiError(422, 'VALIDATION_ERROR', `${field}${issue?.message ?? 'Invalid request'}`);
  }
}
