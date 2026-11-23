-- Only neutral names in stored values and rules. Since 2.0.5 triage plan
-- items aim work at 'owner' or 'company', and since 2.0.10 an auditing
-- agent's question selection starts AUDIT_QUESTIONS:. The older values
-- ('ciaran', 'agency', GREG_QUESTIONS:) were kept so agents written before
-- then kept working; stored rows are renamed to the new values here (same
-- meaning) and the plan item rule accepts only the new ones.
--
-- Safe to run twice. The previous release's code already writes only the new
-- values (it read the old ones as the new), so it keeps working.

UPDATE pm.plan_items SET addressee = 'owner' WHERE addressee = 'ciaran';
UPDATE pm.plan_items SET addressee = 'company' WHERE addressee = 'agency';

UPDATE pm.project_context
SET content = 'AUDIT_QUESTIONS:' || substr(content, length('GREG_QUESTIONS:') + 1)
WHERE content LIKE 'GREG\_QUESTIONS:%';

ALTER TABLE pm.plan_items DROP CONSTRAINT IF EXISTS plan_items_addressee_check;
ALTER TABLE pm.plan_items
  ADD CONSTRAINT plan_items_addressee_check
  CHECK (addressee IN ('owner', 'company', 'teammate', 'client', 'other'));
