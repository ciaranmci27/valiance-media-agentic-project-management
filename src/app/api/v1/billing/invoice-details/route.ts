import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { assertInvoiceDetailsOn, INVOICE_DETAIL_FIELDS, patchInvoiceDetails, readInvoiceDetails } from '@/lib/api/money-api';

export const dynamic = 'force-dynamic';

const line = (max: number) => z.string().trim().max(max);

// Instructions and the default note have the form's caps (Settings > Billing >
// Invoice details); the other fields are capped well past real use.
const updateInvoiceDetailsSchema = z.object({
  business_name: line(200).optional(),
  business_address: line(1000).optional(),
  business_email: line(320).optional(),
  business_phone: line(50).optional(),
  // Blank falls back to the app's default, as the form's Save does.
  payment_terms: line(200).transform((value) => value || 'Upon receipt').optional(),
  payment_instructions: line(500).optional(),
  default_invoice_notes: line(300).optional(),
}).strict().refine((value) => INVOICE_DETAIL_FIELDS.some((field) => value[field] !== undefined), {
  message: `Send at least one of: ${INVOICE_DETAIL_FIELDS.join(', ')}`,
});

/** The company details every invoice PDF carries: the From block, payment terms and instructions, and the default note. */
export const GET = withApi(async ({ supabase, access }) => {
  assertInvoiceDetailsOn(access);
  return success((await readInvoiceDetails(supabase)).details);
}, { permission: 'settings.manage' });

/** Changes the company's invoice details (Settings > Billing > Invoice details): only the fields sent change. */
export const PATCH = withApi(async ({ supabase, access, body, apiKeyId, teamMemberId }) => {
  assertInvoiceDetailsOn(access);
  const { before, after } = await patchInvoiceDetails(supabase, body as z.infer<typeof updateInvoiceDetailsSchema>);
  logAudit(supabase, {
    method: 'PATCH',
    endpoint: '/api/v1/billing/invoice-details',
    entityType: 'business_settings',
    apiKeyId,
    teamMemberId,
    requestBody: body,
    beforeSnapshot: before,
    afterSnapshot: after,
    statusCode: 200,
  });
  return success(after);
}, { schema: updateInvoiceDetailsSchema, permission: 'settings.manage' });
