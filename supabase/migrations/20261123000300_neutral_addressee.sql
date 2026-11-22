-- Who a triage plan item is aimed at, in neutral names: 'owner' and
-- 'company' join 'teammate', 'client' and 'other'. The older 'ciaran' and
-- 'agency' stay valid: agents written before 2.0.5 send them (the app reads
-- them as owner and company), and rows already stored keep their value.
-- New rows default to 'owner'.
--
-- Additive and safe to run twice. The previous release's code keeps working:
-- every value it writes is still accepted.

ALTER TABLE pm.plan_items DROP CONSTRAINT IF EXISTS plan_items_addressee_check;
ALTER TABLE pm.plan_items
  ADD CONSTRAINT plan_items_addressee_check
  CHECK (addressee IN ('owner', 'company', 'teammate', 'client', 'other', 'ciaran', 'agency'));
ALTER TABLE pm.plan_items ALTER COLUMN addressee SET DEFAULT 'owner';
