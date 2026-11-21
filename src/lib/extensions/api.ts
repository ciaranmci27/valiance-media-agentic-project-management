import type { NextRequest } from 'next/server';
import { ZodError } from 'zod';
import type { PermissionKey } from '@/lib/access-control';
import { isModuleEnabled } from '@/lib/access-control';
import type { ModuleId } from '@/lib/modules/registry';
import type { SessionAccessResult } from '@/lib/api/access';
import type { ApiContext } from '@/lib/api/middleware';
import { ApiError, moduleOff } from '@/lib/api/errors';
import { errorResponse } from '@/lib/api/response';
import { matchApiRoute } from './registry';
import type { ResolvedApiRoute } from './types';

/**
 * Answers /api/x/<path> from the install's routes. The auth checks come in as
 * `deps` (the real ones in app/api/x, fakes in the tests), and every route
 * passes one of them before its handler runs: a session unless it says
 * otherwise, an API key with its permission, or nothing for an explicit
 * `auth: 'public'`.
 */

export interface ApiDispatchDeps {
  /** requireSessionAccess: the member, or the refusal to send. */
  requireSession: (permission?: PermissionKey) => Promise<
    { data: SessionAccessResult; error: null } | { data: null; error: Response }
  >;
  /** withApi: checks the key and its permission, then runs `run`; its refusals and errors become responses. */
  withApiKey: (request: NextRequest, permission: PermissionKey, run: (api: ApiContext) => Promise<Response>) => Promise<Response>;
  /** Whether a module is on, for public routes (no member to read it from). */
  moduleEnabled: (id: ModuleId) => Promise<boolean>;
}

/** The app's error envelope for anything a handler throws. */
export function extensionErrorResponse(err: unknown): Response {
  if (err instanceof ApiError) return errorResponse(err.statusCode, err.code, err.message, err.details);
  if (err instanceof ZodError) return errorResponse(422, 'VALIDATION_ERROR', 'Validation failed', err.issues);
  const requestId = crypto.randomUUID();
  console.error(`[API Error] custom route request_id=${requestId}`, err);
  return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred', { request_id: requestId });
}

export async function dispatchApiRoute(
  request: NextRequest,
  segments: readonly string[],
  routes: readonly ResolvedApiRoute[],
  deps: ApiDispatchDeps,
): Promise<Response> {
  const match = matchApiRoute(routes, request.method, segments);
  if (!match.route) {
    if (match.allowed.length) {
      const response = errorResponse(405, 'METHOD_NOT_ALLOWED', `This endpoint takes ${match.allowed.join(', ')}`);
      response.headers.set('Allow', match.allowed.join(', '));
      return response;
    }
    // The same answer as any other API address with no route (api/[...unknown]).
    return errorResponse(404, 'not_found', 'No API endpoint at this address');
  }

  const { route, params } = match;
  const base = { request, params, searchParams: request.nextUrl.searchParams };

  switch (route.auth) {
    case 'session': {
      const { data, error } = await deps.requireSession(route.permission);
      if (error) return error;
      if (route.module && !isModuleEnabled(data.access, route.module)) return extensionErrorResponse(moduleOff(route.module));
      try {
        return await route.handler({ ...base, session: data });
      } catch (err) {
        return extensionErrorResponse(err);
      }
    }
    case 'api-key':
      return deps.withApiKey(request, route.permission, async (api) => {
        if (route.module && !isModuleEnabled(api.access, route.module)) throw moduleOff(route.module);
        return route.handler({ ...base, api });
      });
    case 'public': {
      try {
        if (route.module && !(await deps.moduleEnabled(route.module))) throw moduleOff(route.module);
        return await route.handler(base);
      } catch (err) {
        return extensionErrorResponse(err);
      }
    }
    default:
      // defineApiRoutes refuses any other value; fail closed all the same.
      return errorResponse(500, 'INTERNAL_ERROR', 'Route has no valid auth');
  }
}
