-- One project's failure no longer stops every retainer draft.
--
-- generate_retainer_drafts ran every project in one transaction, so a single
-- raise (a concurrent Generate now claiming the same period, a bad line) rolled
-- back the whole run and no project got its draft until the cause went away.
-- Each project now runs in its own subtransaction: a failure is recorded in
-- project_billing_runs (shown under Billing, Recent runs) and rings the
-- owners' and admins' bell, and the other projects still draft. Behaviour is
-- otherwise unchanged.
--
-- Apply after 20261018173052_project_billing_plans (it writes project_billing_runs).

CREATE OR REPLACE FUNCTION public.generate_retainer_drafts(p_as_of date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  as_of date := COALESCE(p_as_of, public.workspace_today());
  target record;
  lines jsonb;
  invoice_date date;
  created integer := 0;
  draft public.project_invoices;
  recipient uuid;
  project_name text;
BEGIN
  INSERT INTO public.project_retainer_periods (retainer_id, period_start, period_end, status)
  SELECT due.retainer_id, due.period_start, due.period_end, 'skipped'
  FROM public.retainer_due_periods_internal(NULL, as_of) due
  WHERE due.retainer_status = 'paused'
  ON CONFLICT (retainer_id, period_start) DO NOTHING;

  FOR target IN
    SELECT DISTINCT due.project_id
    FROM public.retainer_due_periods_internal(NULL, as_of) due
    WHERE due.retainer_status = 'active'
  LOOP
    BEGIN
      SELECT
        jsonb_agg(
          public.retainer_line_json(
            due.retainer_id, (due.line_position - 1)::integer, due.amount, due.description,
            due.period_start, due.period_end
          ) ORDER BY due.line_position
        ),
        GREATEST(MAX(due.bill_date), as_of)
      INTO lines, invoice_date
      FROM (
        SELECT inner_due.*, row_number() OVER (ORDER BY inner_due.period_start, inner_due.retainer_name) AS line_position
        FROM public.retainer_due_periods_internal(target.project_id, as_of) inner_due
        WHERE inner_due.retainer_status = 'active'
      ) due;

      draft := public.create_retainer_draft_internal(target.project_id, lines, invoice_date, true);
      IF draft.id IS NOT NULL THEN
        created := created + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.project_billing_runs (project_id, run_key, run_date, outcome, detail)
      VALUES (target.project_id, 'retainer-failed:' || to_char(as_of, 'YYYY-MM-DD'), as_of, 'failed',
              left('Retainer draft: ' || SQLERRM, 500))
      ON CONFLICT (project_id, run_key) DO UPDATE SET detail = EXCLUDED.detail, created_at = now();
      SELECT name INTO project_name FROM public.projects WHERE id = target.project_id;
      FOR recipient IN
        SELECT id FROM public.team_members WHERE role IN ('owner', 'admin') AND status = 'active'
      LOOP
        PERFORM public.upsert_notification(
          recipient,
          'Retainer draft failed',
          'The retainer invoice for ' || COALESCE(project_name, 'a project') || ' could not be drafted: '
            || left(SQLERRM, 200) || '. Generate it from Billing, Retainers, once fixed.',
          '/projects/' || target.project_id::text || '?tab=invoices',
          'project',
          target.project_id::text
        );
      END LOOP;
    END;
  END LOOP;

  RETURN created;
END;
$$;
