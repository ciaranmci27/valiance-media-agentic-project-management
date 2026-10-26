import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { requireSessionAccess } from '@/lib/api/access';
import { InboxError, type InboxContext } from './inbox-service';

/**
 * The session-route shell for the Inbox and its settings: a signed-in
 * member, the plain { data } / { error } shape, and InboxError mapped to its
 * status. Permissions are checked inside each service function.
 */
export async function inboxRoute<T>(handler: (ctx: InboxContext) => Promise<T>, status = 200): Promise<NextResponse> {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { service, access, memberId } = auth.data;
  try {
    const data = await handler({ service, access, memberId });
    return NextResponse.json({ data }, { status });
  } catch (error) {
    if (error instanceof InboxError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[inbox] request failed:', error);
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 });
  }
}

/** The request body parsed with `schema`, or a 422 with the first problem. */
export async function readBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new InboxError(400, 'The request body must be JSON');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
    throw new InboxError(422, `${field}${issue?.message ?? 'Invalid request'}`);
  }
  return parsed.data;
}
