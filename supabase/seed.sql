-- ============================================================
-- Valiance Media Seed Data
-- Run this in your Supabase SQL Editor AFTER schema.sql
-- Populates every table with realistic agency/media data
-- ============================================================

-- Clean slate (order matters due to foreign keys)
truncate public.activities cascade;
truncate public.task_comments cascade;
truncate public.task_subtasks cascade;
truncate public.task_assignees cascade;
truncate public.tasks cascade;
truncate public.project_contacts cascade;
truncate public.project_members cascade;
truncate public.leads cascade;
truncate public.projects cascade;
truncate public.contacts cascade;
-- NOTE: we do NOT truncate team_members — your real user row lives there.
-- Instead we delete only the seed rows (by known IDs) so your auth-linked row is safe.
delete from public.team_members where id in (
  'a1a1a1a1-0001-4000-8000-000000000001',
  'a1a1a1a1-0002-4000-8000-000000000002',
  'a1a1a1a1-0003-4000-8000-000000000003',
  'a1a1a1a1-0004-4000-8000-000000000004',
  'a1a1a1a1-0005-4000-8000-000000000005'
);

-- ============================================================
-- 1. TEAM MEMBERS  (auth_user_id = null → not linked to a login)
-- ============================================================
insert into public.team_members (id, name, email, avatar, role) values
  ('a1a1a1a1-0001-4000-8000-000000000001', 'Sarah Chen',      'sarah@valiancemedia.com',   'SC', 'admin'),
  ('a1a1a1a1-0002-4000-8000-000000000002', 'Marcus Johnson',   'marcus@valiancemedia.com',  'MJ', 'member'),
  ('a1a1a1a1-0003-4000-8000-000000000003', 'Emily Rodriguez',  'emily@valiancemedia.com',   'ER', 'member'),
  ('a1a1a1a1-0004-4000-8000-000000000004', 'Jake Thompson',    'jake@valiancemedia.com',    'JT', 'member'),
  ('a1a1a1a1-0005-4000-8000-000000000005', 'Priya Patel',      'priya@valiancemedia.com',   'PP', 'guest');

-- ============================================================
-- 2. CONTACTS
-- ============================================================
insert into public.contacts (id, name, email, phone, company, notes, color) values
  ('b2b2b2b2-0001-4000-8000-000000000001', 'David Lawson',       'david@crestfinancial.com',    '(312) 555-0147', 'Crest Financial Group',   'CFO — prefers email. Budget-conscious but values quality.',                '#6366F1'),
  ('b2b2b2b2-0002-4000-8000-000000000002', 'Monica Reeves',      'monica@bloomwell.co',         '(415) 555-0293', 'Bloomwell Health',        'Head of Marketing. Very hands-on with creative direction.',               '#EC4899'),
  ('b2b2b2b2-0003-4000-8000-000000000003', 'Andre Williams',     'andre@neoforge.io',           '(646) 555-0184', 'NeoForge Technologies',   'CTO. Wants a modern web presence to attract Series B.',                   '#8B5CF6'),
  ('b2b2b2b2-0004-4000-8000-000000000004', 'Rachel Kim',         'rachel@solsticerealty.com',    '(213) 555-0362', 'Solstice Realty',         'Broker-owner. Needs IDX integration and lead capture.',                   '#F59E0B'),
  ('b2b2b2b2-0005-4000-8000-000000000005', 'Tom Nguyen',         'tom.nguyen@peakoutdoors.com', '(503) 555-0219', 'Peak Outdoor Co.',        'E-commerce director. Shopify Plus migration underway.',                   '#10B981'),
  ('b2b2b2b2-0006-4000-8000-000000000006', 'Lisa Martinez',      'lisa@crestfinancial.com',     '(312) 555-0188', 'Crest Financial Group',   'Marketing coordinator. Day-to-day contact for the Crest account.',        '#3B82F6'),
  ('b2b2b2b2-0007-4000-8000-000000000007', 'James Okafor',       'james@urbanpulse.co',         '(718) 555-0445', 'UrbanPulse Media',        'Co-founder. Interested in podcast website & brand package.',              '#EF4444'),
  ('b2b2b2b2-0008-4000-8000-000000000008', 'Samantha Brooks',    'sam@bloomwell.co',            '(415) 555-0301', 'Bloomwell Health',        'VP of Product. Technical contact for app integrations.',                  '#06B6D4'),
  ('b2b2b2b2-0009-4000-8000-000000000009', 'Nathan Cross',       'nathan@crosslegalbr.com',     '(202) 555-0177', 'Cross Legal Group',       'Managing partner. Wants a clean, professional site redesign.',            '#8B5CF6'),
  ('b2b2b2b2-0010-4000-8000-000000000010', 'Yuki Tanaka',        'yuki@kaizenfit.com',          '(808) 555-0233', 'Kaizen Fitness',          'Founder. Building a fitness app — needs branding and landing page.',      '#EF4444');

-- ============================================================
-- 3. PROJECTS
-- ============================================================
insert into public.projects (id, name, description, color, status, start_date, due_date) values
  ('c3c3c3c3-0001-4000-8000-000000000001', 'Crest Financial Rebrand',       'Full brand identity refresh — logo, guidelines, collateral, and website.',        '#6366F1', 'active',    '2026-01-15', '2026-04-30'),
  ('c3c3c3c3-0002-4000-8000-000000000002', 'Bloomwell Health App',          'Patient portal mobile app — React Native, auth, appointments, messaging.',       '#EC4899', 'active',    '2026-02-01', '2026-06-15'),
  ('c3c3c3c3-0003-4000-8000-000000000003', 'NeoForge Website',              'Marketing site for Series B push — Next.js, animations, CMS integration.',       '#8B5CF6', 'active',    '2026-01-20', '2026-03-31'),
  ('c3c3c3c3-0004-4000-8000-000000000004', 'Solstice Realty Platform',      'Property search with IDX, lead capture, and agent profiles.',                     '#F59E0B', 'active',    '2026-02-10', '2026-05-20'),
  ('c3c3c3c3-0005-4000-8000-000000000005', 'Peak Outdoor Shopify Migration','Migrate from legacy WooCommerce to Shopify Plus with custom theme.',              '#10B981', 'completed', '2025-10-01', '2026-01-15'),
  ('c3c3c3c3-0006-4000-8000-000000000006', 'UrbanPulse Brand Package',      'Logo, color system, typography, and podcast microsite.',                          '#EF4444', 'archived',  '2025-08-15', '2025-11-30');

