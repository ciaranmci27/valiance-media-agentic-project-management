-- ============================================================
-- Rename tables to parent-prefixed naming convention
-- Instant (metadata-only), preserves FKs/triggers/RLS
-- ============================================================

-- Rename tables
ALTER TABLE public.subtasks RENAME TO task_subtasks;
ALTER TABLE public.comments RENAME TO task_comments;
ALTER TABLE public.time_entries RENAME TO project_time_entries;
ALTER TABLE public.notifications RENAME TO team_member_notifications;
ALTER TABLE public.agent_activity RENAME TO agent_activities;

-- Rename indexes: subtasks → task_subtasks
ALTER INDEX idx_subtasks_task_id RENAME TO idx_task_subtasks_task_id;

-- Rename indexes: comments → task_comments
ALTER INDEX idx_comments_task_id RENAME TO idx_task_comments_task_id;
ALTER INDEX idx_comments_user_id RENAME TO idx_task_comments_user_id;

-- Rename indexes: time_entries → project_time_entries
ALTER INDEX idx_time_entries_running RENAME TO idx_project_time_entries_running;
ALTER INDEX idx_time_entries_project RENAME TO idx_project_time_entries_project;
ALTER INDEX idx_time_entries_member RENAME TO idx_project_time_entries_member;
ALTER INDEX idx_time_entries_start_time RENAME TO idx_project_time_entries_start_time;

-- Rename indexes: notifications → team_member_notifications
ALTER INDEX idx_notifications_user_id RENAME TO idx_team_member_notifications_user_id;
ALTER INDEX idx_notifications_unread RENAME TO idx_team_member_notifications_unread;
ALTER INDEX idx_notifications_created_at RENAME TO idx_team_member_notifications_created_at;
ALTER INDEX idx_notifications_dedup RENAME TO idx_team_member_notifications_dedup;

-- Rename indexes: agent_activity → agent_activities
ALTER INDEX idx_agent_activity_agent_id RENAME TO idx_agent_activities_agent_id;
ALTER INDEX idx_agent_activity_project_id RENAME TO idx_agent_activities_project_id;
ALTER INDEX idx_agent_activity_activity_type RENAME TO idx_agent_activities_activity_type;
ALTER INDEX idx_agent_activity_created_at RENAME TO idx_agent_activities_created_at;

-- Update upsert_notification function body to reference new table name
CREATE OR REPLACE FUNCTION public.upsert_notification(
  p_user_id uuid,
  p_title text,
  p_message text,
  p_link text,
  p_entity_type text,
  p_entity_id text
) RETURNS void AS $$
BEGIN
  UPDATE public.team_member_notifications
  SET title = p_title, message = p_message, link = p_link, created_at = now()
  WHERE user_id = p_user_id
    AND entity_type = p_entity_type
    AND entity_id = p_entity_id
    AND is_read = false;

  IF NOT FOUND THEN
    INSERT INTO public.team_member_notifications (user_id, title, message, link, entity_type, entity_id)
    VALUES (p_user_id, p_title, p_message, p_link, p_entity_type, p_entity_id);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
