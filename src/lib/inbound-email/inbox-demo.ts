import { validateClientDomain } from './public-domains';
import { matchesSearch, needsAttention, snippetOf, tabCounts, threadFlags, threadInTab, type MessageState } from './inbox-view';
import type {
  ClientEmailDomain, InboxMessage, InboxSettings, InboxSettingsInput, InboxSettingsList, InboxSummary, InboxTab,
  InboxThreadDetail, InboxThreadList, InboxThreadSummary, MxStatus, SetThreadProjectRequest, SetThreadProjectResult,
  TaskSourceEmails,
} from './inbox-types';

/**
 * Demo mode for the Inbox: realistic threads against the demo projects,
 * contacts and tasks, held in memory so every screen and action works
 * without a server. Changes last until the page reloads.
 */

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

const SARAH = { id: 'a1a1a1a1-0001-4000-8000-000000000001', name: 'Sarah Chen' };
const ATLAS = { id: 'a1a1a1a1-0006-4000-8000-000000000006', name: 'Atlas' };
const SCOUT = { id: 'a1a1a1a1-0007-4000-8000-000000000007', name: 'Scout' };
const CREST = 'c3c3c3c3-0001-4000-8000-000000000001';
const BLOOMWELL = 'c3c3c3c3-0002-4000-8000-000000000002';
const NEOFORGE = 'c3c3c3c3-0003-4000-8000-000000000003';
const SOLSTICE = 'c3c3c3c3-0004-4000-8000-000000000004';
const PROJECT_NAMES: Record<string, string> = {
  [CREST]: 'Crest Financial Rebrand',
  [BLOOMWELL]: 'Bloomwell Health App',
  [NEOFORGE]: 'NeoForge Website',
  [SOLSTICE]: 'Solstice Realty Platform',
};

const INBOX_SCOUT: InboxSummary = { id: '9e9e9e9e-0001-4000-8000-000000000001', name: 'Scout', address: 'scout@valiancemedia.com', enabled: true, handler: SCOUT };
const INBOX_BILLING: InboxSummary = { id: '9e9e9e9e-0002-4000-8000-000000000002', name: 'Billing', address: 'billing@valiancemedia.com', enabled: true, handler: ATLAS };

const TRUSTED = { level: 'trusted' as const, reason: 'DKIM pass aligned with the From domain', spf: 'pass', dkim: 'pass', dmarc: 'pass' };
const UNKNOWN = { level: 'unknown' as const, reason: 'No authentication results to rely on', spf: null, dkim: null, dmarc: null };
const UNTRUSTED = { level: 'untrusted' as const, reason: 'DKIM failed for the From domain', spf: 'softfail', dkim: 'fail', dmarc: 'fail' };

let counter = 0;
const id = (prefix: string) => `${prefix}-${String(++counter).padStart(4, '0')}-4000-8000-${String(counter).padStart(12, '0')}`;

function message(partial: Partial<InboxMessage> & Pick<InboxMessage, 'subject' | 'received_at' | 'from' | 'new_text'>): InboxMessage {
  return {
    id: id('9f9f9f9f'),
    status: 'handled',
    sent_at: partial.received_at,
    to: [{ address: INBOX_SCOUT.address, name: 'Scout', contact_id: null }],
    cc: [],
    is_forward: false,
    trust: TRUSTED,
    auto_mail_reason: null,
    text_body: partial.new_text,
    html_body: null,
    attachments: [],
    triage: null,
    linked_tasks: [],
    reviewed_at: null,
    reviewed_by: null,
    ...partial,
  };
}

const person = (name: string, address: string, contactId: string | null = null) => ({ name, address, contact_id: contactId });
const triage = (partial: Omit<InboxMessage['triage'] & object, 'id' | 'member' | 'created_at'> & { created_at?: string }, member = SCOUT) => ({
  id: id('9d9d9d9d'),
  member,
  created_at: partial.created_at ?? hoursAgo(1),
  ...partial,
});