-- Project members
insert into public.project_members (project_id, member_id) values
  -- Crest Financial Rebrand
  ('c3c3c3c3-0001-4000-8000-000000000001', 'a1a1a1a1-0001-4000-8000-000000000001'),
  ('c3c3c3c3-0001-4000-8000-000000000001', 'a1a1a1a1-0002-4000-8000-000000000002'),
  ('c3c3c3c3-0001-4000-8000-000000000001', 'a1a1a1a1-0003-4000-8000-000000000003'),
  -- Bloomwell Health App
  ('c3c3c3c3-0002-4000-8000-000000000002', 'a1a1a1a1-0001-4000-8000-000000000001'),
  ('c3c3c3c3-0002-4000-8000-000000000002', 'a1a1a1a1-0004-4000-8000-000000000004'),
  ('c3c3c3c3-0002-4000-8000-000000000002', 'a1a1a1a1-0003-4000-8000-000000000003'),
  -- NeoForge Website
  ('c3c3c3c3-0003-4000-8000-000000000003', 'a1a1a1a1-0002-4000-8000-000000000002'),
  ('c3c3c3c3-0003-4000-8000-000000000003', 'a1a1a1a1-0004-4000-8000-000000000004'),
  -- Solstice Realty Platform
  ('c3c3c3c3-0004-4000-8000-000000000004', 'a1a1a1a1-0001-4000-8000-000000000001'),
  ('c3c3c3c3-0004-4000-8000-000000000004', 'a1a1a1a1-0002-4000-8000-000000000002'),
  ('c3c3c3c3-0004-4000-8000-000000000004', 'a1a1a1a1-0004-4000-8000-000000000004'),
  -- Peak Outdoor (completed)
  ('c3c3c3c3-0005-4000-8000-000000000005', 'a1a1a1a1-0003-4000-8000-000000000003'),
  ('c3c3c3c3-0005-4000-8000-000000000005', 'a1a1a1a1-0004-4000-8000-000000000004'),
  -- UrbanPulse (archived)
  ('c3c3c3c3-0006-4000-8000-000000000006', 'a1a1a1a1-0002-4000-8000-000000000002'),
  ('c3c3c3c3-0006-4000-8000-000000000006', 'a1a1a1a1-0005-4000-8000-000000000005');

-- ============================================================
-- 4. PROJECT CONTACTS
-- ============================================================
insert into public.project_contacts (id, project_id, contact_id, role, custom_role, is_primary_client) values
  -- Crest Financial Rebrand
  ('d4d4d4d4-0001-4000-8000-000000000001', 'c3c3c3c3-0001-4000-8000-000000000001', 'b2b2b2b2-0001-4000-8000-000000000001', 'Client',            null,              true),
  ('d4d4d4d4-0002-4000-8000-000000000002', 'c3c3c3c3-0001-4000-8000-000000000001', 'b2b2b2b2-0006-4000-8000-000000000006', 'Primary Contact',   null,              false),
  -- Bloomwell Health App
  ('d4d4d4d4-0003-4000-8000-000000000003', 'c3c3c3c3-0002-4000-8000-000000000002', 'b2b2b2b2-0002-4000-8000-000000000002', 'Client',            null,              true),
  ('d4d4d4d4-0004-4000-8000-000000000004', 'c3c3c3c3-0002-4000-8000-000000000002', 'b2b2b2b2-0008-4000-8000-000000000008', 'Technical Contact', null,              false),
  -- NeoForge Website
  ('d4d4d4d4-0005-4000-8000-000000000005', 'c3c3c3c3-0003-4000-8000-000000000003', 'b2b2b2b2-0003-4000-8000-000000000003', 'Client',            null,              true),
  -- Solstice Realty Platform
  ('d4d4d4d4-0006-4000-8000-000000000006', 'c3c3c3c3-0004-4000-8000-000000000004', 'b2b2b2b2-0004-4000-8000-000000000004', 'Client',            null,              true),
  -- Peak Outdoor (completed)
  ('d4d4d4d4-0007-4000-8000-000000000007', 'c3c3c3c3-0005-4000-8000-000000000005', 'b2b2b2b2-0005-4000-8000-000000000005', 'Client',            null,              true),
  -- UrbanPulse (archived)
  ('d4d4d4d4-0008-4000-8000-000000000008', 'c3c3c3c3-0006-4000-8000-000000000006', 'b2b2b2b2-0007-4000-8000-000000000007', 'Client',            null,              true);

