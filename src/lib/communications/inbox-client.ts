'use client';

import { demoInbox, demoInboxSettings } from './inbox-demo';
import type {
  ClientEmailDomain, ClientSenderAddress, ClientSenderAddressList, InboxReplyDraft, InboxSettings, InboxSettingsInput, InboxSettingsList, InboxTab, InboxThreadDetail, InboxThreadList,
  MxStatus, ProjectEmailAddress, ProjectEmailAddressInput, ProjectEmailAddressList, SetThreadProjectRequest, SetThreadProjectResult,
  OwnDomain, TaskSourceEmails, YourAddress, YourAddressInput, YourAddressList, YourAddressPatchInput,
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

/** What a request that never reached the server says, instead of the browser's "Failed to fetch". */
export const OFFLINE_MESSAGE = "Couldn't reach the server. Check your connection and try again.";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      cache: 'no-store',
      ...init,
      headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
    });
  } catch (error) {
    // An abort is the caller's own doing; anything else never reached the server.
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error(OFFLINE_MESSAGE);
  }
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
    /** Add a project beside the thread's others, or confirm one the agent chose. */
    addProject(threadId: string, request: SetThreadProjectRequest): Promise<SetThreadProjectResult> {
      return isDemo ? demoInbox.addProject(threadId, request) : post(`/api/workspace/inbox/threads/${threadId}/projects`, request);
    },
    /** Take a project off the thread (refused while a task on it is linked). */
    removeProject(threadId: string, projectId: string): Promise<{ removed: boolean }> {
      return isDemo
        ? demoInbox.removeProject(threadId, projectId)
        : call(`/api/workspace/inbox/threads/${threadId}/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
    },
    markHandled(threadId: string): Promise<{ handled: number; reviewed: number }> {
      return isDemo ? demoInbox.markHandled(threadId) : post(`/api/workspace/inbox/threads/${threadId}/handled`);
    },
    sendBack(threadId: string, messageId: string | null): Promise<{ message_id: string }> {
      return isDemo ? demoInbox.sendBack(threadId, messageId) : post(`/api/workspace/inbox/threads/${threadId}/send-back`, { message_id: messageId });
    },
    /** A filtered pitch back to the Inbox: the agent reads it in full, and its sender always from now on. */
    moveToInbox(threadId: string, messageId: string): Promise<{ message_id: string }> {
      return isDemo ? demoInbox.moveToInbox(threadId, messageId) : post(`/api/workspace/inbox/threads/${threadId}/move-to-inbox`, { message_id: messageId });
    },
    acceptPlanItem(itemId: string, edits: { project_id?: string; task_id?: string; title?: string; due_date?: string | null } = {}): Promise<unknown> {
      return isDemo ? demoInbox.resolvePlanItem(itemId, 'accepted') : post(`/api/workspace/inbox/plan-items/${itemId}/accept`, edits);
    },
    dismissPlanItem(itemId: string): Promise<unknown> {
      return isDemo ? demoInbox.resolvePlanItem(itemId, 'dismissed') : post(`/api/workspace/inbox/plan-items/${itemId}/dismiss`);
    },
    undoPlanItem(itemId: string): Promise<{ undone?: boolean; changed_since?: boolean; skipped?: string }> {
      return isDemo ? demoInbox.resolvePlanItem(itemId, 'undone') : post(`/api/workspace/inbox/plan-items/${itemId}/undo`);
    },
    undoPlan(planId: string): Promise<unknown> {
      return isDemo ? demoInbox.undoPlan(planId) : post(`/api/workspace/inbox/plans/${planId}/undo`);
    },
    resolveReplyPoint(pointId: string): Promise<unknown> {
      return isDemo ? demoInbox.resolveReplyPoint(pointId) : post(`/api/workspace/inbox/reply-points/${pointId}/resolve`);
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
      if (isDemo) throw new Error('Mail rules are off in demo mode');
      return post<{ rule: InboxSenderRule; filtered: number }>('/api/workspace/inbox/sender-rules', request);
    },
    async updateSenderRule(ruleId: string, request: { action?: 'ignore' | 'fyi' | 'always'; enabled?: boolean }) {
      if (isDemo) throw new Error('Mail rules are off in demo mode');
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
    /**
     * Every address mail comes in on, your domains and the inboxes an address
     * can deliver to. `review` also scans recent mail for addresses nobody
     * listed: slow, so only the addresses page asks, once when it opens.
     */
    yourAddresses({ review = false }: { review?: boolean } = {}): Promise<YourAddressList> {
      if (isDemo) return demoInboxSettings.yourAddresses({ review });
      return call(`/api/workspace/email-addresses${review ? '?review=1' : ''}`);
    },
    addYourAddress(input: YourAddressInput): Promise<YourAddress> {
      return isDemo ? demoInboxSettings.addYourAddress(input) : post('/api/workspace/email-addresses', input);
    },
    updateYourAddress(addressId: string, input: YourAddressPatchInput): Promise<YourAddress> {
      return isDemo ? demoInboxSettings.updateYourAddress(addressId, input) : patch(`/api/workspace/email-addresses/${addressId}`, input);
    },
    async removeYourAddress(addressId: string): Promise<void> {
      if (isDemo) return demoInboxSettings.removeYourAddress(addressId);
      await call(`/api/workspace/email-addresses/${addressId}`, { method: 'DELETE' });
    },
    /** Not ours: an address mail arrived on is never suggested again. */
    async ignoreAddress(address: string): Promise<void> {
      if (isDemo) return demoInboxSettings.ignoreAddress(address);
      await post('/api/workspace/email-addresses/ignored', { address });
    },
    addOwnDomain(domain: string): Promise<OwnDomain> {
      return isDemo ? demoInboxSettings.addOwnDomain(domain) : post('/api/workspace/email-domains', { domain });
    },
    async removeOwnDomain(domainId: string): Promise<void> {
      if (isDemo) return demoInboxSettings.removeOwnDomain(domainId);
      await call(`/api/workspace/email-domains/${domainId}`, { method: 'DELETE' });
    },
  };
}
