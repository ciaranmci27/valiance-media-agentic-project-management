'use client';

import { demoInbox, demoInboxSettings } from './inbox-demo';
import type {
  ClientEmailDomain, ClientSenderAddress, ClientSenderAddressList, InboxReplyDraft, InboxSettings, InboxSettingsInput, InboxSettingsList, InboxTab, InboxThreadDetail, InboxThreadList,
  MxStatus, ProjectEmailAddress, ProjectEmailAddressInput, ProjectEmailAddressList, SetThreadProjectRequest, SetThreadProjectResult,
  TaskSourceEmails,
} from './inbox-types';
import { INBOX_TABLES, INBOX_UPDATED_EVENT } from './inbox-types';
import { invalidateTables } from '@/lib/query-cache';
import type { InboxAttention } from './inbox-view';
import type { InboxSenderRule } from './inbox-rules';

/**
 * The browser side of the Inbox: session routes in the app, in-memory
 * fixtures in demo mode. Every call resolves to the route's `data` or throws
 * with its `error` message.
 */

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: 'no-store',
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Request failed');
  return payload.data as T;
}

const post = <T,>(path: string, body: unknown = {}) => call<T>(path, { method: 'POST', body: JSON.stringify(body) });
const put = <T,>(path: string, body: unknown) => call<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const patch = <T,>(path: string, body: unknown) => call<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

/** Where a change came from, when a view already refreshed itself for it. */
export interface InboxChangeDetail {
  /** The thread view that made the change and has already reloaded it. */
  threadId?: string;
}

/** Tell the sidebar badge, any open Inbox view and cached inbox reads to refresh. */
export function announceInboxChange(detail: InboxChangeDetail | null = null) {
  invalidateTables(INBOX_TABLES);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<InboxChangeDetail | null>(INBOX_UPDATED_EVENT, { detail }));
}

export interface ThreadQuery {
  inboxId: string | null;
  projectId: string | null;
  /** Only threads linked to this task. */
  taskId?: string | null;
  tab: InboxTab;
  search: string;
  limit: number;
  offset: number;
}

