-- New installs start with a placeholder relay domain instead of Valiance
-- Media's own. The relay domain is where an install's inbound email is
-- received (Settings > Email); each install sets its own there. Only the
-- default changes: rows that exist keep their value. Safe to re-run.

ALTER TABLE public.business_settings ALTER COLUMN inbound_email_domain SET DEFAULT 'relay.example.com';
