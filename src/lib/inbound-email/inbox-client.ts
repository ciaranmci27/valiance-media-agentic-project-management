'use client';

import { demoInbox, demoInboxSettings } from './inbox-demo';
import type {
  ClientEmailDomain, InboxSettings, InboxSettingsInput, InboxSettingsList, InboxTab, InboxThreadDetail, InboxThreadList,
  MxStatus, SetThreadProjectRequest, SetThreadProjectResult, TaskSourceEmails,
} from './inbox-types';
import { INBOX_UPDATED_EVENT } from './inbox-types';

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

/** Tell the sidebar badge and any open Inbox view to refresh. */
export function announceInboxChange() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(INBOX_UPDATED_EVENT));
}

export interface ThreadQuery {
  inboxId: string | null;
  projectId: string | null;
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
    async attachmentUrl(attachmentId: string): Promise<{ url: string; filename: string }> {
      if (isDemo) throw new Error('Downloads are off in demo mode');
      return call(`/api/workspace/inbox/attachments/${attachmentId}/url`);
    },
    async attentionCount(): Promise<number> {
      if (isDemo) return demoInbox.attentionCount();
      return (await call<{ needs_attention: number }>('/api/workspace/inbox/count')).needs_attention;
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
