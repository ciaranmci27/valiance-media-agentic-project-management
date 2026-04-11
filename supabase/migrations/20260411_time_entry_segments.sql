-- Add segments JSONB column to project_time_entries for pause/resume support.
-- Each segment is {start: ISO, end: ISO | null}. A null end on the last segment
-- means the timer is actively running; otherwise the entry is paused (if end_time
-- is null) or stopped (if end_time is set).
--
-- Backfill: existing rows get a single segment derived from start_time/end_time
-- so the new column stays consistent with the denormalized range.

ALTER TABLE public.project_time_entries
  ADD COLUMN segments jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE public.project_time_entries
SET segments = jsonb_build_array(
  jsonb_build_object(
    'start', to_char(start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'end', CASE
      WHEN end_time IS NULL THEN NULL
      ELSE to_char(end_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    END
  )
)
WHERE segments = '[]'::jsonb;
