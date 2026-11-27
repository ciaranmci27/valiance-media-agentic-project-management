-- Settings cleanup: the brand's fourth logo slot. Settings > Workspace >
-- Brand now has a horizontal and a square logo, each for the light and the
-- dark theme. Three slots map onto the columns that were there (logo_light_path
-- and logo_dark_path are the horizontal logo, favicon_path the square logo for
-- the light theme); this adds the square logo for the dark theme.
--
-- Additive and safe to re-run: one nullable column, no data changes. NULL
-- means "use the light theme's square logo", so the previous release's code,
-- which never reads it, keeps working unchanged. The brand bucket already
-- accepts the PNG, JPEG and ICO files a square logo may be.

ALTER TABLE pm.workspace_brand ADD COLUMN IF NOT EXISTS logo_square_dark_path text;

COMMENT ON COLUMN pm.workspace_brand.logo_square_dark_path IS
  'Object path in the pm-brand bucket: the square logo for dark backgrounds (the tab icon in a dark browser). NULL uses favicon_path.';