function buildThreads(): InboxThreadDetail[] {
  counter = 0;
  const thread = (detail: Omit<InboxThreadDetail, 'id' | 'state' | 'urgent' | 'untrusted'>): InboxThreadDetail => ({
    id: id('9c9c9c9c'), state: 'handled', urgent: false, untrusted: false, ...detail,
  });
  return [
    thread({
      inbox: INBOX_SCOUT,
      subject: 'Re: Business cards for the April conference',
      project: { id: CREST, name: PROJECT_NAMES[CREST], source: 'mapped' },
      candidates: [{ project_id: CREST, name: PROJECT_NAMES[CREST], reasons: ['contact', 'domain'] }],
      senders: [],
      messages: [
        message({
          subject: 'Business cards for the April conference',
          received_at: hoursAgo(30),
          from: person('David Lawson', 'david@crestfinancial.com', 'b2b2b2b2-0001-4000-8000-000000000001'),
          cc: [person('Lisa Martinez', 'lisa@crestfinancial.com', 'b2b2b2b2-0006-4000-8000-000000000006')],
          new_text: 'Hi Scout,\n\nWe need 500 business cards printed for the Chicago conference on April 5. Lisa will send the final names and titles this week.\n\nAlso, on the homepage wireframe, can the "Book a consultation" button sit above the fold on mobile too?\n\nThanks,\nDavid',
          triage: triage({ outcome: 'task', urgent: false, summary: 'Two requests: 500 business cards for the April 5 conference (names to follow from Lisa), and the consultation button above the fold on mobile. Both added to existing tasks.', question_for_ciaran: null, suggested_reply: null, created_at: hoursAgo(29) }),
          linked_tasks: [
            { task_id: 'e5e5e5e5-0004-4000-8000-000000000004', relation: 'updated', title: 'Business card & letterhead design', status: 'todo', project_id: CREST },
            { task_id: 'e5e5e5e5-0005-4000-8000-000000000005', relation: 'updated', title: 'Website wireframes', status: 'in_progress', project_id: CREST },
          ],
        }),
        message({
          subject: 'Re: Business cards for the April conference',
          received_at: hoursAgo(5),
          from: person('Lisa Martinez', 'lisa@crestfinancial.com', 'b2b2b2b2-0006-4000-8000-000000000006'),
          new_text: 'Attached are the names and titles for the cards. Jordan\'s title changed to Director of IT last week, so please use the new one.\n\nLisa',
          attachments: [
            { id: '9b9b9b9b-0001-4000-8000-000000000001', filename: 'card-names.csv', content_type: 'text/csv', size_bytes: 2_310, kind: 'text', available: true, skipped_reason: null, agent_label: 'Names and titles for 14 cards' },
            { id: '9b9b9b9b-0002-4000-8000-000000000002', filename: 'crest-logo-print.pdf', content_type: 'application/pdf', size_bytes: 1_482_112, kind: 'pdf', available: true, skipped_reason: null, agent_label: 'Print logo, CMYK, 1 page' },
          ],
          triage: triage({ outcome: 'task', urgent: false, summary: 'Lisa sent the 14 names and titles, with Jordan Blake now Director of IT. Copied into the business card task.', question_for_ciaran: null, suggested_reply: null, created_at: hoursAgo(4) }),
          linked_tasks: [{ task_id: 'e5e5e5e5-0004-4000-8000-000000000004', relation: 'updated', title: 'Business card & letterhead design', status: 'todo', project_id: CREST }],
        }),
      ],
    }),
    thread({
      inbox: INBOX_SCOUT,
      subject: 'Site is down?',
      project: { id: NEOFORGE, name: PROJECT_NAMES[NEOFORGE], source: 'inferred' },
      candidates: [],
      senders: [],
      messages: [
        message({
          subject: 'Site is down?',
          received_at: hoursAgo(0.6),
          from: person('Andre Williams', 'andre.williams@gmail.com'),
          trust: UNKNOWN,
          new_text: 'Our homepage shows a 500 error right now. Investors are looking at the site this afternoon. Can someone look ASAP?\n\nAndre\nCTO, NeoForge Technologies',
          status: 'needs_ciaran',
          triage: triage({ outcome: 'needs_ciaran', urgent: true, summary: 'Andre (NeoForge CTO, writing from his personal Gmail) reports a 500 error on the homepage before an investor review this afternoon.', question_for_ciaran: 'This came from a personal address I could not map. Is the production site yours to check, and should I open an urgent task?', suggested_reply: 'Hi Andre, thanks for flagging this. We are looking at it now and will update you within the hour.', created_at: hoursAgo(0.5) }),
        }),
      ],
    }),
    thread({
      inbox: INBOX_SCOUT,
      subject: 'Can we move the beta launch to next Friday?',
      project: { id: BLOOMWELL, name: PROJECT_NAMES[BLOOMWELL], source: 'mapped' },
      candidates: [{ project_id: BLOOMWELL, name: PROJECT_NAMES[BLOOMWELL], reasons: ['contact'] }],
      senders: [],
      messages: [
        message({
          subject: 'Can we move the beta launch to next Friday?',
          received_at: hoursAgo(3),
          from: person('Monica Reeves', 'monica@bloomwell.co', 'b2b2b2b2-0002-4000-8000-000000000002'),
          new_text: 'Hi team,\n\nOur compliance review slipped a week. Could we move the beta launch to next Friday, and would that change the cost?\n\nMonica',
          status: 'needs_ciaran',
          triage: triage({ outcome: 'needs_ciaran', urgent: false, summary: 'Monica asks to move the beta launch a week (compliance review slipped) and whether it changes the cost.', question_for_ciaran: 'Moving the launch touches the schedule and possibly the price. Do you want to keep the original date, or move it at no charge?', suggested_reply: null, created_at: hoursAgo(2.8) }),
        }),
      ],
    }),
    thread({
      inbox: INBOX_SCOUT,
      subject: 'Quick question about IDX listings',
      project: { id: SOLSTICE, name: PROJECT_NAMES[SOLSTICE], source: 'mapped' },
      candidates: [{ project_id: SOLSTICE, name: PROJECT_NAMES[SOLSTICE], reasons: ['contact'] }],
      senders: [],
      messages: [
        message({
          subject: 'Quick question about IDX listings',
          received_at: hoursAgo(7),
          from: person('Rachel Kim', 'rachel@solsticerealty.com', 'b2b2b2b2-0004-4000-8000-000000000004'),
          new_text: 'Will sold listings stay visible on the new site, or only active ones? Some of our agents like showing recent sales.\n\nRachel',
          html_body: '<div style="font-family:Georgia,serif;font-size:15px;color:#1f2937"><p>Will <b>sold listings</b> stay visible on the new site, or only active ones? Some of our agents like showing recent sales.</p><p>Rachel</p><img src="https://tracker.example.com/open.gif" width="1" height="1" alt=""><table style="margin-top:16px;border-top:1px solid #e5e7eb"><tr><td style="padding-top:8px;color:#6b7280;font-size:12px">Rachel Kim, Broker-owner<br>Solstice Realty</td></tr></table></div>',
          triage: triage({ outcome: 'needs_reply', urgent: false, summary: 'Rachel asks whether sold listings stay visible on the new site. The IDX research task says the feed includes sold listings for 12 months.', question_for_ciaran: null, suggested_reply: 'Hi Rachel,\n\nYes. The new IDX feed includes sold listings for the past 12 months, and each agent profile can show their recent sales alongside active listings.\n\nBest,\nSarah', created_at: hoursAgo(6.5) }),
        }),
      ],
    }),
    thread({
      inbox: INBOX_BILLING,
      subject: 'Updated bank details for invoice payments',
      project: null,
      candidates: [],
      senders: [],
      messages: [
        message({
          subject: 'Updated bank details for invoice payments',
          received_at: hoursAgo(9),
          from: person('Crest Accounts', 'accounts@crestfinancial-billing.com'),
          to: [person('Billing', INBOX_BILLING.address)],
          trust: UNTRUSTED,
          status: 'needs_ciaran',
          new_text: 'Hello,\n\nPlease update our remittance details. All future invoice payments should go to the new account below, effective immediately.\n\nAccounts Payable',
          triage: triage({ outcome: 'needs_ciaran', urgent: false, summary: 'Asks to change where invoice payments go. The domain only looks like Crest\'s, and DKIM failed. Treat as likely fraud.', question_for_ciaran: 'Do not act on this without calling David at Crest on a known number. Want me to flag it on the Crest project?', suggested_reply: null, created_at: hoursAgo(8.8) }, ATLAS),
        }),
      ],
    }),
    thread({
      inbox: INBOX_SCOUT,
      subject: 'Partnership idea for your agency',
      project: null,
      candidates: [],
      senders: [],
      messages: [
        message({
          subject: 'Partnership idea for your agency',
          received_at: hoursAgo(1.5),
          from: person('Priya Nair', 'priya@lumenstudio.design'),
          trust: UNKNOWN,
          status: 'new',
          new_text: 'Hi there, I run a small motion design studio and would love to talk about white-label animation work for your web projects. Do you have 20 minutes next week?\n\nPriya',
        }),
      ],
    }),
    thread({
      inbox: INBOX_SCOUT,
      subject: 'Fwd: Brand files for both sites',
      project: { id: CREST, name: PROJECT_NAMES[CREST], source: 'ciaran' },
      candidates: [
        { project_id: CREST, name: PROJECT_NAMES[CREST], reasons: ['contact'] },
        { project_id: NEOFORGE, name: PROJECT_NAMES[NEOFORGE], reasons: ['domain'] },
      ],
      senders: [],
      messages: [
        message({
          subject: 'Fwd: Brand files for both sites',
          received_at: hoursAgo(50),
          from: person('Sarah Chen', 'sarah@valiancemedia.com'),
          is_forward: true,
          new_text: 'Forwarding Jordan\'s files.\n\n---------- Forwarded message ---------\nFrom: Jordan Blake <jordan@crestfinancial.com>\nSubject: Brand files for both sites\n\nHere are the final brand files. The large source file was too big for email, I will share a link.\n\nJordan',
          attachments: [
            { id: '9b9b9b9b-0003-4000-8000-000000000003', filename: 'brand-colors.png', content_type: 'image/png', size_bytes: 284_221, kind: 'image', available: true, skipped_reason: null, agent_label: 'Palette swatches: navy, gold, slate' },
            { id: '9b9b9b9b-0004-4000-8000-000000000004', filename: 'brand-source.ai', content_type: 'application/postscript', size_bytes: 61_202_000, kind: 'other', available: false, skipped_reason: 'over_size_cap', agent_label: null },
          ],
          triage: triage({ outcome: 'task', urgent: false, summary: 'Jordan sent the final brand palette; the source file was over the size limit and was not stored. Palette added to the guidelines task.', question_for_ciaran: null, suggested_reply: null, created_at: hoursAgo(49) }),
          linked_tasks: [{ task_id: 'e5e5e5e5-0003-4000-8000-000000000003', relation: 'updated', title: 'Brand guidelines document', status: 'in_progress', project_id: CREST }],
          reviewed_at: hoursAgo(48),
          reviewed_by: SARAH,
        }),
      ],
    }),
    thread({
      inbox: INBOX_SCOUT,
      subject: 'Your weekly design digest',
      project: null,
      candidates: [],
      senders: [],
      messages: [
        message({
          subject: 'Your weekly design digest',
          received_at: hoursAgo(20),
          from: person('Dribbble Digest', 'digest@dribbble.example'),
          trust: TRUSTED,
          status: 'ignored',
          auto_mail_reason: 'List-Unsubscribe header (newsletter)',
          new_text: 'Top shots this week: 12 landing pages, 8 dashboards and a very good logo animation.',
        }),
      ],
    }),
  ];
}

