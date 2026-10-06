/**
 * Inbound email, the pure parts: subject normalization, threading choice,
 * mapping, auto-mail detection, quoted-history stripping, forwards, HTML to
 * text, sender trust (provider verdict and Authentication-Results), address
 * parsing, public domains, attachment kinds and Svix signatures, fed with
 * the .eml fixtures through the Resend transport where it matters.
 *
 * Run: npx tsx --tsconfig tsconfig.mcp-test.json scripts/verify-inbound-email-lib.ts
 */
import assert from 'node:assert/strict';
import { normalizeSubject, hasForwardPrefix } from '../src/lib/inbound-email/subject';
import { chooseThread, referencedIds } from '../src/lib/inbound-email/threading';
import { mergeClientSenders, resolveMapping, threadProjectDecision } from '../src/lib/inbound-email/mapping';
import { detectAutoMail } from '../src/lib/inbound-email/auto-mail';
import { extractNewText, isForwardedMessage } from '../src/lib/inbound-email/quoted';
import { htmlToText } from '../src/lib/inbound-email/html-text';
import { evaluateAuth, parseAuthenticationResults } from '../src/lib/inbound-email/auth-results';
import { organizationalDomain, parseAddressList, normalizeAddress, validateClientSenderAddress } from '../src/lib/inbound-email/addresses';
import { isPublicEmailDomain, validateClientDomain } from '../src/lib/inbound-email/public-domains';
import { attachmentKind } from '../src/lib/inbound-email/attachments';
import { signSvix, verifySvixSignature } from '../src/lib/inbound-email/svix';
import { parseMessageIdList } from '../src/lib/inbound-email/message-ids';
import { createResendReceiving, inboundFromResend } from '../src/lib/inbound-email/resend';
import { prepareEmail, readableBody } from '../src/lib/inbound-email/prepare';
import { fromRfc822Head, inlineForwardedSender, isAttachedMessage, parseForwardedFrom } from '../src/lib/inbound-email/forwarded';
import { readCapped } from '../src/lib/inbound-email/ingest';
import { skippedReasonLabel } from '../src/lib/inbound-email/inbox-types';
import { verifySignatureHeader } from '../src/lib/webhooks/sign';
import { matchesSearch, needsAttention, snippetOf, tabCounts, threadFlags, threadInTab, type MessageState } from '../src/lib/inbound-email/inbox-view';
import { FakeResend, readEml, resendFixture } from './inbound-email-fixtures';

let checks = 0;
const check = (actual: unknown, expected: unknown, label: string) => {
  assert.deepEqual(actual, expected, label);
  checks++;
};

async function prepared(name: string, options: Parameters<typeof resendFixture>[1] = { emailId: 'e', deliveredTo: ['ashley@relay.example.test'] }) {
  const fake = new FakeResend();
  const fixture = await resendFixture(await readEml(name), options);
  fake.add(fixture);
  const client = createResendReceiving({ apiKey: fake.apiKey, fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => fake.handle(new URL(String(input)), init)) as typeof fetch });
  const inbound = await inboundFromResend(client, options.emailId, null);
  return { inbound, result: prepareEmail(inbound, { trustedAuthservIds: [] }) };
}

