import { z } from 'zod';

export const invoiceStatusEnum = z.enum(['draft', 'sent', 'paid', 'overdue', 'cancelled']);
export const invoiceTypeEnum = z.enum(['hourly', 'fixed', 'recurring']);

export const createInvoiceSchema = z.object({
  invoice_number: z.string().min(1, 'Invoice number is required'),
  amount: z.number().min(0, 'Amount must be positive'),
  status: invoiceStatusEnum.default('draft'),
  invoice_type: invoiceTypeEnum.default('hourly'),
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
  date: z.string().min(1).optional(),
  due_date: z.string().nullable().optional(),
  paid_date: z.string().nullable().optional(),
  description: z.string().optional(),
});
