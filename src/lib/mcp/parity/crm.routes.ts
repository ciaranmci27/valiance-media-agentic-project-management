import 'server-only';
import type { HttpMethod } from '../core';
import * as contact from '@/app/api/v1/contacts/[id]/route';
import * as contactEmails from '@/app/api/v1/contacts/[id]/emails/route';
import * as leadArchive from '@/app/api/v1/leads/[id]/archive/route';
import * as leadConvert from '@/app/api/v1/leads/[id]/convert/route';
import * as leadContacts from '@/app/api/v1/leads/[id]/contacts/route';
import * as leadContact from '@/app/api/v1/leads/[id]/contacts/[contactId]/route';
import * as leadFields from '@/app/api/v1/leads/[id]/fields/route';
import * as leadField from '@/app/api/v1/leads/[id]/fields/[fieldId]/route';
import * as leadProposals from '@/app/api/v1/leads/[id]/proposals/route';
import * as leadProposal from '@/app/api/v1/leads/[id]/proposals/[proposalId]/route';
import * as leadInteraction from '@/app/api/v1/leads/[id]/interactions/[interactionId]/route';
import * as identities from '@/app/api/v1/identities/route';
import * as identity from '@/app/api/v1/identities/[id]/route';
import * as identityMove from '@/app/api/v1/identities/[id]/move/route';
import * as templateDraftApprove from '@/app/api/v1/task-templates/drafts/[draftId]/approve/route';
import * as templateDraftReject from '@/app/api/v1/task-templates/drafts/[draftId]/reject/route';
import * as taskComment from '@/app/api/v1/tasks/[id]/comments/[commentId]/route';
import * as taskFile from '@/app/api/v1/tasks/[id]/files/[fileId]/route';
import * as timeEntry from '@/app/api/v1/projects/[id]/time-entries/[entryId]/route';
import * as timeReview from '@/app/api/v1/projects/[id]/time-entries/review/route';
import * as entityFile from '@/app/api/v1/entity-files/[fileId]/route';
import * as portalUpdate from '@/app/api/v1/projects/[id]/portal/updates/[updateId]/route';
import * as portalUpdateAttachment from '@/app/api/v1/projects/[id]/portal/updates/[updateId]/attachments/[attachmentId]/route';
import * as notification from '@/app/api/v1/notifications/[id]/route';
import * as invoices from '@/app/api/v1/invoices/route';
import * as projectInvoices from '@/app/api/v1/projects/[id]/invoices/route';
import * as projectInvoice from '@/app/api/v1/projects/[id]/invoices/[invoiceId]/route';
import * as invoicePayments from '@/app/api/v1/projects/[id]/invoices/[invoiceId]/payments/route';
import * as invoicePayment from '@/app/api/v1/projects/[id]/invoices/[invoiceId]/payments/[paymentId]/route';
import * as hourlyRates from '@/app/api/v1/projects/[id]/hourly-rates/route';
import * as hourlyRate from '@/app/api/v1/projects/[id]/hourly-rates/[rateId]/route';
import * as draftNotices from '@/app/api/v1/billing/draft-notices/route';
import * as draftNoticesRelayed from '@/app/api/v1/billing/draft-notices/relayed/route';
import * as earnedWork from '@/app/api/v1/billing/earned-work/route';
import * as communications from '@/app/api/v1/projects/[id]/communications/route';
import * as communication from '@/app/api/v1/projects/[id]/communications/[communicationId]/route';
import * as clientNotifications from '@/app/api/v1/projects/[id]/client-notifications/route';
import * as suggestionApprove from '@/app/api/v1/task-suggestions/[id]/approve/route';
import * as suggestionDecline from '@/app/api/v1/task-suggestions/[id]/decline/route';
import * as suggestionReject from '@/app/api/v1/task-suggestions/[id]/reject/route';
import * as suggestionRequestInfo from '@/app/api/v1/task-suggestions/[id]/request-info/route';
import * as suggestionsBulkApprove from '@/app/api/v1/task-suggestions/bulk-approve/route';
import * as suggestionsBulkDecline from '@/app/api/v1/task-suggestions/bulk-decline/route';
import * as suggestionsBulkReject from '@/app/api/v1/task-suggestions/bulk-reject/route';
import * as activities from '@/app/api/v1/activities/route';

