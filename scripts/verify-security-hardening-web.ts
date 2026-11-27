/**
 * The web half of the security hardening (break-it round of 2026-11-27):
 *
 * - Lead notes and every other HTML sink: stored text never runs as script.
 * - Avatar and link URLs: a `javascript:`, `data:` or `//other-host` link is
 *   refused when saved and when shown.
 * - The request proxy sits where Next 16 loads it (it never ran from the app
 *   root), signs pages out to /login, answers CORS for /api/v1, and leaves
 *   API calls to their routes.
 * - /api/email-preview needs a signed-in member.
 * - Every page carries the app-wide Content-Security-Policy.
 *
 * No network or database needed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createElement } from 'react';

const APP = join(__dirname, '..');
const SRC = join(APP, 'src');

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

function setEnv(values: Record<string, string | undefined>) {
  const env = process.env as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

// ---- Lead notes: the tester's payload renders inert ----
async function richText() {
  const { richTextToSafeHtml } = await import('../src/lib/security/rich-text');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const render = (html: string) => renderToStaticMarkup(createElement('div', { dangerouslySetInnerHTML: { __html: html } }));

  const payload = '<img src=x onerror="document.title=document.cookie.slice(0,40)">SECTEST xss';
  const out = render(richTextToSafeHtml(payload));
  check('notes: the tester\'s <img onerror> payload is no tag', !/<img/i.test(out) && out.includes('&lt;img'), out);
  check('notes: no live event handler survives', !/<[^>]+\son[a-z]+=/i.test(out), out);

  const editor = '<p>Call <strong>Tuesday</strong>, <em>after</em> <s>lunch</s> <u>sharp</u></p><ul><li><p>one</p></li></ul><ol start="3"><li>three</li></ol><p>line<br>break</p>';
  check('notes: the editor\'s own markup still reads as formatting', richTextToSafeHtml(editor) === editor, richTextToSafeHtml(editor));

  for (const evil of [
    '<p>ok</p><script>alert(1)</script>',
    '<p onclick="alert(1)">x</p>',
    '<p>x</p><svg onload=alert(1)>',
    '<p>x</p><iframe src="javascript:alert(1)"></iframe>',
    '<p style="position:fixed;inset:0">cover</p>',
    '<p>x</p><a href="javascript:alert(1)">click</a>',
    '<p>x</p><a href=" javascript:alert(1)">click</a>',
    '<p>x</p><a href="data:text/html,<script>alert(1)</script>">click</a>',
    '<p>x</p><a href="https://ok.example" onmouseover="alert(1)">hover</a>',
    '<p>x</p><a href="https://ok.example&quot; onmouseover=&quot;alert(1)">quote</a>',
    '<p>x</p><math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<p>x</p><a href="&#106;avascript:alert(1)">entity</a>',
    '<p>x</p><a href="&amp;#106;avascript:alert(1)">double entity</a>',
    '<p>x</p><form action="https://evil.example"><button>Go</button></form>',
  ]) {
    const html = render(richTextToSafeHtml(evil));
    const live = html.match(/<\/?([a-z0-9]+)/gi)?.map((t) => t.replace(/[</]/g, '').toLowerCase()) ?? [];
    const allowed = new Set(['div', 'p', 'br', 'strong', 'b', 'em', 'i', 's', 'del', 'u', 'ul', 'ol', 'li', 'a']);
    check(`notes: ${evil.slice(0, 60)} renders only the editor's tags`, live.every((t) => allowed.has(t)), html);
    check(`notes: ${evil.slice(0, 60)} has no live handler, style or script link`, !/<[^>]+\s(on[a-z]+|style)=/i.test(html) && !/href="\s*(javascript|data|vbscript):/i.test(html), html);
  }
  const link = richTextToSafeHtml('<p><a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com/?a=1&amp;b=2">site</a></p>');
  check('notes: an https link the editor made stays a link, opening in a new tab', link === '<p><a href="https://example.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">site</a></p>', link);
  check('notes: plain text from an agent or an email keeps its lines and shows its angle brackets', richTextToSafeHtml('Budget <5k\nCall back') === 'Budget &lt;5k<br>Call back', richTextToSafeHtml('Budget <5k\nCall back'));

  const page = readFileSync(join(SRC, 'app', '(protected)', 'leads', '[id]', 'page.tsx'), 'utf8');
  check('notes: the lead page renders notes through the safe renderer', /__html:\s*richTextToSafeHtml\(lead\.notes\)/.test(page) && !/__html:\s*lead\.notes/.test(page));
}

// ---- Every HTML sink in the app is one of the reviewed ones ----
const sandboxes = (text: string) => [...text.matchAll(/sandbox="([^"]*)"/g)].map((m) => m[1]);

function sinks() {
  // Each one is safe for the reason in docs of the hardening commit: static
  // text, hex-checked colors, DOMPurify, the escaping renderer above, or a
  // sandboxed frame without script or without same-origin.
  const REVIEWED: Record<string, number> = {
    'src/app/(protected)/leads/[id]/page.tsx': 1, // richTextToSafeHtml
    'src/app/layout.tsx': 1, // the static theme script
    'src/components/ui/ThemeProvider.tsx': 1, // brand CSS variables, hex colors only (cleanShades, isHexColor)
    'src/components/ui/Markdown.tsx': 1, // marked + DOMPurify with a Markdown-only allowlist
    'src/components/ui/FilePreviewModal.tsx': 1, // marked + DOMPurify, styles and forms dropped
  };
  const found: Record<string, number> = {};
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    const count = (text.match(/dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|\.outerHTML\s*=/g) ?? []).length;
    if (count) found[relative(APP, file).replace(/\\/g, '/')] = count;
  }
  const preview = found['src/components/projects/ClientEmailPreviewModal.tsx'];
  delete found['src/components/projects/ClientEmailPreviewModal.tsx'];
  check('sinks: every innerHTML in the app is a reviewed one (add a new one only with its reason here)', JSON.stringify(found, Object.keys(found).sort()) === JSON.stringify(REVIEWED, Object.keys(REVIEWED).sort()), found);
  const modal = readFileSync(join(SRC, 'components', 'projects', 'ClientEmailPreviewModal.tsx'), 'utf8');
  check('sinks: the client email preview writes only into a frame without scripts', preview === 2 && sandboxes(modal).length === 1 && sandboxes(modal).every((v) => v === 'allow-same-origin'), preview);
  for (const [file, frame] of [
    ['src/components/ui/FilePreviewModal.tsx', 'srcDoc={withScriptNonce(content, nonce)}'],
    ['src/app/portal/[token]/page/[fileId]/page.tsx', 'srcDoc={htmlContent}'],
  ] as const) {
    const text = readFileSync(join(APP, file), 'utf8');
    const at = text.indexOf(frame);
    const tag = text.slice(text.lastIndexOf('<iframe', at), text.indexOf('/>', at));
    check(`sinks: ${file} runs an HTML file's scripts only in a frame without same-origin`, at > 0 && /sandbox="allow-scripts"/.test(tag) && !/allow-same-origin/.test(tag), tag);
  }
  const email = readFileSync(join(SRC, 'components', 'inbox', 'EmailBodyFrame.tsx'), 'utf8');
  check('sinks: inbound email renders in a frame without scripts', sandboxes(email).length === 1 && sandboxes(email).every((v) => !v.split(' ').includes('allow-scripts')));
}

// ---- Avatar and link URLs ----
async function urls() {
  const { isSafeAvatarUrl, safeImageUrl, safeLinkHref } = await import('../src/lib/security/safe-url');
  const supabaseUrl = 'https://abc.supabase.co';
  const bad = ['javascript:alert(document.cookie)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'data:image/svg+xml,<svg onload=alert(1)>', 'data:text/html,hi', 'vbscript:msgbox(1)', '//evil.example/p.gif', '/\\evil.example/p.gif', 'http://tracker.evil.test/p.gif', 'file:///etc/passwd', '', 'x'.repeat(2001)];
  for (const url of bad) check(`avatar: ${JSON.stringify(url.slice(0, 40))} is refused when saved`, !isSafeAvatarUrl(url, { supabaseUrl }));
  for (const url of ['https://abc.supabase.co/storage/v1/object/public/pm-avatars/u/1.jpg', 'https://cdn.example.com/a.png', '/api/logo', 'http://127.0.0.1:55321/storage/v1/object/public/pm-avatars/a.jpg']) {
    check(`avatar: ${url} is accepted`, isSafeAvatarUrl(url, { supabaseUrl }));
  }
  check('avatar: a link into a private bucket of this project is refused', !isSafeAvatarUrl('https://abc.supabase.co/storage/v1/object/sign/pm-entity-files/invoices/x.pdf?token=t', { supabaseUrl }));
  for (const url of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'vbscript:x', '//evil.example/x', ' \njavascript:alert(1)']) {
    check(`render: ${JSON.stringify(url)} is no picture`, safeImageUrl(url) === null);
    check(`render: ${JSON.stringify(url)} is no link`, safeLinkHref(url) === null);
  }
  check('render: https, app paths and local previews show', safeImageUrl('https://x.example/a.png') !== null && safeImageUrl('/api/logo') !== null && safeImageUrl('blob:http://localhost:3009/4b1e') !== null);
  check('render: mailto and tel links stay links', safeLinkHref('mailto:a@b.co') !== null && safeLinkHref('tel:+15551234') !== null);

  const { Avatar, avatarPicture } = await import('../src/components/ui/Avatar');
  const { AgentAvatar } = await import('../src/components/agent/AgentAvatar');
  const { renderToStaticMarkup } = await import('react-dom/server');
  check('render: the Avatar picture rule is the shared one', avatarPicture('javascript:alert(1)') === null && avatarPicture('//evil.example/a.png') === null);
  const person = renderToStaticMarkup(createElement(Avatar, { name: 'BK avatar', src: 'javascript:alert(document.cookie)' }));
  check('render: a person with a javascript: avatar shows initials, no image', !/<img/.test(person) && !/javascript/i.test(person), person);
  const agent = renderToStaticMarkup(createElement(AgentAvatar, { id: 'a', name: 'BK avatar', src: 'javascript:alert(document.cookie)' }));
  check('render: an agent with a javascript: avatar shows initials, no image', !/<img/.test(agent) && !/javascript/i.test(agent), agent);
}

// ---- The proxy: where Next 16 loads it, and what it does ----
async function proxy() {
  // next/dist/build/index.js: rootDir = join(appDir, '..'); a `proxy` or
  // `middleware` file counts only at '/' or '/src' of it. The app directory
  // is src/app, so the file must be src/proxy.ts (`middleware` is deprecated in 16).
  const constants = await import('next/dist/lib/constants');
  check('proxy: Next 16 looks for a file named proxy', (constants as unknown as { PROXY_FILENAME: string }).PROXY_FILENAME === 'proxy');
  check('proxy: the app directory is src/app', existsSync(join(SRC, 'app', 'layout.tsx')) && !existsSync(join(APP, 'app')));
  check('proxy: src/proxy.ts exists (where Next loads it)', existsSync(join(SRC, 'proxy.ts')));
  // Every request goes through the proxy, so it must not ask Supabase Auth each
  // time: it verifies the session with getClaims (local with an asymmetric key).
  const sessionCode = readFileSync(join(SRC, 'lib', 'supabase', 'middleware.ts'), 'utf8');
  const sessionUserCode = readFileSync(join(SRC, 'lib', 'supabase', 'session-user.ts'), 'utf8');
  check('proxy: the session is checked with getClaims, never a getUser call per request',
    /sessionUser\(/.test(sessionCode) && !/auth\.getUser\(/.test(sessionCode) && /auth\.getClaims\(/.test(sessionUserCode) && !/auth\.getUser\(/.test(sessionUserCode));
  check('proxy: no stray middleware.ts at the app root or in src (Next ignores the first, refuses both together)', !existsSync(join(APP, 'middleware.ts')) && !existsSync(join(SRC, 'middleware.ts')) && !existsSync(join(APP, 'proxy.ts')));

  setEnv({ NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:1', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-test-key', NEXT_PUBLIC_DEMO_MODE: undefined, DEMO_MODE: undefined });
  if (!existsSync(join(SRC, 'proxy.ts'))) return;
  const mod = await import('../src/proxy');
  check('proxy: it exports the proxy function and a matcher', typeof mod.proxy === 'function' && Array.isArray(mod.config?.matcher) && mod.config.matcher.length > 0);
  const matcher = new RegExp(`^${mod.config.matcher[0].replace('/((?!', '/(?!').replace(').*)', ').*')}$`);
  check('proxy: the matcher covers pages and APIs, not static files', matcher.test('/dashboard') && matcher.test('/api/email-preview') && !matcher.test('/_next/static/x.js') && !matcher.test('/pdf.worker.min.mjs'));

  const { NextRequest } = await import('next/server');
  const preflight = await mod.proxy(new NextRequest('http://localhost:3009/api/v1/tasks', { method: 'OPTIONS' }));
  check('proxy: /api/v1 preflight answers 204 with CORS', preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === '*', preflight.status);
  check('proxy: CORS lets an API key and an idempotency key through', /x-api-key/i.test(preflight.headers.get('access-control-allow-headers') ?? '') && /idempotency-key/i.test(preflight.headers.get('access-control-allow-headers') ?? ''));
  const v1 = await mod.proxy(new NextRequest('http://localhost:3009/api/v1/tasks'));
  check('proxy: an /api/v1 call is answered by its route, with CORS', !v1.headers.get('location') && v1.headers.get('access-control-allow-origin') === '*');

  const page = await mod.proxy(new NextRequest('http://localhost:3009/team?tab=x'));
  const to = new URL(page.headers.get('location') ?? 'http://x/');
  check('proxy: a signed-out page goes to /login with where it was headed', page.status === 307 && to.pathname === '/login' && to.searchParams.get('auth') === 'required' && to.searchParams.get('next') === '/team?tab=x', page.headers.get('location'));
  const preview = await mod.proxy(new NextRequest('http://localhost:3009/api/email-preview'));
  check('proxy: a signed-out API call goes to its route (which answers 401), never the login page', !preview.headers.get('location'), preview.headers.get('location'));
  const portal = await mod.proxy(new NextRequest('http://localhost:3009/portal/abc'));
  check('proxy: the client portal stays open signed out', !portal.headers.get('location'));

  const { isPublicRoute } = await import('../src/lib/supabase/middleware');
  check('public: /api/email-preview and its page are behind sign-in', !isPublicRoute('/api/email-preview') && !isPublicRoute('/email-preview'));
  for (const path of ['/dashboard', '/oauth/authorize', '/team', '/settings', '/api/workspace/agents', '/api/notifications']) {
    check(`public: ${path} is behind sign-in`, !isPublicRoute(path));
  }
  for (const path of ['/login', '/portal/t', '/api/portal/t/files', '/api/v1/tasks', '/api/mcp', '/.well-known/oauth-authorization-server', '/api/oauth/register', '/api/oauth/token', '/api/docs', '/smtp/docs', '/webhooks/docs', '/auth/callback', '/welcome/set-password', '/api/logo', '/api/x/anything']) {
    check(`public: ${path} stays open signed out`, isPublicRoute(path));
  }

  const route = readFileSync(join(SRC, 'app', 'api', 'email-preview', 'route.ts'), 'utf8');
  const body = route.slice(route.indexOf('export async function GET'));
  check('email preview: the route refuses a signed-out caller itself, before building anything', /^export async function GET\([^)]*\) \{\s*(\/\/[^\n]*\s*)*const access = await requireSessionAccess\(\);\s*if \(access\.error\) return access\.error;/.test(body), body.slice(0, 300));
}

// ---- Content-Security-Policy ----
async function csp() {
  const { default: nextConfig } = await import('../next.config');
  const rules = (await nextConfig.headers?.()) ?? [];
  const policy = (source: string) => rules.filter((r) => r.source === source).flatMap((r) => r.headers).filter((h) => h.key.toLowerCase() === 'content-security-policy').map((h) => h.value).pop() ?? '';
  const directives = (value: string) => value.split(';').map((d) => d.trim());
  const all = directives(policy('/:path*'));
  check('csp: every page refuses plugin content', all.includes("object-src 'none'"), all);
  check('csp: every page refuses a <base> that re-points its links', all.includes("base-uri 'self'"), all);
  // Security review finding 13: pages load only inside the app; the portal stays open to an install's own site.
  check('csp: every page loads only inside the app itself (frame-ancestors self)', all.includes("frame-ancestors 'self'"), all);
  const portal = directives(policy('/portal/:path*'));
  check('csp: the client portal may still be framed by an install\'s site, keeping the rest of the policy', !portal.some((d) => d.startsWith('frame-ancestors')) && portal.includes("object-src 'none'") && portal.includes("base-uri 'self'"), portal);
  const header = (key: string) => rules.filter((r) => r.source === '/:path*').flatMap((r) => r.headers).find((h) => h.key === key)?.value;
  // A one-year HSTS without includeSubDomains: an install on an apex domain must not force HTTPS on every subdomain of it.
  check('headers: HSTS is one year and leaves subdomains alone', header('Strict-Transport-Security') === 'max-age=31536000', header('Strict-Transport-Security'));
  check('headers: HSTS, nosniff and a strict referrer policy on every response', /max-age=\d{7,}/.test(header('Strict-Transport-Security') ?? '')
    && header('X-Content-Type-Options') === 'nosniff' && header('Referrer-Policy') === 'strict-origin-when-cross-origin', rules[0]);
  for (const source of ['/login', '/login/:path*', '/oauth/:path*']) {
    const own = directives(policy(source));
    check(`csp: ${source} keeps frame-ancestors none and the app-wide policy (the last value wins)`, own.includes("frame-ancestors 'none'") && own.includes("object-src 'none'") && own.includes("base-uri 'self'"), own);
  }
  const order = rules.map((r) => r.source);
  check('csp: the no-framing rules come after the app-wide one', order.indexOf('/:path*') < order.indexOf('/login'), order);
}

async function main() {
  await richText();
  sinks();
  await urls();
  await proxy();
  await csp();
  if (failures.length) {
    console.error(`security hardening (web): ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.error(`  x ${f}`);
    process.exit(1);
  }
  console.log(`security hardening (web): ${passed} checks passed`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
