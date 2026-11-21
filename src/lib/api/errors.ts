import { MODULES, type ModuleId } from '@/lib/modules/registry';

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function notFound(resource: string) {
  return new ApiError(404, 'NOT_FOUND', `${resource} not found`);
}

export function badRequest(message: string, details?: unknown) {
  return new ApiError(400, 'BAD_REQUEST', message, details);
}

export function unauthorized(message = 'Unauthorized', details?: unknown) {
  return new ApiError(401, 'UNAUTHORIZED', message, details);
}

export function forbidden(message = 'Forbidden', details?: unknown) {
  return new ApiError(403, 'FORBIDDEN', message, details);
}

/** The stable code for a request into a switched-off module. */
export const MODULE_OFF = 'MODULE_OFF';

/** The plain line a person or agent reads when a module is switched off. */
export function moduleOffMessage(id: ModuleId): string {
  return `${MODULES[id].label} is switched off for this workspace.`;
}

/**
 * A request into a module the workspace has switched off. Not a permission
 * problem: no grant on a key or role fixes it, only switching the module on.
 */
export function moduleOff(id: ModuleId) {
  return new ApiError(403, MODULE_OFF, moduleOffMessage(id), {
    reason: 'module_off',
    module: id,
    hint: `An owner can switch ${MODULES[id].label} on in Settings.`,
  });
}

export function conflict(message: string) {
  return new ApiError(409, 'CONFLICT', message);
}

export function tooManyRequests(message = 'Rate limit exceeded') {
  return new ApiError(429, 'RATE_LIMIT_EXCEEDED', message);
}
