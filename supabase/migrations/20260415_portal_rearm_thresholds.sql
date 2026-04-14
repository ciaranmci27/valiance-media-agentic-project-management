-- Per-project toggle: when a budget is changed, should percentage-threshold
-- alerts that already fired under the old budget rearm for the new budget era?
-- Defaults to false to preserve existing absolute-threshold behavior.

ALTER TABLE public.portal_settings
  ADD COLUMN rearm_thresholds_on_budget_change boolean NOT NULL DEFAULT false;
