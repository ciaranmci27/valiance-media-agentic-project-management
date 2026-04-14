-- Project notifications for dedup and audit trail
CREATE TABLE public.project_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  notification_type text NOT NULL CHECK (notification_type IN ('portal_welcome', 'budget_threshold', 'project_summary')),
  metadata jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_project_notifications_project ON public.project_notifications(project_id);
CREATE INDEX idx_project_notifications_type ON public.project_notifications(project_id, notification_type);

ALTER TABLE public.project_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "project_notifications_all" ON public.project_notifications
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Add threshold config to portal_settings
ALTER TABLE public.portal_settings
  ADD COLUMN notification_thresholds integer[] NOT NULL DEFAULT '{50,75,90,100}';