-- ============================================================
-- 5. TASKS  (spread across projects, varied statuses & priorities)
-- ============================================================
insert into public.tasks (id, project_id, title, description, status, priority, due_date, tags) values
  -- === Crest Financial Rebrand (7 tasks) ===
  ('e5e5e5e5-0001-4000-8000-000000000001', 'c3c3c3c3-0001-4000-8000-000000000001', 'Discovery & brand audit',              'Review current brand assets, competitor analysis, and stakeholder interviews.',            'done',        'high',   '2026-01-31', '{research,branding}'),
  ('e5e5e5e5-0002-4000-8000-000000000002', 'c3c3c3c3-0001-4000-8000-000000000001', 'Logo concepts — round 1',              'Present 3 logo directions based on discovery findings.',                                  'done',        'high',   '2026-02-14', '{design,branding}'),
  ('e5e5e5e5-0003-4000-8000-000000000003', 'c3c3c3c3-0001-4000-8000-000000000001', 'Brand guidelines document',             'Colors, typography, spacing, usage rules, do/don''t examples.',                           'in_progress', 'high',   '2026-03-07', '{design,branding}'),
  ('e5e5e5e5-0004-4000-8000-000000000004', 'c3c3c3c3-0001-4000-8000-000000000001', 'Business card & letterhead design',     'Print collateral matching new brand system.',                                             'todo',        'medium', '2026-03-21', '{design,print}'),
  ('e5e5e5e5-0005-4000-8000-000000000005', 'c3c3c3c3-0001-4000-8000-000000000001', 'Website wireframes',                    'Low-fi wireframes for homepage, about, services, contact, and blog.',                     'in_progress', 'high',   '2026-03-14', '{design,web}'),
  ('e5e5e5e5-0006-4000-8000-000000000006', 'c3c3c3c3-0001-4000-8000-000000000001', 'Website development — Next.js',         'Build out approved wireframes in Next.js with Tailwind and Sanity CMS.',                  'todo',        'high',   '2026-04-15', '{development,web}'),
  ('e5e5e5e5-0007-4000-8000-000000000007', 'c3c3c3c3-0001-4000-8000-000000000001', 'Final QA & launch',                     'Cross-browser testing, SEO audit, performance check, DNS cutover.',                       'todo',        'urgent', '2026-04-28', '{qa,web}'),

  -- === Bloomwell Health App (6 tasks) ===
  ('e5e5e5e5-0008-4000-8000-000000000008', 'c3c3c3c3-0002-4000-8000-000000000002', 'User flow & IA mapping',               'Map patient flows: sign-up, book appointment, view records, message doctor.',              'done',        'high',   '2026-02-14', '{research,ux}'),
  ('e5e5e5e5-0009-4000-8000-000000000009', 'c3c3c3c3-0002-4000-8000-000000000002', 'UI kit & design system',               'Component library in Figma — buttons, inputs, cards, navigation, etc.',                   'in_review',   'high',   '2026-02-28', '{design,mobile}'),
  ('e5e5e5e5-0010-4000-8000-000000000010', 'c3c3c3c3-0002-4000-8000-000000000002', 'Auth & onboarding screens',            'Email/password + SSO login, HIPAA consent, profile setup.',                                'in_progress', 'urgent', '2026-03-15', '{development,mobile}'),
  ('e5e5e5e5-0011-4000-8000-000000000011', 'c3c3c3c3-0002-4000-8000-000000000002', 'Appointment booking module',           'Calendar picker, provider search, confirmation & reminders.',                              'todo',        'high',   '2026-04-01', '{development,mobile}'),
  ('e5e5e5e5-0012-4000-8000-000000000012', 'c3c3c3c3-0002-4000-8000-000000000002', 'Secure messaging implementation',      'HIPAA-compliant chat between patient and care team.',                                      'todo',        'medium', '2026-04-30', '{development,mobile}'),
  ('e5e5e5e5-0013-4000-8000-000000000013', 'c3c3c3c3-0002-4000-8000-000000000002', 'Beta testing & feedback',              'Distribute TestFlight build to 20 pilot users, collect feedback.',                         'todo',        'medium', '2026-05-30', '{qa,mobile}'),

  -- === NeoForge Website (5 tasks) ===
  ('e5e5e5e5-0014-4000-8000-000000000014', 'c3c3c3c3-0003-4000-8000-000000000003', 'Content strategy & copywriting',       'Messaging framework, hero copy, feature descriptions, about page.',                        'done',        'medium', '2026-02-07', '{content,web}'),
  ('e5e5e5e5-0015-4000-8000-000000000015', 'c3c3c3c3-0003-4000-8000-000000000003', 'Homepage & landing page design',       'High-fi designs with scroll animations and 3D product renders.',                           'in_review',   'high',   '2026-02-21', '{design,web}'),
  ('e5e5e5e5-0016-4000-8000-000000000016', 'c3c3c3c3-0003-4000-8000-000000000003', 'Inner pages design',                   'About, pricing, blog, docs, and contact pages.',                                          'in_progress', 'medium', '2026-03-07', '{design,web}'),
  ('e5e5e5e5-0017-4000-8000-000000000017', 'c3c3c3c3-0003-4000-8000-000000000003', 'Frontend development — Next.js',       'Build with Framer Motion animations, MDX blog, and Sanity CMS.',                          'todo',        'high',   '2026-03-21', '{development,web}'),
  ('e5e5e5e5-0018-4000-8000-000000000018', 'c3c3c3c3-0003-4000-8000-000000000003', 'SEO & analytics setup',                'Structured data, sitemap, GA4, Search Console, and Hotjar.',                              'todo',        'low',    '2026-03-28', '{seo,web}'),

  -- === Solstice Realty Platform (5 tasks) ===
  ('e5e5e5e5-0019-4000-8000-000000000019', 'c3c3c3c3-0004-4000-8000-000000000004', 'IDX/MLS integration research',         'Evaluate IDX providers (iHomeFinder, Showcase IDX) for React compatibility.',              'in_progress', 'urgent', '2026-02-21', '{research,development}'),
  ('e5e5e5e5-0020-4000-8000-000000000020', 'c3c3c3c3-0004-4000-8000-000000000004', 'Property search UI',                   'Map view, filters (price, beds, baths, type), saved searches.',                            'todo',        'high',   '2026-03-15', '{design,development}'),
  ('e5e5e5e5-0021-4000-8000-000000000021', 'c3c3c3c3-0004-4000-8000-000000000004', 'Agent profile pages',                  'Bio, listings, reviews, contact form per agent.',                                         'todo',        'medium', '2026-03-30', '{design,web}'),
  ('e5e5e5e5-0022-4000-8000-000000000022', 'c3c3c3c3-0004-4000-8000-000000000004', 'Lead capture & CRM integration',       'Contact forms, property inquiry, Zapier to HubSpot.',                                     'todo',        'high',   '2026-04-15', '{development,integration}'),
  ('e5e5e5e5-0023-4000-8000-000000000023', 'c3c3c3c3-0004-4000-8000-000000000004', 'Staging deploy & client review',       'Deploy to Vercel preview, walk Rachel through the full site.',                             'todo',        'medium', '2026-05-01', '{qa,web}'),

  -- === Peak Outdoor (completed — all done) ===
  ('e5e5e5e5-0024-4000-8000-000000000024', 'c3c3c3c3-0005-4000-8000-000000000005', 'Shopify Plus theme development',       'Custom Liquid theme with mega-menu, product filtering, and quick-view.',                   'done',        'high',   '2025-12-01', '{development,shopify}'),
  ('e5e5e5e5-0025-4000-8000-000000000025', 'c3c3c3c3-0005-4000-8000-000000000005', 'Product data migration',               'Migrate 2,400 SKUs from WooCommerce with images and variants.',                           'done',        'urgent', '2025-12-15', '{data,shopify}'),
  ('e5e5e5e5-0026-4000-8000-000000000026', 'c3c3c3c3-0005-4000-8000-000000000005', 'Checkout & payments testing',          'Stripe, PayPal, Apple Pay. Test all discount code scenarios.',                             'done',        'high',   '2026-01-05', '{qa,shopify}');

