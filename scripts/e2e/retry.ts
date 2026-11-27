/**
 * Retries a request while the local dev server is still compiling, and
 * only then. Next's dev server compiles a route on its first request, and
 * while it recompiles it can drop the connection or answer an HTML error
 * page for a moment. Those signs are retried with a short backoff for at
 * most RETRY_BUDGET_MS; anything else is answered at once, so a real
 * failure is never hidden:
 *
 * - No answer at all (the connection was refused or reset): retried. A
 *   timeout is not: the request may still be running.
 * - 502 or 503 that is not the app's own JSON: retried (the server is not
 *   ready yet).
 * - 500 HTML (not the app's JSON): retried for a read (GET, HEAD), and for
 *   a write only when the page says it is compiling or a module is missing
 *   mid-build, so a write that failed for real is never sent twice.
 * - Every other answer, a JSON 500 included, is the answer.
 */

export const RETRY_BUDGET_MS = 60_000;
const FIRST_WAIT_MS = 250;
const MAX_WAIT_MS = 4_000;

const TRANSPORT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'ECONNABORTED']);
const COMPILING = /compil|turbopack|webpack|Module not found|Cannot find module|ENOENT[^<]{0,200}\.next/i;

/** A fetch that failed before any answer because the connection dropped (never a timeout or abort). */
export function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return false;
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code ?? (error as unknown as { code?: string }).code;
  if (code && TRANSPORT_CODES.has(code)) return true;
  return /other side closed|socket hang up/i.test(`${error.message} ${cause?.message ?? ''}`);
}

const looksJson = (text: string) => /^\s*[[{]/.test(text);
const looksHtml = (text: string) => /<html|<!doctype/i.test(text);

/** Whether an answer is the dev server mid-compile rather than the app answering. */
export function isCompileAnswer(status: number, text: string, method: string): boolean {
  if (looksJson(text)) return false;
  if (status === 502 || status === 503) return true;
  if (status !== 500 || !looksHtml(text)) return false;
  return method === 'GET' || method === 'HEAD' || COMPILING.test(text);
}

export interface RetryOptions {
  method: string;
  budgetMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Told about each retry (the e2e run prints one line). */
  onRetry?: (why: string, attempt: number) => void;
}

/**
 * Runs `attempt` (a fresh fetch each time) until it answers something that
 * is not a compile sign, or the budget is spent; then the last answer is
 * returned (or the last transport error thrown) as it is. Answers the
 * response with its body read once as text.
 */
export async function fetchWhileCompiling(attempt: () => Promise<Response>, options: RetryOptions): Promise<{ response: Response; text: string; retries: number }> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const method = options.method.toUpperCase();
  const deadline = now() + (options.budgetMs ?? RETRY_BUDGET_MS);
  let wait = FIRST_WAIT_MS;
  for (let retries = 0; ; retries++) {
    let why: string;
    try {
      const response = await attempt();
      const text = await response.text();
      if (!isCompileAnswer(response.status, text, method) || now() + wait > deadline) return { response, text, retries };
      why = `HTTP ${response.status} while the server compiles`;
    } catch (error) {
      if (!isTransportError(error) || now() + wait > deadline) throw error;
      why = 'the connection dropped while the server compiles';
    }
    options.onRetry?.(why, retries + 1);
    await sleep(wait);
    wait = Math.min(wait * 2, MAX_WAIT_MS);
  }
}