const DEMO_TEAM_EMAILS = new Set(['sarah@valiancemedia.com', INBOX_SCOUT.address, INBOX_BILLING.address]);

function withSenders(detail: InboxThreadDetail): InboxThreadDetail {
  const seen = new Map<string, string>();
  for (const m of [...detail.messages].reverse()) {
    if (!m.from || DEMO_TEAM_EMAILS.has(m.from.address) || seen.has(m.from.address)) continue;
    seen.set(m.from.address, m.from.name);
  }
  const senders = [...seen.entries()].map(([address, name]) => {
    const host = address.split('@')[1];
    const publicHost = !validateClientDomain(host).ok;
    const contactIds = detail.messages.filter((m) => m.from?.address === address && m.from.contact_id).map((m) => m.from!.contact_id!);
    return {
      address,
      name,
      domain: host,
      domain_is_public: publicHost,
      contact_ids: [...new Set(contactIds)],
      mapped_project_ids: contactIds.length && detail.project ? [detail.project.id] : [],
      domain_project_ids: demoDomains.filter((d) => d.domain === host).map((d) => d.project_id),
    };
  });
  const states = detail.messages.map(stateOf);
  const flags = threadFlags(states);
  return { ...detail, senders, state: flags.state, urgent: flags.urgent, untrusted: flags.untrusted };
}

