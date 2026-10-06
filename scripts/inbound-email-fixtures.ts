/**
 * Test doubles for inbound email: .eml fixtures parsed with postal-mime and
 * reshaped the way Resend's Receiving API returns a received email
 * (https://resend.com/docs/api-reference/emails/retrieve-received-email,
 * .../list-received-email-attachments), a fake Resend served through a
 * fetch interceptor (API and signed download URLs), and an in-memory
 * Supabase Storage for fake-postgrest's `handle` hook. Every address and
 * domain in the fixtures is fictional (.example, .test).
 */
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import PostalMime from 'postal-mime';

export const FIXTURES = new URL('./fixtures/inbound-email/', import.meta.url);

export interface FixtureAttachment {
  meta: { id: string; filename: string | null; size: number | null; content_type: string; content_disposition: string | null; content_id: string | null };
  bytes: Buffer;
}

export interface ResendFixture {
  email: Record<string, unknown>;
  attachments: FixtureAttachment[];
  raw: Buffer;
}

export async function readEml(name: string, replacements: Record<string, string> = {}): Promise<Buffer> {
  let text = await readFile(new URL(name, FIXTURES), 'utf8');
  for (const [key, value] of Object.entries(replacements)) text = text.replace(`{{${key}}}`, value);
  return Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8');
}

/** A received email as Resend's API would describe it, from a raw .eml. */
export async function resendFixture(raw: Buffer, options: {
  emailId: string;
  deliveredTo: string[];
  receivedFor?: string[];
  authentication?: { spf: string; dkim: string; dmarc: string } | null;
  hideSizes?: boolean;
  messageId?: string;
}): Promise<ResendFixture> {
  const parsed = await PostalMime.parse(raw);
  const headers: Record<string, string | string[]> = {};
  for (const header of parsed.headers) {
    const existing = headers[header.key];
    if (existing === undefined) headers[header.key] = header.value;
    else headers[header.key] = Array.isArray(existing) ? [...existing, header.value] : [existing, header.value];
  }
  const attachments: FixtureAttachment[] = parsed.attachments.map((attachment, index) => {
    const content = attachment.content;
    const bytes = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content instanceof Uint8Array ? content : new Uint8Array(content));
    return {
      meta: {
        id: `${options.emailId}-att-${index}`,
        filename: attachment.filename,
        size: options.hideSizes ? null : bytes.byteLength,
        content_type: attachment.mimeType,
        content_disposition: attachment.disposition,
        content_id: attachment.contentId ?? null,
      },
      bytes,
    };
  });
  const bare = (list?: { address?: string }[]) => (list ?? []).map((a) => a.address).filter(Boolean);
  return {
    raw,
    attachments,
    email: {
      object: 'email',
      id: options.emailId,
      to: options.deliveredTo,
      from: parsed.from && 'address' in parsed.from ? parsed.from.address : null,
      created_at: new Date().toISOString(),
      subject: parsed.subject ?? '',
      html: parsed.html ?? null,
      html_format: 'cid',
      text: parsed.text ?? null,
      headers,
      bcc: [],
      cc: bare(parsed.cc as { address?: string }[] | undefined),
      reply_to: [],
      received_for: options.receivedFor ?? [],
      authentication: options.authentication === undefined ? { spf: 'pass', dkim: 'pass', dmarc: 'pass' } : options.authentication,
      message_id: options.messageId ?? parsed.messageId ?? null,
      attachments: attachments.map((a) => a.meta),
    },
  };
}

const CDN = 'https://inbound-cdn.resend.test';

/** Resend's API and download URLs behind a fetch interceptor. */
export class FakeResend {
  emails = new Map<string, ResendFixture>();
  calls: string[] = [];
  failDownloads = new Set<string>();
  apiKey = 're_test_receiving_key';

  add(fixture: ResendFixture) {
    this.emails.set(String(fixture.email.id), fixture);
  }

