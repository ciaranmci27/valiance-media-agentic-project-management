-- Client Communications overhaul: rename project_notifications → client_communications,
-- add status/snapshot columns, new notification types, and portal_settings alert controls.

-- ── 1. Rename project_notifications → client_communications ────────────────────
ALTER TABLE public.project_notifications RENAME TO client_communications;

-- Rename existing indexes to match
ALTER INDEX idx_project_notifications_project RENAME TO idx_client_communications_project;
ALTER INDEX idx_project_notifications_type RENAME TO idx_client_communications_type;

-- Rename the RLS policy
ALTER POLICY "project_notifications_all" ON public.client_communications RENAME TO "client_communications_all";

-- ── 2. Expand allowed notification types ──────────────────────────────────────
ALTER TABLE public.client_communications
  DROP CONSTRAINT IF EXISTS project_notifications_notification_type_check;

ALTER TABLE public.client_communications
  ADD CONSTRAINT client_communications_notification_type_check
  CHECK (notification_type IN (
    'portal_welcome',
    'project_summary',
    'budget_threshold',
    'dollar_interval',
    'budget_extended'
  ));

-- ── 3. Add status + snapshot + audit columns ──────────────────────────────────
ALTER TABLE public.client_communications
  ADD COLUMN status text NOT NULL DEFAULT 'sent'
    CHECK (status IN ('pending', 'sent', 'failed', 'dismissed')),
  ADD COLUMN subject text,
  ADD COLUMN rendered_html text,
  ADD COLUMN slot_overrides jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN triggered_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  ADD COLUMN sent_at timestamptz,
  ADD COLUMN dismissed_at timestamptz;

-- Index for fast "pending" lookups per project
CREATE INDEX idx_client_communications_status ON public.client_communications(project_id, status);

-- Backfill sent_at = created_at for historical rows (all of which are 'sent')
UPDATE public.client_communications SET sent_at = created_at WHERE sent_at IS NULL;

-- ── 4. Portal settings: alert mode + dollar interval + approval gate ──────────
ALTER TABLE public.portal_settings
  ADD COLUMN alert_mode text NOT NULL DEFAULT 'percentage'
    CHECK (alert_mode IN ('percentage', 'dollar_interval', 'none')),
  ADD COLUMN dollar_interval numeric(12,2),
  ADD COLUMN require_alert_approval boolean NOT NULL DEFAULT true;