function stateOf(m: InboxMessage): MessageState {
  return { status: m.status, reviewed_at: m.reviewed_at, outcome: m.triage?.outcome ?? null, urgent: m.triage?.urgent ?? false, trust: m.trust.level };
}

let demoDomains: ClientEmailDomain[] = [
  { id: '9a9a9a9a-0001-4000-8000-000000000001', domain: 'crestfinancial.com', project_id: CREST, created_at: hoursAgo(400) },
  { id: '9a9a9a9a-0002-4000-8000-000000000002', domain: 'bloomwell.co', project_id: BLOOMWELL, created_at: hoursAgo(300) },
  { id: '9a9a9a9a-0003-4000-8000-000000000003', domain: 'neoforge.io', project_id: NEOFORGE, created_at: hoursAgo(200) },
];
let threads: InboxThreadDetail[] | null = null;
const store = () => (threads ??= buildThreads());

function summary(detail: InboxThreadDetail): InboxThreadSummary {
  const flags = threadFlags(detail.messages.map(stateOf));
  const latest = detail.messages[detail.messages.length - 1];
  return {
    id: detail.id,
    inbox_id: detail.inbox.id,
    inbox_name: detail.inbox.name,
    subject: latest.subject || detail.subject,
    project: detail.project,
    last_message_at: latest.received_at,
    message_count: detail.messages.length,
    sender: latest.from ? { name: latest.from.name, address: latest.from.address } : null,
    snippet: snippetOf(latest.new_text || latest.text_body),
    state: flags.state,
    needs_you: flags.needs_you,
    needs_reply: flags.needs_reply,
    has_new: flags.has_new,
    urgent: flags.urgent,
    untrusted: flags.untrusted,
    attachment_count: detail.messages.reduce((total, m) => total + m.attachments.length, 0),
  };
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 180));

