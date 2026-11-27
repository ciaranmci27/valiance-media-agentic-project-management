import { ApiError } from '@/lib/api/errors';

/**
 * How large a request body the app reads. A JSON body is parsed whole, so
 * without a ceiling one key (120 requests a minute) could make the server
 * read gigabytes a minute. 1 MB holds any JSON body the app takes; the routes
 * that carry a file inline (content_base64, up to 3 MB of file) pass
 * FILE_BODY_LIMIT, and the MCP server takes MCP_BODY_LIMIT so its file tool
 * fits too.
 */
export const JSON_BODY_LIMIT = 1024 * 1024;
export const FILE_BODY_LIMIT = 5 * 1024 * 1024;
export const MCP_BODY_LIMIT = 6 * 1024 * 1024;

/** The 413 every capped reader answers, in the API's error shape. */
export function bodyTooLarge(limit: number): ApiError {
  return new ApiError(413, 'PAYLOAD_TOO_LARGE', `The request body is larger than ${formatBytes(limit)}, the most this endpoint reads`, {
    reason: 'body_too_large',
    max_bytes: limit,
  });
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Throws the 413 when the request says (Content-Length) it is larger than
 * `limit`, before anything is read. A body without the header is counted as
 * it streams by readBodyText.
 */
export function assertDeclaredBodySize(headers: Headers, limit: number): void {
  const declared = headers.get('content-length');
  if (declared === null || declared.trim() === '') return;
  const size = Number(declared);
  if (Number.isFinite(size) && size > limit) throw bodyTooLarge(limit);
}

/**
 * The body as text, never more than `limit` bytes: refused on its
 * Content-Length first, then counted while it streams (a chunked body has no
 * length), and the stream is cancelled as soon as it passes the limit, so
 * the rest is never read.
 */
export async function readBodyText(request: Request, limit: number = JSON_BODY_LIMIT): Promise<string> {
  assertDeclaredBodySize(request.headers, limit);
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let seen = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (seen > limit) {
      await reader.cancel().catch(() => {});
      throw bodyTooLarge(limit);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** readBodyText, then JSON.parse; a body that is not JSON throws a SyntaxError as request.json() does. */
export async function readJsonBody(request: Request, limit: number = JSON_BODY_LIMIT): Promise<unknown> {
  return JSON.parse(await readBodyText(request, limit));
}
