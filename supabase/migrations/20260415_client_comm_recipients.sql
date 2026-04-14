-- Add multi-recipient support to client_communications.
-- recipients stores the actual To/Cc/Bcc list used at send time, for audit.
ALTER TABLE public.client_communications
  ADD COLUMN recipients jsonb NOT NULL DEFAULT '{"to":[],"cc":[],"bcc":[]}';