export const demoInbox = {
  async listThreads(filters: { inboxId: string | null; projectId: string | null; tab: InboxTab; search: string; limit: number; offset: number }): Promise<InboxThreadList> {
    await pause();
    const scoped = store()
      .filter((t) => !filters.inboxId || t.inbox.id === filters.inboxId)
      .filter((t) => !filters.projectId || t.project?.id === filters.projectId)
      .filter((t) => matchesSearch(filters.search, [
        ...t.messages.map((m) => m.subject),
        ...t.messages.flatMap((m) => [m.from?.name, m.from?.address]),
        t.project?.name,
        t.inbox.name,
      ]))
      .map((t) => ({ detail: t, flags: threadFlags(t.messages.map(stateOf)) }))
      .sort((a, b) => (summary(a.detail).last_message_at < summary(b.detail).last_message_at ? 1 : -1));
    const counts = tabCounts(scoped.map((t) => ({ flags: t.flags, project_id: t.detail.project?.id ?? null })));
    const inTab = scoped.filter((t) => threadInTab(t.flags, t.detail.project?.id ?? null, filters.tab));
    return {
      inboxes: [INBOX_SCOUT, INBOX_BILLING],
      threads: inTab.slice(filters.offset, filters.offset + filters.limit).map((t) => summary(t.detail)),
      total: inTab.length,
      counts,
    };
  },

  async threadDetail(threadId: string): Promise<InboxThreadDetail> {
    await pause();
    const detail = store().find((t) => t.id === threadId);
    if (!detail) throw new Error('Thread not found');
    return structuredClone(withSenders(detail));
  },

  async setProject(threadId: string, request: SetThreadProjectRequest): Promise<SetThreadProjectResult> {
    await pause();
    const detail = store().find((t) => t.id === threadId);
    if (!detail) throw new Error('Thread not found');
    detail.project = { id: request.project_id, name: PROJECT_NAMES[request.project_id] ?? 'Project', source: 'ciaran' };
    let rememberedDomain: SetThreadProjectResult['remembered_domain'] = null;
    if (request.remember_domain) {
      const valid = validateClientDomain(request.remember_domain.domain);
      if (!valid.ok) throw new Error(valid.error);
      const added = request.remember_domain.project_ids.filter((projectId) => !demoDomains.some((d) => d.domain === valid.domain && d.project_id === projectId));
      demoDomains = [...demoDomains, ...added.map((projectId) => ({ id: crypto.randomUUID(), domain: valid.domain, project_id: projectId, created_at: new Date().toISOString() }))];
      rememberedDomain = { domain: valid.domain, added_project_ids: added };
    }
    return {
      project: detail.project,
      remembered_sender: request.remember_sender
        ? { contact_id: crypto.randomUUID(), created_contact: true, linked_project_ids: request.remember_sender.project_ids }
        : null,
      remembered_domain: rememberedDomain,
    };
  },

  async markHandled(threadId: string): Promise<{ handled: number; reviewed: number }> {
    await pause();
    const detail = store().find((t) => t.id === threadId);
    if (!detail) throw new Error('Thread not found');
    let handled = 0;
    let reviewed = 0;
    for (const m of detail.messages) {
      if (m.status === 'new' || m.status === 'needs_ciaran') { m.status = 'handled'; handled++; }
      if (m.status === 'handled' && !m.reviewed_at) { m.reviewed_at = new Date().toISOString(); m.reviewed_by = SARAH; reviewed++; }
    }
    return { handled, reviewed };
  },

  async sendBack(threadId: string, messageId: string | null): Promise<{ message_id: string }> {
    await pause();
    const detail = store().find((t) => t.id === threadId);
    const target = messageId ? detail?.messages.find((m) => m.id === messageId) : detail?.messages[detail.messages.length - 1];
    if (!target) throw new Error('Message not found');
    if (target.status === 'new') throw new Error('It is already waiting for the agent');
    target.status = 'new';
    target.reviewed_at = null;
    target.reviewed_by = null;
    return { message_id: target.id };
  },

  async attentionCount(): Promise<number> {
    return store().filter((t) => needsAttention(threadFlags(t.messages.map(stateOf)))).length;
  },

  async taskSources(taskId: string): Promise<TaskSourceEmails> {
    await pause();
    const emails = store().flatMap((t) => t.messages
      .flatMap((m) => m.linked_tasks.filter((link) => link.task_id === taskId).map((link) => ({
        message_id: m.id,
        thread_id: t.id,
        inbox_id: t.inbox.id,
        subject: m.subject,
        from: m.from ? { name: m.from.name, address: m.from.address } : null,
        received_at: m.received_at,
        relation: link.relation,
      }))));
    return { link_count: emails.length, emails };
  },

  async listDomains(projectId: string): Promise<ClientEmailDomain[]> {
    await pause();
    return demoDomains.filter((d) => d.project_id === projectId).sort((a, b) => a.domain.localeCompare(b.domain));
  },

  async addDomain(projectId: string, input: string): Promise<ClientEmailDomain> {
    await pause();
    const valid = validateClientDomain(input);
    if (!valid.ok) throw new Error(valid.error);
    if (demoDomains.some((d) => d.project_id === projectId && d.domain === valid.domain)) throw new Error(`${valid.domain} is already on this project.`);
    const row = { id: crypto.randomUUID(), domain: valid.domain, project_id: projectId, created_at: new Date().toISOString() };
    demoDomains = [...demoDomains, row];
    return row;
  },

  async removeDomain(projectId: string, domainId: string): Promise<void> {
    await pause();
    demoDomains = demoDomains.filter((d) => !(d.id === domainId && d.project_id === projectId));
  },
};

