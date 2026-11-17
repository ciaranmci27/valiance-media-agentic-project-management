-- "Nothing to do" on a meeting: a person says a catch-up asked for no new
-- work. The app skips the agent's waiting suggestions from it, marks its
-- messages handled, and records here who said so and when, so the meeting
-- reads "Marked nothing to do by X". Undo clears it.

ALTER TABLE communications.meetings ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;
ALTER TABLE communications.meetings ADD COLUMN IF NOT EXISTS dismissed_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL;

ALTER TABLE communications.meetings DROP CONSTRAINT IF EXISTS meetings_dismissed_check;
ALTER TABLE communications.meetings ADD CONSTRAINT meetings_dismissed_check
  CHECK (dismissed_by IS NULL OR dismissed_at IS NOT NULL);

-- A person's accept claims a waiting suggestion before applying it
-- ('accepting'), so two accepts at once (two Adds, Add all twice) apply it
-- once; it goes back to 'pending' if applying fails.
ALTER TABLE communications.plan_items DROP CONSTRAINT IF EXISTS plan_items_state_check;
ALTER TABLE communications.plan_items ADD CONSTRAINT plan_items_state_check CHECK (state IN (
  'applying', 'done', 'failed', 'pending', 'accepting', 'accepted', 'dismissed', 'expired', 'undone', 'skipped'
));
