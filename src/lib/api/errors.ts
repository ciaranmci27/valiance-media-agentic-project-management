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

export function conflict(message: string) {
  return new ApiError(409, 'CONFLICT', message);
}

export function tooManyRequests(message = 'Rate limit exceeded') {
  return new ApiError(429, 'RATE_LIMIT_EXCEEDED', message);
}
