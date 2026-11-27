import 'server-only';
import type { HttpMethod } from '../core';
import * as inboxes from '@/app/api/v1/inbox/inboxes/route';
import * as inbox from '@/app/api/v1/inbox/inboxes/[id]/route';
import * as mxCheck from '@/app/api/v1/inbox/mx-check/route';
import * as relayDomain from '@/app/api/v1/inbox/relay-domain/route';
import * as addresses from '@/app/api/v1/inbox/addresses/route';
import * as address from '@/app/api/v1/inbox/addresses/[id]/route';
import * as ignored from '@/app/api/v1/inbox/addresses/ignored/route';
import * as domains from '@/app/api/v1/inbox/domains/route';
import * as domain from '@/app/api/v1/inbox/domains/[id]/route';
import * as myInboxes from '@/app/api/v1/me/inboxes/route';
import * as myInbox from '@/app/api/v1/me/inboxes/[id]/route';
import * as projectAddresses from '@/app/api/v1/projects/[id]/email-addresses/route';
import * as projectAddress from '@/app/api/v1/projects/[id]/email-addresses/[addressId]/route';
import * as projectDomains from '@/app/api/v1/projects/[id]/email-domains/route';
import * as projectDomain from '@/app/api/v1/projects/[id]/email-domains/[domainId]/route';
import * as projectSenders from '@/app/api/v1/projects/[id]/email-senders/route';
import * as projectSender from '@/app/api/v1/projects/[id]/email-senders/[senderId]/route';

/** Email setup (Settings > Email, your own inbox, a project's email): the v1 route module behind each tool path (routes.ts merges these). */
export const EMAIL_ROUTE_MODULES: Record<string, Partial<Record<HttpMethod, unknown>>> = {
  '/api/v1/inbox/inboxes': inboxes,
  '/api/v1/inbox/inboxes/{id}': inbox,
  '/api/v1/inbox/mx-check': mxCheck,
  '/api/v1/inbox/relay-domain': relayDomain,
  '/api/v1/inbox/addresses': addresses,
  '/api/v1/inbox/addresses/{id}': address,
  '/api/v1/inbox/addresses/ignored': ignored,
  '/api/v1/inbox/domains': domains,
  '/api/v1/inbox/domains/{id}': domain,
  '/api/v1/me/inboxes': myInboxes,
  '/api/v1/me/inboxes/{id}': myInbox,
  '/api/v1/projects/{id}/email-addresses': projectAddresses,
  '/api/v1/projects/{id}/email-addresses/{addressId}': projectAddress,
  '/api/v1/projects/{id}/email-domains': projectDomains,
  '/api/v1/projects/{id}/email-domains/{domainId}': projectDomain,
  '/api/v1/projects/{id}/email-senders': projectSenders,
  '/api/v1/projects/{id}/email-senders/{senderId}': projectSender,
};
