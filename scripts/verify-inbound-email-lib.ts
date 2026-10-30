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
import { normalizeSubject, hasForwardPrefix } from '../src/lib/communications/email/subject';
import { chooseThread, referencedIds } from '../src/lib/communications/email/threading';
import { mergeClientSenders, resolveMapping, threadProjectDecision } from '../src/lib/communications/mapping';
import { detectAutoMail } from '../src/lib/communications/email/auto-mail';
import { extractNewText, isForwardedMessage } from '../src/lib/communications/email/quoted';
import { htmlToText } from '../src/lib/communications/email/html-text';
import { compactLinks, hasQuotedHtml, inlineImageIds, isTrackingLink, linkParts, normalizeContentId, opensAsHtml, shortUrl } from '../src/lib/communications/email/display';
import { alertSeriesKey, sortEmail } from '../src/lib/communications/sorting';
import { evaluateAuth, parseAuthenticationResults } from '../src/lib/communications/email/auth-results';
import { organizationalDomain, parseAddressList, normalizeAddress, validateClientSenderAddress } from '../src/lib/communications/email/addresses';
import { isPublicEmailDomain, validateClientDomain } from '../src/lib/communications/email/public-domains';
import { attachmentKind } from '../src/lib/communications/attachments';
import { signSvix, verifySvixSignature } from '../src/lib/communications/email/svix';
import { parseMessageIdList } from '../src/lib/communications/email/message-ids';
import { createResendReceiving, inboundFromResend } from '../src/lib/communications/email/resend';
import { headerLinesFromMap, headerValues } from '../src/lib/communications/email/headers';
import { composeAnswer, decisionsOf } from '../src/lib/communications/inbox-decisions';
import { prepareEmail, readableBody } from '../src/lib/communications/email/prepare';
import { fromRfc822Head, inlineForwardedSender, isAttachedMessage, parseForwardedFrom } from '../src/lib/communications/email/forwarded';
import { readCapped } from '../src/lib/communications/email/ingest';
import { skippedReasonLabel } from '../src/lib/communications/inbox-types';
import { verifySignatureHeader } from '../src/lib/webhooks/sign';
import { attentionCounts, codeIn, matchesSearch, needsAttention, snippetOf, tabCounts, threadFlags, threadInTab, type MessageState } from '../src/lib/communications/inbox-view';
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

  // Sorting: kind, topic and action, from real mail.
  const sort = (fromAddress: string, subject: string, text = '', extra: Partial<Parameters<typeof sortEmail>[0]> = {}) => {
    const result = sortEmail({ fromAddress, subject, text, autoMailReason: null, fromTeam: false, knownPerson: false, filterAutoMail: true, rules: [], ...extra });
    return [result.action, result.kind, result.topic];
  };
  check(sort('no-reply@okendo.io', '❗ Your Okendo Plan Limit is at 90%', "You've reached 90% of the plan limit"), ['ignore', 'notification', 'usage'], 'sort: a usage alert is filtered');
  check(sort('ads-noreply@google.com', 'Improve your Ad Strength for better results'), ['ignore', 'marketing', 'promotion'], 'sort: a promotion is filtered');
  check(sort('upwork@t.upwork.com', 'You have received a new proposal', 'Base rate $35 per hour. Log in to view.'), ['fyi', 'notification', 'update'], 'sort: a bulk subdomain is automated; footer prices and log in do not count');
  check(sort('no-reply@asana.com', '📅 You have 1 overdue task'), ['fyi', 'notification', 'update'], 'sort: an overdue task is not an account problem');
  check(sort('forwarding-noreply@google.com', 'Forwarding Confirmation - Receive Mail from x'), ['triage', 'notification', 'security'], 'sort: noreply inside the address; a forwarding confirmation is security');
  check(sort('billing@stripe.com', 'Your payment failed'), ['triage', 'notification', 'account_risk'], 'sort: a failed payment is triaged');
  check(sort('receipts@vercel.com', 'Your receipt from Vercel #1234'), ['fyi', 'notification', 'receipt'], 'sort: a receipt is an update');
  check(sort('billing@vercel.com', 'Invoice receipt: payment due Nov 3'), ['triage', 'notification', 'money'], 'sort: an invoice is money, never a receipt');
  check(sort('updates@tool.example', 'Payment received, thank you', '', { autoMailReason: 'list: list-unsubscribe' }), ['fyi', 'notification', 'receipt'], 'sort: a receipt is never filtered as bulk mail');
  // Codes and calendar replies, whoever sends them (TikTok mails through a client's Google Group).
  check(sort('tiktok.happysoles@suitupbrands.com', '807155 is your verification code', '', { knownPerson: true }), ['ignore', 'notification', 'code'], 'sort: a one-time code goes to Codes, even through a client group');
  check(sort('no-reply@shopify.com', 'Your Shopify login code'), ['ignore', 'notification', 'code'], 'sort: a login code');
  check(sort('no-reply@okendo.io', 'Your one-time passcode', '', { filterAutoMail: false }), ['ignore', 'notification', 'code'], 'sort: a code waits in Codes even in an inbox that keeps bulk mail');
  check(sort('no-reply@accounts.google.com', 'Critical security alert'), ['triage', 'notification', 'security'], 'sort: a security alert is never a code');
  check(sort('no-reply@accounts.google.com', 'New sign-in: your verification code was used'), ['triage', 'notification', 'security'], 'sort: a new sign-in naming a code stays security');
  check(sort('maria@suitupbrands.com', 'Fwd: 123456 is your verification code', '', { knownPerson: true }), ['triage', 'person', null], 'sort: a forwarded code is a person writing');
  check(sort('shay@happyinnovations.com', 'Updated invitation: Customer service tickets @ Fri Oct 23, 2026', '', { knownPerson: true }), ['fyi', 'notification', 'calendar'], 'sort: an updated invitation is a calendar reply');
  check(sort('dana@client.example', 'Accepted: Kickoff call @ Mon Nov 2', '', { knownPerson: true }), ['fyi', 'notification', 'calendar'], 'sort: an acceptance is a calendar reply');
  check(sort('dana@client.example', 'Invitation: Kickoff call @ Mon Nov 2', '', { knownPerson: true }), ['triage', 'person', null], 'sort: a new invitation is still a person');
  check(sort('dana@client.example', 'Re: Accepted: Kickoff call', '', { knownPerson: true }), ['triage', 'person', null], 'sort: a reply about a calendar reply is a person');
  check(sort('workspacesupport@feedback.google.com', 'Quick reminder - [Managed user cannot sign in due to a conflicting unmanaged account] Your feedback matters for case #76845455'),
    ['fyi', 'notification', 'survey'], 'sort: a support survey is an update, not security');
  check(sort('gemini-notes@google.com', 'Notes: “Q4 All-Hands Meeting” Oct 23, 2026'), ['triage', 'meeting_notes', null], 'sort: Gemini notes are meeting notes');
  check(sort('maria@suitupbrands.com', 'Re: Customer Support Update'), ['triage', 'person', null], 'sort: a person is triaged');
  check(sort('info@smallclient.example', 'Quick question about the site'), ['triage', 'person', null], 'sort: info@ is a person until headers say otherwise');
  check(sort('news@brand.example', 'Our summer sale', '', { knownPerson: true }), ['triage', 'person', null], 'sort: a known contact is a person whatever the mailbox');
  check(sort('ciaran@agency.example', 'Notes from today', '', { fromTeam: true }), ['triage', 'team', null], 'sort: a teammate');
  const rules = [
    { id: 'r1', match_kind: 'domain' as const, match_value: 'okendo.io', topic: 'usage' as const, action: 'always' as const },
    { id: 'r2', match_kind: 'domain' as const, match_value: 'upwork.com', topic: null, action: 'ignore' as const },
    { id: 'r3', match_kind: 'address' as const, match_value: 'no-reply@upwork.com', topic: null, action: 'fyi' as const },
  ];
  check(sort('no-reply@okendo.io', 'Plan Limit is at 90%', '', { rules }), ['always', 'notification', 'usage'], 'sort: a topic rule overrides the default');
  check(sort('upwork@t.upwork.com', 'New proposal', '', { rules }), ['ignore', 'notification', 'update'], 'sort: a domain rule covers subdomains');
  check(sort('no-reply@upwork.com', 'Shortlist ready', '', { rules }), ['fyi', 'notification', 'update'], 'sort: an exact address beats its domain');
  check(sortEmail({ fromAddress: 'no-reply@okendo.io', subject: 'Plan Limit is at 90%', text: '', autoMailReason: null, fromTeam: false, knownPerson: false, filterAutoMail: true, rules }).reason,
    'Always triaged by the rule for a usage alert from okendo.io.', 'sort: the reason names the rule');
  check(sort('updates@tool.example', 'Your weekly activity', '', { autoMailReason: 'list: list-unsubscribe' }), ['ignore', 'notification', 'update'], 'sort: bulk mail stays filtered');
  check(sort('billing@tool.example', 'Your payment failed', '', { autoMailReason: 'list: list-unsubscribe' }), ['triage', 'notification', 'account_risk'], 'sort: bulk mail about an account problem gets through');
  check(sort('no-reply@okendo.io', 'Plan Limit is at 90%', '', { filterAutoMail: false }), ['fyi', 'notification', 'usage'], 'sort: an inbox that keeps bulk mail only filters by rule');
  check(alertSeriesKey('❗ Your Okendo Plan Limit is at 75%') === alertSeriesKey('❗ Your Okendo Plan Limit is at 90%'), true, 'sort: alerts that differ by a number are one series');

  // Display: links cut to their site, which body opens first, inline image ids.
  const tracking = 'https://www.upwork.com/ab/notifications/track?id=9f8e7d6c5b4a39281706f5e4d3c2b1a0&u=1';
  check(linkParts(`View job (${tracking}) now.`), [{ text: 'View job ' }, { url: tracking, label: 'upwork.com' }, { text: ' now.' }], 'display: a wrapped tracking link becomes its site');
  check(linkParts('See https://acme.example/pricing.'), [{ text: 'See ' }, { url: 'https://acme.example/pricing', label: 'acme.example/pricing' }, { text: '.' }], 'display: a short readable path stays, trailing punctuation is text');
  check(linkParts('<https://a.example/x>'), [{ url: 'https://a.example/x', label: 'a.example/x' }], 'display: angle-bracketed link');
  check(linkParts('no links here'), [{ text: 'no links here' }], 'display: plain text is one part');
  const doc = 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfG/edit?usp=sharing';
  check(compactLinks(`Brief: ${doc}`), `Brief: ${doc}`, 'display: a shared document link is kept whole for the agent');
  check(isTrackingLink('https://click.mail.example/ls/click?upn=' + 'q'.repeat(90)), true, 'display: a long redirect with a token query is tracking');
  check(isTrackingLink('https://acme.example/pricing?plan=pro'), false, 'display: a short readable link is not tracking');
  check(compactLinks(`Apply here (${tracking}x${'a'.repeat(40)}) or see https://docs.example/brief.`),
    'Apply here [upwork.com link] or see https://docs.example/brief.', 'display: the agent copy cuts long links to their site and keeps short ones');
  check(shortUrl('https://go.example/c/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'), 'go.example', 'display: an opaque token path drops');
  const reply = { html_body: '<p>Yes</p>', text_body: 'Yes\n\nOn Mon, Bob wrote:\n> the whole earlier email, quoted back in full', new_text: 'Yes', is_forward: false };
  check(opensAsHtml(reply), false, 'display: a reply with quoted history opens on the new text');
  check(opensAsHtml({ html_body: '<p>Your plan is at 90%</p>', text_body: null, new_text: 'Your plan is at 90%', is_forward: false }), true, 'display: a whole HTML email opens as designed');
  check(opensAsHtml({ html_body: null, text_body: 'Hi', new_text: 'Hi', is_forward: false }), false, 'display: no HTML, no HTML view');
  check([...inlineImageIds('<img src="cid:Logo@Mail"><img src=\'cid:%3Cb%3E\'>')], ['logo@mail', 'b'], 'display: cid references, normalized');
  check(normalizeContentId('<Logo@Mail>'), 'logo@mail', 'display: a stored Content-ID matches its reference');
  check(['<div class="gmail_quote gmail_quote_container">', '<blockquote type="cite">', '<div id="divRplyFwdMsg">', '<div class="moz-cite-prefix">', '<p>no history</p>'].map(hasQuotedHtml),
    [true, true, true, true, false], 'display: quoted history marked by Gmail, Apple Mail, Outlook, Thunderbird');

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

  // A sender signing from a subdomain is gray to Resend but passes DMARC.
  check(evaluateAuth({ headers: [], fromAddress: 'vip@info.archive.example', trustedIds: [], providerAuth: { spf: 'pass', dkim: 'gray', dmarc: 'pass' } }).trust, 'trusted', 'provider DMARC pass is trusted');
  check(evaluateAuth({ headers: [], fromAddress: 'vip@info.archive.example', trustedIds: [], providerAuth: { spf: 'pass', dkim: 'gray', dmarc: 'fail' } }).trust, 'untrusted', 'provider gray with DMARC fail stays untrusted');

  // Resend's header map: a repeated header arrives as one JSON array string.
  const mapped = headerLinesFromMap({ 'Authentication-Results': '["a.example; dkim=pass","b.example; dkim=fail"]', Subject: '[Important] Renewal' });
  check(headerValues(mapped, 'authentication-results'), ['a.example; dkim=pass', 'b.example; dkim=fail'], 'headers: a JSON array string is each value, in order');
  check(headerValues(mapped, 'subject'), ['[Important] Renewal'], 'headers: a value that only starts with a bracket is kept whole');

  // Forwarded through one of our own domains (a Google Group), as Contabo's notice arrived.
  const groupForward = [
    { name: 'authentication-results', value: 'amazonses.com; spf=pass (spfCheck: ok) envelope-from=software+bnc@ours.example; dkim=pass header.i=@ours.example; dmarc=fail header.from=vendor.example;' },
    { name: 'authentication-results', value: 'mx.google.com; dkim=pass header.i=@ours.example header.s=google; arc=pass (i=2 dkim=pass dkdomain=vendor.example dmarc=pass fromdomain=vendor.example); dmarc=fail (p=NONE arc=pass) header.from=vendor.example' },
    { name: 'arc-authentication-results', value: 'i=3; mx.google.com; dkim=pass header.i=@ours.example; arc=pass (i=2 dmarc=pass fromdomain=vendor.example); dmarc=fail header.from=vendor.example' },
    { name: 'arc-authentication-results', value: 'i=2; mx.google.com; dkim=pass header.i=@ours.example; arc=pass (i=1); dmarc=fail header.from=vendor.example' },
    { name: 'arc-authentication-results', value: 'i=1; mx.google.com; dkim=pass header.i=@vendor.example header.s=s1; dkim=pass header.i=@amazonses.com; spf=pass smtp.mailfrom=bounce@amazonses.com; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=vendor.example' },
    { name: 'arc-seal', value: 'i=3; a=rsa-sha256; t=1; cv=pass; d=google.com; s=arc; b=x' },
    { name: 'arc-seal', value: 'i=2; a=rsa-sha256; t=1; cv=pass; d=google.com; s=arc; b=x' },
    { name: 'arc-seal', value: 'i=1; a=rsa-sha256; t=1; cv=none; d=google.com; s=arc; b=x' },
  ];
  const gmailGray = { spf: 'pass', dkim: 'gray', dmarc: 'fail' };
  const viaUs = (headers: typeof groupForward, ownDomains = ['ours.example'], from = 'no-reply@vendor.example') =>
    evaluateAuth({ headers, fromAddress: from, trustedIds: [], providerAuth: gmailGray, ownDomains });
  check([viaUs(groupForward).trust, viaUs(groupForward).reason], ['trusted', 'forwarded by ours.example: the original passed for vendor.example'], 'forward: through our own domain keeps the original verdict');
  check(viaUs(groupForward, []).trust, 'untrusted', 'forward: no own domains, no forward trust');
  check(viaUs(groupForward, ['elsewhere.example']).trust, 'untrusted', 'forward: the last hop signed by a domain not ours');
  check(viaUs(groupForward.map((h, i) => i === 0 ? { ...h, value: h.value.replace('amazonses.com;', 'planted.example;') } : h)).trust, 'untrusted', 'forward: a stamp from an unlisted receiver is ignored');
  check(viaUs([...groupForward, { name: 'arc-authentication-results', value: 'i=1; mx.google.com; dmarc=pass header.from=vendor.example' }]).trust, 'untrusted', 'forward: a repeated ARC instance breaks the chain');
  check(viaUs(groupForward.map((h) => h.name === 'arc-seal' && h.value.startsWith('i=2') ? { ...h, value: h.value.replace('cv=pass', 'cv=fail') } : h)).trust, 'untrusted', 'forward: a failed seal breaks the chain');
  check(viaUs(groupForward.map((h) => h.value.startsWith('i=3; mx') ? { ...h, value: h.value.replace('arc=pass', 'arc=fail') } : h)).trust, 'untrusted', 'forward: the newest set must say arc=pass');
  check(viaUs(groupForward.map((h) => h.value.startsWith('i=1; mx') ? { ...h, value: 'i=1; mx.google.com; dkim=none; spf=pass smtp.mailfrom=x@spoof.example; dmarc=fail header.from=vendor.example' } : h)).trust, 'untrusted', 'forward: a spoof the forwarder saw fail stays untrusted');
  check(viaUs(groupForward.filter((h) => h.name !== 'arc-seal')).trust, 'untrusted', 'forward: ARC results without seals are not a chain');
  check(viaUs(groupForward, ['ours.example'], 'someone@ours.example').trust, 'untrusted', 'forward: From on our own domain is judged on its own signature');

  // Decisions: what the panel offers, and the one answer it sends.
  const legacy = decisionsOf({ question_for_human: 'The idea task could not be read. Proposed default: keep this as discussion on the existing idea.', questions: null });
  check([legacy.legacy, legacy.questions[0].question, legacy.questions[0].options.map((o) => o.label)],
    [true, 'The idea task could not be read.', ['Keep this as discussion on the existing idea']], 'decisions: an older question offers its proposed default as the choice');
  check(decisionsOf({ question_for_human: 'Which project is this for?', questions: null }).questions[0].options, [], 'decisions: no default, no choice but an answer');
  check(decisionsOf({ question_for_human: 'Should I set the default-branch? Proposed default: main', questions: null }).questions[0],
    { question: 'Should I set the default-branch?', options: [{ label: 'Main' }], recommended: 0 }, 'decisions: only "Proposed default:" splits, not a word like default-branch');
  check(decisionsOf({ question_for_human: 'Which project is this for? (Proposed default: Acme Roofing.)', questions: null }).questions[0],
    { question: 'Which project is this for?', options: [{ label: 'Acme Roofing' }], recommended: 0 }, 'decisions: a default in brackets loses them');
  check(composeAnswer({ ...legacy, picks: [{ option: 0 }] }), 'Go with your proposed default.', 'decisions: taking the default reads as the agent expects');
  check(composeAnswer({ ...legacy, picks: [{ other: ' Make it a task ' }], note: '', draft: { instructions: 'Thank him' } }),
    'Make it a task\n\nI asked for a reply draft too.', 'decisions: something else, with a draft asked for');
  const two = [
    { question: 'Is the site ours?', options: [{ label: 'Yes, open an urgent task' }, { label: 'No' }], recommended: 0 },
    { question: 'Remember his Gmail?', options: [{ label: 'Yes' }, { label: 'Not now' }], recommended: 1 },
  ];
  check(decisionsOf({ question_for_human: 'x', questions: two }).legacy, false, 'decisions: sent questions are used as they are');
  check(composeAnswer({ questions: two, legacy: false, picks: [{ option: 0 }, { other: 'Only for this thread' }], note: 'He is the CTO' }),
    '1. Is the site ours? → Yes, open an urgent task\n\n2. Remember his Gmail? → Only for this thread\n\nAlso: He is the CTO', 'decisions: every question answered in one go, numbered, with the note');

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
  check(threadFlags([msg({}), msg({ status: 'needs_human', outcome: 'needs_human', urgent: true })]).state, 'needs_you', 'needs_human wins the thread state');
  check(threadFlags([msg({ status: 'needs_human', urgent: true })]).urgent, true, 'urgent while it waits on a person');
  check(threadFlags([msg({ urgent: true, reviewed_at: 'x' })]).urgent, false, 'not urgent once handled');
  check(threadFlags([msg({ outcome: 'needs_reply' })]).needs_reply, true, 'a suggested reply needs reply until reviewed');
  check(threadFlags([msg({ outcome: 'needs_reply', reviewed_at: '2026-10-05' })]).state, 'handled', 'reviewing clears needs reply');
  check(threadFlags([msg({ outcome: 'needs_reply', status: 'new' })]).state, 'new', 'sent back to the agent: new, not needs reply');
  check(threadFlags([msg({ status: 'ignored', outcome: null }), msg({ status: 'ignored', outcome: null })]).state, 'ignored', 'all auto-mail is ignored');
  check(threadFlags([msg({ trust: 'untrusted' })]).untrusted, true, 'any untrusted message flags the thread');
  const ignoredFlags = threadFlags([msg({ status: 'ignored', outcome: null })]);
  check([threadInTab(ignoredFlags, null, 'unassigned'), threadInTab(threadFlags([msg({})]), null, 'unassigned')], [false, true], 'unassigned skips auto-mail');
  const counts = tabCounts([
    { flags: threadFlags([msg({ status: 'needs_human' }), msg({ status: 'new', outcome: null })]), project_id: 'p' },
    { flags: threadFlags([msg({ outcome: 'needs_reply' })]), project_id: null },
    { flags: ignoredFlags, project_id: null },
  ]);
  check([counts.all, counts.needs_you, counts.new, counts.needs_reply, counts.handled, counts.ignored, counts.unassigned, counts.everything], [2, 1, 1, 1, 0, 1, 1, 3], 'tab counts (the Inbox leaves out Filtered, All holds every thread)');
  // Updates: machine mail that asks nothing of anyone, never money, account or security mail.
  const machine = (extra: Partial<MessageState>, topic: MessageState['topic'] = 'update') => msg({ kind: 'notification', topic, ...extra });
  const fyi = threadFlags([machine({ status: 'handled', outcome: 'no_action' })]);
  check([
    fyi.update,
    threadFlags([machine({ status: 'handled', outcome: 'no_action' }, 'money')]).update,
    threadFlags([machine({ status: 'needs_human' })]).update,
    threadFlags([msg({ status: 'handled', outcome: 'no_action' })]).update,
    threadFlags([machine({ status: 'handled', outcome: 'no_action' }), msg({ status: 'handled', outcome: 'no_action', kind: 'person' })]).update,
  ], [true, false, false, false, false], 'updates: machine FYI only; money, needs-you, unsorted and threads with a person stay in the Inbox');
  check([threadInTab(fyi, 'p', 'all'), threadInTab(fyi, 'p', 'updates'), threadInTab(fyi, null, 'unassigned')], [false, true, false], 'updates leave the Inbox and Unassigned');
  // FYI: the latest email was read as needing nothing, and nothing waits.
  const done = (extra: Partial<MessageState> = {}) => msg({ status: 'handled', outcome: 'no_action', kind: 'person', ...extra });
  const chat = threadFlags([done({ category: 'work', outcome: 'task' }), done({ category: 'fyi' })]);
  check([chat.fyi, threadInTab(chat, 'p', 'fyi'), threadInTab(chat, 'p', 'all'), threadInTab(chat, 'p', 'handled'), threadInTab(chat, null, 'unassigned')],
    [true, true, false, false, false], 'fyi: a thank-you after finished work moves the thread to FYI, out of the Inbox and its filters');
  check([
    threadFlags([done({ category: 'fyi' }), done({ category: 'work' })]).fyi,
    threadFlags([done({ category: 'fyi' }), done({ category: 'fyi', status: 'needs_human', outcome: 'needs_human' })]).fyi,
    threadFlags([done({ category: 'fyi' }), msg({ status: 'new', outcome: null, kind: 'person' })]).fyi,
    threadFlags([done({ category: 'fyi', outcome: 'needs_reply' })]).fyi,
    threadFlags([done({ category: null })]).fyi,
  ], [false, false, false, false, false], 'fyi: new work, anything waiting, a reply owed, or an older triage stays in the Inbox');
  // Codes: every email a one-time code; Filtered keeps the rest.
  const codes = threadFlags([msg({ status: 'ignored', outcome: null, kind: 'notification', topic: 'code' })]);
  const pitch = threadFlags([msg({ status: 'ignored', outcome: 'no_action', kind: 'person', category: 'outreach' })]);
  check([threadInTab(codes, null, 'codes'), threadInTab(codes, null, 'ignored'), threadInTab(codes, null, 'all'), threadInTab(pitch, null, 'ignored'), threadInTab(pitch, null, 'codes')],
    [true, false, false, true, false], 'codes: one-time codes in Codes, not Filtered; a filtered pitch stays in Filtered');
  check([
    codeIn('807155 is your verification code', ''),
    codeIn('G-482913 is your Google verification code', ''),
    codeIn('Your Shopify login code', 'Hi,\n\nYour login code is: 448193\n\nIt expires in 10 minutes.'),
    codeIn('Your Slack confirmation code', 'Your confirmation code is ABC-123'),
    codeIn('Sign in to Notion', 'Use the code below to sign in.'),
  ], ['807155', 'G-482913', '448193', 'ABC-123', null], 'codes: the code from the subject, else the text; none when neither shows one');
  check(needsAttention(threadFlags([msg({ status: 'new', outcome: null })])), false, 'new mail waits on the agent, not on a person');
  check(attentionCounts([
    threadFlags([msg({ status: 'needs_human', outcome: 'needs_human', urgent: true })]),
    threadFlags([msg({ status: 'needs_human', outcome: 'needs_human' })]),
    threadFlags([msg({ status: 'handled', outcome: 'needs_reply' })]),
    threadFlags([msg({ status: 'handled', outcome: 'no_action' })]),
  ]), { total: 3, urgent: 1, decide: 1, reply: 1 }, 'attention: urgent, a decision, a reply; handled mail waits on nobody');
  check([matchesSearch('acme dana', ['Banner', 'Dana Wu', 'Acme Roofing']), matchesSearch('acme ben', ['Dana', 'Acme'])], [true, false], 'search needs every word');
  check(snippetOf('  Hello\n\nthere  ', 8), 'Hello t…', 'snippet flattens and trims');
  check(snippetOf('[https://cdn.example/logo.png?v=1] https://www.okendo.io Hi Happy Nuts, see (https://t.example/x)'), 'Hi Happy Nuts, see', 'snippet drops links');
  check(snippetOf('View the proposal ͏ ­ ͏ ­ more'), 'View the proposal more', 'snippet drops invisible preheader padding');

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

  // Client sender addresses (communications.client_addresses): mapping, validation and the project list.
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
