-- Workspace brand: the name, colors, logos and favicon the app, the client
-- portal, emails and invoice PDFs show, set by an Owner in Settings >
-- Workspace > Brand. Replaces the brand that lived in code.
--
-- Additive and safe to re-run. Adds one table with one row of NULLs (core's
-- defaults) and one storage bucket; no existing data changes.

-- 1. The brand: one row, every field optional. NULL means "use core's
--    default", so a fresh install starts neutral and an Owner fills it in.
CREATE TABLE IF NOT EXISTS public.workspace_brand (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  name text CHECK (name IS NULL OR char_length(name) <= 60),
  tagline text CHECK (tagline IS NULL OR char_length(tagline) <= 60),
  description text CHECK (description IS NULL OR char_length(description) <= 200),
  brand_color text CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  -- Optional per-shade overrides on top of the scale generated from brand_color: {"50": "#F0F5F5", ...}.
  brand_shades jsonb CHECK (brand_shades IS NULL OR jsonb_typeof(brand_shades) = 'object'),
  accent_color text CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  -- Object paths in the public 'brand' bucket.
  logo_light_path text,
  logo_dark_path text,
  favicon_path text,
  invert_logo_in_sidebar boolean NOT NULL DEFAULT false,
  show_name_under_logo boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_workspace_brand_updated_at ON public.workspace_brand;
CREATE TRIGGER set_workspace_brand_updated_at
  BEFORE UPDATE ON public.workspace_brand
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

INSERT INTO public.workspace_brand (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- 2. Anyone may read it: the sign-in page, the client portal and emails show
--    the brand before anyone signs in, and it holds nothing private. Only the
--    app's Owner-only route writes it, with the service role.
ALTER TABLE public.workspace_brand ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_brand_read ON public.workspace_brand;
CREATE POLICY workspace_brand_read ON public.workspace_brand
  FOR SELECT TO anon, authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.workspace_brand FROM anon, authenticated;

-- 3. Logos and the favicon: a public bucket written only by the service role
--    (no storage policies for anon or authenticated). PNG, JPEG and ICO only:
--    emails and invoice PDFs cannot show SVG, and an SVG in a public bucket
--    could carry script.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('brand', 'brand', true, 2097152, ARRAY['image/png', 'image/jpeg', 'image/x-icon', 'image/vnd.microsoft.icon'])
ON CONFLICT (id) DO NOTHING;
