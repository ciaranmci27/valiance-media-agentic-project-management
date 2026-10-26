-- Triage plans: what the agent made of a message, item by item, and what the
-- app did with each item. The agent proposes one plan per message: a summary
-- and items (create a task, comment, remind, link, file a project, a reply
-- owed, ...), each with its intent, project, addressee, evidence and
-- confidence. The app's policy decides each item: apply, apply unsure
-- (applied, shown as unsure, one tap to undo), propose (waits for a person),
-- or reject. A person accepts, dismisses or undoes items; undoing restores
-- what the item changed.
-- A shadow plan records the decisions and applies nothing, so a new triage
-- can run beside the old one on real mail. inboxes.triage_mode picks the
-- triage an inbox runs: legacy (the old one), shadow (both; only the old
-- one's work is kept) or plans.
-- reply_points: what someone is waiting on Ciaran (or the agent) for, one
-- point each, kept per conversation and amended rather than repeated.
-- conversations.muted_at: a person asked to ignore the conversation.
--
-- Apply after 20261026192302_message_delivery.sql. Safe to re-run.

BEGIN;

ALTER TABLE communications.inboxes
  ADD COLUMN IF NOT EXISTS triage_mode text NOT NULL DEFAULT 'legacy'
    CONSTRAINT inboxes_triage_mode_check CHECK (triage_mode IN ('legacy', 'shadow', 'plans'));
ALTER TABLE communications.conversations ADD COLUMN IF NOT EXISTS muted_at timestamptz;
ALTER TABLE communications.conversations
  ADD COLUMN IF NOT EXISTS muted_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS communications.plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES communications.messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES communications.conversations(id) ON DELETE CASCADE,
  -- The agent that made it.
  member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  mode text NOT NULL CONSTRAINT plans_mode_check CHECK (mode IN ('live', 'shadow')),
  status text NOT NULL DEFAULT 'applying' CONSTRAINT plans_status_check
    CHECK (status IN ('applying', 'applied', 'partial', 'undone')),
  summary text NOT NULL CONSTRAINT plans_summary_check CHECK (length(summary) BETWEEN 1 AND 4000),
  thread_summary text CONSTRAINT plans_thread_summary_check CHECK (thread_summary IS NULL OR length(thread_summary) <= 300),
  urgent boolean NOT NULL DEFAULT false,
  -- Every item proposes: the message looks like an attack or an impostor.
  suspicious boolean NOT NULL DEFAULT false,
  -- What the agent noticed: context_incomplete (it answers something the
  -- agent never saw), content_unreadable (only a link or file it cannot read).
  flags text[] NOT NULL DEFAULT '{}'
    CONSTRAINT plans_flags_check CHECK (flags <@ ARRAY['context_incomplete', 'content_unreadable']::text[]),
  -- The triage row a live plan records (summary feed, questions, answers).
  triage_id uuid REFERENCES communications.triage(id) ON DELETE SET NULL,
  idempotency_key text CONSTRAINT plans_idempotency_key_check CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plans_key_has_hash CHECK (idempotency_key IS NULL OR request_hash IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_plans_message ON communications.plans (message_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plans_conversation ON communications.plans (conversation_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS plans_message_idempotency_key ON communications.plans (message_id, mode, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS communications.plan_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES communications.plans(id) ON DELETE CASCADE,
  position integer NOT NULL CONSTRAINT plan_items_position_check CHECK (position >= 0),
  -- Copies of the plan's, so per-conversation rules can be indexed.
  conversation_id uuid NOT NULL REFERENCES communications.conversations(id) ON DELETE CASCADE,
  mode text NOT NULL CONSTRAINT plan_items_mode_check CHECK (mode IN ('live', 'shadow')),
  type text NOT NULL CONSTRAINT plan_items_type_check CHECK (type IN (
    'create_task', 'update_task', 'comment', 'attach_file',
    'add_reminder', 'update_reminder', 'complete_reminder',
    'link_task', 'file_project', 'reply_owed', 'revert_item', 'mute_conversation',
    'add_context', 'propose_mapping', 'create_lead', 'log_interaction', 'ask'
  )),
  intent text NOT NULL CONSTRAINT plan_items_intent_check CHECK (intent IN (
    'new_work', 'change', 'handoff', 'waiting_on', 'commitment', 'reply_owed',
    'owner_instruction', 'new_business', 'money', 'account_risk', 'context', 'noise'
  )),
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  -- The task it acts on, or the one it created.
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  -- Who the work is aimed at.
  addressee text NOT NULL DEFAULT 'ciaran'
    CONSTRAINT plan_items_addressee_check CHECK (addressee IN ('ciaran', 'agency', 'teammate', 'client', 'other')),
  addressee_member_id uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The words (or the attachment) that justify it.
  evidence text CONSTRAINT plan_items_evidence_check CHECK (evidence IS NULL OR length(evidence) <= 1000),
  confidence text NOT NULL DEFAULT 'sure' CONSTRAINT plan_items_confidence_check CHECK (confidence IN ('sure', 'unsure')),
  decision text NOT NULL CONSTRAINT plan_items_decision_check CHECK (decision IN ('apply', 'apply_unsure', 'propose', 'reject')),
  decision_reason text CONSTRAINT plan_items_decision_reason_check CHECK (decision_reason IS NULL OR length(decision_reason) <= 500),
  -- applying: being written; done: applied; failed: could not be applied;
  -- pending: a proposal waiting; accepted / dismissed / expired: a proposal
  -- resolved; undone: applied, then undone; skipped: shadow or rejected.
  state text NOT NULL CONSTRAINT plan_items_state_check CHECK (state IN (
    'applying', 'done', 'failed', 'pending', 'accepted', 'dismissed', 'expired', 'undone', 'skipped'
  )),
  -- What applying it did: ids it created, the values it replaced.
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text CONSTRAINT plan_items_error_check CHECK (error IS NULL OR length(error) <= 1000),
  resolved_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_items_plan_position_key UNIQUE (plan_id, position)
);
CREATE INDEX IF NOT EXISTS idx_plan_items_conversation ON communications.plan_items (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plan_items_project ON communications.plan_items (project_id, created_at DESC) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_plan_items_task ON communications.plan_items (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_plan_items_pending ON communications.plan_items (created_at) WHERE state = 'pending';
-- At most one question waiting per conversation.
CREATE UNIQUE INDEX IF NOT EXISTS plan_items_one_open_ask ON communications.plan_items (conversation_id)
  WHERE type = 'ask' AND state = 'pending' AND mode = 'live';

CREATE TABLE IF NOT EXISTS communications.reply_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES communications.conversations(id) ON DELETE CASCADE,
  -- The message that raised it (or last amended it).
  message_id uuid REFERENCES communications.messages(id) ON DELETE SET NULL,
  plan_item_id uuid REFERENCES communications.plan_items(id) ON DELETE SET NULL,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  -- Who is waiting, and on what.
  who text NOT NULL CONSTRAINT reply_points_who_check CHECK (length(who) BETWEEN 1 AND 200),
  what text NOT NULL CONSTRAINT reply_points_what_check CHECK (length(what) BETWEEN 1 AND 1000),
  kind text NOT NULL CONSTRAINT reply_points_kind_check CHECK (kind IN ('info', 'decision', 'security', 'schedule')),
  -- Owed to the agent instead (a teammate asked it something); its answer, when it found one.
  to_agent boolean NOT NULL DEFAULT false,
  note text CONSTRAINT reply_points_note_check CHECK (note IS NULL OR length(note) <= 2000),
  by_when date,
  urgent boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'open' CONSTRAINT reply_points_state_check CHECK (state IN ('open', 'resolved', 'expired')),
  resolved_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reply_points_conversation ON communications.reply_points (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reply_points_open ON communications.reply_points (by_when NULLS LAST, created_at) WHERE state = 'open';

-- A live plan's triage row, so the summary feed, questions and answers keep working.
ALTER TABLE communications.triage
  ADD COLUMN IF NOT EXISTS plan_id uuid REFERENCES communications.plans(id) ON DELETE SET NULL;

DROP TRIGGER IF EXISTS set_plans_updated_at ON communications.plans;
CREATE TRIGGER set_plans_updated_at BEFORE UPDATE ON communications.plans
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
DROP TRIGGER IF EXISTS set_plan_items_updated_at ON communications.plan_items;
CREATE TRIGGER set_plan_items_updated_at BEFORE UPDATE ON communications.plan_items
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
DROP TRIGGER IF EXISTS set_reply_points_updated_at ON communications.reply_points;
CREATE TRIGGER set_reply_points_updated_at BEFORE UPDATE ON communications.reply_points
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Read under RLS by whoever can read the message; written only by the server.
ALTER TABLE communications.plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.plan_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications.reply_points ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plans_select ON communications.plans;
CREATE POLICY plans_select ON communications.plans FOR SELECT TO authenticated
  USING (communications.can_read_message(message_id));
DROP POLICY IF EXISTS plan_items_select ON communications.plan_items;
CREATE POLICY plan_items_select ON communications.plan_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM communications.plans p WHERE p.id = plan_id AND communications.can_read_message(p.message_id)));
DROP POLICY IF EXISTS reply_points_select ON communications.reply_points;
CREATE POLICY reply_points_select ON communications.reply_points FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM communications.messages m
    WHERE m.thread_id = conversation_id AND communications.can_read_message(m.id)
  ));
REVOKE ALL ON communications.plans, communications.plan_items, communications.reply_points FROM PUBLIC, anon, authenticated;
GRANT SELECT ON communications.plans, communications.plan_items, communications.reply_points TO authenticated;
GRANT ALL ON communications.plans, communications.plan_items, communications.reply_points TO service_role;

-- Live sync pings for the Inbox.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    FOREACH t IN ARRAY ARRAY['plans', 'plan_items', 'reply_points'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'communications' AND tablename = t
      ) THEN
        EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE communications.%I', t);
      END IF;
    END LOOP;
  END IF;
END $$;

COMMIT;