-- Task assignees
insert into public.task_assignees (task_id, member_id) values
  -- Crest Financial
  ('e5e5e5e5-0001-4000-8000-000000000001', 'a1a1a1a1-0001-4000-8000-000000000001'),
  ('e5e5e5e5-0002-4000-8000-000000000002', 'a1a1a1a1-0003-4000-8000-000000000003'),
  ('e5e5e5e5-0003-4000-8000-000000000003', 'a1a1a1a1-0003-4000-8000-000000000003'),
  ('e5e5e5e5-0004-4000-8000-000000000004', 'a1a1a1a1-0003-4000-8000-000000000003'),
  ('e5e5e5e5-0005-4000-8000-000000000005', 'a1a1a1a1-0001-4000-8000-000000000001'),
  ('e5e5e5e5-0005-4000-8000-000000000005', 'a1a1a1a1-0002-4000-8000-000000000002'),
  ('e5e5e5e5-0006-4000-8000-000000000006', 'a1a1a1a1-0002-4000-8000-000000000002'),
  ('e5e5e5e5-0007-4000-8000-000000000007', 'a1a1a1a1-0001-4000-8000-000000000001'),
  ('e5e5e5e5-0007-4000-8000-000000000007', 'a1a1a1a1-0002-4000-8000-000000000002'),
  -- Bloomwell
  ('e5e5e5e5-0008-4000-8000-000000000008', 'a1a1a1a1-0001-4000-8000-000000000001'),
  ('e5e5e5e5-0009-4000-8000-000000000009', 'a1a1a1a1-0003-4000-8000-000000000003'),
  ('e5e5e5e5-0010-4000-8000-000000000010', 'a1a1a1a1-0004-4000-8000-000000000004'),
  ('e5e5e5e5-0010-4000-8000-000000000010', 'a1a1a1a1-0001-4000-8000-000000000001'),
  ('e5e5e5e5-0011-4000-8000-000000000011', 'a1a1a1a1-0004-4000-8000-000000000004'),
  ('e5e5e5e5-0012-4000-8000-000000000012', 'a1a1a1a1-0004-4000-8000-000000000004'),
  ('e5e5e5e5-0013-4000-8000-000000000013', 'a1a1a1a1-0001-4000-8000-000000000001'),
  ('e5e5e5e5-0013-4000-8000-000000000013', 'a1a1a1a1-0003-4000-8000-000000000003'),
  -- NeoForge
  ('e5e5e5e5-0014-4000-8000-000000000014', 'a1a1a1a1-0002-4000-8000-000000000002'),
  ('e5e5e5e5-0015-4000-8000-000000000015', 'a1a1a1a1-0002-4000-8000-000000000002'),
  ('e5e5e5e5-0015-4000-8000-000000000015', 'a1a1a1a1-0004-4000-8000-000000000004'),
  ('e5e5e5e5-0016-4000-8000-000000000016', 'a1a1a1a1-0002-4000-8000-000000000002'),
  ('e5e5e5e5-0017-4000-8000-000000000017', 'a1a1a1a1-0004-4000-8000-000000000004'),
  ('e5e5e5e5-0018-4000-8000-000000000018', 'a1a1a1a1-0002-4000-8000-000000000002'),
  -- Solstice Realty
  ('e5e5e5e5-0019-4000-8000-000000000019', 'a1a1a1a1-0004-4000-8000-000000000004'),
  ('e5e5e5e5-0019-4000-8000-000000000019', 'a1a1a1a1-0001-4000-8000-000000000001'),
  ('e5e5e5e5-0020-4000-8000-000000000020', 'a1a1a1a1-0002-4000-8000-000000000002'),
  ('e5e5e5e5-0020-4000-8000-000000000020', 'a1a1a1a1-0004-4000-8000-000000000004'),
  ('e5e5e5e5-0021-4000-8000-000000000021', 'a1a1a1a1-0002-4000-8000-000000000002'),
  ('e5e5e5e5-0022-4000-8000-000000000022', 'a1a1a1a1-0001-4000-8000-000000000001'),
  ('e5e5e5e5-0022-4000-8000-000000000022', 'a1a1a1a1-0004-4000-8000-000000000004'),
  ('e5e5e5e5-0023-4000-8000-000000000023', 'a1a1a1a1-0001-4000-8000-000000000001'),
  -- Peak Outdoor (completed)
  ('e5e5e5e5-0024-4000-8000-000000000024', 'a1a1a1a1-0004-4000-8000-000000000004'),
  ('e5e5e5e5-0025-4000-8000-000000000025', 'a1a1a1a1-0003-4000-8000-000000000003'),
  ('e5e5e5e5-0026-4000-8000-000000000026', 'a1a1a1a1-0003-4000-8000-000000000003'),
  ('e5e5e5e5-0026-4000-8000-000000000026', 'a1a1a1a1-0004-4000-8000-000000000004');

