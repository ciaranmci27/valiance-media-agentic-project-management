-- Chat relay heartbeat: when a Discord relay last checked in.
--
-- The Discord relay said hello only when it connected, so a relay that
-- stopped (its host down, the process killed) left the connection reading
-- Connected for days. Relays from this release on send a heartbeat every
-- 5 minutes; the app stamps relay_seen_at on each one. Once a relay has
-- sent one, a connection with nothing from it for 15 minutes reads Not
-- receiving. A relay that never sends one (an older relay) leaves this null
-- and is judged as before.
--
-- Additive and safe to run twice. The previous release's code never reads
-- or writes the column.

ALTER TABLE pm.chat_connections
  ADD COLUMN IF NOT EXISTS relay_seen_at timestamptz;

COMMENT ON COLUMN pm.chat_connections.relay_seen_at IS
  'The last heartbeat from this connection''s relay (Discord), or null when its relay sends none. Set by the server only.';
