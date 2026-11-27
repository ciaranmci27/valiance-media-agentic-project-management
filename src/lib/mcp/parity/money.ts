import { z } from 'zod';
import { idempotencyKeyInput, routeTool, type PmTool } from '../core';
import { calendarDate, nameText } from '@/lib/schemas/shared';
import { atLeastOne, id } from './shared';

/**
 * Billing and money. Money writes need invoices.manage or settings.manage,
 * which no agent holds by default: an Owner grants them on purpose. Revenue
 * splits need compensation.manage, not an API scope, so no tool sets one.
 */

const retainerTiming = z.enum(['advance', 'arrears']).describe('advance: billed at the period start for the coming month; arrears: the day after the period ends');
const retainerStatus = z.enum(['active', 'paused']);
const leadDays = z.number().int().min(0).max(28).describe('Days before the bill date the draft appears (0-28, default 1)');

const PLAN_FIELDS = [
  'payment_terms_days', 'hours_trigger', 'days_of_month', 'every_weeks', 'weeks_anchor', 'trigger_amount',
  'cap_mode', 'cap_value', 'min_amount', 'combine_with_retainer', 'paused', 'starts_on', 'ends_on',
];
const INVOICE_DETAIL_FIELDS = [
  'business_name', 'business_address', 'business_email', 'business_phone',
  'payment_terms', 'payment_instructions', 'default_invoice_notes',
];
const RETAINER_FIELDS = ['name', 'billing_timing', 'start_date', 'end_date', 'status', 'lead_days'];

