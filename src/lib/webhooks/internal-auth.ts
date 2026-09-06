import { createHash, timingSafeEqual } from 'node:crypto';

type Environment = Record<string, string | undefined>;
export const privateHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

/** Internal integrations use dedicated server secrets, never browser sessions. */
export function internalAuthorization(request: Request, kind: 'snapshot' | 'scheduler', env: Environment = process.env): Response | null {
  const prefix = kind === 'snapshot' ? 'ACCOUNTING_INVOICE_SOURCE' : 'WEBHOOK_SCHEDULER';
  const secret = env[`${prefix}_SECRET`];
  const respond = (error: string, status: number) => Response.json({ error }, { status, headers: privateHeaders });
  if (env.NEXT_PUBLIC_DEMO_MODE === 'true' || env.DEMO_MODE === 'true' || env[`${prefix}_ENABLED`] !== 'true') return respond('Integration disabled', 404);
  if (!secret || secret.length < 32 || secret.length > 512 || !env.SUPABASE_SERVICE_ROLE_KEY || !env.NEXT_PUBLIC_SUPABASE_URL) return respond('Integration is not configured', 503);
  const header = request.headers.get('authorization') ?? '';
  if (header.length > 1024 || !header.startsWith('Bearer ')) return respond('Unauthorized', 401);
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(header.slice(7)), digest(secret))) return respond('Unauthorized', 401);
  return null;
}

export async function readSmallJson(request: Request, maxBytes = 2048): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('Use application/json');
  if (Number(request.headers.get('content-length')) > maxBytes) throw new Error('Request is too large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Request body is required');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Request is too large');
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { await reader.cancel().catch(() => {}); }
}

export function snapshotInput(value: unknown): { p_id: string; p_cursor: number | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid snapshot request');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['snapshot_id', 'cursor'].includes(k)) || typeof v.snapshot_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.snapshot_id)) throw new Error('Use a UUID snapshot_id');
  if (v.cursor != null && (typeof v.cursor !== 'number' || !Number.isSafeInteger(v.cursor) || v.cursor < 0 || v.cursor > 2147483647)) throw new Error('Use a nonnegative integer cursor');
  return { p_id: v.snapshot_id, p_cursor: v.cursor == null ? null : v.cursor as number };
}
