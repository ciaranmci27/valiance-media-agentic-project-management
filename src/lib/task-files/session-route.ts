import { NextResponse } from 'next/server';
import { ZodError, type z } from 'zod';
import { requireSessionAccess } from '@/lib/api/access';
import { ApiError } from '@/lib/api/errors';
import { getActorClient } from '@/lib/api/supabase-service';
import type { TaskFilesContext } from './service';

/**
 * The session-route shell for task files: a signed-in member, writes named
 * as them (getActorClient), the plain { data } / { error } shape, and the
 * service's ApiErrors mapped to their status. Permissions are checked in
 * the service.
 */
export async function taskFilesRoute<T>(
  handler: (ctx: TaskFilesContext) => Promise<T>,
  respond: (data: T) => NextResponse = (data) => NextResponse.json({ data }),
): Promise<NextResponse> {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, memberId } = auth.data;
  try {
    return respond(await handler({ db: getActorClient(memberId, 'app'), access, memberId, channel: 'app' }));
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
    console.error('[task files] request failed:', error);
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 });
  }
}

/** The request body parsed with `schema`, or a 422 with the first problem. */
export async function readTaskFileBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, 'BAD_REQUEST', 'The request body must be JSON');
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
