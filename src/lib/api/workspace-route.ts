import { NextResponse } from 'next/server';
import { ZodError, type z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';
import { appUrlFor } from '@/lib/team/invite';
import { requireSessionAccess } from './access';
import type { AgentCaller } from './agent-owners';
import type { Granter } from './agent-setup';
import { sessionCaller } from './agent-workspace';
import { ApiError } from './errors';

/**
 * The shell of the agent workspace session routes (/api/workspace/agents,
 * /agent-templates, /projects/{id}/agents, /brief, /projects/setup): a
 * signed-in member, writes named as them, { data } on success, and the
 * service's ApiErrors as { success: false, error: { code, message, details } }
 * with their status, so a screen can show the server's own words and mark
 * the fields it names (details.fields). Who may do what is decided in the
 * service, by the same rules as the API.
 */

export interface WorkspaceContext {
  service: SupabaseClient;
  access: AccessContext;
  memberId: string;
  /** The signed-in login (auth.users id), and a client acting as it with the session's own token. */
  authUserId: string;
  sessionClient: SupabaseClient;
  caller: AgentCaller;
  granter: Granter;
  request: Request;
  /** The app's address for links and connect snippets: NEXT_PUBLIC_APP_URL, else this request's origin. */
  appUrl: string;
}

export function workspaceError(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json({ success: false, error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }, { status: error.statusCode });
  }
  console.error('[workspace] request failed:', error);
  return NextResponse.json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Try again.' } }, { status: 500 });
}

export async function workspaceRoute(
  request: Request,
  handler: (ctx: WorkspaceContext) => Promise<unknown>,
  options: { status?: number; noStore?: boolean } = {},
): Promise<NextResponse> {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, memberId, service, user, client } = auth.data;
  const { caller, granter } = sessionCaller(memberId, access);
  try {
    const data = await handler({ service, access, memberId, authUserId: user.id, sessionClient: client, caller, granter, request, appUrl: appUrlFor(new URL(request.url).origin) });
    if (data instanceof Response) return data as NextResponse;
    return NextResponse.json({ data }, {
      status: options.status ?? 200,
      ...(options.noStore ? { headers: { 'Cache-Control': 'no-store' } } : {}),
    });
  } catch (error) {
    const response = workspaceError(error);
    if (options.noStore) response.headers.set('Cache-Control', 'no-store');
    return response;
  }
}

/** The JSON body parsed with `schema` (an empty body reads as {}), or a 422 naming each problem. */
export async function readWorkspaceBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  const text = await request.text();
  let body: unknown = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(400, 'BAD_REQUEST', 'The request body must be JSON', { reason: 'invalid_json' });
    }
  }
  try {
    return schema.parse(body);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const issues = error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message }));
    const fields: Record<string, string> = {};
    for (const issue of issues) {
      const key = issue.path.join('.') || '_';
      if (!(key in fields)) fields[key] = issue.message;
    }
    const first = issues[0];
    throw new ApiError(422, 'VALIDATION_ERROR', `${first?.path.length ? `${first.path.join('.')}: ` : ''}${first?.message ?? 'Invalid request'}`, {
      reason: 'invalid_body', issues, fields,
    });
  }
}

/** page and limit from a query (limit 1 to max, default 25). */
export function pageFrom(searchParams: URLSearchParams, max = 100, fallback = 25) {
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const limit = Math.min(max, Math.max(1, parseInt(searchParams.get('limit') || String(fallback), 10) || fallback));
  return { page, limit, offset: (page - 1) * limit };
}

export const pageMeta = (page: number, limit: number, total: number) => ({ page, limit, total, total_pages: limit > 0 ? Math.ceil(total / limit) : 0 });