/** Contacts, leads, identities, templates and the routes decision 1 opens to MCP: the v1 route module behind each tool path (routes.ts merges these). */
export const CRM_ROUTE_MODULES: Record<string, Partial<Record<HttpMethod, unknown>>> = {
  // Contacts
  '/api/v1/contacts/{id}': contact,
  '/api/v1/contacts/{id}/emails': contactEmails,
  // Leads
  '/api/v1/leads/{id}/archive': leadArchive,
  '/api/v1/leads/{id}/convert': leadConvert,
  '/api/v1/leads/{id}/contacts': leadContacts,
  '/api/v1/leads/{id}/contacts/{contactId}': leadContact,
  '/api/v1/leads/{id}/fields': leadFields,
  '/api/v1/leads/{id}/fields/{fieldId}': leadField,
  '/api/v1/leads/{id}/proposals': leadProposals,
  '/api/v1/leads/{id}/proposals/{proposalId}': leadProposal,
  '/api/v1/leads/{id}/interactions/{interactionId}': leadInteraction,
  // Identities
  '/api/v1/identities': identities,
  '/api/v1/identities/{id}': identity,
  '/api/v1/identities/{id}/move': identityMove,
  // Templates
  '/api/v1/task-templates/drafts/{draftId}/approve': templateDraftApprove,
  '/api/v1/task-templates/drafts/{draftId}/reject': templateDraftReject,
  // Move to Trash
  '/api/v1/tasks/{id}/comments/{commentId}': taskComment,
  '/api/v1/tasks/{id}/files/{fileId}': taskFile,
  '/api/v1/projects/{id}/time-entries/{entryId}': timeEntry,
  '/api/v1/entity-files/{fileId}': entityFile,
  '/api/v1/projects/{id}/portal/updates/{updateId}': portalUpdate,
  '/api/v1/projects/{id}/portal/updates/{updateId}/attachments/{attachmentId}': portalUpdateAttachment,
  '/api/v1/notifications/{id}': notification,
  // Time approval
  '/api/v1/projects/{id}/time-entries/review': timeReview,
  // Invoices, payments, rates and billing reads
  '/api/v1/invoices': invoices,
  '/api/v1/projects/{id}/invoices': projectInvoices,
  '/api/v1/projects/{id}/invoices/{invoiceId}': projectInvoice,
  '/api/v1/projects/{id}/invoices/{invoiceId}/payments': invoicePayments,
  '/api/v1/projects/{id}/invoices/{invoiceId}/payments/{paymentId}': invoicePayment,
  '/api/v1/projects/{id}/hourly-rates': hourlyRates,
  '/api/v1/projects/{id}/hourly-rates/{rateId}': hourlyRate,
  '/api/v1/billing/draft-notices': draftNotices,
  '/api/v1/billing/draft-notices/relayed': draftNoticesRelayed,
  '/api/v1/billing/earned-work': earnedWork,
  // Client communications
  '/api/v1/projects/{id}/communications': communications,
  '/api/v1/projects/{id}/communications/{communicationId}': communication,
  '/api/v1/projects/{id}/client-notifications': clientNotifications,
  // Task suggestions
  '/api/v1/task-suggestions/{id}/approve': suggestionApprove,
  '/api/v1/task-suggestions/{id}/decline': suggestionDecline,
  '/api/v1/task-suggestions/{id}/reject': suggestionReject,
  '/api/v1/task-suggestions/{id}/request-info': suggestionRequestInfo,
  '/api/v1/task-suggestions/bulk-approve': suggestionsBulkApprove,
  '/api/v1/task-suggestions/bulk-decline': suggestionsBulkDecline,
  '/api/v1/task-suggestions/bulk-reject': suggestionsBulkReject,
  // Activity feed
  '/api/v1/activities': activities,
};
