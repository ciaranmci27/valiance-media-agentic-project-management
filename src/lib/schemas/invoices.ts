import { z } from 'zod';

export const invoiceStatusEnum = z.enum(['draft', 'sent', 'paid', 'overdue', 'cancelled']);
export const invoiceTypeEnum = z.enum(['hourly', 'fixed', 'recurring']);
export const invoiceLineItemTypeEnum = z.enum(['hourly', 'fixed', 'recurring', 'reimbursement']);
export const recurrenceFrequencyEnum = z.enum(['weekly', 'monthly', 'quarterly', 'annual']);

export const invoiceLineItemSchema = z.object({
  id: z.string().min(1),
  position: z.number().int().min(0),
  item_type: invoiceLineItemTypeEnum,
  amount: z.number().min(0),
  description: z.string().default(''),
  service_start_date: z.string().nullable().default(null),
  service_end_date: z.string().nullable().default(null),
  recurrence_frequency: recurrenceFrequencyEnum.nullable().default(null),
});

export const createInvoiceSchema = z.object({
  invoice_number: z.string().min(1, 'Invoice number is required'),
  amount: z.number().min(0, 'Amount must be positive'),
  status: invoiceStatusEnum.default('draft'),
  invoice_type: invoiceTypeEnum.default('hourly'),
  line_items: z.array(invoiceLineItemSchema).default([]),
  date: z.string().min(1, 'Date is required'),
  due_date: z.string().nullable().default(null),
  paid_date: z.string().nullable().default(null),
  description: z.string().default(''),
});

export const updateInvoiceSchema = z.object({
  invoice_number: z.string().min(1).optional(),
  amount: z.number().min(0).optional(),
  status: invoiceStatusEnum.optional(),
  invoice_type: invoiceTypeEnum.optional(),
  line_items: z.array(invoiceLineItemSchema).optional(),
  date: z.string().min(1).optional(),
  due_date: z.string().nullable().optional(),
  paid_date: z.string().nullable().optional(),
  description: z.string().optional(),
});