export const MONEY_TOOLS: PmTool[] = [
  // Retainers
  routeTool({
    name: 'list_retainers',
    lead: "List a project's retainers with amounts and periods.",
    detail: 'Answers { retainers, amounts, periods }: each retainer (name, billing_timing, start_date, end_date, status, lead_days, currency), its dated amounts, and the periods already handled (generated or skipped, with invoice_id). Revenue splits are not included.',
    input: z.object({ project_id: id('project_id') }).strict(),
    permission: 'invoices.read',
    method: 'GET',
    path: '/api/v1/projects/{id}/retainers',
    request: ({ project_id }) => ({ params: { id: project_id } }),
  }),
  routeTool({
    name: 'create_retainer',
    lead: 'Set up a monthly retainer on a project.',
    detail: 'Like Billing > Retainers, Create: name, the first amount (from start_date), billing_timing, end_date, status and lead_days. Drafts then appear on their own each period. link_lines ties lines you already invoiced by hand to it, so those periods never draft again. Revenue splits cannot be set here.',
    input: z.object({
      project_id: id('project_id'),
      name: nameText(),
      amount: z.number().min(0).describe('The monthly amount, from start_date'),
      start_date: calendarDate.describe('First day of the first period, YYYY-MM-DD'),
      billing_timing: retainerTiming.optional(),
      end_date: calendarDate.nullable().optional().describe('Last day; the final month prorates to it'),
      status: retainerStatus.optional(),
      lead_days: leadDays.optional(),
      link_lines: z.array(z.object({ invoice_id: id('invoice_id'), line_item_id: z.string().min(1).max(200) }).strict()).max(500).optional()
        .describe('Lines on this project\'s invoices that already billed a period'),
      idempotency_key: idempotencyKeyInput,
    }).strict(),
    permission: 'invoices.manage',
    method: 'POST',
    path: '/api/v1/projects/{id}/retainers',
    request: ({ project_id, ...body }) => ({ params: { id: project_id }, body }),
  }),
  routeTool({
    name: 'update_retainer',
    lead: 'Edit, pause, resume or end a retainer.',
    detail: 'Only the fields sent change. status paused stops new drafts; active resumes them. end_date ends it (the last month prorates). Change its amount by date with schedule_retainer_amount instead.',
    input: z.object({
      project_id: id('project_id'),
      retainer_id: id('retainer_id'),
      name: nameText().optional(),
      billing_timing: retainerTiming.optional(),
      start_date: calendarDate.optional(),
      end_date: calendarDate.nullable().optional(),
      status: retainerStatus.optional(),
      lead_days: leadDays.optional(),
    }).strict().refine(atLeastOne(RETAINER_FIELDS), { message: `Send at least one of: ${RETAINER_FIELDS.join(', ')}` }),
    permission: 'invoices.manage',
    method: 'PATCH',
    path: '/api/v1/projects/{id}/retainers/{retainerId}',
    request: ({ project_id, retainer_id, ...body }) => ({ params: { id: project_id, retainerId: retainer_id }, body }),
  }),
  routeTool({
    name: 'schedule_retainer_amount',
    lead: "Change a retainer's amount from a date.",
    detail: 'Periods from effective_date on bill the new amount; an amount already set for that date is replaced. Periods already invoiced keep theirs. Answers the dated amount.',
    input: z.object({
      project_id: id('project_id'),
      retainer_id: id('retainer_id'),
      amount: z.number().min(0),
      effective_date: calendarDate.describe('YYYY-MM-DD'),
    }).strict(),
    permission: 'invoices.manage',
    method: 'POST',
    path: '/api/v1/projects/{id}/retainers/{retainerId}/amounts',
    idempotent: true,
    request: ({ project_id, retainer_id, ...body }) => ({ params: { id: project_id, retainerId: retainer_id }, body }),
  }),
  routeTool({
    name: 'list_due_retainer_periods',
    lead: 'List retainer periods that are due and not invoiced.',
    detail: 'The app\'s Due now list: retainer_id, retainer_name, period_start, period_end, bill_date, amount (prorated when partial), full_amount and skipped. Draft one with draft_retainer_invoice.',
    input: z.object({ project_id: id('project_id') }).strict(),
    permission: 'invoices.manage',
    method: 'GET',
    path: '/api/v1/projects/{id}/retainers/due-periods',
    request: ({ project_id }) => ({ params: { id: project_id } }),
  }),
  routeTool({
    name: 'draft_retainer_invoice',
    lead: 'Draft the invoice for one retainer period now.',
    detail: 'As the daily job would on its date. period_start is the period\'s first day (list_due_retainer_periods). A skipped period is drafted; one already on an invoice answers 409. Answers the draft invoice, which is not sent.',
    input: z.object({
      project_id: id('project_id'),
      retainer_id: id('retainer_id'),
      period_start: calendarDate.describe('YYYY-MM-DD'),
      idempotency_key: idempotencyKeyInput,
    }).strict(),
    permission: 'invoices.manage',
    method: 'POST',
    path: '/api/v1/projects/{id}/retainers/{retainerId}/periods',
    request: ({ project_id, retainer_id, ...body }) => ({ params: { id: project_id, retainerId: retainer_id }, body }),
  }),

  // Billing plan
  routeTool({
    name: 'get_billing_plan',
    lead: "Read a project's payment terms and hours billing.",
    detail: 'payment_terms_days, hours_trigger (manual, days_of_month, every_weeks, reaches_amount, fixed_blocks) with its settings, cap_mode and cap_value, min_amount, combine_with_retainer, paused, starts_on, ends_on. The defaults when none is saved.',
    input: z.object({ project_id: id('project_id') }).strict(),
    permission: 'invoices.read',
    method: 'GET',
    path: '/api/v1/projects/{id}/billing-plan',
    request: ({ project_id }) => ({ params: { id: project_id } }),
  }),
  routeTool({
    name: 'update_billing_plan',
    lead: "Change a project's payment terms or hours billing.",
    detail: 'Only the fields sent change. A new hours_trigger without starts_on starts today, so switching drafting on never drafts past dates. every_weeks needs weeks_anchor; reaches_amount and fixed_blocks need trigger_amount; a cap_mode other than none needs cap_value. Answers the saved plan.',
    input: z.object({
      project_id: id('project_id'),
      payment_terms_days: z.number().int().min(0).max(120).optional().describe('Days until an invoice is due (0 = on receipt)'),
      hours_trigger: z.enum(['manual', 'days_of_month', 'every_weeks', 'reaches_amount', 'fixed_blocks']).optional(),
      days_of_month: z.array(z.number().int().min(1).max(31)).min(1).max(4).optional().describe('1-31; 31 means the last day'),
      every_weeks: z.number().int().min(1).max(12).optional(),
      weeks_anchor: calendarDate.nullable().optional(),
      trigger_amount: z.number().positive().nullable().optional(),
      cap_mode: z.enum(['none', 'amount', 'hours']).optional(),
      cap_value: z.number().positive().nullable().optional(),
      min_amount: z.number().min(0).optional(),
      combine_with_retainer: z.boolean().optional(),
      paused: z.boolean().optional(),
      starts_on: calendarDate.nullable().optional(),
      ends_on: calendarDate.nullable().optional(),
    }).strict().refine(atLeastOne(PLAN_FIELDS), { message: `Send at least one of: ${PLAN_FIELDS.join(', ')}` }),
    permission: 'invoices.manage',
    method: 'PATCH',
    path: '/api/v1/projects/{id}/billing-plan',
    request: ({ project_id, ...body }) => ({ params: { id: project_id }, body }),
  }),

  // Company invoice details
  routeTool({
    name: 'get_invoice_details',
    lead: 'Read the company details printed on invoices.',
    detail: 'business_name, business_address, business_email, business_phone, payment_terms, payment_instructions and default_invoice_notes (Settings > Billing > Invoice details). Needs Client invoicing on.',
    input: z.object({}).strict(),
    permission: 'settings.manage',
    module: 'billing',
    method: 'GET',
    path: '/api/v1/billing/invoice-details',
    request: () => ({}),
  }),
  routeTool({
    name: 'update_invoice_details',
    lead: 'Change the company details printed on invoices.',
    detail: 'Only the fields sent change; every invoice PDF made afterwards carries them. A blank payment_terms becomes Upon receipt. payment_instructions at most 500 characters, default_invoice_notes at most 300. Answers the saved details.',
    input: z.object({
      business_name: z.string().max(200).optional(),
      business_address: z.string().max(1000).optional(),
      business_email: z.string().max(320).optional(),
      business_phone: z.string().max(50).optional(),
      payment_terms: z.string().max(200).optional(),
      payment_instructions: z.string().max(500).optional(),
      default_invoice_notes: z.string().max(300).optional(),
    }).strict().refine(atLeastOne(INVOICE_DETAIL_FIELDS), { message: `Send at least one of: ${INVOICE_DETAIL_FIELDS.join(', ')}` }),
    permission: 'settings.manage',
    module: 'billing',
    method: 'PATCH',
    path: '/api/v1/billing/invoice-details',
    request: (body) => ({ body }),
  }),

  // Hour approvals
  routeTool({
    name: 'get_hour_approvals',
    lead: "Read whether people's hours approve as logged.",
    detail: 'auto_approve_human_hours: true means finished sessions approve at once; false means they wait for someone who approves time. Agent hours always wait; an Owner\'s own never do. Exists while Time tracking and Client invoicing or Team pay are on.',
    input: z.object({}).strict(),
    permission: 'settings.manage',
    module: 'time',
    method: 'GET',
    path: '/api/v1/time/hour-approvals',
    request: () => ({}),
  }),
  routeTool({
    name: 'set_hour_approvals',
    lead: "Turn auto-approval of people's hours on or off.",
    detail: 'Settings > Billing > Hour approvals. Applies to sessions finished from now on; entries already logged keep their status. Answers { auto_approve_human_hours }.',
    input: z.object({ auto_approve_human_hours: z.boolean() }).strict(),
    permission: 'settings.manage',
    module: 'time',
    method: 'PATCH',
    path: '/api/v1/time/hour-approvals',
    request: (body) => ({ body }),
  }),
];