-- ============================================================
-- 6. SUBTASKS
-- ============================================================
insert into public.task_subtasks (id, task_id, title, completed, sort_order) values
  -- Brand guidelines document subtasks
  ('f6f6f6f6-0001-4000-8000-000000000001', 'e5e5e5e5-0003-4000-8000-000000000003', 'Define primary & secondary color palette',  true,  0),
  ('f6f6f6f6-0002-4000-8000-000000000002', 'e5e5e5e5-0003-4000-8000-000000000003', 'Select brand typefaces (heading + body)',    true,  1),
  ('f6f6f6f6-0003-4000-8000-000000000003', 'e5e5e5e5-0003-4000-8000-000000000003', 'Write logo usage rules & clear space',      false, 2),
  ('f6f6f6f6-0004-4000-8000-000000000004', 'e5e5e5e5-0003-4000-8000-000000000003', 'Create do / don''t examples page',          false, 3),
  ('f6f6f6f6-0005-4000-8000-000000000005', 'e5e5e5e5-0003-4000-8000-000000000003', 'Photography & iconography style guide',     false, 4),

  -- Website wireframes subtasks
  ('f6f6f6f6-0006-4000-8000-000000000006', 'e5e5e5e5-0005-4000-8000-000000000005', 'Homepage wireframe',                        true,  0),
  ('f6f6f6f6-0007-4000-8000-000000000007', 'e5e5e5e5-0005-4000-8000-000000000005', 'About page wireframe',                      true,  1),
  ('f6f6f6f6-0008-4000-8000-000000000008', 'e5e5e5e5-0005-4000-8000-000000000005', 'Services page wireframe',                   false, 2),
  ('f6f6f6f6-0009-4000-8000-000000000009', 'e5e5e5e5-0005-4000-8000-000000000005', 'Blog listing + post wireframe',             false, 3),
  ('f6f6f6f6-0010-4000-8000-000000000010', 'e5e5e5e5-0005-4000-8000-000000000005', 'Contact page wireframe',                    false, 4),

  -- UI kit & design system subtasks
  ('f6f6f6f6-0011-4000-8000-000000000011', 'e5e5e5e5-0009-4000-8000-000000000009', 'Button & input components',                 true,  0),
  ('f6f6f6f6-0012-4000-8000-000000000012', 'e5e5e5e5-0009-4000-8000-000000000009', 'Card & list components',                    true,  1),
  ('f6f6f6f6-0013-4000-8000-000000000013', 'e5e5e5e5-0009-4000-8000-000000000009', 'Navigation patterns (tab bar, drawer)',      true,  2),
  ('f6f6f6f6-0014-4000-8000-000000000014', 'e5e5e5e5-0009-4000-8000-000000000009', 'Dark mode variants',                        false, 3),

  -- Auth & onboarding subtasks
  ('f6f6f6f6-0015-4000-8000-000000000015', 'e5e5e5e5-0010-4000-8000-000000000010', 'Email/password login flow',                 true,  0),
  ('f6f6f6f6-0016-4000-8000-000000000016', 'e5e5e5e5-0010-4000-8000-000000000010', 'Google SSO integration',                    false, 1),
  ('f6f6f6f6-0017-4000-8000-000000000017', 'e5e5e5e5-0010-4000-8000-000000000010', 'HIPAA consent screen',                      false, 2),
  ('f6f6f6f6-0018-4000-8000-000000000018', 'e5e5e5e5-0010-4000-8000-000000000010', 'Profile setup wizard',                      false, 3),

  -- IDX research subtasks
  ('f6f6f6f6-0019-4000-8000-000000000019', 'e5e5e5e5-0019-4000-8000-000000000019', 'Evaluate iHomeFinder API',                  true,  0),
  ('f6f6f6f6-0020-4000-8000-000000000020', 'e5e5e5e5-0019-4000-8000-000000000019', 'Evaluate Showcase IDX',                     true,  1),
  ('f6f6f6f6-0021-4000-8000-000000000021', 'e5e5e5e5-0019-4000-8000-000000000019', 'Cost comparison spreadsheet',               false, 2),
  ('f6f6f6f6-0022-4000-8000-000000000022', 'e5e5e5e5-0019-4000-8000-000000000019', 'Prototype with chosen provider',            false, 3),

  -- Shopify theme (completed)
  ('f6f6f6f6-0023-4000-8000-000000000023', 'e5e5e5e5-0024-4000-8000-000000000024', 'Mega-menu with collections',                true,  0),
  ('f6f6f6f6-0024-4000-8000-000000000024', 'e5e5e5e5-0024-4000-8000-000000000024', 'Product filtering & sorting',               true,  1),
  ('f6f6f6f6-0025-4000-8000-000000000025', 'e5e5e5e5-0024-4000-8000-000000000024', 'Quick-view modal',                          true,  2),
  ('f6f6f6f6-0026-4000-8000-000000000026', 'e5e5e5e5-0024-4000-8000-000000000024', 'Mobile responsive pass',                    true,  3);

