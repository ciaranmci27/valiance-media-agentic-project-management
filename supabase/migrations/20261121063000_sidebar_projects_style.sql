-- How the sidebar lists projects, set in Settings > Workspace > Brand:
-- 'list' (a section of the first few active projects, today's layout) or
-- 'menu' (every active project folded under the Projects row). Existing
-- workspaces keep 'list'; the setup wizard picks one from the preset.
--
-- Safe to re-run. The previous release's code never reads the column.

ALTER TABLE public.workspace_brand
  ADD COLUMN IF NOT EXISTS sidebar_projects text NOT NULL DEFAULT 'list';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_brand_sidebar_projects_check'
      AND conrelid = 'public.workspace_brand'::regclass
  ) THEN
    ALTER TABLE public.workspace_brand
      ADD CONSTRAINT workspace_brand_sidebar_projects_check CHECK (sidebar_projects IN ('list', 'menu'));
  END IF;
END $$;
