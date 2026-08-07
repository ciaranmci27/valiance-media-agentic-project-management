-- The sensitive-path pattern becomes a per-project dial with one source of
-- truth. It already governed the merge gate (a hold whenever a PR touches
-- matching files), but the pattern lived only inside the gate script, so the
-- app could never predict the gate's answer without growing a second copy
-- that would drift. On the project row, the gate reads it from the same
-- fetch it already makes, and the app computes honest autonomy forecasts
-- (which tasks will finish hands-free vs end in a "your merge" hold) from
-- the identical value.
--
-- The default is the gate's list as shipped: paths whose failures tests do
-- not catch and whose mistakes are expensive or irreversible.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS sensitive_paths text NOT NULL
    DEFAULT '(^|/)(migrations?|supabase/migrations)/|\.sql$|auth|permission|role|access|middleware|session|credential|secret|token|rls|billing|payment|invoice|stripe|payout|revenue|pdf|docx|document-generation|(^|/)email/|mailer|smtp|resend|sendgrid|twilio|sms|outbound|webhook';

COMMENT ON COLUMN public.projects.sensitive_paths IS
  'Case-insensitive regex over changed file paths. A PR touching a match is never auto-merged; the app uses the same pattern to forecast which tasks will need a manual merge.';
