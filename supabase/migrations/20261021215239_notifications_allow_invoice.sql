-- ============================================================
-- Invoice drafts announce themselves with a bell per invoice
-- (announce_billing_draft, entity_type 'invoice'), but the notification
-- type check never allowed 'invoice'. Every self-drafting invoice would have
-- failed on that insert and rolled back: retainer drafts and scheduled hours
-- drafts alike, the first on Nov 1. Widen the check.
-- ============================================================
ALTER TABLE public.team_member_notifications
  DROP CONSTRAINT IF EXISTS team_member_notifications_entity_type_check;
ALTER TABLE public.team_member_notifications
  ADD CONSTRAINT team_member_notifications_entity_type_check
  CHECK (entity_type IN ('task', 'project', 'lead', 'comment', 'member', 'contact', 'suggestion', 'goal', 'question', 'invoice'));
