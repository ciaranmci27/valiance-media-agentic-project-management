-- Replace fixed_price with flexible budget fields (hours or amount)

-- Add budget columns
ALTER TABLE public.projects
  ADD COLUMN budget_type text CHECK (budget_type IN ('hours', 'amount')),
  ADD COLUMN budget_value numeric(12,2);

-- Migrate existing fixed_price data: non-hourly projects with a fixed_price become amount budgets
UPDATE public.projects
  SET budget_type = 'amount', budget_value = fixed_price
  WHERE fixed_price IS NOT NULL AND hourly_tracking = false;

-- Drop the now-redundant fixed_price column
ALTER TABLE public.projects DROP COLUMN fixed_price;