export function inboxClient(isDemo: boolean) {
  return {
    listThreads(query: ThreadQuery): Promise<InboxThreadList> {
      if (isDemo) return demoInbox.listThreads(query);
      const params = new URLSearchParams({ status: query.tab, limit: String(query.limit), offset: String(query.offset) });
      if (query.inboxId) params.set('inbox_id', query.inboxId);
      if (query.projectId) params.set('project_id', query.projectId);
      if (query.taskId) params.set('task_id', query.taskId);
      if (query.search.trim()) params.set('q', query.search.trim());
      return call(`/api/workspace/inbox/threads?${params}`);
    },
    threadDetail(threadId: string): Promise<InboxThreadDetail> {
      return isDemo ? demoInbox.threadDetail(threadId) : call(`/api/workspace/inbox/threads/${threadId}`);
    },
    setProject(threadId: string, request: SetThreadProjectRequest): Promise<SetThreadProjectResult> {
      return isDemo ? demoInbox.setProject(threadId, request) : post(`/api/workspace/inbox/threads/${threadId}/project`, request);
    },
    markHandled(threadId: string): Promise<{ handled: number; reviewed: number }> {
      return isDemo ? demoInbox.markHandled(threadId) : post(`/api/workspace/inbox/threads/${threadId}/handled`);
    },
    sendBack(threadId: string, messageId: string | null): Promise<{ message_id: string }> {
      return isDemo ? demoInbox.sendBack(threadId, messageId) : post(`/api/workspace/inbox/threads/${threadId}/send-back`, { message_id: messageId });
    },
    async answerQuestion(threadId: string, messageId: string, answer: string): Promise<{ message_id: string }> {
      if (isDemo) throw new Error('Answers are off in demo mode');
      return post(`/api/workspace/inbox/threads/${threadId}/answer`, { message_id: messageId, answer });
    },
    async attachmentUrl(attachmentId: string): Promise<{ url: string; filename: string }> {
      if (isDemo) throw new Error('Downloads are off in demo mode');
      return call(`/api/workspace/inbox/attachments/${attachmentId}/url`);
    },
    async linkTask(threadId: string, request: { task_id: string; relation?: 'created' | 'updated' | 'related'; message_id?: string | null }) {
      if (isDemo) throw new Error('Linking is off in demo mode');
      return post<{ task_id: string; message_id: string; relation: string; project_set: boolean }>(`/api/workspace/inbox/threads/${threadId}/links`, request);
    },
    async unlinkTask(threadId: string, taskId: string) {
      if (isDemo) throw new Error('Unlinking is off in demo mode');
      return call<{ removed: number }>(`/api/workspace/inbox/threads/${threadId}/links?task_id=${encodeURIComponent(taskId)}`, { method: 'DELETE' });
    },
    async requestDraft(threadId: string, instructions = ''): Promise<InboxReplyDraft> {
      if (isDemo) throw new Error('Drafts are off in demo mode');
      return post(`/api/workspace/inbox/threads/${threadId}/draft`, { instructions });
    },
    async senderRules(): Promise<{ rules: InboxSenderRule[] }> {
      if (isDemo) return { rules: [] };
      return call('/api/workspace/inbox/sender-rules');
    },
    async createSenderRule(request: { match_kind: 'address' | 'domain'; match_value: string; topic: string | null; action: 'ignore' | 'fyi' | 'always'; reason?: string; thread_id?: string | null }) {
      if (isDemo) throw new Error('Sender rules are off in demo mode');
      return post<{ rule: InboxSenderRule; filtered: number }>('/api/workspace/inbox/sender-rules', request);
    },
    async updateSenderRule(ruleId: string, request: { action?: 'ignore' | 'fyi' | 'always'; enabled?: boolean }) {
      if (isDemo) throw new Error('Sender rules are off in demo mode');
      return patch<{ rule: InboxSenderRule }>(`/api/workspace/inbox/sender-rules/${ruleId}`, request);
    },
    async attentionCount(): Promise<InboxAttention> {
      if (isDemo) return demoInbox.attentionCount();
      const { total, urgent, decide, reply } = await call<InboxAttention>('/api/workspace/inbox/count');
      return { total, urgent, decide, reply };
    },
    taskSources(taskId: string): Promise<TaskSourceEmails> {
      return isDemo ? demoInbox.taskSources(taskId) : call(`/api/workspace/tasks/${taskId}/source-emails`);
    },
    listDomains(projectId: string): Promise<ClientEmailDomain[]> {
      return isDemo ? demoInbox.listDomains(projectId) : call(`/api/workspace/projects/${projectId}/email-domains`);
    },
    addDomain(projectId: string, domain: string): Promise<ClientEmailDomain> {
      return isDemo ? demoInbox.addDomain(projectId, domain) : post(`/api/workspace/projects/${projectId}/email-domains`, { domain });
    },
    async removeDomain(projectId: string, domainId: string): Promise<void> {
      if (isDemo) return demoInbox.removeDomain(projectId, domainId);
      await call(`/api/workspace/projects/${projectId}/email-domains/${domainId}`, { method: 'DELETE' });
    },
    listSenders(projectId: string): Promise<ClientSenderAddressList> {
      return isDemo ? demoInbox.listSenders(projectId) : call(`/api/workspace/projects/${projectId}/email-senders`);
    },
    addSender(projectId: string, address: string): Promise<ClientSenderAddress> {
      return isDemo ? demoInbox.addSender(projectId, address) : post(`/api/workspace/projects/${projectId}/email-senders`, { address });
    },
    async removeSender(projectId: string, senderId: string): Promise<void> {
      if (isDemo) return demoInbox.removeSender(projectId, senderId);
      await call(`/api/workspace/projects/${projectId}/email-senders/${senderId}`, { method: 'DELETE' });
    },
    listAddresses(projectId: string): Promise<ProjectEmailAddressList> {
      return isDemo ? demoInbox.listAddresses(projectId) : call(`/api/workspace/projects/${projectId}/email-addresses`);
    },
    addAddress(projectId: string, input: ProjectEmailAddressInput): Promise<ProjectEmailAddress> {
      return isDemo ? demoInbox.addAddress(projectId, input) : post(`/api/workspace/projects/${projectId}/email-addresses`, input);
    },
    updateAddress(projectId: string, addressId: string, input: Partial<ProjectEmailAddressInput>): Promise<ProjectEmailAddress> {
      return isDemo
        ? demoInbox.updateAddress(projectId, addressId, input)
        : patch(`/api/workspace/projects/${projectId}/email-addresses/${addressId}`, input);
    },
    async removeAddress(projectId: string, addressId: string): Promise<void> {
      if (isDemo) return demoInbox.removeAddress(projectId, addressId);
      await call(`/api/workspace/projects/${projectId}/email-addresses/${addressId}`, { method: 'DELETE' });
    },
  };
}

export function inboxSettingsClient(isDemo: boolean) {
  return {
    list(): Promise<InboxSettingsList> {
      return isDemo ? demoInboxSettings.list() : call('/api/workspace/email-inboxes');
    },
    create(input: InboxSettingsInput): Promise<InboxSettings> {
      return isDemo ? demoInboxSettings.create(input) : post('/api/workspace/email-inboxes', input);
    },
    update(inboxId: string, input: InboxSettingsInput): Promise<InboxSettings> {
      return isDemo ? demoInboxSettings.update(inboxId, input) : put(`/api/workspace/email-inboxes/${inboxId}`, input);
    },
    setRelayDomain(domain: string): Promise<{ relay_domain: string }> {
      return isDemo ? demoInboxSettings.setRelay(domain) : put('/api/workspace/email-inboxes/relay-domain', { domain });
    },
    mx(domain: string): Promise<MxStatus> {
      return isDemo ? demoInboxSettings.mx(domain) : call(`/api/workspace/email-inboxes/mx?domain=${encodeURIComponent(domain)}`);
    },
  };
}
