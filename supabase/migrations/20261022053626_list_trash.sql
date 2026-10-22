-- Soft delete: the Trash list.
--
-- Everything in Trash the caller may restore (the same people who may delete
-- it), newest first per type: what it is, where it lived (project or lead),
-- who moved it there and when, and what must happen before it can come back
-- (null when nothing blocks it). Records hidden only because their parent is
-- in Trash are not listed: restoring the parent brings them back.
--
-- Safe to re-run.

CREATE OR REPLACE FUNCTION public.list_trash(p_types text[] DEFAULT NULL, p_limit integer DEFAULT 500)
RETURNS TABLE (
  record_type text,
  id uuid,
  label text,
  context text,
  project_id uuid,
  deleted_at timestamptz,
  deleted_by uuid,
  deleted_by_name text,
  blocker text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  spec record;
  is_service boolean := coalesce(auth.role(), '') = 'service_role';
BEGIN
  IF NOT is_service AND public.current_team_member_id() IS NULL THEN
    RETURN;
  END IF;
  FOR spec IN
    SELECT * FROM (VALUES
      ('projects', 'r.name', 'NULL', 'r.id', ''),
      ('tasks', 'r.title', 'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('task_subtasks', 'r.title', 't.title', 't.project_id', 'LEFT JOIN public.tasks t ON t.id = r.task_id'),
      ('task_comments', 'left(r.text, 120)', 't.title', 't.project_id', 'LEFT JOIN public.tasks t ON t.id = r.task_id'),
      ('reminders', 'r.title', 'coalesce(t.title, p.name)', 'r.project_id',
        'LEFT JOIN public.tasks t ON t.id = r.task_id LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('project_credentials', 'r.label', 'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('entity_files', 'r.name',
        'CASE r.entity_type WHEN ''project'' THEN (SELECT name FROM public.projects WHERE id = r.entity_id)
           WHEN ''lead'' THEN (SELECT name FROM public.leads WHERE id = r.entity_id)
           WHEN ''contact'' THEN (SELECT name FROM public.contacts WHERE id = r.entity_id) END',
        'CASE WHEN r.entity_type = ''project'' THEN r.entity_id END', ''),
      ('portal_updates', 'r.title', 'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('portal_update_attachments', 'r.name', 'u.title', 'u.project_id', 'LEFT JOIN public.portal_updates u ON u.id = r.update_id'),
      ('contacts', 'r.name', 'NULL', 'NULL', ''),
      ('leads', 'r.name', 'NULL', 'NULL', ''),
      ('lead_interactions', 'r.title', 'l.name', 'NULL', 'LEFT JOIN public.leads l ON l.id = r.lead_id'),
      ('lead_proposals', 'r.title', 'l.name', 'NULL', 'LEFT JOIN public.leads l ON l.id = r.lead_id'),
      ('lead_fields', 'r.field_key || '': '' || left(r.value, 80)', 'l.name', 'NULL', 'LEFT JOIN public.leads l ON l.id = r.lead_id'),
      ('project_time_entries',
        'coalesce(nullif(btrim(r.description), ''''), ''Time entry'') || '' ('' || to_char(r.start_time AT TIME ZONE public.workspace_timezone(), ''Mon FMDD, YYYY'') || '')''',
        'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('project_invoices', 'r.invoice_number || '' ($'' || to_char(r.amount, ''FM999,999,990.00'') || '')''', 'p.name', 'r.project_id',
        'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('invoice_payments', '''Payment of $'' || to_char(r.amount, ''FM999,999,990.00'') || '' on '' || i.invoice_number', 'p.name', 'i.project_id',
        'LEFT JOIN public.project_invoices i ON i.id = r.invoice_id LEFT JOIN public.projects p ON p.id = i.project_id'),
      ('project_hourly_rates', '''$'' || to_char(r.hourly_rate, ''FM999,990.00'') || ''/hr from '' || to_char(r.effective_at AT TIME ZONE public.workspace_timezone(), ''Mon FMDD, YYYY'')',
        'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('project_retainers', 'r.name', 'p.name', 'r.project_id', 'LEFT JOIN public.projects p ON p.id = r.project_id'),
      ('project_retainer_amounts', 'rt.name || '': $'' || to_char(r.amount, ''FM999,999,990.00'') || '' from '' || to_char(r.effective_date, ''Mon FMDD, YYYY'')',
        'p.name', 'rt.project_id',
        'LEFT JOIN public.project_retainers rt ON rt.id = r.retainer_id LEFT JOIN public.projects p ON p.id = rt.project_id')
    ) AS specs(record_type, label_sql, context_sql, project_sql, join_sql)
  LOOP
    CONTINUE WHEN p_types IS NOT NULL AND NOT spec.record_type = ANY (p_types);
    RETURN QUERY EXECUTE format(
      'SELECT %L::text, r.id, (%s)::text, (%s)::text, (%s)::uuid, r.deleted_at, r.deleted_by, m.name::text,
              public.trash_restore_blocker(%L, r.id)
       FROM public.%I r %s
       LEFT JOIN public.team_members m ON m.id = r.deleted_by
       WHERE r.deleted_at IS NOT NULL AND ($1 OR public.can_trash_record(%L, r.id))
       ORDER BY r.deleted_at DESC
       LIMIT %s',
      spec.record_type, spec.label_sql, spec.context_sql, spec.project_sql, spec.record_type,
      spec.record_type, spec.join_sql, spec.record_type, greatest(1, least(coalesce(p_limit, 500), 2000)))
    USING is_service;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.list_trash(text[], integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_trash(text[], integer) TO authenticated, service_role;
