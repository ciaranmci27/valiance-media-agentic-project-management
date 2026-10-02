-- workspace_today() validated the owner's time zone by joining
-- pg_timezone_names, a view that reads the whole time zone database on every
-- call (about 60 ms). retainer_accruing_lines evaluates it once per retainer
-- row, which made that RPC take about 0.8 s while returning nothing, on every
-- app load and every Finances or Dashboard visit.
--
-- Same answer, without the catalog: the first owner (by created_at) whose time
-- zone Postgres recognizes, else UTC. A name Postgres rejects raises
-- invalid_parameter_value, which is caught and skipped, exactly as the join
-- skipped names missing from the catalog. Names are limited to the shape of
-- the catalog's own names, so a bare POSIX offset ('+05', 'UTC+3'), which
-- AT TIME ZONE accepts but the catalog never listed, still falls back. The
-- one difference: a bare abbreviation such as 'PST' is now honored rather
-- than treated as UTC. Owners pick IANA names, so today's answer is unchanged.

CREATE OR REPLACE FUNCTION public.workspace_today()
RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  zone text;
BEGIN
  FOR zone IN
    SELECT member.timezone
    FROM public.team_members member
    WHERE member.role = 'owner'
      AND member.timezone ~ '^[A-Za-z][A-Za-z0-9_-]*(/[A-Za-z0-9_+-]+)*$'
    ORDER BY member.created_at
  LOOP
    BEGIN
      RETURN (now() AT TIME ZONE zone)::date;
    EXCEPTION WHEN invalid_parameter_value THEN
      NULL;
    END;
  END LOOP;
  RETURN (now() AT TIME ZONE 'UTC')::date;
END;
$$;
