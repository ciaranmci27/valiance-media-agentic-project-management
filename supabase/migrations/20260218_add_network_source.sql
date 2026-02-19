-- Add 'network' to leads source check constraint
alter table public.leads drop constraint if exists leads_source_check;
alter table public.leads add constraint leads_source_check
  check (source in ('referral', 'website', 'social', 'cold_outreach', 'event', 'network', 'other'));