  private json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  async handle(url: URL, init?: RequestInit): Promise<Response> {
    this.calls.push(url.pathname);
    if (url.origin === 'https://api.resend.com') {
      const auth = new Headers(init?.headers).get('authorization');
      if (auth !== `Bearer ${this.apiKey}`) return this.json({ message: 'bad key' }, 401);
      const match = /^\/emails\/receiving\/([^/]+)(\/attachments)?$/.exec(url.pathname);
      const fixture = match ? this.emails.get(decodeURIComponent(match[1])) : undefined;
      if (!fixture) return this.json({ message: 'not found' }, 404);
      const id = String(fixture.email.id);
      if (match?.[2]) {
        return this.json({
          object: 'list',
          has_more: false,
          data: fixture.attachments.map((a) => ({ ...a.meta, download_url: `${CDN}/${id}/attachments/${a.meta.id}?signature=t`, expires_at: '2026-10-05T19:00:00.000Z' })),
        });
      }
      return this.json({ ...fixture.email, raw: { download_url: `${CDN}/raw/${id}?signature=t`, expires_at: '2026-10-05T19:00:00.000Z' } });
    }
    if (url.origin === CDN) {
      if (this.failDownloads.has(url.pathname)) return new Response('busy', { status: 503 });
      const raw = /^\/raw\/([^/]+)$/.exec(url.pathname);
      if (raw) {
        const fixture = this.emails.get(raw[1]);
        return fixture ? new Response(new Uint8Array(fixture.raw)) : new Response('gone', { status: 404 });
      }
      const attachment = /^\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname);
      const fixture = attachment ? this.emails.get(attachment[1]) : undefined;
      const found = fixture?.attachments.find((a) => a.meta.id === attachment?.[2]);
      return found ? new Response(new Uint8Array(found.bytes)) : new Response('gone', { status: 404 });
    }
    throw new Error(`FakeResend cannot serve ${url}`);
  }

  install() {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === 'https://api.resend.com' || url.origin === CDN) return this.handle(url, init);
      return original(input, init);
    }) as typeof fetch;
    return () => { globalThis.fetch = original; };
  }
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/** Supabase Storage, in memory: upload, download, remove, signed URLs. */
export class FakeStorage {
  objects = new Map<string, { bytes: Buffer; contentType: string }>();
  uploads = 0;
  failUploads = false;
  /** A delete request naming any of these paths fails whole (500), removing nothing. */
  failRemove = new Set<string>();
  /** Called with each delete request's paths before it is applied. */
  onRemove?: (paths: string[]) => Promise<void>;
  listCalls = 0;

  handler = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    if (!url.pathname.startsWith('/storage/v1/')) return false;
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const path = decodeURIComponent(url.pathname.slice('/storage/v1/'.length));
    let match: RegExpExecArray | null;
    if ((match = /^object\/sign\/([^/]+)\/(.+)$/.exec(path)) && request.method === 'POST') {
      const key = `${match[1]}/${match[2]}`;
      if (!this.objects.has(key)) { send(400, { statusCode: '404', error: 'not_found', message: 'Object not found' }); return true; }
      send(200, { signedURL: `/object/sign/${key}?token=signed-${Date.now()}` });
      return true;
    }
    if ((match = /^object\/list-v2\/([^/]+)$/.exec(path)) && request.method === 'POST') {
      // Storage's flat listing (with_delimiter false): every object under the
      // prefix by name, `limit` per page, keyset cursor on the name.
      const options = JSON.parse((await readBody(request)).toString() || '{}') as { limit?: number; prefix?: string; cursor?: string; with_delimiter?: boolean };
      const bucket = `${match[1]}/`;
      const names = [...this.objects.keys()].filter((key) => key.startsWith(bucket)).map((key) => key.slice(bucket.length))
        .filter((name) => name.startsWith(options.prefix ?? '') && (!options.cursor || name > options.cursor)).sort();
      const page = names.slice(0, options.limit ?? 1000);
      this.listCalls++;
      send(200, {
        hasNext: names.length > page.length,
        nextCursor: names.length > page.length ? page[page.length - 1] : undefined,
        folders: [],
        objects: page.map((name) => ({ id: name, key: name, name: name.split('/').pop(), created_at: '', updated_at: '', metadata: {} })),
      });
      return true;
    }
    if ((match = /^object\/([^/]+)$/.exec(path)) && request.method === 'DELETE') {
      const { prefixes } = JSON.parse((await readBody(request)).toString() || '{}') as { prefixes: string[] };
      await this.onRemove?.(prefixes);
      if (prefixes.some((prefix) => this.failRemove.has(prefix))) { send(500, { statusCode: '500', error: 'internal', message: 'storage delete failed' }); return true; }
      const removed = prefixes.filter((prefix) => this.objects.delete(`${match![1]}/${prefix}`));
      send(200, removed.map((name) => ({ name })));
      return true;
    }
    if ((match = /^object\/([^/]+)\/(.+)$/.exec(path))) {
      const key = `${match[1]}/${match[2]}`;
      if (request.method === 'POST' || request.method === 'PUT') {
        if (this.failUploads) { send(500, { statusCode: '500', error: 'internal', message: 'storage down' }); return true; }
        if (this.objects.has(key) && request.headers['x-upsert'] !== 'true') { send(400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' }); return true; }
        this.objects.set(key, { bytes: await readBody(request), contentType: String(request.headers['content-type'] ?? '') });
        this.uploads++;
        send(200, { Key: key, Id: key });
        return true;
      }
      if (request.method === 'GET') {
        const object = this.objects.get(key);
        if (!object) { send(400, { statusCode: '404', error: 'not_found', message: 'Object not found' }); return true; }
        response.writeHead(200, { 'Content-Type': object.contentType });
        response.end(object.bytes);
        return true;
      }
    }
    send(404, { message: `FakeStorage cannot serve ${request.method} ${path}` });
    return true;
  };
}
