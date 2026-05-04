-- Business settings: a singleton row holding the workspace's own business
-- identity (the "From" block on invoices). One row per install. Filled in
-- via Settings → Business Info so personal details aren't committed to source.
--
-- Also adds per-project invoice billing fields used by the invoice PDF:
-- billing_address (Bill To), billing_email (override), tax_rate (percent).

CREATE TABLE public.business_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name text NOT NULL DEFAULT '',
  business_address text NOT NULL DEFAULT '',
  business_email text NOT NULL DEFAULT '',
  business_phone text NOT NULL DEFAULT '',
  payment_terms text NOT NULL DEFAULT 'Upon Receipt',
  payment_instructions text NOT NULL DEFAULT '',
  default_invoice_notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Enforce singleton: only one row may ever exist in this table.
CREATE UNIQUE INDEX business_settings_singleton ON public.business_settings ((true));

ALTER TABLE public.business_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "business_settings_all" ON public.business_settings
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Auto-bump updated_at on every UPDATE, matching the rest of the schema.
CREATE TRIGGER set_business_settings_updated_at
  BEFORE UPDATE ON public.business_settings
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Seed a single empty row so the app always has a settings row to read/update.
INSERT INTO public.business_settings DEFAULT VALUES;

-- Project-level invoice billing fields. All optional; the PDF falls back to
-- the linked primary contact's email/company when not set on the project.
--
-- invoice_pdf_options holds per-project rendering toggles so each
-- client/project can have its own invoice presentation. NOT NULL DEFAULT
-- means existing rows pick up the all-true defaults automatically. Keys
-- match InvoicePdfOptions in app code; the merge in buildInvoiceData()
-- defaults missing keys to true.
ALTER TABLE public.projects
  ADD COLUMN billing_address text,
  ADD COLUMN billing_email text,
  ADD COLUMN tax_rate numeric(5,2),
  ADD COLUMN invoice_pdf_options jsonb NOT NULL DEFAULT '{
    "showLogo": true,
    "showTopAccent": true,
    "showStatusStamp": true,
    "showSenderName": true,
    "showLineCaptions": true,
    "showPortalLink": true,
    "showNotes": true,
    "showPaymentInstructions": true,
    "showFooter": true
  }'::jsonb;