// -- Settings ----------------------------------------------------------------

let relay = 'relay.valiancemedia.com';
let settings: InboxSettings[] = [
  {
    id: INBOX_SCOUT.id, name: 'Scout', address: INBOX_SCOUT.address, routing_local_part: 'scout', routing_domain: relay,
    routing_address: `scout@${relay}`, handler_member_id: SCOUT.id, enabled: true, retention_days: 90, max_attachment_mb: 25,
    agent_readable_types: ['image', 'pdf', 'text'], summary_interval_minutes: 30, filter_auto_mail: true, verification_code: 'VM-7K2Q',
    verified_at: hoursAgo(240), last_received_at: hoursAgo(0.6), last_error: null, last_error_at: null,
    access_member_ids: [SCOUT.id, SARAH.id], message_count: 9, created_at: hoursAgo(300),
  },
  {
    id: INBOX_BILLING.id, name: 'Billing', address: INBOX_BILLING.address, routing_local_part: 'billing', routing_domain: relay,
    routing_address: `billing@${relay}`, handler_member_id: ATLAS.id, enabled: true, retention_days: 180, max_attachment_mb: 10,
    agent_readable_types: ['pdf'], summary_interval_minutes: 60, filter_auto_mail: true, verification_code: 'VM-3XPA',
    verified_at: null, last_received_at: hoursAgo(9), last_error: 'Attachment invoice-scan.tiff was over the 10 MB limit and was not stored',
    last_error_at: hoursAgo(9), access_member_ids: [ATLAS.id], message_count: 1, created_at: hoursAgo(20),
  },
];

