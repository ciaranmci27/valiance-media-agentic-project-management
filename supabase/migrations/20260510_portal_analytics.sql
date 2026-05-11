-- Portal analytics: per-event log of activity inside client portals, plus
-- an admin-managed IP exclusion list on business_settings that the
-- dashboard filters by.
--
-- One row per event. Server-stamped identity columns (ip_address, user_agent,
-- ip_hash, parsed UA) are filled in by the API; client-reported columns
-- (timezone, language, screen size, etc.) come from the portal page's first
-- event after mount. metadata holds event-specific payload (file_id,
-- invoice_id, section key, pin success bool, etc).
--
-- Per-session rollup is computed in the API handler from this table; the
-- old portal_session_summary view was removed because we already query the
-- raw events on the same request for top-files/sections/invoices.
--
-- No geo lookup is performed; timezone + IP + UA is the location signal.

create table public.portal_events (
  id                  uuid primary key default gen_random_uuid(),
  portal_settings_id  uuid not null references public.portal_settings(id) on delete cascade,
  project_id          uuid not null references public.projects(id) on delete cascade,
  session_id          uuid not null,
  event_type          text not null check (event_type in (
    'portal_view',
    'pin_attempt',
    'section_view',
    'file_preview',
    'file_download',
    'invoice_view',
    'invoice_pdf_download',
    'credential_submit',
    'heartbeat'
  )),

  -- Server-stamped from the request (never trusted from client body)
  ip_address          inet,
  ip_hash             text,
  user_agent          text,
  referrer            text,
  device_type         text,
  browser             text,
  os                  text,
  accept_language     text,

  -- Client-reported (sent by the portal page; informational only)
  timezone            text,
  language            text,
  screen_width        integer,
  screen_height       integer,
  viewport_width      integer,
  viewport_height     integer,
  connection_type     text,
  color_scheme        text,
  reduced_motion      boolean,

  metadata            jsonb not null default '{}',
  created_at          timestamptz not null default now()
);

create index idx_portal_events_settings_created on public.portal_events(portal_settings_id, created_at desc);
create index idx_portal_events_project_created on public.portal_events(project_id, created_at desc);
create index idx_portal_events_session on public.portal_events(session_id);
create index idx_portal_events_type on public.portal_events(portal_settings_id, event_type, created_at desc);
create index idx_portal_events_ip_hash on public.portal_events(portal_settings_id, ip_hash);

alter table public.portal_events enable row level security;

-- Inserts normally happen via the service-role key from API routes; the
-- policy lets the admin dashboard query directly when needed.
create policy "portal_events_all" on public.portal_events
  for all to authenticated using (true) with check (true);

-- Admin-controlled IP exclusion list for portal analytics. Stored as a JSON
-- array of { ip, label } objects on the singleton business_settings row so
-- it shares storage with the rest of the org-wide config. The analytics
-- dashboard filters these out by default so test traffic from the team
-- doesn't pollute the "real client" view.
--
-- ip:    the bare IPv4 or IPv6 address (no CIDR prefix; matches what the
--        dashboard renders after we strip /32 and /128 from inet values)
-- label: free-text description so admins can tell entries apart
--        ("Developer's home", "Office VPN", etc.)
alter table public.business_settings
  add column excluded_ips jsonb not null default '[]'::jsonb;
