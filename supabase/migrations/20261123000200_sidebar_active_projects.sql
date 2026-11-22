-- Settings > Workspace > Brand: whether the sidebar shows active projects in
-- a section of their own, set apart from how the Projects item works
-- (sidebar_projects: 'list' opens the Projects page, 'menu' folds the active
-- projects under it). Until now the section came only with 'list', so every
-- workspace keeps what it sees: on with 'list', off with 'menu'.
--
-- Additive and safe to run twice. The previous release's code never reads it.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'pm' AND table_name = 'workspace_brand' AND column_name = 'sidebar_active_projects'
  ) THEN
    ALTER TABLE pm.workspace_brand ADD COLUMN sidebar_active_projects boolean NOT NULL DEFAULT true;
    UPDATE pm.workspace_brand SET sidebar_active_projects = false WHERE sidebar_projects = 'menu';
  END IF;
END $$;

COMMENT ON COLUMN pm.workspace_brand.sidebar_active_projects IS
  'The sidebar lists the first five active projects in a section of their own.';