function applyInput(base: InboxSettings, input: InboxSettingsInput): InboxSettings {
  const local = input.routing_local_part || input.address.split('@')[0].replace(/[^a-z0-9._-]/g, '');
  const domain = input.routing_domain || relay;
  const moved = local !== base.routing_local_part || domain !== base.routing_domain;
  const access = [...new Set([...input.access_member_ids, ...(input.handler_member_id ? [input.handler_member_id] : [])])];
  return {
    ...base,
    ...input,
    routing_local_part: local,
    routing_domain: domain,
    routing_address: `${local}@${domain}`,
    verified_at: moved ? null : base.verified_at,
    access_member_ids: access,
  };
}

export const demoInboxSettings = {
  async list(): Promise<InboxSettingsList> {
    await pause();
    return structuredClone({ relay_domain: relay, inboxes: settings });
  },
  async create(input: InboxSettingsInput): Promise<InboxSettings> {
    await pause();
    if (settings.some((s) => s.address === input.address.toLowerCase())) throw new Error('An inbox already uses that address.');
    const blank: InboxSettings = {
      ...settings[0], id: crypto.randomUUID(), routing_local_part: '', routing_domain: '', verified_at: null,
      verification_code: `VM-${Math.random().toString(36).slice(2, 6).toUpperCase().replace(/[^A-Z0-9]/g, 'Q').padEnd(4, 'Q')}`,
      last_received_at: null, last_error: null, last_error_at: null, message_count: 0, created_at: new Date().toISOString(),
    };
    const created = applyInput(blank, input);
    settings = [...settings, created];
    return structuredClone(created);
  },
  async update(inboxId: string, input: InboxSettingsInput): Promise<InboxSettings> {
    await pause();
    const base = settings.find((s) => s.id === inboxId);
    if (!base) throw new Error('Inbox not found');
    const updated = applyInput(base, input);
    settings = settings.map((s) => (s.id === inboxId ? updated : s));
    return structuredClone(updated);
  },
  async setRelay(domain: string): Promise<{ relay_domain: string }> {
    await pause();
    relay = domain.trim().toLowerCase();
    return { relay_domain: relay };
  },
  async mx(domain: string): Promise<MxStatus> {
    await pause();
    return domain.endsWith('valiancemedia.com')
      ? { domain, found: true, records: [{ exchange: 'inbound-smtp.us-east-1.amazonaws.com', priority: 10 }], error: null }
      : { domain, found: false, records: [], error: null };
  },
};