-- ============================================================
-- 7. COMMENTS
-- ============================================================
insert into public.task_comments (id, task_id, user_id, text, created_at) values
  -- Brand guidelines
  ('aabbccdd-0001-4000-8000-000000000001', 'e5e5e5e5-0003-4000-8000-000000000003', 'a1a1a1a1-0001-4000-8000-000000000001', 'David approved the color palette in yesterday''s call. Moving to typography next.',           now() - interval '3 days'),
  ('aabbccdd-0002-4000-8000-000000000002', 'e5e5e5e5-0003-4000-8000-000000000003', 'a1a1a1a1-0003-4000-8000-000000000003', 'I''m leaning toward Inter for body and Fraunces for headings. Sending samples today.',        now() - interval '2 days'),
  ('aabbccdd-0003-4000-8000-000000000003', 'e5e5e5e5-0003-4000-8000-000000000003', 'a1a1a1a1-0001-4000-8000-000000000001', 'Love the Fraunces pairing. Let''s lock that in and move to the usage rules section.',         now() - interval '1 day'),

  -- Website wireframes
  ('aabbccdd-0004-4000-8000-000000000004', 'e5e5e5e5-0005-4000-8000-000000000005', 'a1a1a1a1-0002-4000-8000-000000000002', 'Homepage wireframe is looking solid. Lisa from Crest had some feedback on the hero section.',  now() - interval '5 days'),
  ('aabbccdd-0005-4000-8000-000000000005', 'e5e5e5e5-0005-4000-8000-000000000005', 'a1a1a1a1-0001-4000-8000-000000000001', 'Updated based on Lisa''s notes — moved the value prop above the fold.',                       now() - interval '4 days'),

  -- UI kit
  ('aabbccdd-0006-4000-8000-000000000006', 'e5e5e5e5-0009-4000-8000-000000000009', 'a1a1a1a1-0003-4000-8000-000000000003', 'All core components done. Just need dark mode variants before handoff.',                      now() - interval '1 day'),
  ('aabbccdd-0007-4000-8000-000000000007', 'e5e5e5e5-0009-4000-8000-000000000009', 'a1a1a1a1-0001-4000-8000-000000000001', 'Samantha from Bloomwell wants to review before we finalize. Scheduling for Thursday.',        now() - interval '12 hours'),

  -- Auth & onboarding
  ('aabbccdd-0008-4000-8000-000000000008', 'e5e5e5e5-0010-4000-8000-000000000010', 'a1a1a1a1-0004-4000-8000-000000000004', 'Email/password flow is done and tested. Starting on Google SSO tomorrow.',                    now() - interval '2 days'),
  ('aabbccdd-0009-4000-8000-000000000009', 'e5e5e5e5-0010-4000-8000-000000000010', 'a1a1a1a1-0001-4000-8000-000000000001', 'Make sure the HIPAA consent copy gets legal review before we ship.',                          now() - interval '1 day'),

  -- NeoForge homepage design
  ('aabbccdd-0010-4000-8000-000000000010', 'e5e5e5e5-0015-4000-8000-000000000015', 'a1a1a1a1-0002-4000-8000-000000000002', 'Andre loved the 3D render concept. Wants us to push the animations further.',                 now() - interval '3 days'),
  ('aabbccdd-0011-4000-8000-000000000011', 'e5e5e5e5-0015-4000-8000-000000000015', 'a1a1a1a1-0004-4000-8000-000000000004', 'Built a quick Framer Motion prototype for the hero section. Will share the link today.',      now() - interval '2 days'),

  -- IDX research
  ('aabbccdd-0012-4000-8000-000000000012', 'e5e5e5e5-0019-4000-8000-000000000019', 'a1a1a1a1-0004-4000-8000-000000000004', 'iHomeFinder has the better API but Showcase IDX is way cheaper. Writing up the comparison.', now() - interval '1 day'),
  ('aabbccdd-0013-4000-8000-000000000013', 'e5e5e5e5-0019-4000-8000-000000000019', 'a1a1a1a1-0001-4000-8000-000000000001', 'Let''s go with iHomeFinder — Rachel''s budget can handle it and the DX is miles better.',     now() - interval '6 hours'),

  -- Shopify theme (completed project)
  ('aabbccdd-0014-4000-8000-000000000014', 'e5e5e5e5-0024-4000-8000-000000000024', 'a1a1a1a1-0004-4000-8000-000000000004', 'Theme is live! Tom is really happy with the mega-menu.',                                      now() - interval '35 days'),
  ('aabbccdd-0015-4000-8000-000000000015', 'e5e5e5e5-0026-4000-8000-000000000026', 'a1a1a1a1-0003-4000-8000-000000000003', 'All payment methods verified. Discount codes working across all scenarios.',                  now() - interval '30 days');

