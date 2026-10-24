-- Inbox: answers to the agent's questions.
--
-- When the agent triages an email needs_human, its question waits on a
-- person. A person answers it from the thread (their own words, or "go with
-- your default"); the answer is kept here against the triage that asked, and
-- the email goes back to the agent, who acts on the answer as an instruction
-- from that person. An unanswered question keeps showing in the agent's
-- summaries and daily brief until it is answered or the thread is handled.
-- Answers are written by the server (service role) only, never deleted.

CREATE TABLE IF NOT EXISTS public.email_question_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.email_messages(id) ON DELETE CASCADE,
  -- The triage whose question this answers.
  triage_id uuid NOT NULL REFERENCES public.email_triage(id) ON DELETE CASCADE,
  answer text NOT NULL CHECK (length(answer) BETWEEN 1 AND 2000),
  answered_by uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_question_answers_message ON public.email_question_answers (message_id, created_at DESC);

ALTER TABLE public.email_question_answers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_question_answers_select ON public.email_question_answers;
CREATE POLICY email_question_answers_select ON public.email_question_answers FOR SELECT TO authenticated
  USING (public.can_read_email_message(message_id));
