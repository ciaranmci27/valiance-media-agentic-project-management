-- Add line_items JSONB column to project_invoices.
-- Each invoice can now contain multiple line items so a single payment
-- can mix hourly work, fixed charges, recurring retainers, and reimbursements.
--
-- Shape of each line item:
-- {
--   "id": uuid,
--   "position": int,
--   "item_type": "hourly" | "fixed" | "recurring" | "reimbursement",
--   "amount": number,
--   "description": string,
--   "service_start_date": "YYYY-MM-DD" | null,
--   "service_end_date":   "YYYY-MM-DD" | null,
--   "recurrence_frequency": "weekly" | "monthly" | "quarterly" | "annual" | null
-- }
--
-- Lazy backfill: when an invoice has an empty line_items array, the app
-- synthesizes a single line item from the existing invoice_type + amount
-- on read, so this migration does not touch existing rows.

ALTER TABLE public.project_invoices
  ADD COLUMN line_items jsonb NOT NULL DEFAULT '[]'::jsonb;
