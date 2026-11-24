import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError, badRequest } from './errors';

/**
 * Idempotency-Key on POSTs. Harnesses retry: a POST that carries the header
 * runs once per API key, path and key for 24 hours, and a retry gets the
 * first answer back instead of a second task, comment or question.
 *
 * - The same key with another body (or query string) is 422
 *   idempotency_key_reused: it names a different request.
 * - A retry while the first request still runs is 409 idempotency_in_flight.
 * - Only 2xx answers are stored. An error releases the key, so a retry runs
 *   again and can succeed.
 * - The database (pm.claim_api_idempotency_key) does the claim in one
 *   statement, so two racing retries cannot both run. A claim left running
 *   for 10 minutes (a request that died) is taken over.
 * - REST and MCP share the store: an MCP tool's idempotency_key travels as
 *   this header on the in-process call.
 */

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_KEY_MAX = 255;
/** Set on an answer replayed from the store. */
export const IDEMPOTENCY_REPLAYED_HEADER = 'idempotency-replayed';

export interface IdempotencyClaim {
  apiKeyId: string;
  path: string;
  key: string;
  requestHash: string;
}

type ClaimResult =
  | { state: 'claimed'; claim: IdempotencyClaim }
  | { state: 'replay'; response: Response }
  /** The database does not have the store yet (new code before its migration): run as a plain POST. */
  | { state: 'unavailable' };

const missingStore = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === 'PGRST202' || error.code === '42883' || error.code === '42P01'
    || /could not find the function|does not exist/i.test(error.message ?? ''));

/** The header's value, checked: 1 to 255 visible ASCII characters. Null when absent. */
export function idempotencyKeyFrom(headers: Headers): string | null {
  const raw = headers.get(IDEMPOTENCY_HEADER);
  if (raw === null) return null;
  const key = raw.trim();
  if (!key || key.length > IDEMPOTENCY_KEY_MAX || !/^[\x21-\x7e]+$/.test(key)) {
    throw badRequest(`Idempotency-Key must be 1 to ${IDEMPOTENCY_KEY_MAX} visible ASCII characters`, {
      reason: 'invalid_idempotency_key',
      hint: 'Send a unique value per logical request, such as a UUID, and the same value on every retry of it.',
    });
  }
  return key;
}

/** What makes two requests the same: the query string and the body, byte for byte. */
export function idempotencyRequestHash(search: string, body: string): string {
  return createHash('sha256').update(search).update('\n').update(body).digest('hex');
}

export async function claimIdempotencyKey(
  service: SupabaseClient,
  input: IdempotencyClaim,
): Promise<ClaimResult> {
  const { data, error } = await service.rpc('claim_api_idempotency_key', {
    p_api_key_id: input.apiKeyId,
    p_path: input.path,
    p_idempotency_key: input.key,
    p_request_hash: input.requestHash,
  });
  if (missingStore(error)) {
    console.warn('[idempotency] pm.claim_api_idempotency_key is missing; apply the agent plumbing migration');
    return { state: 'unavailable' };
  }
  if (error) throw error;
  const result = (data ?? {}) as { state?: string; status?: number; body?: string; started_at?: string };
  if (result.state === 'claimed') return { state: 'claimed', claim: input };
  if (result.state === 'replay') {
    return {
      state: 'replay',
      response: new NextResponse(result.body ?? '', {
        status: result.status ?? 200,
        headers: { 'content-type': 'application/json', [IDEMPOTENCY_REPLAYED_HEADER]: 'true' },
      }),
    };
  }
  if (result.state === 'mismatch') {
    throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request.', {
      reason: 'idempotency_key_reused',
      hint: 'Use a new key for a new request. A retry must send the same body as the first try.',
    });
  }
  throw new ApiError(409, 'IDEMPOTENCY_IN_FLIGHT', 'A request with this Idempotency-Key is still running.', {
    reason: 'idempotency_in_flight',
    ...(result.started_at ? { started_at: result.started_at } : {}),
    hint: 'Wait a few seconds and retry with the same key: you will get its answer.',
  });
}

const match = (claim: IdempotencyClaim) => ({
  api_key_id: claim.apiKeyId,
  path: claim.path,
  idempotency_key: claim.key,
  request_hash: claim.requestHash,
});

/**
 * Stores a 2xx answer for retries, or releases the key for anything else.
 * Never fails the request it follows: the answer is already decided.
 */
export async function finishIdempotencyKey(service: SupabaseClient, claim: IdempotencyClaim, response: Response): Promise<void> {
  try {
    if (response.status >= 200 && response.status < 300) {
      const now = new Date();
      const { error } = await service
        .from('api_idempotency_keys')
        .update({
          state: 'completed',
          response_status: response.status,
          response_body: await response.clone().text(),
          completed_at: now.toISOString(),
          expires_at: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
        })
        .match(match(claim))
        .eq('state', 'in_flight');
      if (error) throw error;
    } else {
      await releaseIdempotencyKey(service, claim);
    }
  } catch (error) {
    console.error('[idempotency] could not finish the key', error);
  }
}

/** Frees the key after an error, so a retry runs again. */
export async function releaseIdempotencyKey(service: SupabaseClient, claim: IdempotencyClaim): Promise<void> {
  try {
    const { error } = await service
      .from('api_idempotency_keys')
      .delete()
      .match(match(claim))
      .eq('state', 'in_flight');
    if (error) throw error;
  } catch (error) {
    console.error('[idempotency] could not release the key', error);
  }
}