-- ============================================================
-- 8. LEADS
-- ============================================================
insert into public.leads (id, name, email, phone, company, source, status, value, notes, assigned_to, contact_id) values
  ('77770001-0001-4000-8000-000000000001', 'Nathan Cross',       'nathan@crosslegalbr.com',      '(202) 555-0177', 'Cross Legal Group',        'referral',       'qualified', 18000.00, 'Referred by David Lawson. Wants a clean, professional site redesign. Budget ~$18K.',               'a1a1a1a1-0001-4000-8000-000000000001', 'b2b2b2b2-0009-4000-8000-000000000009'),
  ('77770001-0002-4000-8000-000000000002', 'Yuki Tanaka',        'yuki@kaizenfit.com',           '(808) 555-0233', 'Kaizen Fitness',           'website',        'proposal',  25000.00, 'Filled out the website form. Building a fitness app — needs branding + landing page. Sent proposal.','a1a1a1a1-0003-4000-8000-000000000003', 'b2b2b2b2-0010-4000-8000-000000000010'),
  ('77770001-0003-4000-8000-000000000003', 'Olivia Grant',       'olivia@sunnysidecafe.com',     '(541) 555-0198', 'Sunnyside Cafe',           'social',         'contacted', 5000.00,  'Reached out via Instagram DM. Looking for a simple website + online ordering.',                     'a1a1a1a1-0002-4000-8000-000000000002', null),
  ('77770001-0004-4000-8000-000000000004', 'Marcus Lee',         'mlee@velocityauto.com',        '(469) 555-0411', 'Velocity Auto Group',      'cold_outreach',  'new',       35000.00, 'Multi-location dealership. Could be a big account — website + inventory system.',                   null,                                    null),
  ('77770001-0005-4000-8000-000000000005', 'Diana Frost',        'diana@frostinteriors.com',     '(917) 555-0266', 'Frost Interiors',          'event',          'new',       12000.00, 'Met at the NYC Design Week mixer. Portfolio website for her interior design firm.',                 null,                                    null),
  ('77770001-0006-4000-8000-000000000006', 'Kevin Park',         'kevin@greenleafnursery.com',   '(360) 555-0344', 'Greenleaf Nursery',        'referral',       'contacted', 8000.00,  'Referred by Tom at Peak Outdoor. E-commerce site for plants and garden supplies.',                  'a1a1a1a1-0004-4000-8000-000000000004', null),
  ('77770001-0007-4000-8000-000000000007', 'Amanda Chen',        'achen@brightwaveai.com',       '(650) 555-0122', 'BrightWave AI',            'website',        'qualified', 45000.00, 'AI startup. Needs full brand + website before their demo day in May.',                              'a1a1a1a1-0001-4000-8000-000000000001', null),
  ('77770001-0008-4000-8000-000000000008', 'Robert Simmons',     'rob@heartlandbrewing.com',     '(614) 555-0289', 'Heartland Brewing Co.',    'social',         'lost',      15000.00, 'Was interested in a website redesign but went with a cheaper local agency.',                        'a1a1a1a1-0002-4000-8000-000000000002', null);

-- ============================================================
-- 9. ACTIVITIES
-- ============================================================
insert into public.activities (id, type, entity_id, entity_type, user_id, description, metadata, created_at) values
  ('99990001-0001-4000-8000-000000000001', 'task_completed',  'e5e5e5e5-0001-4000-8000-000000000001', 'task',    'a1a1a1a1-0001-4000-8000-000000000001', 'Completed "Discovery & brand audit"',              '{"project": "Crest Financial Rebrand"}',   now() - interval '20 days'),
  ('99990001-0002-4000-8000-000000000002', 'task_completed',  'e5e5e5e5-0002-4000-8000-000000000002', 'task',    'a1a1a1a1-0003-4000-8000-000000000003', 'Completed "Logo concepts — round 1"',              '{"project": "Crest Financial Rebrand"}',   now() - interval '14 days'),
  ('99990001-0003-4000-8000-000000000003', 'project_updated', 'c3c3c3c3-0005-4000-8000-000000000005', 'project', 'a1a1a1a1-0003-4000-8000-000000000003', 'Marked "Peak Outdoor Shopify Migration" as completed', '{}',                                  now() - interval '34 days'),
  ('99990001-0004-4000-8000-000000000004', 'task_created',    'e5e5e5e5-0010-4000-8000-000000000010', 'task',    'a1a1a1a1-0001-4000-8000-000000000001', 'Created "Auth & onboarding screens"',               '{"project": "Bloomwell Health App"}',      now() - interval '10 days'),
  ('99990001-0005-4000-8000-000000000005', 'comment_added',   'aabbccdd-0010-4000-8000-000000000010', 'comment', 'a1a1a1a1-0002-4000-8000-000000000002', 'Commented on "Homepage & landing page design"',    '{"task": "Homepage & landing page design"}', now() - interval '3 days'),
  ('99990001-0006-4000-8000-000000000006', 'task_updated',    'e5e5e5e5-0009-4000-8000-000000000009', 'task',    'a1a1a1a1-0003-4000-8000-000000000003', 'Moved "UI kit & design system" to In Review',      '{"project": "Bloomwell Health App"}',      now() - interval '1 day'),
  ('99990001-0007-4000-8000-000000000007', 'task_completed',  'e5e5e5e5-0008-4000-8000-000000000008', 'task',    'a1a1a1a1-0001-4000-8000-000000000001', 'Completed "User flow & IA mapping"',                '{"project": "Bloomwell Health App"}',      now() - interval '7 days'),
  ('99990001-0008-4000-8000-000000000008', 'task_completed',  'e5e5e5e5-0014-4000-8000-000000000014', 'task',    'a1a1a1a1-0002-4000-8000-000000000002', 'Completed "Content strategy & copywriting"',        '{"project": "NeoForge Website"}',          now() - interval '12 days'),
  ('99990001-0009-4000-8000-000000000009', 'member_added',    'a1a1a1a1-0005-4000-8000-000000000005', 'member',  'a1a1a1a1-0001-4000-8000-000000000001', 'Added Priya Patel to the team',                     '{}',                                       now() - interval '45 days'),
  ('99990001-0010-4000-8000-000000000010', 'task_created',    'e5e5e5e5-0019-4000-8000-000000000019', 'task',    'a1a1a1a1-0001-4000-8000-000000000001', 'Created "IDX/MLS integration research"',             '{"project": "Solstice Realty Platform"}',  now() - interval '5 days'),
  ('99990001-0011-4000-8000-000000000011', 'comment_added',   'aabbccdd-0013-4000-8000-000000000013', 'comment', 'a1a1a1a1-0001-4000-8000-000000000001', 'Commented on "IDX/MLS integration research"',       '{"task": "IDX/MLS integration research"}', now() - interval '6 hours'),
  ('99990001-0012-4000-8000-000000000012', 'task_completed',  'e5e5e5e5-0024-4000-8000-000000000024', 'task',    'a1a1a1a1-0004-4000-8000-000000000004', 'Completed "Shopify Plus theme development"',        '{"project": "Peak Outdoor Shopify Migration"}', now() - interval '50 days');

