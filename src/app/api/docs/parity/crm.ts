import type { EndpointDoc } from '../docs-data';

/** Contacts, leads, identities, templates and the routes decision 1 opens to MCP. */
export const CRM_ENDPOINTS: EndpointDoc[] = [
  {
    method: 'GET', path: '/api/v1/contacts/:id/emails', group: 'Contacts', scopes: ['contacts.read'],
    description: "A contact's email addresses, primary first: id, contact_id, email, label, is_primary, created_at, updated_at. The primary one is also the contact's email. MCP: list_contact_emails.",
    params: [{ name: 'id', type: 'uuid', required: true, description: 'Contact ID' }],
  },
  {
    method: 'PUT', path: '/api/v1/contacts/:id/emails', group: 'Contacts', scopes: ['contacts.manage'],
    description: "Make a contact's addresses exactly this list, the way the contact form in the app saves them: a row with an id keeps that address (taking the new email or label), a row without one is added, and an address left out is removed. Addresses are trimmed and lowercased. The row marked is_primary (else the first) becomes primary and the contact's email; an empty list clears them. Answers the saved list, primary first. An address twice in the list is 409 duplicate_email; an id that is not one of this contact's addresses is 422 unknown_email_id. MCP: set_contact_emails.",
    params: [{ name: 'id', type: 'uuid', required: true, description: 'Contact ID' }],
    body: [
      { name: 'emails', type: 'array', required: true, description: 'Up to 50 rows of { id?, email, label?, is_primary? }. id: an address already on the contact, to keep or edit it. label: such as Work (100 characters at most).' },
    ],
  },
];
