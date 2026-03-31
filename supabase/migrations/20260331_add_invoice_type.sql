-- Add invoice_type column to project_invoices
-- Allows distinguishing between hourly, fixed, and recurring invoices
-- for accurate balance calculations on mixed-billing projects.

ALTER TABLE public.project_invoices
  ADD COLUMN invoice_type text NOT NULL DEFAULT 'hourly'
    CHECK (invoice_type IN ('hourly', 'fixed', 'recurring'));