async function main() {
  // Subjects.
  check(normalizeSubject('Re: RE: Fwd: [EXTERNAL] Homepage   banner'), 'homepage banner', 'stacked prefixes and tags');
  check(normalizeSubject('AW: WG: SV: VS: TR: Fw: Angebot'), 'angebot', 'localized prefixes');
  check(normalizeSubject('Re[2]: Re(3): Quote'), 'quote', 'counted prefixes');
  check(normalizeSubject('Report: Q3 numbers'), 'report: q3 numbers', '"Re" inside a word is not a prefix');
  check(normalizeSubject('Homepage banner (fwd)'), 'homepage banner', 'trailing (fwd)');
  check(normalizeSubject(null), '', 'missing subject');
  check(hasForwardPrefix('Re: Fwd: Site down?'), true, 'forward anywhere in the chain');
  check(hasForwardPrefix('Re: Site down?'), false, 'a reply is not a forward');

  // Message ids.
  check(parseMessageIdList('<a@x> <b@y>\n <c@z>'), ['a@x', 'b@y', 'c@z'], 'References list');
  check(referencedIds(['b@y'], ['a@x', 'b@y']), ['a@x', 'b@y'], 'In-Reply-To and References merged');

  // Threading.
  const now = '2026-10-06T12:00:00Z';
  check(chooseThread({ referenced: [{ thread_id: 't1', received_at: '2026-10-01T00:00:00Z' }, { thread_id: 't2', received_at: '2026-10-05T00:00:00Z' }], subjectNormalized: 'x', subjectThreads: [], participants: [], receivedAt: now }),
    { kind: 'existing', thread_id: 't2', reason: 'references' }, 'references win, newest thread');
  const subjectThreads = [
    { thread_id: 'old', subject_normalized: 'homepage banner', last_message_at: '2026-08-01T00:00:00Z', participants: ['dana@acme-roofing.example'] },
    { thread_id: 'other', subject_normalized: 'homepage banner', last_message_at: '2026-10-05T00:00:00Z', participants: ['zed@else.example'] },
    { thread_id: 'match', subject_normalized: 'homepage banner', last_message_at: '2026-10-04T00:00:00Z', participants: ['dana@acme-roofing.example'] },
  ];
  check(chooseThread({ referenced: [], subjectNormalized: 'homepage banner', subjectThreads, participants: ['Dana@acme-roofing.example'], receivedAt: now }),
    { kind: 'existing', thread_id: 'match', reason: 'subject' }, 'subject plus shared participant within 30 days');
  check(chooseThread({ referenced: [], subjectNormalized: 'homepage banner', subjectThreads, participants: ['new@person.example'], receivedAt: now }),
    { kind: 'new' }, 'same subject without a shared participant is new');
  check(chooseThread({ referenced: [], subjectNormalized: 'homepage banner', subjectThreads: [subjectThreads[0]], participants: ['dana@acme-roofing.example'], receivedAt: now }),
    { kind: 'new' }, 'older than 30 days is new');
  check(chooseThread({ referenced: [], subjectNormalized: '', subjectThreads, participants: ['dana@acme-roofing.example'], receivedAt: now }),
    { kind: 'new' }, 'an empty subject never threads by subject');

  // Mapping.
  check(resolveMapping({ contactProjectIds: [], domainProjectIds: [] }).project_id, null, 'no candidates');
  const single = resolveMapping({ contactProjectIds: ['p1'], domainProjectIds: ['p1'] });
  check([single.project_id, single.candidates.length, single.candidate_project_ids], ['p1', 2, ['p1']], 'one project by contact and domain is mapped');
  const several = resolveMapping({ contactProjectIds: ['p1', 'p2'], domainProjectIds: [] });
  check([several.project_id, several.candidate_project_ids], [null, ['p1', 'p2']], 'several candidates leave the project open');
  const viaAddress = { id: 'a1', project_id: 'p7' };
  check(threadProjectDecision({ project_id: 'p9' }, single, null).project_id, null, 'a thread keeps its project');
  check(threadProjectDecision({ project_id: 'p9' }, single, viaAddress).project_id, null, 'a thread keeps its project over a project address');
  check(threadProjectDecision({ project_id: null }, single, null), { project_id: 'p1', project_source: 'mapped', project_address_id: null }, 'a thread without one takes the mapping');
  check(threadProjectDecision(null, single, viaAddress), { project_id: 'p7', project_source: 'address', project_address_id: 'a1' }, 'a project address outranks the mapping');
  check(threadProjectDecision(null, several, viaAddress).project_id, 'p7', 'a project address settles several candidates');

  // Public domains.
  for (const domain of ['gmail.com', 'outlook.com', 'hotmail.co.uk', 'yahoo.fr', 'gmx.de', 'icloud.com', 'proton.me', 'aol.com', 'live.com', 'googlemail.com'])
    check(isPublicEmailDomain(domain), true, `${domain} is public`);
  check(isPublicEmailDomain('acme-roofing.example'), false, 'a client domain is not public');
  check(validateClientDomain('@Acme-Roofing.Example.'), { ok: true, domain: 'acme-roofing.example' }, 'domains are cleaned');
  check(validateClientDomain('gmail.com').ok, false, 'public domains are refused');
  check(validateClientDomain('not a domain').ok, false, 'garbage is refused');

  // Addresses and alignment.
  check(parseAddressList('"Lee, Bo" <Bo@X.example>, Ann <ann@x.example>, carl@x.example'),
    [{ address: 'bo@x.example', name: 'Lee, Bo' }, { address: 'ann@x.example', name: 'Ann' }, { address: 'carl@x.example', name: '' }], 'address list with a quoted comma');
  check(parseAddressList('=?UTF-8?B?SsO8cmdlbg==?= <j@x.example>')[0].name, 'Jürgen', 'encoded-word names decode');
  check(normalizeAddress('not-an-address'), null, 'non-addresses are dropped');
  check(organizationalDomain('mail.acme-roofing.example'), 'acme-roofing.example', 'subdomain to registrable domain');
  check(organizationalDomain('mx.client.co.uk'), 'client.co.uk', 'listed multi-part suffix');
  check(organizationalDomain('mx.client.com.zz'), 'client.com.zz', 'generic second-level suffix');

  // Auto-mail.
  const ooo = await prepared('out-of-office.eml');
  check(ooo.result.message.auto_mail_reason, 'auto-submitted: auto-replied', 'out of office');
  const newsletter = await prepared('newsletter.eml');
  check(newsletter.result.message.auto_mail_reason, 'precedence: bulk', 'newsletter');
  const bounce = await prepared('bounce.eml');
  check(bounce.result.message.auto_mail_reason, 'bounce: mailer-daemon sender', 'bounce');
  check(detectAutoMail({ headers: [{ name: 'content-type', value: 'multipart/report; report-type=delivery-status' }], fromAddress: 'x@y.example' }), 'report: multipart/report', 'multipart/report alone');
  check(detectAutoMail({ headers: [{ name: 'auto-submitted', value: 'no' }], fromAddress: 'x@y.example' }), null, 'Auto-Submitted: no is a person');
  check(detectAutoMail({ headers: [{ name: 'x-autorespond', value: 'yes' }], fromAddress: 'x@y.example' }), 'autoreply: x-autorespond', 'X-Autorespond');
  check(detectAutoMail({ headers: [{ name: 'list-id', value: '<l.example>' }], fromAddress: 'x@y.example' }), 'list: list-id', 'List-Id');

  // Replies, forwards, HTML.
  const gmail = await prepared('gmail-reply.eml');
  check(gmail.result.message.new_text, 'Looks great! Two changes please:\n1. Make the phone number bigger.\n2. Swap the photo for the one with the red truck.\n\nThanks,\nDana', 'Gmail reply: wrapped attribution and quotes stripped');
  check(gmail.result.message.in_reply_to, ['orig-1@agency.example'], 'In-Reply-To read from the headers map');
  check(gmail.result.message.subject_normalized, 'homepage banner', 'normalized subject');
  check(gmail.result.recipients.map((r) => `${r.kind}:${r.address}:${r.name}`),
    ['from:dana@acme-roofing.example:Dana Wu', 'to:owner@agency.example:Sam Owner', 'cc:ashley@agency.example:Ashley P.'], 'sender and recipients with names');
  check(gmail.result.deliveredTo, ['ashley@relay.example.test', 'ashley@agency.example'], 'delivered-to: the provider to and cc lists');
  check(gmail.result.message.is_forward, false, 'a reply is not a forward');
  const outlook = await prepared('outlook-reply.eml');
  check(outlook.result.message.new_text, 'Hi Ashley,\n\nYes, please send the corrected invoice to accounts@birchpartners.example.\n\nBen Ortiz | Birch Partners', 'Outlook reply: header block stripped');
  const forward = await prepared('forward-full-history.eml');
  check([forward.result.message.is_forward, forward.result.message.new_text], [true, 'Can you check this one?'], 'forward detected; new_text is the note');
  check(isForwardedMessage('Site down?', 'Begin forwarded message:\nFrom: x'), true, 'Apple Mail forward marker');
  const htmlOnly = await prepared('html-only.eml');
  check(htmlOnly.result.message.text_body, null, 'HTML-only has no text part');
  check(htmlOnly.result.message.new_text, 'Hi Ashley,\n\nHere is the link to the new logo: logo folder (https://files.example/logo).\n\nPlease update the header & footer.', 'HTML to text: no script or style, link kept');
  check(htmlToText('<span>A&nbsp;&lt;b&gt; &#8211; &#x41;</span><br>B'), 'A <b> – A\nB', 'entities decode');
  check(extractNewText('> only quoted'), '> only quoted', 'all-quoted text falls back to the full text');

  // Trust.
  check(gmail.result.message.auth.trust, 'trusted', 'provider DKIM pass is trusted');
  const fail = await prepared('gmail-reply.eml', { emailId: 'f', deliveredTo: ['ashley@relay.example.test'], authentication: { spf: 'pass', dkim: 'fail', dmarc: 'fail' } });
  check(fail.result.message.auth.trust, 'untrusted', 'provider DKIM fail is untrusted');
  const gray = await prepared('gmail-reply.eml', { emailId: 'g', deliveredTo: ['ashley@relay.example.test'], authentication: { spf: 'gray', dkim: 'gray', dmarc: 'gray' } });
  check(gray.result.message.auth.trust, 'untrusted', 'provider DKIM gray (unsigned or misaligned) is untrusted');
  const unknown = await prepared('gmail-reply.eml', { emailId: 'u', deliveredTo: ['ashley@relay.example.test'], authentication: null });
  check([unknown.result.message.auth.trust, unknown.result.message.auth.source], ['unknown', null], 'no provider verdict and no trusted header is unknown');
  const processing = evaluateAuth({ headers: [], fromAddress: 'a@b.example', trustedIds: [], providerAuth: { spf: null, dkim: 'processing_failed', dmarc: null } });
  check(processing.trust, 'unknown', 'processing_failed is unknown');
  const forged = [
    { name: 'authentication-results', value: 'mx.relay.example.test; dkim=pass header.d=mail.acme-roofing.example header.s=s1; spf=pass smtp.mailfrom=acme-roofing.example; dmarc=pass header.from=acme-roofing.example' },
    { name: 'authentication-results', value: 'mx.relay.example.test; dkim=pass header.d=evil.example' },
  ];
  check(evaluateAuth({ headers: forged, fromAddress: 'dana@acme-roofing.example', trustedIds: ['mx.relay.example.test'] }).trust, 'trusted', 'topmost listed header: aligned subdomain DKIM pass');
  check(evaluateAuth({ headers: forged.slice().reverse(), fromAddress: 'dana@acme-roofing.example', trustedIds: ['mx.relay.example.test'] }).trust, 'untrusted', 'topmost listed header misaligned is untrusted');
  check(evaluateAuth({ headers: forged, fromAddress: 'dana@acme-roofing.example', trustedIds: [] }).trust, 'unknown', 'an unlisted authserv-id is ignored');
  check(evaluateAuth({ headers: [{ name: 'arc-authentication-results', value: 'i=2; mx.relay.example.test; dkim=pass (good) header.i=@acme-roofing.example' }], fromAddress: 'dana@acme-roofing.example', trustedIds: ['mx.relay.example.test'] }).trust, 'trusted', 'ARC results with an instance and comments');
  check(parseAuthenticationResults('mx.example; dkim=pass header.d=a.example; spf=softfail (sender) smtp.mailfrom=a.example').results.map((r) => `${r.method}=${r.result}`), ['dkim=pass', 'spf=softfail'], 'Authentication-Results parse');

  // Attachments.
  check(['image/png', 'application/pdf', 'text/csv', 'image/svg+xml', 'application/msword'].map((t) => attachmentKind(t, null)), ['image', 'pdf', 'text', 'other', 'other'], 'kinds by type');
  check(attachmentKind('application/octet-stream', 'scan.PDF'), 'pdf', 'octet-stream falls back to the extension');

  // Svix (Resend webhooks).
  const secret = `whsec_${Buffer.from('a-test-signing-secret-of-32-bytes!').toString('base64')}`;
  const body = '{"type":"email.received","data":{"email_id":"x"}}';
  const t = 1_790_000_000;
  const signature = signSvix(secret, 'msg_1', t, body);
  check(verifySvixSignature({ secret, id: 'msg_1', timestamp: String(t), signature, body, nowSeconds: t + 10 }), true, 'a good signature verifies');
  check(verifySvixSignature({ secret, id: 'msg_1', timestamp: String(t), signature: `v1,AAAA ${signature}`, body, nowSeconds: t }), true, 'any listed signature may match');
  check(verifySvixSignature({ secret, id: 'msg_1', timestamp: String(t), signature, body: body + ' ', nowSeconds: t }), false, 'a changed body fails');
  check(verifySvixSignature({ secret, id: 'msg_2', timestamp: String(t), signature, body, nowSeconds: t }), false, 'another message id fails');
  check(verifySvixSignature({ secret, id: 'msg_1', timestamp: String(t), signature, body, nowSeconds: t + 301 }), false, 'older than five minutes fails');
  check(verifySvixSignature({ secret: `whsec_${Buffer.from('another-secret').toString('base64')}`, id: 'msg_1', timestamp: String(t), signature, body, nowSeconds: t }), false, 'the wrong secret fails');
  check(verifySvixSignature({ secret, id: 'msg_1', timestamp: String(t), signature: signature.replace('v1,', 'v2,'), body, nowSeconds: t }), false, 'only v1 signatures count');
  check(verifySvixSignature({ secret, id: null, timestamp: String(t), signature, body, nowSeconds: t }), false, 'missing headers fail');

  // The app's own webhook signature helper keeps its five-minute window (unchanged).
  check(await verifySignatureHeader('s', null, body), false, 'outbound webhook signature helper still refuses a missing header');

  // Inbox thread states (the Inbox page and the sidebar badge).
  const msg = (partial: Partial<MessageState>): MessageState => ({ status: 'handled', reviewed_at: null, outcome: 'task', urgent: false, trust: 'trusted', ...partial });
  check(threadFlags([msg({}), msg({ status: 'needs_ciaran', outcome: 'needs_ciaran', urgent: true })]).state, 'needs_you', 'needs_ciaran wins the thread state');
  check(threadFlags([msg({ status: 'needs_ciaran', urgent: true })]).urgent, true, 'urgent while it waits on a person');
  check(threadFlags([msg({ urgent: true, reviewed_at: 'x' })]).urgent, false, 'not urgent once handled');
  check(threadFlags([msg({ outcome: 'needs_reply' })]).needs_reply, true, 'a suggested reply needs reply until reviewed');
  check(threadFlags([msg({ outcome: 'needs_reply', reviewed_at: '2026-10-05' })]).state, 'handled', 'reviewing clears needs reply');
  check(threadFlags([msg({ outcome: 'needs_reply', status: 'new' })]).state, 'new', 'sent back to the agent: new, not needs reply');
  check(threadFlags([msg({ status: 'ignored', outcome: null }), msg({ status: 'ignored', outcome: null })]).state, 'ignored', 'all auto-mail is ignored');
  check(threadFlags([msg({ trust: 'untrusted' })]).untrusted, true, 'any untrusted message flags the thread');
  const ignoredFlags = threadFlags([msg({ status: 'ignored', outcome: null })]);
  check([threadInTab(ignoredFlags, null, 'unassigned'), threadInTab(threadFlags([msg({})]), null, 'unassigned')], [false, true], 'unassigned skips auto-mail');
  const counts = tabCounts([
    { flags: threadFlags([msg({ status: 'needs_ciaran' }), msg({ status: 'new', outcome: null })]), project_id: 'p' },
    { flags: threadFlags([msg({ outcome: 'needs_reply' })]), project_id: null },
    { flags: ignoredFlags, project_id: null },
  ]);
  check([counts.all, counts.needs_you, counts.new, counts.needs_reply, counts.handled, counts.ignored, counts.unassigned], [3, 1, 1, 1, 0, 1, 1], 'tab counts');
  check(needsAttention(threadFlags([msg({ status: 'new', outcome: null })])), false, 'new mail waits on the agent, not on a person');
  check([matchesSearch('acme dana', ['Banner', 'Dana Wu', 'Acme Roofing']), matchesSearch('acme ben', ['Dana', 'Acme'])], [true, false], 'search needs every word');
  check(snippetOf('  Hello\n\nthere  ', 8), 'Hello t…', 'snippet flattens and trims');

  // Downloads: identity encoding, and a decoded body is not held to Content-Length.
  let downloadHeaders: Headers | null = null;
  const downloads = createResendReceiving({
    apiKey: 'k',
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      downloadHeaders = new Headers(init?.headers);
      return new Response('ok');
    }) as typeof fetch,
  });
  await downloads.download('https://cdn.example.test/file?signature=x');
  check((downloadHeaders as Headers | null)?.get('accept-encoding'), 'identity', 'downloads ask for identity encoding');
  const decodedBody = new TextEncoder().encode('decoded body, longer than the compressed length');
  const gz = await readCapped(new Response(decodedBody, { headers: { 'content-length': '12', 'content-encoding': 'gzip' } }), 1024);
  check(gz?.bytes.byteLength, decodedBody.byteLength, 'a content-encoded download is read whole, not compared to Content-Length');
  const cut = await readCapped(new Response(decodedBody, { headers: { 'content-length': '12' } }), 1024).then(() => 'stored', (error: Error) => error.message);
  check(/Content-Length said 12/.test(cut), true, 'without an encoding a length mismatch is still an error');

  // Client sender addresses (email_client_addresses): mapping, validation and the project list.
  const bySender = resolveMapping({ contactProjectIds: [], domainProjectIds: [], senderProjectIds: ['p1'] });
  check([bySender.project_id, bySender.candidates], ['p1', [{ project_id: 'p1', reason: 'sender' }]], 'a client sender address alone maps, with reason sender');
  const senderTwice = resolveMapping({ contactProjectIds: [], domainProjectIds: [], senderProjectIds: ['p1', 'p2'] });
  check([senderTwice.project_id, senderTwice.candidate_project_ids], [null, ['p1', 'p2']], 'one sender on two projects leaves the project open');
  const senderAndContact = resolveMapping({ contactProjectIds: ['p1'], domainProjectIds: [], senderProjectIds: ['p1'] });
  check([senderAndContact.project_id, senderAndContact.candidates.map((c) => c.reason)], ['p1', ['contact', 'sender']], 'contact and sender on one project map it');
  check(threadProjectDecision(null, bySender, { id: 'a1', project_id: 'p7' }), { project_id: 'p7', project_source: 'address', project_address_id: 'a1' },
    'a project address outranks a sender match');
  check([validateClientSenderAddress(' Bob@GMAIL.com '), validateClientSenderAddress('bob').ok],
    [{ ok: true, address: 'bob@gmail.com' }, false], 'a sender address is lowercased, public services allowed; a non-address is refused');
  const merged = mergeClientSenders(
    [
      { address: 'zed@acme.example', contact_id: 'c2', contact_name: 'Zoe' },
      { address: 'amy@acme.example', contact_id: 'c1', contact_name: 'Amy' },
      { address: 'shared@acme.example', contact_id: 'c2', contact_name: 'Zoe' },
      { address: 'shared@acme.example', contact_id: 'c1', contact_name: 'Amy' },
    ],
    [
      { id: 'm2', address: 'zed@acme.example', created_at: 't2' },
      { id: 'm3', address: 'bob@gmail.com', created_at: 't3' },
      { id: 'm1', address: 'al@gmail.com', created_at: 't1' },
    ],
    true,
  );
  check(merged.map((r) => [r.address, r.source, r.id, r.contact_name]), [
    ['amy@acme.example', 'contact', null, 'Amy'],
    ['shared@acme.example', 'contact', null, 'Amy'],
    ['zed@acme.example', 'contact', 'm2', 'Zoe'],
    ['al@gmail.com', 'manual', 'm1', null],
    ['bob@gmail.com', 'manual', 'm3', null],
  ], 'merge: contacts first by name, each address once (first contact by name), a manual row on a contact address stays removable, then manual by address');
  const hidden = mergeClientSenders([{ address: 'amy@acme.example', contact_id: 'c1', contact_name: 'Amy' }], [], false);
  check(hidden, [{ address: 'amy@acme.example', source: 'contact', id: null, contact_id: null, contact_name: null, created_at: null }],
    'merge: without contact access the address stays, the contact name and id do not');

  // Skipped files have words.
  check([skippedReasonLabel('over_size_cap'), skippedReasonLabel('download_failed'), skippedReasonLabel('later_reason'), skippedReasonLabel(null)],
    ['Not stored: it was over the size limit', 'Not stored: it failed to download', 'Not stored', 'Not stored'], 'skipped reason labels');

  // ---- Forwards from the team: the original sender, one layer deep (forwarded.ts) ----
  // (Appended block; keep it self-contained.)
  {
    const dana = { address: 'dana@acme-roofing.example', name: 'Dana Wu' };
    const gmail = [
      'Can you check this one?',
      '',
      '---------- Forwarded message ---------',
      'From: Dana Wu <Dana@Acme-Roofing.example>',
      'Date: Mon, Oct 5, 2026 at 4:40 PM',
      'Subject: Site down?',
      'To: Sam Owner <owner@agency.example>',
      '',
      'Our website shows an error page.',
    ].join('\r\n');
    check(inlineForwardedSender('Fwd: Site down?', gmail), dana, 'forward: Gmail marker under a short note, address lowercased');
    check(inlineForwardedSender('Site down?', gmail), dana, 'forward: the Gmail marker needs no forward prefix in the subject');
    const apple = ['FYI', '', 'Begin forwarded message:', '', 'From: Dana Wu <dana@acme-roofing.example>', 'Subject: Site down?',
      'Date: October 5, 2026 at 4:40:00 PM EDT', 'To: Sam Owner <owner@agency.example>', '', 'Our website shows an error page.'].join('\n');
    check(inlineForwardedSender('Fwd: Site down?', apple), dana, 'forward: Apple Mail "Begin forwarded message:"');
    const outlookOld = ['Please take a look.', '', '-----Original Message-----', 'From: Dana Wu [mailto:dana@acme-roofing.example]',
      'Sent: Monday, October 5, 2026 4:40 PM', 'To: Sam Owner', 'Subject: Site down?', '', 'Our website shows an error page.'].join('\n');
    check(inlineForwardedSender('FW: Site down?', outlookOld), dana, 'forward: Outlook "-----Original Message-----" with [mailto:]');
    check(inlineForwardedSender('RE: Site down?', outlookOld), null, 'forward: the same Outlook block on a reply is not a forward');
    const outlookNew = ['', '________________________________', 'From: Dana Wu <dana@acme-roofing.example>', 'Sent: Monday, October 5, 2026 4:40 PM',
      'To: Sam Owner <owner@agency.example>', 'Subject: Site down?', '', 'Our website shows an error page.'].join('\n');
    check(inlineForwardedSender('FW: Site down?', outlookNew), dana, 'forward: Outlook header block under a rule');
    const outlookBare = ['Sam', '*From:* Dana Wu <dana@acme-roofing.example>', '*Sent:* Monday, October 5, 2026', '*To:* Sam Owner', '*Subject:* Site down?', '', 'Body'].join('\n');
    check(inlineForwardedSender('Fw: Site down?', outlookBare), dana, 'forward: a bare (bold) Outlook header block');
    check(inlineForwardedSender('Fw: Site down?', ['From: me', 'Just a note.'].join('\n')), null, 'forward: a From: line that opens no header block is not a forward');
    const farDown = [...Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of a long note about the project.`), '',
      '---------- Forwarded message ---------', 'From: Dana Wu <dana@acme-roofing.example>', 'Subject: Site down?'].join('\n');
    check(inlineForwardedSender('Fwd: Site down?', farDown), null, 'forward: a marker far down the body (past a short note) is not a forward');
    const longNote = ['x'.repeat(1300), '---------- Forwarded message ---------', 'From: Dana Wu <dana@acme-roofing.example>', 'Subject: Site down?'].join('\n');
    check(inlineForwardedSender('Fwd: x', longNote), null, 'forward: a note longer than the limit hides the marker');
    const reply = ['Thanks, will do.', '', 'On Mon, Oct 5, 2026 at 4:40 PM Dana Wu <dana@acme-roofing.example> wrote:',
      '> ---------- Forwarded message ---------', '> From: Bob <bob@vendor.example>', '> Subject: Invoice'].join('\n');
    check(inlineForwardedSender('Re: Fwd: Invoice', reply), null, 'forward: a reply quoting a forward is not a forward');
    const quoted = ['> From: Dana Wu <dana@acme-roofing.example>', '> Sent: Monday', '> To: Sam', '> Subject: Site down?'].join('\n');
    check(inlineForwardedSender('FW: Site down?', quoted), null, 'forward: ">" quoted header lines are not a forward');
    const noOthers = ['---------- Forwarded message ---------', 'From: Dana Wu <dana@acme-roofing.example>', '', 'Body'].join('\n');
    check(inlineForwardedSender('Fwd: x', noOthers), null, 'forward: a marker whose block has only From is not recognized');
    const noAddress = ['---------- Forwarded message ---------', 'From: Dana Wu', 'Subject: Site down?'].join('\n');
    check(inlineForwardedSender('Fwd: x', noAddress), null, 'forward: a From without an address is not a forward');
    check(inlineForwardedSender('Fwd: x', ''), null, 'forward: an empty body');
    // HTML-only Gmail forward: the HTML-derived text carries the block.
    const html = '<div dir="ltr">Can you check this one?<br><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>'
      + 'From: <strong class="gmail_sendername" dir="auto">Dana Wu</strong> <span dir="auto">&lt;<a href="mailto:dana@acme-roofing.example">dana@acme-roofing.example</a>&gt;</span><br>'
      + 'Date: Mon, Oct 5, 2026 at 4:40 PM<br>Subject: Site down?<br>To: &lt;<a href="mailto:owner@agency.example">owner@agency.example</a>&gt;<br></div><br><br>Our website shows an error page.</div></div>';
    check(inlineForwardedSender('Fwd: Site down?', readableBody(null, html)), dana, 'forward: an HTML-only Gmail forward, through its HTML text');
    check(inlineForwardedSender('Fwd: Site down?', readableBody('  ', html)), dana, 'forward: a blank plain part falls back to the HTML text');
    check([parseForwardedFrom('"Wu, Dana" <dana@acme-roofing.example>'), parseForwardedFrom('dana@acme-roofing.example'), parseForwardedFrom('Dana Wu <mailto:dana@acme-roofing.example>')],
      [{ address: 'dana@acme-roofing.example', name: 'Wu, Dana' }, { address: 'dana@acme-roofing.example', name: '' }, dana], 'forward: From value shapes');
    // Forwarded as an attachment.
    const head = Buffer.from(['Return-Path: <dana@acme-roofing.example>', 'From: =?UTF-8?Q?Dana_Wu?=', ' <dana@acme-roofing.example>', 'Subject: Site down?', '',
      'From: Not This <not@this.example>'].join('\r\n'));
    check(fromRfc822Head(head), dana, 'forward: an attached message\'s From header (folded, encoded name)');
    check(fromRfc822Head(Buffer.from('Subject: no sender\r\n\r\nFrom: body <body@x.example>')), null, 'forward: an attached message without From');
    check([isAttachedMessage('message/rfc822', 'x'), isAttachedMessage('application/octet-stream', 'Site down.EML'), isAttachedMessage('text/plain', 'notes.txt')],
      [true, true, false], 'forward: attached messages by type or .eml name');
  }

  console.log(`inbound email lib: ${checks} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
