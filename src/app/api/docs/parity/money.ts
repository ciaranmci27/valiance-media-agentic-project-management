import type { EndpointDoc } from '../docs-data';

const projectParam = { name: 'id', type: 'uuid', required: true, description: 'Project ID' };
const retainerParam = { name: 'retainerId', type: 'uuid', required: true, description: 'Retainer ID (in this project)' };
const READ = ['invoices.read', 'invoices.manage'];
const MANAGE = ['invoices.manage'];
const SETTINGS = ['settings.manage'];

/** Billing and money. */
export const MONEY_ENDPOINTS: EndpointDoc[] = [
  // Retainers
  {
    method: 'GET', path: '/api/v1/projects/:id/retainers', group: 'Retainers', scopes: READ,
    description: 'The project\'s retainers, oldest first, as { retainers, amounts, periods }: each retainer (name, billing_timing, start_date, end_date, status, lead_days, currency), its dated amounts, and the periods already handled (status generated or skipped, invoice_id). Revenue splits are not included (they need compensation.manage, which is not an API scope). MCP: list_retainers.',
    params: [projectParam],
  },
  {
    method: 'POST', path: '/api/v1/projects/:id/retainers', group: 'Retainers', scopes: MANAGE,
    description: 'Sets up a retainer (Billing > Retainers, Create). Drafts then appear on their own each period, lead_days before the bill date. link_lines ties lines already invoiced by hand to it, in the same transaction, so those periods never draft again. Takes Idempotency-Key. Answers 201 with the retainer. Revenue splits cannot be set over the API. MCP: create_retainer.',
    params: [projectParam],
    body: [
      { name: 'name', type: 'string', required: true, description: 'Shown on each invoice line' },
      { name: 'amount', type: 'number', required: true, description: 'The monthly amount from start_date (at least 0)' },
      { name: 'start_date', type: 'YYYY-MM-DD', required: true, description: 'First day of the first period' },
      { name: 'billing_timing', type: 'advance|arrears', required: false, description: 'advance (default): billed at the period start; arrears: the day after the period ends' },
      { name: 'end_date', type: 'YYYY-MM-DD|null', required: false, description: 'Last day; the final month prorates to it' },
      { name: 'status', type: 'active|paused', required: false, description: 'Default active' },
      { name: 'lead_days', type: 'number', required: false, description: '0-28, default 1' },
      { name: 'link_lines', type: '{ invoice_id, line_item_id }[]', required: false, description: 'Lines on this project\'s invoices that already billed a period' },
    ],
  },
  {
    method: 'PATCH', path: '/api/v1/projects/:id/retainers/:retainerId', group: 'Retainers', scopes: MANAGE,
    description: 'Edits a retainer: only the fields sent change. status paused stops new drafts and active resumes them; end_date ends it (the last month prorates). The amount changes by date with POST .../amounts. 404 when the retainer is not in this project or is in Trash. MCP: update_retainer.',
    params: [projectParam, retainerParam],
    body: [
      { name: 'name', type: 'string', required: false, description: 'New name' },
      { name: 'billing_timing', type: 'advance|arrears', required: false, description: 'When each period is billed' },
      { name: 'start_date', type: 'YYYY-MM-DD', required: false, description: 'First day of the first period' },
      { name: 'end_date', type: 'YYYY-MM-DD|null', required: false, description: 'Last day; null for no end' },
      { name: 'status', type: 'active|paused', required: false, description: 'Pause or resume' },
      { name: 'lead_days', type: 'number', required: false, description: '0-28' },
    ],
  },
  {
    method: 'POST', path: '/api/v1/projects/:id/retainers/:retainerId/amounts', group: 'Retainers', scopes: MANAGE,
    description: 'Schedules the retainer\'s amount from a date. An amount already set for that date is replaced; periods already invoiced keep theirs. Answers 201 with the dated amount. MCP: schedule_retainer_amount.',
    params: [projectParam, retainerParam],
    body: [
      { name: 'amount', type: 'number', required: true, description: 'At least 0' },
      { name: 'effective_date', type: 'YYYY-MM-DD', required: true, description: 'Periods from this date bill the new amount' },
    ],
  },
  {
    method: 'GET', path: '/api/v1/projects/:id/retainers/due-periods', group: 'Retainers', scopes: MANAGE,
    description: 'Retainer periods whose bill date has come and that no invoice covers yet (the app\'s Due now list): retainer_id, retainer_name, billing_timing, period_start, period_end, bill_date, amount (prorated when partial), full_amount, prorated, description and skipped. MCP: list_due_retainer_periods.',
    params: [projectParam],
  },
  {
    method: 'POST', path: '/api/v1/projects/:id/retainers/:retainerId/periods', group: 'Retainers', scopes: MANAGE,
    description: 'Drafts the invoice for one period now, as the daily job would on its date. A skipped period is drafted; 409 when the period is already on an invoice; 400 when period_start is not one of the retainer\'s periods. Takes Idempotency-Key. Answers 201 with the draft invoice (not sent). MCP: draft_retainer_invoice.',
    params: [projectParam, retainerParam],
    body: [{ name: 'period_start', type: 'YYYY-MM-DD', required: true, description: 'The period\'s first day (GET .../retainers/due-periods)' }],
  },

  // Billing plan
  {
    method: 'GET', path: '/api/v1/projects/:id/billing-plan', group: 'Billing Plans', scopes: READ,
    description: 'The project\'s billing plan: payment_terms_days, hours_trigger (manual, days_of_month, every_weeks, reaches_amount, fixed_blocks), days_of_month, every_weeks, weeks_anchor, trigger_amount, cap_mode, cap_value, min_amount, combine_with_retainer, paused, starts_on, ends_on and currency. The defaults (manual, due on receipt) when none is saved. MCP: get_billing_plan.',
    params: [projectParam],
  },
  {
    method: 'PATCH', path: '/api/v1/projects/:id/billing-plan', group: 'Billing Plans', scopes: MANAGE,
    description: 'Changes the billing plan (Billing > Hours): only the fields sent change. A new hours_trigger without starts_on starts today, so switching drafting on never drafts past dates. every_weeks needs weeks_anchor, reaches_amount and fixed_blocks need trigger_amount, a cap_mode other than none needs cap_value (400 otherwise). Answers the saved plan. MCP: update_billing_plan.',
    params: [projectParam],
    body: [
      { name: 'payment_terms_days', type: 'number', required: false, description: '0-120 days until an invoice is due (0 = on receipt)' },
      { name: 'hours_trigger', type: 'manual|days_of_month|every_weeks|reaches_amount|fixed_blocks', required: false, description: 'When approved hours are drafted' },
      { name: 'days_of_month', type: 'number[]', required: false, description: '1 to 4 days, 1-31 (31 = the last day)' },
      { name: 'every_weeks', type: 'number', required: false, description: '1-12' },
      { name: 'weeks_anchor', type: 'YYYY-MM-DD|null', required: false, description: 'A date the weekly cycle runs from' },
      { name: 'trigger_amount', type: 'number|null', required: false, description: 'The amount that triggers a draft (reaches_amount, fixed_blocks)' },
      { name: 'cap_mode', type: 'none|amount|hours', required: false, description: 'A cap on each draft' },
      { name: 'cap_value', type: 'number|null', required: false, description: 'The cap' },
      { name: 'min_amount', type: 'number', required: false, description: 'Below this, no draft is made' },
      { name: 'combine_with_retainer', type: 'boolean', required: false, description: 'Hours ride on the retainer\'s invoice when they fall on the same date' },
      { name: 'paused', type: 'boolean', required: false, description: 'Stops scheduled drafts' },
      { name: 'starts_on', type: 'YYYY-MM-DD|null', required: false, description: 'Nothing is drafted before it' },
      { name: 'ends_on', type: 'YYYY-MM-DD|null', required: false, description: 'Nothing is drafted after it' },
    ],
  },

  // Company invoice details
  {
    method: 'GET', path: '/api/v1/billing/invoice-details', group: 'Billing Settings', scopes: SETTINGS,
    description: 'The company details every invoice PDF carries (Settings > Billing > Invoice details): business_name, business_address, business_email, business_phone, payment_terms, payment_instructions and default_invoice_notes. 403 MODULE_OFF with Client invoicing off. MCP: get_invoice_details.',
  },
  {
    method: 'PATCH', path: '/api/v1/billing/invoice-details', group: 'Billing Settings', scopes: SETTINGS,
    description: 'Changes the company\'s invoice details: only the fields sent change, trimmed; a blank payment_terms becomes Upon receipt. Invoice PDFs made afterwards carry them. Answers the saved details. MCP: update_invoice_details.',
    body: [
      { name: 'business_name', type: 'string', required: false, description: 'At most 200 characters' },
      { name: 'business_address', type: 'string', required: false, description: 'At most 1,000 characters' },
      { name: 'business_email', type: 'string', required: false, description: 'At most 320 characters' },
      { name: 'business_phone', type: 'string', required: false, description: 'At most 50 characters' },
      { name: 'payment_terms', type: 'string', required: false, description: 'At most 200 characters' },
      { name: 'payment_instructions', type: 'string', required: false, description: 'At most 500 characters' },
      { name: 'default_invoice_notes', type: 'string', required: false, description: 'At most 300 characters' },
    ],
  },

  // Hour approvals
  {
    method: 'GET', path: '/api/v1/time/hour-approvals', group: 'Time Entries', scopes: SETTINGS,
    description: 'Whether people\'s finished hours approve as they are logged: { auto_approve_human_hours } (true, the default) or wait for someone who approves time (false). Agent hours always wait; an Owner\'s own never do. 403 MODULE_OFF unless Time tracking and Client invoicing or Team pay are on. MCP: get_hour_approvals.',
  },
  {
    method: 'PATCH', path: '/api/v1/time/hour-approvals', group: 'Time Entries', scopes: SETTINGS,
    description: 'Turns auto-approval of people\'s hours on or off (Settings > Billing > Hour approvals). Applies to sessions finished from then on; entries already logged keep their status. Answers { auto_approve_human_hours }. MCP: set_hour_approvals.',
    body: [{ name: 'auto_approve_human_hours', type: 'boolean', required: true, description: 'true: approve as logged; false: wait for review' }],
  },
];
