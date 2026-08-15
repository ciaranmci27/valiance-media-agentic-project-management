-- Suggestion bundles: related suggestions group for one review session and
-- one combined task, without ever merging.
--
-- A bundle is nothing but a shared key. Members keep their own text, status,
-- and rejection history forever, so Ciaran can approve any subset; the
-- approved subset becomes ONE task (composition, not blending). Greg sets
-- the key at proposal time for sensitive-domain findings (payments,
-- shipping, invoicing: domains Ciaran hand-reviews anyway, where fewer PRs
-- means less of his time); safe-path quick fixes stay solo and flow through
-- auto-merge individually. Ciaran can bundle or unbundle manually; an
-- unbundle writes metadata.unbundled, which Greg respects.
alter table public.task_suggestions
  add column if not exists bundle_key uuid;

create index if not exists idx_task_suggestions_bundle
  on public.task_suggestions(bundle_key) where bundle_key is not null;
