import { NextRequest } from 'next/server';
import { ZodSchema, ZodError } from 'zod';
import { SupabaseClient } from '@supabase/supabase-js';
import { getServiceClient } from './supabase-service';
import { hashApiKey } from './crypto';
import { checkRateLimit } from './rate-limit';
import { ApiError, unauthorized, forbidden, tooManyRequests, badRequest } from './errors';
import { errorResponse } from './response';

function applyRateLimitHeaders(
  response: Response,
  rateInfo: { remaining: number; resetAt: number } | null
): Response {
  if (rateInfo) {
    response.headers.set('X-RateLimit-Limit', '120');
    response.headers.set('X-RateLimit-Remaining', String(rateInfo.remaining));
    response.headers.set('X-RateLimit-Reset', String(Math.ceil(rateInfo.resetAt / 1000)));
  }
  return response;
}

export interface ApiContext<TBody = unknown, TParams = Record<string, string>> {
  supabase: SupabaseClient;
  params: TParams;
  body: TBody;
  searchParams: URLSearchParams;
  apiKeyId: string;
  permissions: string;
  teamMemberId: string | null;
}

interface WithApiOptions<TBody> {
  schema?: ZodSchema<TBody>;
}

type HandlerFn<TBody, TParams> = (ctx: ApiContext<TBody, TParams>) => Promise<Response>;

export function withApi<TBody = unknown, TParams = Record<string, string>>(
  handler: HandlerFn<TBody, TParams>,
  options?: WithApiOptions<TBody>
) {
  return async (
    request: NextRequest,
    routeContext?: { params?: Promise<TParams> | TParams }
  ): Promise<Response> => {
    let rateInfo: { remaining: number; resetAt: number } | null = null;

    try {
      // 1. Authenticate via x-api-key header
      const apiKey = request.headers.get('x-api-key');
      if (!apiKey) throw unauthorized('Missing x-api-key header');

      const keyHash = await hashApiKey(apiKey);
      const supabase = getServiceClient();

      const { data: keyRow, error: keyError } = await supabase
        .from('api_keys')
        .select('id, permissions, team_member_id')
        .eq('key_hash', keyHash)
        .is('revoked_at', null)
        .maybeSingle();

      if (keyError || !keyRow) throw unauthorized('Invalid or revoked API key');

      // 2. Rate limit
      const rateResult = checkRateLimit(keyHash);
      rateInfo = { remaining: rateResult.remaining, resetAt: rateResult.resetAt };
      if (!rateResult.allowed) throw tooManyRequests();

      // 3. Permission check — block writes for read_only keys
      const method = request.method;
      if (keyRow.permissions === 'read_only' && method !== 'GET' && method !== 'HEAD') {
        throw forbidden('Read-only API key cannot perform write operations');
      }

      // 4. Update last_used_at (fire-and-forget)
      supabase
        .from('api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', keyRow.id)
        .then(() => {});

      // 5. Resolve params (Next.js 15+ async params)
      let resolvedParams = {} as TParams;
      if (routeContext?.params) {
        resolvedParams =
          routeContext.params instanceof Promise
            ? await routeContext.params
            : routeContext.params;
      }

      // 6. Parse and validate body
      let body = undefined as unknown as TBody;
      if (options?.schema && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        const raw = await request.json().catch(() => { throw badRequest('Request body must be valid JSON'); });
        body = options.schema.parse(raw);
      }

      // 7. Execute handler
      const searchParams = request.nextUrl.searchParams;
      const response = await handler({
        supabase,
        params: resolvedParams,
        body,
        searchParams,
        apiKeyId: keyRow.id,
        permissions: keyRow.permissions,
        teamMemberId: keyRow.team_member_id || null,
      });
      return applyRateLimitHeaders(response, rateInfo);
    } catch (err) {
      if (err instanceof ZodError) {
        return applyRateLimitHeaders(errorResponse(422, 'VALIDATION_ERROR', 'Validation failed', err.issues), rateInfo);
      }
      if (err instanceof ApiError) {
        return applyRateLimitHeaders(errorResponse(err.statusCode, err.code, err.message, err.details), rateInfo);
      }
      console.error('[API Error]', err);
      return applyRateLimitHeaders(errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred'), rateInfo);
    }
  };
}