-- ============================================================
-- 10. ENTITY FILES (internal attachments for leads, projects, contacts)
-- ============================================================
insert into public.entity_files (id, entity_type, entity_id, name, file_url, file_size, mime_type, uploaded_by, created_at, updated_at) values
  ('ef000001-0001-4000-8000-000000000001', 'lead',    '77770001-0001-4000-8000-000000000001', 'Cross-Legal-NDA.pdf',             '#', 145000,  'application/pdf',       'a1a1a1a1-0001-4000-8000-000000000001', now() - interval '8 days',  now() - interval '8 days'),
  ('ef000001-0002-4000-8000-000000000002', 'lead',    '77770001-0002-4000-8000-000000000002', 'Kaizen-Brand-Brief.docx',         '#', 320000,  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a1a1a1a1-0003-4000-8000-000000000003', now() - interval '6 days',  now() - interval '6 days'),
  ('ef000001-0003-4000-8000-000000000003', 'project', 'c3c3c3c3-0001-4000-8000-000000000001', 'Meeting-Notes-Kickoff.pdf',       '#', 89000,   'application/pdf',       'a1a1a1a1-0001-4000-8000-000000000001', now() - interval '30 days', now() - interval '30 days'),
  ('ef000001-0004-4000-8000-000000000004', 'project', 'c3c3c3c3-0002-4000-8000-000000000002', 'HIPAA-Compliance-Checklist.xlsx', '#', 52000,   'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'a1a1a1a1-0004-4000-8000-000000000004', now() - interval '12 days', now() - interval '12 days'),
  ('ef000001-0005-4000-8000-000000000005', 'contact', 'b2b2b2b2-0001-4000-8000-000000000001', 'Crest-MSA-Signed.pdf',           '#', 210000,  'application/pdf',       'a1a1a1a1-0001-4000-8000-000000000001', now() - interval '25 days', now() - interval '25 days'),
  ('ef000001-0006-4000-8000-000000000006', 'contact', 'b2b2b2b2-0003-4000-8000-000000000003', 'NeoForge-Brand-Moodboard.png',   '#', 4800000, 'image/png',             'a1a1a1a1-0002-4000-8000-000000000002', now() - interval '20 days', now() - interval '20 days');

-- ============================================================
-- 11. TIME ENTRIES (start/stop timer tracking)
-- ============================================================
insert into public.project_time_entries (id, project_id, member_id, start_time, end_time, description, created_at, updated_at) values
  ('te000001-0001-4000-8000-000000000001', 'c3c3c3c3-0001-4000-8000-000000000001', 'a1a1a1a1-0001-4000-8000-000000000001', (current_date - 2) + time '09:00', (current_date - 2) + time '12:30', 'Brand strategy workshop',        now() - interval '2 days', now() - interval '2 days'),
  ('te000001-0002-4000-8000-000000000002', 'c3c3c3c3-0001-4000-8000-000000000001', 'a1a1a1a1-0002-4000-8000-000000000002', (current_date - 3) + time '10:00', (current_date - 3) + time '15:00', 'Logo concept exploration',       now() - interval '3 days', now() - interval '3 days'),
  ('te000001-0003-4000-8000-000000000003', 'c3c3c3c3-0001-4000-8000-000000000001', 'a1a1a1a1-0003-4000-8000-000000000003', (current_date - 5) + time '13:00', (current_date - 5) + time '15:30', 'Typography and color system',    now() - interval '5 days', now() - interval '5 days'),
  ('te000001-0004-4000-8000-000000000004', 'c3c3c3c3-0001-4000-8000-000000000001', 'a1a1a1a1-0001-4000-8000-000000000001', (current_date - 6) + time '14:00', (current_date - 6) + time '15:30', 'Client feedback review',         now() - interval '6 days', now() - interval '6 days'),
  ('te000001-0005-4000-8000-000000000005', 'c3c3c3c3-0002-4000-8000-000000000002', 'a1a1a1a1-0004-4000-8000-000000000004', (current_date - 1) + time '09:00', (current_date - 1) + time '15:00', 'Homepage wireframes',            now() - interval '1 day',  now() - interval '1 day'),
  ('te000001-0006-4000-8000-000000000006', 'c3c3c3c3-0002-4000-8000-000000000002', 'a1a1a1a1-0003-4000-8000-000000000003', (current_date - 2) + time '10:00', (current_date - 2) + time '14:00', 'Design review meeting',          now() - interval '2 days', now() - interval '2 days'),
  ('te000001-0007-4000-8000-000000000007', 'c3c3c3c3-0002-4000-8000-000000000002', 'a1a1a1a1-0001-4000-8000-000000000001', (current_date - 4) + time '11:00', (current_date - 4) + time '13:00', 'Sprint planning and task setup', now() - interval '4 days', now() - interval '4 days'),
  ('te000001-0008-4000-8000-000000000008', 'c3c3c3c3-0002-4000-8000-000000000002', 'a1a1a1a1-0004-4000-8000-000000000004', (current_date - 7) + time '08:30', (current_date - 7) + time '16:00', 'Auth flow implementation',       now() - interval '7 days', now() - interval '7 days');
