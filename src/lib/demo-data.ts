import type { TeamMember, Contact, Project, ProjectContact, Task, Lead, LeadInteraction, LeadProposal, LeadField, LeadContact, Activity, PortalSettings, PortalUpdate, PortalUpdateAttachment, EntityFile, TimeEntry, Notification, ProjectGoal, TaskSuggestion, AgentActivity, ProjectInvoice, ClientCommunication, PortalAnalyticsResponse, PortalSessionSummary } from './types';
import { DEFAULT_SECTION_ORDER } from './types';
import { siteConfig } from '@/site-config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 3_600_000).toISOString();
}

// ---------------------------------------------------------------------------
// Constants — used by auth-context to set the fake session
// ---------------------------------------------------------------------------
export const DEMO_USER_ID = 'demo-user-0000-0000-000000000000';
export const DEMO_ADMIN_TEAM_MEMBER_ID = 'a1a1a1a1-0001-4000-8000-000000000001';

// ---------------------------------------------------------------------------
// 1. TEAM MEMBERS
// ---------------------------------------------------------------------------
export const demoTeam: TeamMember[] = [
  { id: 'a1a1a1a1-0001-4000-8000-000000000001', auth_user_id: DEMO_USER_ID, name: 'Sarah Chen',     email: 'sarah@valiancemedia.com',  avatar: '', role: 'owner',  timezone: 'America/Phoenix' },
  { id: 'a1a1a1a1-0002-4000-8000-000000000002', auth_user_id: null, name: 'Marcus Johnson',  email: 'marcus@valiancemedia.com', avatar: '', role: 'member', timezone: 'America/New_York' },
  { id: 'a1a1a1a1-0003-4000-8000-000000000003', auth_user_id: null, name: 'Emily Rodriguez', email: 'emily@valiancemedia.com',  avatar: '', role: 'member', timezone: 'America/Los_Angeles' },
  { id: 'a1a1a1a1-0004-4000-8000-000000000004', auth_user_id: null, name: 'Jake Thompson',   email: 'jake@valiancemedia.com',   avatar: '', role: 'member', timezone: 'America/Chicago' },
  { id: 'a1a1a1a1-0005-4000-8000-000000000005', auth_user_id: null, name: 'Priya Patel',     email: 'priya@valiancemedia.com',  avatar: '', role: 'guest',  timezone: 'Asia/Kolkata' },
  { id: 'a1a1a1a1-0006-4000-8000-000000000006', auth_user_id: null, name: 'Atlas',           email: 'atlas@agent.local',        avatar: '', role: 'agent',  timezone: 'UTC' },
  { id: 'a1a1a1a1-0007-4000-8000-000000000007', auth_user_id: null, name: 'Scout',           email: 'scout@agent.local',        avatar: '', role: 'agent',  timezone: 'UTC' },
];

// ---------------------------------------------------------------------------
// 2. CONTACTS
// ---------------------------------------------------------------------------
export const demoContacts: Contact[] = [
  { id: 'b2b2b2b2-0001-4000-8000-000000000001', name: 'David Lawson',    email: 'david@crestfinancial.com',    phone: '(312) 555-0147', company: 'Crest Financial Group',  notes: 'CFO — prefers email. Budget-conscious but values quality.',           color: siteConfig.colors.brand[500], avatar_url: '', created_at: daysAgo(90), updated_at: daysAgo(10) },
  { id: 'b2b2b2b2-0002-4000-8000-000000000002', name: 'Monica Reeves',   email: 'monica@bloomwell.co',         phone: '(415) 555-0293', company: 'Bloomwell Health',       notes: 'Head of Marketing. Very hands-on with creative direction.',          color: '#EC4899', avatar_url: '', created_at: daysAgo(85), updated_at: daysAgo(5) },
  { id: 'b2b2b2b2-0003-4000-8000-000000000003', name: 'Andre Williams',  email: 'andre@neoforge.io',           phone: '(646) 555-0184', company: 'NeoForge Technologies',  notes: 'CTO. Wants a modern web presence to attract Series B.',              color: '#8B5CF6', avatar_url: '', created_at: daysAgo(80), updated_at: daysAgo(3) },
  { id: 'b2b2b2b2-0004-4000-8000-000000000004', name: 'Rachel Kim',      email: 'rachel@solsticerealty.com',    phone: '(213) 555-0362', company: 'Solstice Realty',        notes: 'Broker-owner. Needs IDX integration and lead capture.',              color: '#F59E0B', avatar_url: '', created_at: daysAgo(75), updated_at: daysAgo(2) },
  { id: 'b2b2b2b2-0005-4000-8000-000000000005', name: 'Tom Nguyen',      email: 'tom.nguyen@peakoutdoors.com', phone: '(503) 555-0219', company: 'Peak Outdoor Co.',        notes: 'E-commerce director. Shopify Plus migration underway.',              color: '#10B981', avatar_url: '', created_at: daysAgo(180), updated_at: daysAgo(35) },
  { id: 'b2b2b2b2-0006-4000-8000-000000000006', name: 'Lisa Martinez',   email: 'lisa@crestfinancial.com',     phone: '(312) 555-0188', company: 'Crest Financial Group',  notes: 'Marketing coordinator. Day-to-day contact for the Crest account.',   color: '#3B82F6', avatar_url: '', created_at: daysAgo(88), updated_at: daysAgo(8) },
  { id: 'b2b2b2b2-0007-4000-8000-000000000007', name: 'James Okafor',    email: 'james@urbanpulse.co',         phone: '(718) 555-0445', company: 'UrbanPulse Media',        notes: 'Co-founder. Interested in podcast website & brand package.',         color: '#EF4444', avatar_url: '', created_at: daysAgo(200), updated_at: daysAgo(60) },
  { id: 'b2b2b2b2-0008-4000-8000-000000000008', name: 'Samantha Brooks', email: 'sam@bloomwell.co',            phone: '(415) 555-0301', company: 'Bloomwell Health',       notes: 'VP of Product. Technical contact for app integrations.',             color: '#06B6D4', avatar_url: '', created_at: daysAgo(85), updated_at: daysAgo(1) },
  { id: 'b2b2b2b2-0009-4000-8000-000000000009', name: 'Nathan Cross',    email: 'nathan@crosslegalbr.com',     phone: '(202) 555-0177', company: 'Cross Legal Group',       notes: 'Managing partner. Wants a clean, professional site redesign.',       color: '#8B5CF6', avatar_url: '', created_at: daysAgo(40), updated_at: daysAgo(7) },
  { id: 'b2b2b2b2-0010-4000-8000-000000000010', name: 'Yuki Tanaka',     email: 'yuki@kaizenfit.com',          phone: '(808) 555-0233', company: 'Kaizen Fitness',          notes: 'Founder. Building a fitness app — needs branding and landing page.', color: '#EF4444', avatar_url: '', created_at: daysAgo(30), updated_at: daysAgo(4) },
  { id: 'b2b2b2b2-0011-4000-8000-000000000011', name: 'Olivia Grant',    email: 'olivia@sunnysidecafe.com',    phone: '(541) 555-0198', company: 'Sunnyside Cafe',          notes: 'Owner-operator. Wants a warm, inviting site with online ordering.',  color: '#F97316', avatar_url: '', created_at: daysAgo(15), updated_at: daysAgo(8) },
  { id: 'b2b2b2b2-0012-4000-8000-000000000012', name: 'Marcus Lee',      email: 'mlee@velocityauto.com',       phone: '(469) 555-0411', company: 'Velocity Auto Group',     notes: 'VP Digital. Multi-location dealership, big potential account.',      color: '#14B8A6', avatar_url: '', created_at: daysAgo(5),  updated_at: daysAgo(5) },
  { id: 'b2b2b2b2-0013-4000-8000-000000000013', name: 'Diana Frost',     email: 'diana@frostinteriors.com',    phone: '(917) 555-0266', company: 'Frost Interiors',          notes: 'Interior designer. Needs a portfolio site to showcase her work.',    color: '#A855F7', avatar_url: '', created_at: daysAgo(3),  updated_at: daysAgo(3) },
  { id: 'b2b2b2b2-0014-4000-8000-000000000014', name: 'Kevin Park',      email: 'kevin@greenleafnursery.com',  phone: '(360) 555-0344', company: 'Greenleaf Nursery',        notes: 'Owner. Referred by Tom at Peak Outdoor. Wants e-commerce for plants.', color: '#22C55E', avatar_url: '', created_at: daysAgo(12), updated_at: daysAgo(6) },
  { id: 'b2b2b2b2-0015-4000-8000-000000000015', name: 'Amanda Chen',     email: 'achen@brightwaveai.com',      phone: '(650) 555-0122', company: 'BrightWave AI',            notes: 'CEO. AI startup pre-demo day. Needs full brand + website fast.',     color: '#0EA5E9', avatar_url: '', created_at: daysAgo(10), updated_at: daysAgo(2) },
  { id: 'b2b2b2b2-0016-4000-8000-000000000016', name: 'Robert Simmons',  email: 'rob@heartlandbrewing.com',    phone: '(614) 555-0289', company: 'Heartland Brewing Co.',    notes: 'Marketing director. Lost deal — went with cheaper local agency.',    color: '#78716C', avatar_url: '', created_at: daysAgo(30), updated_at: daysAgo(15) },
  { id: 'b2b2b2b2-0017-4000-8000-000000000017', name: 'Patricia Vega',   email: 'patricia@vegadental.com',     phone: '(305) 555-0399', company: 'Vega Dental Group',        notes: 'Practice manager. Looking for patient-facing website + booking.',    color: '#EC4899', avatar_url: '', created_at: daysAgo(8),  updated_at: daysAgo(2) },
  { id: 'b2b2b2b2-0018-4000-8000-000000000018', name: 'Derek Holt',      email: 'derek@holtconstruction.com',  phone: '(404) 555-0512', company: 'Holt Construction',        notes: 'Owner. Wants project showcase site + lead gen.',                     color: '#F59E0B', avatar_url: '', created_at: daysAgo(6),  updated_at: daysAgo(1) },
  { id: 'b2b2b2b2-0019-4000-8000-000000000019', name: 'Mei-Lin Chang',   email: 'meiling@savorstreet.co',      phone: '(212) 555-0678', company: 'Savor Street Food Hall',   notes: 'Founder. Multi-vendor food hall. Needs site + vendor portal.',       color: '#EF4444', avatar_url: '', created_at: daysAgo(2),  updated_at: daysAgo(1) },
  { id: 'b2b2b2b2-0020-4000-8000-000000000020', name: 'Jordan Blake',    email: 'jordan@crestfinancial.com',   phone: '(312) 555-0221', company: 'Crest Financial Group',   notes: 'IT director. Technical approvals for the website project.',          color: siteConfig.colors.brand[500], avatar_url: '', created_at: daysAgo(33), updated_at: daysAgo(5) },
];

// ---------------------------------------------------------------------------
// 3. PROJECTS
// ---------------------------------------------------------------------------
const memberMap: Record<string, string[]> = {
  'c3c3c3c3-0001-4000-8000-000000000001': ['a1a1a1a1-0001-4000-8000-000000000001','a1a1a1a1-0002-4000-8000-000000000002','a1a1a1a1-0003-4000-8000-000000000003'],
  'c3c3c3c3-0002-4000-8000-000000000002': ['a1a1a1a1-0001-4000-8000-000000000001','a1a1a1a1-0004-4000-8000-000000000004','a1a1a1a1-0003-4000-8000-000000000003'],
  'c3c3c3c3-0003-4000-8000-000000000003': ['a1a1a1a1-0002-4000-8000-000000000002','a1a1a1a1-0004-4000-8000-000000000004'],
  'c3c3c3c3-0004-4000-8000-000000000004': ['a1a1a1a1-0001-4000-8000-000000000001','a1a1a1a1-0002-4000-8000-000000000002','a1a1a1a1-0004-4000-8000-000000000004'],
  'c3c3c3c3-0005-4000-8000-000000000005': ['a1a1a1a1-0003-4000-8000-000000000003','a1a1a1a1-0004-4000-8000-000000000004'],
  'c3c3c3c3-0006-4000-8000-000000000006': ['a1a1a1a1-0002-4000-8000-000000000002','a1a1a1a1-0005-4000-8000-000000000005'],
};

export const demoProjects: Project[] = [
  { id: 'c3c3c3c3-0001-4000-8000-000000000001', name: 'Crest Financial Rebrand',        description: 'Full brand identity refresh - logo, guidelines, collateral, and website.',   color: siteConfig.colors.brand[500], status: 'active',    start_date: '2026-01-15', due_date: '2026-04-30', hourly_tracking: true,  hourly_rate: 150, budget_type: 'hours',  budget_value: 80,    autonomous_enabled: true,  deployment_policy: 'production', max_concurrent_tasks: 2, suggestions_per_cycle: 3, repo_path: null, member_ids: memberMap['c3c3c3c3-0001-4000-8000-000000000001'], created_at: daysAgo(35), updated_at: daysAgo(1) },
  { id: 'c3c3c3c3-0002-4000-8000-000000000002', name: 'Bloomwell Health App',           description: 'Patient portal mobile app - React Native, auth, appointments, messaging.',  color: '#EC4899', status: 'active',    start_date: '2026-02-01', due_date: '2026-06-15', hourly_tracking: true,  hourly_rate: 175, budget_type: null,     budget_value: null,  autonomous_enabled: true,  deployment_policy: 'production', max_concurrent_tasks: 2, suggestions_per_cycle: 3, repo_path: null, member_ids: memberMap['c3c3c3c3-0002-4000-8000-000000000002'], created_at: daysAgo(18), updated_at: daysAgo(1) },
  { id: 'c3c3c3c3-0003-4000-8000-000000000003', name: 'NeoForge Website',               description: 'Marketing site for Series B push - Next.js, animations, CMS integration.',  color: '#8B5CF6', status: 'active',    start_date: '2026-01-20', due_date: '2026-03-31', hourly_tracking: false, hourly_rate: null, budget_type: 'amount', budget_value: 18000, autonomous_enabled: false, deployment_policy: 'production', max_concurrent_tasks: 2, suggestions_per_cycle: 3, repo_path: null, member_ids: memberMap['c3c3c3c3-0003-4000-8000-000000000003'], created_at: daysAgo(30), updated_at: daysAgo(2) },
  { id: 'c3c3c3c3-0004-4000-8000-000000000004', name: 'Solstice Realty Platform',       description: 'Property search with IDX, lead capture, and agent profiles.',                color: '#F59E0B', status: 'active',    start_date: '2026-02-10', due_date: '2026-05-20', hourly_tracking: true,  hourly_rate: 165, budget_type: 'amount', budget_value: 25000, autonomous_enabled: false, deployment_policy: 'production', max_concurrent_tasks: 2, suggestions_per_cycle: 3, repo_path: null, member_ids: memberMap['c3c3c3c3-0004-4000-8000-000000000004'], created_at: daysAgo(9),  updated_at: daysAgo(1) },
  { id: 'c3c3c3c3-0005-4000-8000-000000000005', name: 'Peak Outdoor Shopify Migration', description: 'Migrate from legacy WooCommerce to Shopify Plus with custom theme.',         color: '#10B981', status: 'completed', start_date: '2025-10-01', due_date: '2026-01-15', hourly_tracking: false, hourly_rate: null, budget_type: 'amount', budget_value: 24000, autonomous_enabled: false, deployment_policy: 'production', max_concurrent_tasks: 2, suggestions_per_cycle: 3, repo_path: null, member_ids: memberMap['c3c3c3c3-0005-4000-8000-000000000005'], created_at: daysAgo(140), updated_at: daysAgo(35) },
  { id: 'c3c3c3c3-0006-4000-8000-000000000006', name: 'UrbanPulse Brand Package',       description: 'Logo, color system, typography, and podcast microsite.',                     color: '#EF4444', status: 'archived',  start_date: '2025-08-15', due_date: '2025-11-30', hourly_tracking: false, hourly_rate: null, budget_type: 'amount', budget_value: 8500,  autonomous_enabled: false, deployment_policy: 'production', max_concurrent_tasks: 2, suggestions_per_cycle: 3, repo_path: null, member_ids: memberMap['c3c3c3c3-0006-4000-8000-000000000006'], created_at: daysAgo(190), updated_at: daysAgo(80) },
];

// ---------------------------------------------------------------------------
// 4. PROJECT CONTACTS
// ---------------------------------------------------------------------------
function contactRef(id: string): Contact | undefined {
  return demoContacts.find(c => c.id === id);
}

export const demoProjectContacts: ProjectContact[] = [
  { id: 'd4d4d4d4-0001-4000-8000-000000000001', project_id: 'c3c3c3c3-0001-4000-8000-000000000001', contact_id: 'b2b2b2b2-0001-4000-8000-000000000001', role: 'Client',            custom_role: null, is_primary_client: true,  created_at: daysAgo(35), contact: contactRef('b2b2b2b2-0001-4000-8000-000000000001') },
  { id: 'd4d4d4d4-0002-4000-8000-000000000002', project_id: 'c3c3c3c3-0001-4000-8000-000000000001', contact_id: 'b2b2b2b2-0006-4000-8000-000000000006', role: 'Primary Contact',   custom_role: null, is_primary_client: false, created_at: daysAgo(35), contact: contactRef('b2b2b2b2-0006-4000-8000-000000000006') },
  { id: 'd4d4d4d4-0003-4000-8000-000000000003', project_id: 'c3c3c3c3-0002-4000-8000-000000000002', contact_id: 'b2b2b2b2-0002-4000-8000-000000000002', role: 'Client',            custom_role: null, is_primary_client: true,  created_at: daysAgo(18), contact: contactRef('b2b2b2b2-0002-4000-8000-000000000002') },
  { id: 'd4d4d4d4-0004-4000-8000-000000000004', project_id: 'c3c3c3c3-0002-4000-8000-000000000002', contact_id: 'b2b2b2b2-0008-4000-8000-000000000008', role: 'Technical Contact', custom_role: null, is_primary_client: false, created_at: daysAgo(18), contact: contactRef('b2b2b2b2-0008-4000-8000-000000000008') },
  { id: 'd4d4d4d4-0005-4000-8000-000000000005', project_id: 'c3c3c3c3-0003-4000-8000-000000000003', contact_id: 'b2b2b2b2-0003-4000-8000-000000000003', role: 'Client',            custom_role: null, is_primary_client: true,  created_at: daysAgo(30), contact: contactRef('b2b2b2b2-0003-4000-8000-000000000003') },
  { id: 'd4d4d4d4-0006-4000-8000-000000000006', project_id: 'c3c3c3c3-0004-4000-8000-000000000004', contact_id: 'b2b2b2b2-0004-4000-8000-000000000004', role: 'Client',            custom_role: null, is_primary_client: true,  created_at: daysAgo(9),  contact: contactRef('b2b2b2b2-0004-4000-8000-000000000004') },
  { id: 'd4d4d4d4-0007-4000-8000-000000000007', project_id: 'c3c3c3c3-0005-4000-8000-000000000005', contact_id: 'b2b2b2b2-0005-4000-8000-000000000005', role: 'Client',            custom_role: null, is_primary_client: true,  created_at: daysAgo(140), contact: contactRef('b2b2b2b2-0005-4000-8000-000000000005') },
  { id: 'd4d4d4d4-0008-4000-8000-000000000008', project_id: 'c3c3c3c3-0006-4000-8000-000000000006', contact_id: 'b2b2b2b2-0007-4000-8000-000000000007', role: 'Client',            custom_role: null, is_primary_client: true,  created_at: daysAgo(190), contact: contactRef('b2b2b2b2-0007-4000-8000-000000000007') },
  // Additional contacts on projects
  { id: 'd4d4d4d4-0009-4000-8000-000000000009', project_id: 'c3c3c3c3-0001-4000-8000-000000000001', contact_id: 'b2b2b2b2-0020-4000-8000-000000000020', role: 'Technical Contact', custom_role: null, is_primary_client: false, created_at: daysAgo(33), contact: contactRef('b2b2b2b2-0020-4000-8000-000000000020') },
  { id: 'd4d4d4d4-0010-4000-8000-000000000010', project_id: 'c3c3c3c3-0003-4000-8000-000000000003', contact_id: 'b2b2b2b2-0003-4000-8000-000000000003', role: 'Stakeholder',       custom_role: null, is_primary_client: false, created_at: daysAgo(28), contact: contactRef('b2b2b2b2-0003-4000-8000-000000000003') },
  { id: 'd4d4d4d4-0011-4000-8000-000000000011', project_id: 'c3c3c3c3-0004-4000-8000-000000000004', contact_id: 'b2b2b2b2-0004-4000-8000-000000000004', role: 'Billing Contact',   custom_role: null, is_primary_client: false, created_at: daysAgo(9),  contact: contactRef('b2b2b2b2-0004-4000-8000-000000000004') },
];

// ---------------------------------------------------------------------------
// 5. TASKS  (with subtasks + comments inline)
// ---------------------------------------------------------------------------
const TM1 = 'a1a1a1a1-0001-4000-8000-000000000001';
const TM2 = 'a1a1a1a1-0002-4000-8000-000000000002';
const TM3 = 'a1a1a1a1-0003-4000-8000-000000000003';
const TM4 = 'a1a1a1a1-0004-4000-8000-000000000004';

export const demoTasks: (Omit<Task, 'ai_managed'> & { ai_managed?: boolean })[] = [
  // === Crest Financial Rebrand (7 tasks) ===
  { id: 'e5e5e5e5-0001-4000-8000-000000000001', project_id: 'c3c3c3c3-0001-4000-8000-000000000001', title: 'Discovery & brand audit',          description: 'Review current brand assets, competitor analysis, and stakeholder interviews.',  status: 'done',        priority: 'high',   assignee_ids: [TM1], due_date: '2026-01-31', tags: ['research','branding'], subtasks: [], comments: [], created_at: daysAgo(35), updated_at: daysAgo(20) },
  { id: 'e5e5e5e5-0002-4000-8000-000000000002', project_id: 'c3c3c3c3-0001-4000-8000-000000000001', title: 'Logo concepts — round 1',          description: 'Present 3 logo directions based on discovery findings.',                        status: 'done',        priority: 'high',   assignee_ids: [TM3], due_date: '2026-02-14', tags: ['design','branding'], subtasks: [], comments: [], created_at: daysAgo(35), updated_at: daysAgo(14) },
  {
    id: 'e5e5e5e5-0003-4000-8000-000000000003', project_id: 'c3c3c3c3-0001-4000-8000-000000000001', title: 'Brand guidelines document',         description: 'Colors, typography, spacing, usage rules, do/don\'t examples.',                 status: 'in_progress', priority: 'high',   assignee_ids: [TM3], due_date: '2026-03-07', tags: ['design','branding'],
    subtasks: [
      { id: 'f6f6f6f6-0001-4000-8000-000000000001', task_id: 'e5e5e5e5-0003-4000-8000-000000000003', title: 'Define primary & secondary color palette', completed: true,  sort_order: 0 },
      { id: 'f6f6f6f6-0002-4000-8000-000000000002', task_id: 'e5e5e5e5-0003-4000-8000-000000000003', title: 'Select brand typefaces (heading + body)',   completed: true,  sort_order: 1 },
      { id: 'f6f6f6f6-0003-4000-8000-000000000003', task_id: 'e5e5e5e5-0003-4000-8000-000000000003', title: 'Write logo usage rules & clear space',      completed: false, sort_order: 2 },
      { id: 'f6f6f6f6-0004-4000-8000-000000000004', task_id: 'e5e5e5e5-0003-4000-8000-000000000003', title: 'Create do / don\'t examples page',           completed: false, sort_order: 3 },
      { id: 'f6f6f6f6-0005-4000-8000-000000000005', task_id: 'e5e5e5e5-0003-4000-8000-000000000003', title: 'Photography & iconography style guide',      completed: false, sort_order: 4 },
    ],
    comments: [
      { id: 'aabbccdd-0001-4000-8000-000000000001', task_id: 'e5e5e5e5-0003-4000-8000-000000000003', user_id: TM1, text: 'David approved the color palette in yesterday\'s call. Moving to typography next.',    created_at: daysAgo(3) },
      { id: 'aabbccdd-0002-4000-8000-000000000002', task_id: 'e5e5e5e5-0003-4000-8000-000000000003', user_id: TM3, text: 'I\'m leaning toward Inter for body and Fraunces for headings. Sending samples today.', created_at: daysAgo(2) },
      { id: 'aabbccdd-0003-4000-8000-000000000003', task_id: 'e5e5e5e5-0003-4000-8000-000000000003', user_id: TM1, text: 'Love the Fraunces pairing. Let\'s lock that in and move to the usage rules section.',  created_at: daysAgo(1) },
    ],
    created_at: daysAgo(25), updated_at: daysAgo(1),
  },
  {
    id: 'e5e5e5e5-0004-4000-8000-000000000004', project_id: 'c3c3c3c3-0001-4000-8000-000000000001', title: 'Business card & letterhead design', description: 'Print collateral matching new brand system.',                                   status: 'todo',        priority: 'medium', assignee_ids: [TM3], due_date: '2026-03-21', tags: ['design','print'],
    subtasks: [
      { id: 'f6f6f6f6-0027-4000-8000-000000000027', task_id: 'e5e5e5e5-0004-4000-8000-000000000004', title: 'Business card front/back layout', completed: false, sort_order: 0 },
      { id: 'f6f6f6f6-0028-4000-8000-000000000028', task_id: 'e5e5e5e5-0004-4000-8000-000000000004', title: 'Letterhead & envelope design',    completed: false, sort_order: 1 },
      { id: 'f6f6f6f6-0029-4000-8000-000000000029', task_id: 'e5e5e5e5-0004-4000-8000-000000000004', title: 'Print-ready file prep (CMYK)',    completed: false, sort_order: 2 },
    ],
    comments: [
      { id: 'aabbccdd-0016-4000-8000-000000000016', task_id: 'e5e5e5e5-0004-4000-8000-000000000004', user_id: TM3, text: 'Waiting on brand guidelines to be finalized before starting this.',  created_at: daysAgo(18) },
      { id: 'aabbccdd-0017-4000-8000-000000000017', task_id: 'e5e5e5e5-0004-4000-8000-000000000004', user_id: TM1, text: 'Lisa mentioned they need 500 cards for a conference on April 5.',    created_at: daysAgo(10) },
    ],
    created_at: daysAgo(20), updated_at: daysAgo(10),
  },
  {
    id: 'e5e5e5e5-0005-4000-8000-000000000005', project_id: 'c3c3c3c3-0001-4000-8000-000000000001', title: 'Website wireframes',                description: 'Low-fi wireframes for homepage, about, services, contact, and blog.',          status: 'in_progress', priority: 'high',   assignee_ids: [TM1, TM2], due_date: '2026-03-14', tags: ['design','web'],
    subtasks: [
      { id: 'f6f6f6f6-0006-4000-8000-000000000006', task_id: 'e5e5e5e5-0005-4000-8000-000000000005', title: 'Homepage wireframe',            completed: true,  sort_order: 0 },
      { id: 'f6f6f6f6-0007-4000-8000-000000000007', task_id: 'e5e5e5e5-0005-4000-8000-000000000005', title: 'About page wireframe',           completed: true,  sort_order: 1 },
      { id: 'f6f6f6f6-0008-4000-8000-000000000008', task_id: 'e5e5e5e5-0005-4000-8000-000000000005', title: 'Services page wireframe',        completed: false, sort_order: 2 },
      { id: 'f6f6f6f6-0009-4000-8000-000000000009', task_id: 'e5e5e5e5-0005-4000-8000-000000000005', title: 'Blog listing + post wireframe',  completed: false, sort_order: 3 },
      { id: 'f6f6f6f6-0010-4000-8000-000000000010', task_id: 'e5e5e5e5-0005-4000-8000-000000000005', title: 'Contact page wireframe',         completed: false, sort_order: 4 },
    ],
    comments: [
      { id: 'aabbccdd-0004-4000-8000-000000000004', task_id: 'e5e5e5e5-0005-4000-8000-000000000005', user_id: TM2, text: 'Homepage wireframe is looking solid. Lisa from Crest had some feedback on the hero section.', created_at: daysAgo(5) },
      { id: 'aabbccdd-0005-4000-8000-000000000005', task_id: 'e5e5e5e5-0005-4000-8000-000000000005', user_id: TM1, text: 'Updated based on Lisa\'s notes — moved the value prop above the fold.',                       created_at: daysAgo(4) },
    ],
    created_at: daysAgo(20), updated_at: daysAgo(4),
  },
  {
    id: 'e5e5e5e5-0006-4000-8000-000000000006', project_id: 'c3c3c3c3-0001-4000-8000-000000000001', title: 'Website development — Next.js',    description: 'Build out approved wireframes in Next.js with Tailwind and Sanity CMS.',        status: 'todo',        priority: 'high',   assignee_ids: [TM2], due_date: '2026-04-15', tags: ['development','web'],
    subtasks: [
      { id: 'f6f6f6f6-0030-4000-8000-000000000030', task_id: 'e5e5e5e5-0006-4000-8000-000000000006', title: 'Project scaffold & Tailwind config', completed: false, sort_order: 0 },
      { id: 'f6f6f6f6-0031-4000-8000-000000000031', task_id: 'e5e5e5e5-0006-4000-8000-000000000006', title: 'Homepage build',                    completed: false, sort_order: 1 },
      { id: 'f6f6f6f6-0032-4000-8000-000000000032', task_id: 'e5e5e5e5-0006-4000-8000-000000000006', title: 'Inner pages (about, services)',      completed: false, sort_order: 2 },
      { id: 'f6f6f6f6-0033-4000-8000-000000000033', task_id: 'e5e5e5e5-0006-4000-8000-000000000006', title: 'Sanity CMS integration',            completed: false, sort_order: 3 },
      { id: 'f6f6f6f6-0034-4000-8000-000000000034', task_id: 'e5e5e5e5-0006-4000-8000-000000000006', title: 'Blog with MDX support',             completed: false, sort_order: 4 },
      { id: 'f6f6f6f6-0035-4000-8000-000000000035', task_id: 'e5e5e5e5-0006-4000-8000-000000000006', title: 'Contact form with email delivery',  completed: false, sort_order: 5 },
    ],
    comments: [
      { id: 'aabbccdd-0018-4000-8000-000000000018', task_id: 'e5e5e5e5-0006-4000-8000-000000000006', user_id: TM2, text: 'Going to start scaffolding once wireframes are signed off. Already set up the repo.', created_at: daysAgo(12) },
    ],
    created_at: daysAgo(15), updated_at: daysAgo(12),
  },
  {
    id: 'e5e5e5e5-0007-4000-8000-000000000007', project_id: 'c3c3c3c3-0001-4000-8000-000000000001', title: 'Final QA & launch',                description: 'Cross-browser testing, SEO audit, performance check, DNS cutover.',             status: 'todo',        priority: 'urgent', assignee_ids: [TM1, TM2], due_date: '2026-04-28', tags: ['qa','web'],
    subtasks: [
      { id: 'f6f6f6f6-0036-4000-8000-000000000036', task_id: 'e5e5e5e5-0007-4000-8000-000000000007', title: 'Cross-browser testing (Chrome, Safari, Firefox, Edge)', completed: false, sort_order: 0 },
      { id: 'f6f6f6f6-0037-4000-8000-000000000037', task_id: 'e5e5e5e5-0007-4000-8000-000000000007', title: 'Mobile responsiveness audit',          completed: false, sort_order: 1 },
      { id: 'f6f6f6f6-0038-4000-8000-000000000038', task_id: 'e5e5e5e5-0007-4000-8000-000000000007', title: 'Lighthouse performance pass (>90)',     completed: false, sort_order: 2 },
      { id: 'f6f6f6f6-0039-4000-8000-000000000039', task_id: 'e5e5e5e5-0007-4000-8000-000000000007', title: 'SEO meta tags & Open Graph',           completed: false, sort_order: 3 },
      { id: 'f6f6f6f6-0040-4000-8000-000000000040', task_id: 'e5e5e5e5-0007-4000-8000-000000000007', title: 'DNS cutover & go-live',                completed: false, sort_order: 4 },
    ],
    comments: [],
    created_at: daysAgo(15), updated_at: daysAgo(15),
  },

  // === Bloomwell Health App (6 tasks) ===
  { id: 'e5e5e5e5-0008-4000-8000-000000000008', project_id: 'c3c3c3c3-0002-4000-8000-000000000002', title: 'User flow & IA mapping',           description: 'Map patient flows: sign-up, book appointment, view records, message doctor.',   status: 'done',        priority: 'high',   assignee_ids: [TM1], due_date: '2026-02-14', tags: ['research','ux'], subtasks: [], comments: [], created_at: daysAgo(18), updated_at: daysAgo(7) },
  {
    id: 'e5e5e5e5-0009-4000-8000-000000000009', project_id: 'c3c3c3c3-0002-4000-8000-000000000002', title: 'UI kit & design system',           description: 'Component library in Figma — buttons, inputs, cards, navigation, etc.',        status: 'in_review',   priority: 'high',   assignee_ids: [TM3], due_date: '2026-02-28', tags: ['design','mobile'],
    subtasks: [
      { id: 'f6f6f6f6-0011-4000-8000-000000000011', task_id: 'e5e5e5e5-0009-4000-8000-000000000009', title: 'Button & input components',              completed: true,  sort_order: 0 },
      { id: 'f6f6f6f6-0012-4000-8000-000000000012', task_id: 'e5e5e5e5-0009-4000-8000-000000000009', title: 'Card & list components',                 completed: true,  sort_order: 1 },
      { id: 'f6f6f6f6-0013-4000-8000-000000000013', task_id: 'e5e5e5e5-0009-4000-8000-000000000009', title: 'Navigation patterns (tab bar, drawer)',   completed: true,  sort_order: 2 },
      { id: 'f6f6f6f6-0014-4000-8000-000000000014', task_id: 'e5e5e5e5-0009-4000-8000-000000000009', title: 'Dark mode variants',                     completed: false, sort_order: 3 },
    ],
    comments: [
      { id: 'aabbccdd-0006-4000-8000-000000000006', task_id: 'e5e5e5e5-0009-4000-8000-000000000009', user_id: TM3, text: 'All core components done. Just need dark mode variants before handoff.',                     created_at: daysAgo(1) },
      { id: 'aabbccdd-0007-4000-8000-000000000007', task_id: 'e5e5e5e5-0009-4000-8000-000000000009', user_id: TM1, text: 'Samantha from Bloomwell wants to review before we finalize. Scheduling for Thursday.',       created_at: hoursAgo(12) },
    ],
    created_at: daysAgo(18), updated_at: daysAgo(1),
  },
  {
    id: 'e5e5e5e5-0010-4000-8000-000000000010', project_id: 'c3c3c3c3-0002-4000-8000-000000000002', title: 'Auth & onboarding screens',        description: 'Email/password + SSO login, HIPAA consent, profile setup.',                     status: 'in_progress', priority: 'urgent', assignee_ids: [TM4, TM1], due_date: '2026-03-15', tags: ['development','mobile'],
    subtasks: [
      { id: 'f6f6f6f6-0015-4000-8000-000000000015', task_id: 'e5e5e5e5-0010-4000-8000-000000000010', title: 'Email/password login flow',   completed: true,  sort_order: 0 },
      { id: 'f6f6f6f6-0016-4000-8000-000000000016', task_id: 'e5e5e5e5-0010-4000-8000-000000000010', title: 'Google SSO integration',      completed: false, sort_order: 1 },
      { id: 'f6f6f6f6-0017-4000-8000-000000000017', task_id: 'e5e5e5e5-0010-4000-8000-000000000010', title: 'HIPAA consent screen',        completed: false, sort_order: 2 },
      { id: 'f6f6f6f6-0018-4000-8000-000000000018', task_id: 'e5e5e5e5-0010-4000-8000-000000000010', title: 'Profile setup wizard',        completed: false, sort_order: 3 },
    ],
    comments: [
      { id: 'aabbccdd-0008-4000-8000-000000000008', task_id: 'e5e5e5e5-0010-4000-8000-000000000010', user_id: TM4, text: 'Email/password flow is done and tested. Starting on Google SSO tomorrow.',   created_at: daysAgo(2) },
      { id: 'aabbccdd-0009-4000-8000-000000000009', task_id: 'e5e5e5e5-0010-4000-8000-000000000010', user_id: TM1, text: 'Make sure the HIPAA consent copy gets legal review before we ship.',         created_at: daysAgo(1) },
    ],
    created_at: daysAgo(10), updated_at: daysAgo(1),
  },
  {
    id: 'e5e5e5e5-0011-4000-8000-000000000011', project_id: 'c3c3c3c3-0002-4000-8000-000000000002', title: 'Appointment booking module',       description: 'Calendar picker, provider search, confirmation & reminders.',                   status: 'todo',        priority: 'high',   assignee_ids: [TM4], due_date: '2026-04-01', tags: ['development','mobile'],
    subtasks: [
      { id: 'f6f6f6f6-0041-4000-8000-000000000041', task_id: 'e5e5e5e5-0011-4000-8000-000000000011', title: 'Calendar date picker component',     completed: false, sort_order: 0 },
      { id: 'f6f6f6f6-0042-4000-8000-000000000042', task_id: 'e5e5e5e5-0011-4000-8000-000000000011', title: 'Provider search & filtering',        completed: false, sort_order: 1 },
      { id: 'f6f6f6f6-0043-4000-8000-000000000043', task_id: 'e5e5e5e5-0011-4000-8000-000000000011', title: 'Booking confirmation screen',        completed: false, sort_order: 2 },
      { id: 'f6f6f6f6-0044-4000-8000-000000000044', task_id: 'e5e5e5e5-0011-4000-8000-000000000011', title: 'Push notification reminders',        completed: false, sort_order: 3 },
    ],
    comments: [
      { id: 'aabbccdd-0019-4000-8000-000000000019', task_id: 'e5e5e5e5-0011-4000-8000-000000000011', user_id: TM4, text: 'Going to use react-native-calendars for the picker. Checking if it supports custom themes.', created_at: daysAgo(8) },
      { id: 'aabbccdd-0020-4000-8000-000000000020', task_id: 'e5e5e5e5-0011-4000-8000-000000000011', user_id: TM1, text: 'Monica wants the confirmation to include an "Add to Calendar" button (Google + Apple).',       created_at: daysAgo(6) },
    ],
    created_at: daysAgo(10), updated_at: daysAgo(6),
  },
  {
    id: 'e5e5e5e5-0012-4000-8000-000000000012', project_id: 'c3c3c3c3-0002-4000-8000-000000000002', title: 'Secure messaging implementation',  description: 'HIPAA-compliant chat between patient and care team.',                           status: 'todo',        priority: 'medium', assignee_ids: [TM4], due_date: '2026-04-30', tags: ['development','mobile'],
    subtasks: [
      { id: 'f6f6f6f6-0045-4000-8000-000000000045', task_id: 'e5e5e5e5-0012-4000-8000-000000000012', title: 'Evaluate HIPAA-compliant messaging SDKs', completed: false, sort_order: 0 },
      { id: 'f6f6f6f6-0046-4000-8000-000000000046', task_id: 'e5e5e5e5-0012-4000-8000-000000000012', title: 'Chat UI with message threads',           completed: false, sort_order: 1 },
      { id: 'f6f6f6f6-0047-4000-8000-000000000047', task_id: 'e5e5e5e5-0012-4000-8000-000000000012', title: 'End-to-end encryption integration',      completed: false, sort_order: 2 },
    ],
    comments: [
      { id: 'aabbccdd-0021-4000-8000-000000000021', task_id: 'e5e5e5e5-0012-4000-8000-000000000012', user_id: TM1, text: 'Samantha flagged that Twilio has a HIPAA-eligible option. Jake, can you look into pricing?', created_at: daysAgo(7) },
    ],
    created_at: daysAgo(10), updated_at: daysAgo(7),
  },
  {
    id: 'e5e5e5e5-0013-4000-8000-000000000013', project_id: 'c3c3c3c3-0002-4000-8000-000000000002', title: 'Beta testing & feedback',          description: 'Distribute TestFlight build to 20 pilot users, collect feedback.',              status: 'todo',        priority: 'medium', assignee_ids: [TM1, TM3], due_date: '2026-05-30', tags: ['qa','mobile'],
    subtasks: [
      { id: 'f6f6f6f6-0048-4000-8000-000000000048', task_id: 'e5e5e5e5-0013-4000-8000-000000000013', title: 'Recruit 20 pilot users from Bloomwell',  completed: false, sort_order: 0 },
      { id: 'f6f6f6f6-0049-4000-8000-000000000049', task_id: 'e5e5e5e5-0013-4000-8000-000000000013', title: 'Set up TestFlight distribution',         completed: false, sort_order: 1 },
      { id: 'f6f6f6f6-0050-4000-8000-000000000050', task_id: 'e5e5e5e5-0013-4000-8000-000000000013', title: 'Create feedback survey (Typeform)',      completed: false, sort_order: 2 },
      { id: 'f6f6f6f6-0051-4000-8000-000000000051', task_id: 'e5e5e5e5-0013-4000-8000-000000000013', title: 'Compile feedback report & triage bugs',  completed: false, sort_order: 3 },
    ],
    comments: [],
    created_at: daysAgo(10), updated_at: daysAgo(10),
  },

  // === NeoForge Website (5 tasks) ===
  { id: 'e5e5e5e5-0014-4000-8000-000000000014', project_id: 'c3c3c3c3-0003-4000-8000-000000000003', title: 'Content strategy & copywriting',   description: 'Messaging framework, hero copy, feature descriptions, about page.',             status: 'done',        priority: 'medium', assignee_ids: [TM2], due_date: '2026-02-07', tags: ['content','web'], subtasks: [], comments: [], created_at: daysAgo(30), updated_at: daysAgo(12) },
  {
    id: 'e5e5e5e5-0015-4000-8000-000000000015', project_id: 'c3c3c3c3-0003-4000-8000-000000000003', title: 'Homepage & landing page design',   description: 'High-fi designs with scroll animations and 3D product renders.',                status: 'in_review',   priority: 'high',   assignee_ids: [TM2, TM4], due_date: '2026-02-21', tags: ['design','web'],
    subtasks: [],
    comments: [
      { id: 'aabbccdd-0010-4000-8000-000000000010', task_id: 'e5e5e5e5-0015-4000-8000-000000000015', user_id: TM2, text: 'Andre loved the 3D render concept. Wants us to push the animations further.',            created_at: daysAgo(3) },
      { id: 'aabbccdd-0011-4000-8000-000000000011', task_id: 'e5e5e5e5-0015-4000-8000-000000000015', user_id: TM4, text: 'Built a quick Framer Motion prototype for the hero section. Will share the link today.', created_at: daysAgo(2) },
    ],
    created_at: daysAgo(25), updated_at: daysAgo(2),
  },
  {
    id: 'e5e5e5e5-0016-4000-8000-000000000016', project_id: 'c3c3c3c3-0003-4000-8000-000000000003', title: 'Inner pages design',               description: 'About, pricing, blog, docs, and contact pages.',                               status: 'in_progress', priority: 'medium', assignee_ids: [TM2], due_date: '2026-03-07', tags: ['design','web'],
    subtasks: [
      { id: 'f6f6f6f6-0052-4000-8000-000000000052', task_id: 'e5e5e5e5-0016-4000-8000-000000000016', title: 'About / Team page',        completed: true,  sort_order: 0 },
      { id: 'f6f6f6f6-0053-4000-8000-000000000053', task_id: 'e5e5e5e5-0016-4000-8000-000000000016', title: 'Pricing page with tiers',  completed: true,  sort_order: 1 },
      { id: 'f6f6f6f6-0054-4000-8000-000000000054', task_id: 'e5e5e5e5-0016-4000-8000-000000000016', title: 'Blog index + post layout', completed: false, sort_order: 2 },
      { id: 'f6f6f6f6-0055-4000-8000-000000000055', task_id: 'e5e5e5e5-0016-4000-8000-000000000016', title: 'Docs / changelog page',    completed: false, sort_order: 3 },
      { id: 'f6f6f6f6-0056-4000-8000-000000000056', task_id: 'e5e5e5e5-0016-4000-8000-000000000016', title: 'Contact / demo request',   completed: false, sort_order: 4 },
    ],
    comments: [
      { id: 'aabbccdd-0022-4000-8000-000000000022', task_id: 'e5e5e5e5-0016-4000-8000-000000000016', user_id: TM2, text: 'About and pricing pages are done. Andre wants the pricing page to highlight their Enterprise tier more.', created_at: daysAgo(4) },
      { id: 'aabbccdd-0023-4000-8000-000000000023', task_id: 'e5e5e5e5-0016-4000-8000-000000000016', user_id: TM4, text: 'The blog layout should support code syntax highlighting — their audience is developers.', created_at: daysAgo(3) },
    ],
    created_at: daysAgo(20), updated_at: daysAgo(3),
  },
  {
    id: 'e5e5e5e5-0017-4000-8000-000000000017', project_id: 'c3c3c3c3-0003-4000-8000-000000000003', title: 'Frontend development — Next.js',   description: 'Build with Framer Motion animations, MDX blog, and Sanity CMS.',               status: 'todo',        priority: 'high',   assignee_ids: [TM4], due_date: '2026-03-21', tags: ['development','web'],
    subtasks: [
      { id: 'f6f6f6f6-0057-4000-8000-000000000057', task_id: 'e5e5e5e5-0017-4000-8000-000000000017', title: 'Next.js project setup + Vercel deploy', completed: false, sort_order: 0 },
      { id: 'f6f6f6f6-0058-4000-8000-000000000058', task_id: 'e5e5e5e5-0017-4000-8000-000000000017', title: 'Framer Motion hero animations',         completed: false, sort_order: 1 },
      { id: 'f6f6f6f6-0059-4000-8000-000000000059', task_id: 'e5e5e5e5-0017-4000-8000-000000000017', title: 'MDX blog engine',                       completed: false, sort_order: 2 },
      { id: 'f6f6f6f6-0060-4000-8000-000000000060', task_id: 'e5e5e5e5-0017-4000-8000-000000000017', title: 'Sanity CMS schema + studio',            completed: false, sort_order: 3 },
    ],
    comments: [],
    created_at: daysAgo(15), updated_at: daysAgo(15),
  },
  {
    id: 'e5e5e5e5-0018-4000-8000-000000000018', project_id: 'c3c3c3c3-0003-4000-8000-000000000003', title: 'SEO & analytics setup',            description: 'Structured data, sitemap, GA4, Search Console, and Hotjar.',                   status: 'todo',        priority: 'low',    assignee_ids: [TM2], due_date: '2026-03-28', tags: ['seo','web'],
    subtasks: [
      { id: 'f6f6f6f6-0061-4000-8000-000000000061', task_id: 'e5e5e5e5-0018-4000-8000-000000000018', title: 'JSON-LD structured data',      completed: false, sort_order: 0 },
      { id: 'f6f6f6f6-0062-4000-8000-000000000062', task_id: 'e5e5e5e5-0018-4000-8000-000000000018', title: 'Auto-generated sitemap.xml',   completed: false, sort_order: 1 },
      { id: 'f6f6f6f6-0063-4000-8000-000000000063', task_id: 'e5e5e5e5-0018-4000-8000-000000000018', title: 'GA4 + Search Console setup',   completed: false, sort_order: 2 },
      { id: 'f6f6f6f6-0064-4000-8000-000000000064', task_id: 'e5e5e5e5-0018-4000-8000-000000000018', title: 'Hotjar heatmap integration',   completed: false, sort_order: 3 },
    ],
    comments: [],
    created_at: daysAgo(15), updated_at: daysAgo(15),
  },

  // === Solstice Realty Platform (5 tasks) ===
  {
    id: 'e5e5e5e5-0019-4000-8000-000000000019', project_id: 'c3c3c3c3-0004-4000-8000-000000000004', title: 'IDX/MLS integration research',     description: 'Evaluate IDX providers (iHomeFinder, Showcase IDX) for React compatibility.',   status: 'in_progress', priority: 'urgent', assignee_ids: [TM4, TM1], due_date: '2026-02-21', tags: ['research','development'],
    subtasks: [
      { id: 'f6f6f6f6-0019-4000-8000-000000000019', task_id: 'e5e5e5e5-0019-4000-8000-000000000019', title: 'Evaluate iHomeFinder API',       completed: true,  sort_order: 0 },
      { id: 'f6f6f6f6-0020-4000-8000-000000000020', task_id: 'e5e5e5e5-0019-4000-8000-000000000019', title: 'Evaluate Showcase IDX',          completed: true,  sort_order: 1 },
      { id: 'f6f6f6f6-0021-4000-8000-000000000021', task_id: 'e5e5e5e5-0019-4000-8000-000000000019', title: 'Cost comparison spreadsheet',    completed: false, sort_order: 2 },
      { id: 'f6f6f6f6-0022-4000-8000-000000000022', task_id: 'e5e5e5e5-0019-4000-8000-000000000019', title: 'Prototype with chosen provider', completed: false, sort_order: 3 },
    ],
    comments: [
      { id: 'aabbccdd-0012-4000-8000-000000000012', task_id: 'e5e5e5e5-0019-4000-8000-000000000019', user_id: TM4, text: 'iHomeFinder has the better API but Showcase IDX is way cheaper. Writing up the comparison.', created_at: daysAgo(1) },
      { id: 'aabbccdd-0013-4000-8000-000000000013', task_id: 'e5e5e5e5-0019-4000-8000-000000000019', user_id: TM1, text: 'Let\'s go with iHomeFinder — Rachel\'s budget can handle it and the DX is miles better.',    created_at: hoursAgo(6) },
    ],
    created_at: daysAgo(9), updated_at: hoursAgo(6),
  },
  {
    id: 'e5e5e5e5-0020-4000-8000-000000000020', project_id: 'c3c3c3c3-0004-4000-8000-000000000004', title: 'Property search UI',               description: 'Map view, filters (price, beds, baths, type), saved searches.',                 status: 'todo',        priority: 'high',   assignee_ids: [TM2, TM4], due_date: '2026-03-15', tags: ['design','development'],
    subtasks: [
      { id: 'f6f6f6f6-0065-4000-8000-000000000065', task_id: 'e5e5e5e5-0020-4000-8000-000000000020', title: 'Map view with Mapbox GL',           completed: false, sort_order: 0 },
      { id: 'f6f6f6f6-0066-4000-8000-000000000066', task_id: 'e5e5e5e5-0020-4000-8000-000000000020', title: 'Filter panel (price/beds/baths)',   completed: false, sort_order: 1 },
      { id: 'f6f6f6f6-0067-4000-8000-000000000067', task_id: 'e5e5e5e5-0020-4000-8000-000000000020', title: 'Property cards with image carousel', completed: false, sort_order: 2 },
      { id: 'f6f6f6f6-0068-4000-8000-000000000068', task_id: 'e5e5e5e5-0020-4000-8000-000000000020', title: 'Saved searches / favorites',       completed: false, sort_order: 3 },
    ],
    comments: [
      { id: 'aabbccdd-0024-4000-8000-000000000024', task_id: 'e5e5e5e5-0020-4000-8000-000000000020', user_id: TM2, text: 'Rachel wants the map to default to the Greater LA area. I\'ll set that as the initial viewport.', created_at: daysAgo(7) },
    ],
    created_at: daysAgo(9), updated_at: daysAgo(7),
  },
  {
    id: 'e5e5e5e5-0021-4000-8000-000000000021', project_id: 'c3c3c3c3-0004-4000-8000-000000000004', title: 'Agent profile pages',              description: 'Bio, listings, reviews, contact form per agent.',                               status: 'todo',        priority: 'medium', assignee_ids: [TM2], due_date: '2026-03-30', tags: ['design','web'],
    subtasks: [
      { id: 'f6f6f6f6-0069-4000-8000-000000000069', task_id: 'e5e5e5e5-0021-4000-8000-000000000021', title: 'Agent bio + headshot layout',      completed: false, sort_order: 0 },
      { id: 'f6f6f6f6-0070-4000-8000-000000000070', task_id: 'e5e5e5e5-0021-4000-8000-000000000021', title: 'Active listings feed per agent',   completed: false, sort_order: 1 },
      { id: 'f6f6f6f6-0071-4000-8000-000000000071', task_id: 'e5e5e5e5-0021-4000-8000-000000000021', title: 'Client reviews / testimonials',    completed: false, sort_order: 2 },
    ],
    comments: [],
    created_at: daysAgo(9), updated_at: daysAgo(9),
  },
  {
    id: 'e5e5e5e5-0022-4000-8000-000000000022', project_id: 'c3c3c3c3-0004-4000-8000-000000000004', title: 'Lead capture & CRM integration',   description: 'Contact forms, property inquiry, Zapier to HubSpot.',                           status: 'todo',        priority: 'high',   assignee_ids: [TM1, TM4], due_date: '2026-04-15', tags: ['development','integration'],
    subtasks: [
      { id: 'f6f6f6f6-0072-4000-8000-000000000072', task_id: 'e5e5e5e5-0022-4000-8000-000000000022', title: 'General contact form',                   completed: false, sort_order: 0 },
      { id: 'f6f6f6f6-0073-4000-8000-000000000073', task_id: 'e5e5e5e5-0022-4000-8000-000000000022', title: 'Property-specific inquiry form',          completed: false, sort_order: 1 },
      { id: 'f6f6f6f6-0074-4000-8000-000000000074', task_id: 'e5e5e5e5-0022-4000-8000-000000000022', title: 'Zapier → HubSpot automation',             completed: false, sort_order: 2 },
      { id: 'f6f6f6f6-0075-4000-8000-000000000075', task_id: 'e5e5e5e5-0022-4000-8000-000000000022', title: 'Email notification to assigned agent',    completed: false, sort_order: 3 },
    ],
    comments: [
      { id: 'aabbccdd-0025-4000-8000-000000000025', task_id: 'e5e5e5e5-0022-4000-8000-000000000022', user_id: TM1, text: 'Rachel already has HubSpot set up. We just need to wire the Zap and map the fields.', created_at: daysAgo(5) },
    ],
    created_at: daysAgo(9), updated_at: daysAgo(5),
  },
  { id: 'e5e5e5e5-0023-4000-8000-000000000023', project_id: 'c3c3c3c3-0004-4000-8000-000000000004', title: 'Staging deploy & client review',   description: 'Deploy to Vercel preview, walk Rachel through the full site.',                  status: 'todo',        priority: 'medium', assignee_ids: [TM1], due_date: '2026-05-01', tags: ['qa','web'], subtasks: [], comments: [], created_at: daysAgo(9), updated_at: daysAgo(9) },

  // === Peak Outdoor (completed — all done) ===
  {
    id: 'e5e5e5e5-0024-4000-8000-000000000024', project_id: 'c3c3c3c3-0005-4000-8000-000000000005', title: 'Shopify Plus theme development',   description: 'Custom Liquid theme with mega-menu, product filtering, and quick-view.',        status: 'done',        priority: 'high',   assignee_ids: [TM4], due_date: '2025-12-01', tags: ['development','shopify'],
    subtasks: [
      { id: 'f6f6f6f6-0023-4000-8000-000000000023', task_id: 'e5e5e5e5-0024-4000-8000-000000000024', title: 'Mega-menu with collections',    completed: true, sort_order: 0 },
      { id: 'f6f6f6f6-0024-4000-8000-000000000024', task_id: 'e5e5e5e5-0024-4000-8000-000000000024', title: 'Product filtering & sorting',   completed: true, sort_order: 1 },
      { id: 'f6f6f6f6-0025-4000-8000-000000000025', task_id: 'e5e5e5e5-0024-4000-8000-000000000024', title: 'Quick-view modal',              completed: true, sort_order: 2 },
      { id: 'f6f6f6f6-0026-4000-8000-000000000026', task_id: 'e5e5e5e5-0024-4000-8000-000000000024', title: 'Mobile responsive pass',        completed: true, sort_order: 3 },
    ],
    comments: [
      { id: 'aabbccdd-0014-4000-8000-000000000014', task_id: 'e5e5e5e5-0024-4000-8000-000000000024', user_id: TM4, text: 'Theme is live! Tom is really happy with the mega-menu.', created_at: daysAgo(35) },
    ],
    created_at: daysAgo(140), updated_at: daysAgo(35),
  },
  { id: 'e5e5e5e5-0025-4000-8000-000000000025', project_id: 'c3c3c3c3-0005-4000-8000-000000000005', title: 'Product data migration',           description: 'Migrate 2,400 SKUs from WooCommerce with images and variants.',                 status: 'done',        priority: 'urgent', assignee_ids: [TM3], due_date: '2025-12-15', tags: ['data','shopify'], subtasks: [], comments: [], created_at: daysAgo(140), updated_at: daysAgo(40) },
  {
    id: 'e5e5e5e5-0026-4000-8000-000000000026', project_id: 'c3c3c3c3-0005-4000-8000-000000000005', title: 'Checkout & payments testing',      description: 'Stripe, PayPal, Apple Pay. Test all discount code scenarios.',                  status: 'done',        priority: 'high',   assignee_ids: [TM3, TM4], due_date: '2026-01-05', tags: ['qa','shopify'],
    subtasks: [],
    comments: [
      { id: 'aabbccdd-0015-4000-8000-000000000015', task_id: 'e5e5e5e5-0026-4000-8000-000000000026', user_id: TM3, text: 'All payment methods verified. Discount codes working across all scenarios.', created_at: daysAgo(30) },
    ],
    created_at: daysAgo(120), updated_at: daysAgo(30),
  },
];

// ---------------------------------------------------------------------------
// 6. LEADS
// ---------------------------------------------------------------------------
export const demoLeads: Lead[] = [
  { id: '77770001-0001-4000-8000-000000000001', name: 'Nathan Cross',     email: 'nathan@crosslegalbr.com',     phone: '(202) 555-0177', company: 'Cross Legal Group',      source: 'referral',       status: 'qualified', value: 18000, equity: null,  notes: 'Referred by David Lawson. Wants a clean, professional site redesign. Budget ~$18K.',                assigned_to: TM1, member_ids: [TM1],      contact_id: 'b2b2b2b2-0009-4000-8000-000000000009', created_at: daysAgo(25), updated_at: daysAgo(3) },
  { id: '77770001-0002-4000-8000-000000000002', name: 'Yuki Tanaka',      email: 'yuki@kaizenfit.com',          phone: '(808) 555-0233', company: 'Kaizen Fitness',         source: 'website',        status: 'proposal',  value: 25000, equity: null,  notes: 'Filled out the website form. Building a fitness app — needs branding + landing page. Sent proposal.', assigned_to: TM3, member_ids: [TM3],      contact_id: 'b2b2b2b2-0010-4000-8000-000000000010', created_at: daysAgo(20), updated_at: daysAgo(4) },
  { id: '77770001-0003-4000-8000-000000000003', name: 'Olivia Grant',     email: 'olivia@sunnysidecafe.com',    phone: '(541) 555-0198', company: 'Sunnyside Cafe',         source: 'social',         status: 'contacted', value: 5000,  equity: null,  notes: 'Reached out via Instagram DM. Looking for a simple website + online ordering.',                      assigned_to: TM2, member_ids: [TM2],      contact_id: 'b2b2b2b2-0011-4000-8000-000000000011', created_at: daysAgo(15), updated_at: daysAgo(8) },
  { id: '77770001-0004-4000-8000-000000000004', name: 'Marcus Lee',       email: 'mlee@velocityauto.com',       phone: '(469) 555-0411', company: 'Velocity Auto Group',    source: 'cold_outreach',  status: 'new',       value: 35000, equity: null,  notes: 'Multi-location dealership. Could be a big account — website + inventory system.',                    assigned_to: null, member_ids: [],         contact_id: 'b2b2b2b2-0012-4000-8000-000000000012', created_at: daysAgo(5),  updated_at: daysAgo(5) },
  { id: '77770001-0005-4000-8000-000000000005', name: 'Diana Frost',      email: 'diana@frostinteriors.com',    phone: '(917) 555-0266', company: 'Frost Interiors',        source: 'event',          status: 'new',       value: 12000, equity: null,  notes: 'Met at the NYC Design Week mixer. Portfolio website for her interior design firm.',                  assigned_to: null, member_ids: [],         contact_id: 'b2b2b2b2-0013-4000-8000-000000000013', created_at: daysAgo(3),  updated_at: daysAgo(3) },
  { id: '77770001-0006-4000-8000-000000000006', name: 'Kevin Park',       email: 'kevin@greenleafnursery.com',  phone: '(360) 555-0344', company: 'Greenleaf Nursery',      source: 'referral',       status: 'contacted', value: 8000,  equity: null,  notes: 'Referred by Tom at Peak Outdoor. E-commerce site for plants and garden supplies.',                   assigned_to: TM4, member_ids: [TM4],      contact_id: 'b2b2b2b2-0014-4000-8000-000000000014', created_at: daysAgo(12), updated_at: daysAgo(6) },
  { id: '77770001-0007-4000-8000-000000000007', name: 'Amanda Chen',      email: 'achen@brightwaveai.com',      phone: '(650) 555-0122', company: 'BrightWave AI',          source: 'website',        status: 'qualified', value: 45000, equity: null,  notes: 'AI startup. Needs full brand + website before their demo day in May.',                               assigned_to: TM1, member_ids: [TM1],      contact_id: 'b2b2b2b2-0015-4000-8000-000000000015', created_at: daysAgo(10), updated_at: daysAgo(2) },
  { id: '77770001-0008-4000-8000-000000000008', name: 'Robert Simmons',   email: 'rob@heartlandbrewing.com',    phone: '(614) 555-0289', company: 'Heartland Brewing Co.',  source: 'social',         status: 'lost',      value: 15000, equity: null,  notes: 'Was interested in a website redesign but went with a cheaper local agency.',                         assigned_to: TM2, member_ids: [TM2],      contact_id: 'b2b2b2b2-0016-4000-8000-000000000016', created_at: daysAgo(30), updated_at: daysAgo(15) },
  { id: '77770001-0009-4000-8000-000000000009', name: 'Patricia Vega',    email: 'patricia@vegadental.com',     phone: '(305) 555-0399', company: 'Vega Dental Group',      source: 'referral',       status: 'contacted', value: 14000, equity: null,  notes: 'Referred by Nathan Cross. Dental practice needing patient-facing website + online booking system.',  assigned_to: TM3, member_ids: [TM3, TM1], contact_id: 'b2b2b2b2-0017-4000-8000-000000000017', created_at: daysAgo(8),  updated_at: daysAgo(2) },
  { id: '77770001-0010-4000-8000-000000000010', name: 'Derek Holt',       email: 'derek@holtconstruction.com',  phone: '(404) 555-0512', company: 'Holt Construction',      source: 'website',        status: 'qualified', value: 22000, equity: null,  notes: 'Filled out inquiry form. Wants project showcase site with before/after galleries + lead gen forms.', assigned_to: TM2, member_ids: [TM2, TM4], contact_id: 'b2b2b2b2-0018-4000-8000-000000000018', created_at: daysAgo(6),  updated_at: daysAgo(1) },
  { id: '77770001-0011-4000-8000-000000000011', name: 'Mei-Lin Chang',    email: 'meiling@savorstreet.co',      phone: '(212) 555-0678', company: 'Savor Street Food Hall',  source: 'event',          status: 'new',       value: 28000, equity: 5,     notes: 'Met at NYC food & bev networking event. Multi-vendor food hall opening in Tribeca. Needs full digital presence — website, vendor portal, social launch.', assigned_to: null, member_ids: [], contact_id: 'b2b2b2b2-0019-4000-8000-000000000019', created_at: daysAgo(2), updated_at: daysAgo(1) },
  { id: '77770001-0012-4000-8000-000000000012', name: 'Tom Nguyen',       email: 'tom.nguyen@peakoutdoors.com', phone: '(503) 555-0219', company: 'Peak Outdoor Co.',        source: 'referral',       status: 'won',       value: 8500,  equity: null,  notes: 'Follow-up from the completed Shopify project. Wants ongoing SEO + content retainer.',                assigned_to: TM2, member_ids: [TM2],      contact_id: 'b2b2b2b2-0005-4000-8000-000000000005', created_at: daysAgo(28), updated_at: daysAgo(20) },
];

// ---------------------------------------------------------------------------
// 7. ACTIVITIES
// ---------------------------------------------------------------------------
export const demoActivities: Activity[] = [
  { id: '99990001-0001-4000-8000-000000000001', type: 'task_completed',  entity_id: 'e5e5e5e5-0001-4000-8000-000000000001', entity_type: 'task',    user_id: TM1, description: 'Completed "Discovery & brand audit"',                        metadata: { project: 'Crest Financial Rebrand' },           created_at: daysAgo(20) },
  { id: '99990001-0002-4000-8000-000000000002', type: 'task_completed',  entity_id: 'e5e5e5e5-0002-4000-8000-000000000002', entity_type: 'task',    user_id: TM3, description: 'Completed "Logo concepts — round 1"',                       metadata: { project: 'Crest Financial Rebrand' },           created_at: daysAgo(14) },
  { id: '99990001-0003-4000-8000-000000000003', type: 'project_updated', entity_id: 'c3c3c3c3-0005-4000-8000-000000000005', entity_type: 'project', user_id: TM3, description: 'Marked "Peak Outdoor Shopify Migration" as completed',       metadata: {},                                               created_at: daysAgo(34) },
  { id: '99990001-0004-4000-8000-000000000004', type: 'task_created',    entity_id: 'e5e5e5e5-0010-4000-8000-000000000010', entity_type: 'task',    user_id: TM1, description: 'Created "Auth & onboarding screens"',                       metadata: { project: 'Bloomwell Health App' },              created_at: daysAgo(10) },
  { id: '99990001-0005-4000-8000-000000000005', type: 'comment_added',   entity_id: 'aabbccdd-0010-4000-8000-000000000010', entity_type: 'comment', user_id: TM2, description: 'Commented on "Homepage & landing page design"',              metadata: { task: 'Homepage & landing page design' },       created_at: daysAgo(3) },
  { id: '99990001-0006-4000-8000-000000000006', type: 'task_updated',    entity_id: 'e5e5e5e5-0009-4000-8000-000000000009', entity_type: 'task',    user_id: TM3, description: 'Moved "UI kit & design system" to In Review',                metadata: { project: 'Bloomwell Health App' },              created_at: daysAgo(1) },
  { id: '99990001-0007-4000-8000-000000000007', type: 'task_completed',  entity_id: 'e5e5e5e5-0008-4000-8000-000000000008', entity_type: 'task',    user_id: TM1, description: 'Completed "User flow & IA mapping"',                        metadata: { project: 'Bloomwell Health App' },              created_at: daysAgo(7) },
  { id: '99990001-0008-4000-8000-000000000008', type: 'task_completed',  entity_id: 'e5e5e5e5-0014-4000-8000-000000000014', entity_type: 'task',    user_id: TM2, description: 'Completed "Content strategy & copywriting"',                  metadata: { project: 'NeoForge Website' },                  created_at: daysAgo(12) },
  { id: '99990001-0009-4000-8000-000000000009', type: 'member_added',    entity_id: 'a1a1a1a1-0005-4000-8000-000000000005', entity_type: 'member',  user_id: TM1, description: 'Added Priya Patel to the team',                             metadata: {},                                               created_at: daysAgo(45) },
  { id: '99990001-0010-4000-8000-000000000010', type: 'task_created',    entity_id: 'e5e5e5e5-0019-4000-8000-000000000019', entity_type: 'task',    user_id: TM1, description: 'Created "IDX/MLS integration research"',                     metadata: { project: 'Solstice Realty Platform' },          created_at: daysAgo(5) },
  { id: '99990001-0011-4000-8000-000000000011', type: 'comment_added',   entity_id: 'aabbccdd-0013-4000-8000-000000000013', entity_type: 'comment', user_id: TM1, description: 'Commented on "IDX/MLS integration research"',                 metadata: { task: 'IDX/MLS integration research' },         created_at: hoursAgo(6) },
  { id: '99990001-0012-4000-8000-000000000012', type: 'task_completed',  entity_id: 'e5e5e5e5-0024-4000-8000-000000000024', entity_type: 'task',    user_id: TM4, description: 'Completed "Shopify Plus theme development"',                  metadata: { project: 'Peak Outdoor Shopify Migration' },    created_at: daysAgo(50) },
  { id: '99990001-0013-4000-8000-000000000013', type: 'task_completed',  entity_id: 'e5e5e5e5-0025-4000-8000-000000000025', entity_type: 'task',    user_id: TM3, description: 'Completed "Product data migration"',                           metadata: { project: 'Peak Outdoor Shopify Migration' },    created_at: daysAgo(40) },
  { id: '99990001-0014-4000-8000-000000000014', type: 'task_completed',  entity_id: 'e5e5e5e5-0026-4000-8000-000000000026', entity_type: 'task',    user_id: TM3, description: 'Completed "Checkout & payments testing"',                      metadata: { project: 'Peak Outdoor Shopify Migration' },    created_at: daysAgo(30) },
  { id: '99990001-0015-4000-8000-000000000015', type: 'task_created',    entity_id: 'e5e5e5e5-0020-4000-8000-000000000020', entity_type: 'task',    user_id: TM1, description: 'Created "Property search UI"',                                 metadata: { project: 'Solstice Realty Platform' },          created_at: daysAgo(9) },
  { id: '99990001-0016-4000-8000-000000000016', type: 'comment_added',   entity_id: 'aabbccdd-0024-4000-8000-000000000024', entity_type: 'comment', user_id: TM2, description: 'Commented on "Property search UI"',                             metadata: { task: 'Property search UI' },                   created_at: daysAgo(7) },
  { id: '99990001-0017-4000-8000-000000000017', type: 'task_updated',    entity_id: 'e5e5e5e5-0003-4000-8000-000000000003', entity_type: 'task',    user_id: TM3, description: 'Updated "Brand guidelines document" — completed typography subtask', metadata: { project: 'Crest Financial Rebrand' },     created_at: daysAgo(2) },
  { id: '99990001-0018-4000-8000-000000000018', type: 'comment_added',   entity_id: 'aabbccdd-0022-4000-8000-000000000022', entity_type: 'comment', user_id: TM2, description: 'Commented on "Inner pages design"',                              metadata: { task: 'Inner pages design' },                   created_at: daysAgo(4) },
  { id: '99990001-0019-4000-8000-000000000019', type: 'task_created',    entity_id: 'e5e5e5e5-0011-4000-8000-000000000011', entity_type: 'task',    user_id: TM1, description: 'Created "Appointment booking module"',                         metadata: { project: 'Bloomwell Health App' },              created_at: daysAgo(10) },
  { id: '99990001-0020-4000-8000-000000000020', type: 'task_created',    entity_id: 'e5e5e5e5-0012-4000-8000-000000000012', entity_type: 'task',    user_id: TM1, description: 'Created "Secure messaging implementation"',                    metadata: { project: 'Bloomwell Health App' },              created_at: daysAgo(10) },
  { id: '99990001-0021-4000-8000-000000000021', type: 'comment_added',   entity_id: 'aabbccdd-0019-4000-8000-000000000019', entity_type: 'comment', user_id: TM4, description: 'Commented on "Appointment booking module"',                     metadata: { task: 'Appointment booking module' },           created_at: daysAgo(8) },
  { id: '99990001-0022-4000-8000-000000000022', type: 'task_updated',    entity_id: 'e5e5e5e5-0016-4000-8000-000000000016', entity_type: 'task',    user_id: TM2, description: 'Updated "Inner pages design" — completed pricing subtask',        metadata: { project: 'NeoForge Website' },                  created_at: daysAgo(5) },
  { id: '99990001-0023-4000-8000-000000000023', type: 'project_updated', entity_id: 'c3c3c3c3-0006-4000-8000-000000000006', entity_type: 'project', user_id: TM1, description: 'Archived "UrbanPulse Brand Package"',                           metadata: {},                                               created_at: daysAgo(80) },
  { id: '99990001-0024-4000-8000-000000000024', type: 'member_added',    entity_id: 'a1a1a1a1-0004-4000-8000-000000000004', entity_type: 'member',  user_id: TM1, description: 'Added Jake Thompson to the team',                              metadata: {},                                               created_at: daysAgo(60) },
  { id: '99990001-0025-4000-8000-000000000025', type: 'comment_added',   entity_id: 'aabbccdd-0025-4000-8000-000000000025', entity_type: 'comment', user_id: TM1, description: 'Commented on "Lead capture & CRM integration"',                 metadata: { task: 'Lead capture & CRM integration' },       created_at: daysAgo(5) },
  { id: '99990001-0026-4000-8000-000000000026', type: 'task_completed',  entity_id: 'e5e5e5e5-0014-4000-8000-000000000014', entity_type: 'task',    user_id: TM2, description: 'Completed "Content strategy & copywriting"',                  metadata: { project: 'NeoForge Website' },                  created_at: daysAgo(12) },
  { id: '99990001-0027-4000-8000-000000000027', type: 'comment_added',   entity_id: 'aabbccdd-0003-4000-8000-000000000003', entity_type: 'comment', user_id: TM1, description: 'Commented on "Brand guidelines document"',                     metadata: { task: 'Brand guidelines document' },            created_at: daysAgo(1) },
  { id: '99990001-0028-4000-8000-000000000028', type: 'comment_added',   entity_id: 'aabbccdd-0007-4000-8000-000000000007', entity_type: 'comment', user_id: TM1, description: 'Commented on "UI kit & design system"',                       metadata: { task: 'UI kit & design system' },               created_at: hoursAgo(12) },
];

// ---------------------------------------------------------------------------
// 8. Empty arrays for lead sub-entities (no seed data for these)
// ---------------------------------------------------------------------------
export const demoLeadInteractions: LeadInteraction[] = [
  // Nathan Cross (qualified)
  { id: 'li-0001-4000-8000-000000000001', lead_id: '77770001-0001-4000-8000-000000000001', type: 'call',      title: 'Intro call with Nathan',                description: 'David Lawson connected us. Nathan wants a modern, professional website for his law firm. Current site is 8 years old. He values clean design and fast load times.',  occurred_at: daysAgo(24), scheduled_at: null, completed: true, created_at: daysAgo(24), updated_at: daysAgo(24) },
  { id: 'li-0002-4000-8000-000000000002', lead_id: '77770001-0001-4000-8000-000000000001', type: 'email',     title: 'Sent portfolio & case studies',          description: 'Shared our legal/professional services portfolio — Crest Financial as a reference. Nathan replied saying he\'s impressed.',                                          occurred_at: daysAgo(22), scheduled_at: null, completed: true, created_at: daysAgo(22), updated_at: daysAgo(22) },
  { id: 'li-0003-4000-8000-000000000003', lead_id: '77770001-0001-4000-8000-000000000001', type: 'meeting',   title: 'Discovery meeting — scope review',       description: 'Walked through his current site, discussed pain points. He wants 8 pages, blog, attorney profiles, and a client portal. Budget is $18K.',                           occurred_at: daysAgo(18), scheduled_at: null, completed: true, created_at: daysAgo(18), updated_at: daysAgo(18) },
  { id: 'li-0004-4000-8000-000000000004', lead_id: '77770001-0001-4000-8000-000000000001', type: 'note',      title: 'Internal: proposal prep notes',          description: 'Nathan is a strong lead — clear budget, quick decision maker, and David vouched for us. Let\'s prioritize this one.',                                               occurred_at: daysAgo(10), scheduled_at: null, completed: true, created_at: daysAgo(10), updated_at: daysAgo(10) },
  { id: 'li-0005-4000-8000-000000000005', lead_id: '77770001-0001-4000-8000-000000000001', type: 'follow_up', title: 'Follow up on proposal',                  description: 'Need to send the proposal and check in early next week.',                                                                                                          occurred_at: daysAgo(3),  scheduled_at: daysAgo(-3), completed: false, created_at: daysAgo(3), updated_at: daysAgo(3) },

  // Yuki Tanaka (proposal)
  { id: 'li-0006-4000-8000-000000000006', lead_id: '77770001-0002-4000-8000-000000000002', type: 'email',     title: 'Inbound form submission',                description: 'Yuki filled out our website contact form. She\'s building a fitness app and needs branding + landing page. Sounds excited about the project.',                       occurred_at: daysAgo(19), scheduled_at: null, completed: true, created_at: daysAgo(19), updated_at: daysAgo(19) },
  { id: 'li-0007-4000-8000-000000000007', lead_id: '77770001-0002-4000-8000-000000000002', type: 'call',      title: 'Discovery call',                         description: 'Great call with Yuki. She\'s a former personal trainer launching Kaizen Fitness — an app for personalized workout plans. Needs logo, brand identity, and a landing page to launch with. Budget ~$25K.', occurred_at: daysAgo(17), scheduled_at: null, completed: true, created_at: daysAgo(17), updated_at: daysAgo(17) },
  { id: 'li-0008-4000-8000-000000000008', lead_id: '77770001-0002-4000-8000-000000000002', type: 'meeting',   title: 'Brand vision workshop',                  description: 'Ran a mini brand workshop over Zoom. Yuki wants a bold, energetic brand — think neon green + dark backgrounds. She shared a mood board with references from Nike Training and Calm.', occurred_at: daysAgo(12), scheduled_at: null, completed: true, created_at: daysAgo(12), updated_at: daysAgo(12) },
  { id: 'li-0009-4000-8000-000000000009', lead_id: '77770001-0002-4000-8000-000000000002', type: 'email',     title: 'Proposal sent',                          description: 'Sent the full proposal — Brand Identity ($12K) + Landing Page ($13K). Total $25K with 50% upfront. Timeline: 8 weeks.',                                             occurred_at: daysAgo(7),  scheduled_at: null, completed: true, created_at: daysAgo(7), updated_at: daysAgo(7) },
  { id: 'li-0010-4000-8000-000000000010', lead_id: '77770001-0002-4000-8000-000000000002', type: 'follow_up', title: 'Check in on proposal decision',           description: 'Yuki said she\'d review over the weekend. Follow up Monday.',                                                                                                      occurred_at: daysAgo(4),  scheduled_at: daysAgo(-1), completed: false, created_at: daysAgo(4), updated_at: daysAgo(4) },

  // Olivia Grant (contacted)
  { id: 'li-0011-4000-8000-000000000011', lead_id: '77770001-0003-4000-8000-000000000003', type: 'note',      title: 'Instagram DM conversation',              description: 'Olivia reached out via our Instagram. She owns Sunnyside Cafe in Portland and wants a simple site with menu, hours, and online ordering through Square.',            occurred_at: daysAgo(14), scheduled_at: null, completed: true, created_at: daysAgo(14), updated_at: daysAgo(14) },
  { id: 'li-0012-4000-8000-000000000012', lead_id: '77770001-0003-4000-8000-000000000003', type: 'call',      title: 'Quick intro call',                       description: 'Short 15-minute call. She has a $5K budget and needs it done in 4 weeks for their spring menu launch. Straightforward project.',                                    occurred_at: daysAgo(10), scheduled_at: null, completed: true, created_at: daysAgo(10), updated_at: daysAgo(10) },
  { id: 'li-0013-4000-8000-000000000013', lead_id: '77770001-0003-4000-8000-000000000003', type: 'follow_up', title: 'Send quote for simple site',              description: 'Put together a quick quote for the 4-page site + Square integration.',                                                                                             occurred_at: daysAgo(8),  scheduled_at: daysAgo(-2), completed: false, created_at: daysAgo(8), updated_at: daysAgo(8) },

  // Kevin Park (contacted)
  { id: 'li-0014-4000-8000-000000000014', lead_id: '77770001-0006-4000-8000-000000000006', type: 'call',      title: 'Intro call — referred by Tom Nguyen',    description: 'Tom from Peak Outdoor connected us. Kevin wants to sell plants + garden supplies online. Currently no web presence at all.',                                         occurred_at: daysAgo(11), scheduled_at: null, completed: true, created_at: daysAgo(11), updated_at: daysAgo(11) },
  { id: 'li-0015-4000-8000-000000000015', lead_id: '77770001-0006-4000-8000-000000000006', type: 'email',     title: 'Sent Shopify examples',                  description: 'Shared three Shopify e-commerce examples similar to his niche. He liked the clean greenhouse nursery one.',                                                          occurred_at: daysAgo(8),  scheduled_at: null, completed: true, created_at: daysAgo(8), updated_at: daysAgo(8) },
  { id: 'li-0016-4000-8000-000000000016', lead_id: '77770001-0006-4000-8000-000000000006', type: 'follow_up', title: 'Schedule scope call',                     description: 'Kevin wants to chat more about inventory management. Need to set up a deeper scope call this week.',                                                                occurred_at: daysAgo(6),  scheduled_at: daysAgo(-1), completed: false, created_at: daysAgo(6), updated_at: daysAgo(6) },

  // Amanda Chen (qualified)
  { id: 'li-0017-4000-8000-000000000017', lead_id: '77770001-0007-4000-8000-000000000007', type: 'email',     title: 'Inbound — website form',                 description: 'Amanda filled out our form requesting branding + website for BrightWave AI. They\'re pre-Series A and have a demo day in May.',                                     occurred_at: daysAgo(9),  scheduled_at: null, completed: true, created_at: daysAgo(9), updated_at: daysAgo(9) },
  { id: 'li-0018-4000-8000-000000000018', lead_id: '77770001-0007-4000-8000-000000000007', type: 'call',      title: 'Discovery call with Amanda',              description: 'Impressive founder. BrightWave does AI-powered customer insights for e-commerce. They need brand identity, website, and pitch deck design before their May 15 demo day. Budget is $45K — very serious.', occurred_at: daysAgo(7), scheduled_at: null, completed: true, created_at: daysAgo(7), updated_at: daysAgo(7) },
  { id: 'li-0019-4000-8000-000000000019', lead_id: '77770001-0007-4000-8000-000000000007', type: 'meeting',   title: 'Team intro + scope workshop',            description: 'Brought Sarah and Jake into a workshop with Amanda\'s team. Mapped out deliverables: logo + brand guide, 6-page website, investor pitch deck. Timeline is tight — 10 weeks.', occurred_at: daysAgo(4), scheduled_at: null, completed: true, created_at: daysAgo(4), updated_at: daysAgo(4) },
  { id: 'li-0020-4000-8000-000000000020', lead_id: '77770001-0007-4000-8000-000000000007', type: 'note',      title: 'Internal: high-priority prospect',        description: 'This is our biggest pipeline opportunity right now. Amanda is decisive and well-funded. Let\'s fast-track the proposal.',                                            occurred_at: daysAgo(2),  scheduled_at: null, completed: true, created_at: daysAgo(2), updated_at: daysAgo(2) },
  { id: 'li-0021-4000-8000-000000000021', lead_id: '77770001-0007-4000-8000-000000000007', type: 'follow_up', title: 'Send proposal by end of week',            description: 'Proposal is 90% done. Need to finalize the timeline and send by Friday.',                                                                                          occurred_at: daysAgo(1),  scheduled_at: daysAgo(-2), completed: false, created_at: daysAgo(1), updated_at: daysAgo(1) },

  // Robert Simmons (lost)
  { id: 'li-0022-4000-8000-000000000022', lead_id: '77770001-0008-4000-8000-000000000008', type: 'email',     title: 'Initial outreach',                       description: 'Robert DM\'d us on Twitter about a taproom website redesign. Sent him our craft beverage portfolio.',                                                               occurred_at: daysAgo(28), scheduled_at: null, completed: true, created_at: daysAgo(28), updated_at: daysAgo(28) },
  { id: 'li-0023-4000-8000-000000000023', lead_id: '77770001-0008-4000-8000-000000000008', type: 'call',      title: 'Scope call',                              description: 'Nice guy but very price-sensitive. Wants a full site with events calendar, taproom menu, and online merch. Budget is only $15K.',                                    occurred_at: daysAgo(25), scheduled_at: null, completed: true, created_at: daysAgo(25), updated_at: daysAgo(25) },
  { id: 'li-0024-4000-8000-000000000024', lead_id: '77770001-0008-4000-8000-000000000008', type: 'email',     title: 'Sent proposal',                           description: 'Sent a scaled-back proposal at $15K. We made it work but margins are tight.',                                                                                      occurred_at: daysAgo(22), scheduled_at: null, completed: true, created_at: daysAgo(22), updated_at: daysAgo(22) },
  { id: 'li-0025-4000-8000-000000000025', lead_id: '77770001-0008-4000-8000-000000000008', type: 'email',     title: 'Robert chose another agency',             description: 'Robert emailed saying he found a local Columbus agency that can do it for $8K. Wished us well. No hard feelings — we were out of his range.',                        occurred_at: daysAgo(15), scheduled_at: null, completed: true, created_at: daysAgo(15), updated_at: daysAgo(15) },

  // Patricia Vega (contacted)
  { id: 'li-0026-4000-8000-000000000026', lead_id: '77770001-0009-4000-8000-000000000009', type: 'call',      title: 'Intro call — referred by Nathan Cross',  description: 'Nathan connected us with Patricia. She runs a dental group in Miami and needs a patient-facing website with online booking. She\'s comparing 3 agencies.',           occurred_at: daysAgo(7),  scheduled_at: null, completed: true, created_at: daysAgo(7), updated_at: daysAgo(7) },
  { id: 'li-0027-4000-8000-000000000027', lead_id: '77770001-0009-4000-8000-000000000009', type: 'email',     title: 'Sent healthcare portfolio',               description: 'Shared our Bloomwell case study and two other healthcare projects. Patricia was impressed with the HIPAA-awareness.',                                                occurred_at: daysAgo(5),  scheduled_at: null, completed: true, created_at: daysAgo(5), updated_at: daysAgo(5) },
  { id: 'li-0028-4000-8000-000000000028', lead_id: '77770001-0009-4000-8000-000000000009', type: 'follow_up', title: 'Schedule discovery meeting',               description: 'Patricia wants to loop in her office manager for a deeper requirements discussion.',                                                                                occurred_at: daysAgo(2),  scheduled_at: daysAgo(-4), completed: false, created_at: daysAgo(2), updated_at: daysAgo(2) },

  // Derek Holt (qualified)
  { id: 'li-0029-4000-8000-000000000029', lead_id: '77770001-0010-4000-8000-000000000010', type: 'email',     title: 'Inbound inquiry — website form',          description: 'Derek found us through Google. He runs a construction company in Atlanta and wants a project showcase site with before/after galleries.',                            occurred_at: daysAgo(5),  scheduled_at: null, completed: true, created_at: daysAgo(5), updated_at: daysAgo(5) },
  { id: 'li-0030-4000-8000-000000000030', lead_id: '77770001-0010-4000-8000-000000000010', type: 'call',      title: 'Discovery call with Derek',               description: 'Great call. Holt Construction does residential and commercial builds. He wants a 10-page site with project galleries, team page, and lead gen forms. Budget is $22K, timeline 6-8 weeks.', occurred_at: daysAgo(3), scheduled_at: null, completed: true, created_at: daysAgo(3), updated_at: daysAgo(3) },
  { id: 'li-0031-4000-8000-000000000031', lead_id: '77770001-0010-4000-8000-000000000010', type: 'note',      title: 'Internal: solid mid-range prospect',      description: 'Derek is practical and knows what he wants. Not flashy but a clean project with good margins. Marcus is taking point.',                                              occurred_at: daysAgo(1),  scheduled_at: null, completed: true, created_at: daysAgo(1), updated_at: daysAgo(1) },

  // Tom Nguyen retainer (won)
  { id: 'li-0032-4000-8000-000000000032', lead_id: '77770001-0012-4000-8000-000000000012', type: 'call',      title: 'Retainer discussion',                     description: 'Tom reached out about ongoing SEO + content work after the Shopify project. He\'s happy with our work and wants to keep the momentum.',                              occurred_at: daysAgo(27), scheduled_at: null, completed: true, created_at: daysAgo(27), updated_at: daysAgo(27) },
  { id: 'li-0033-4000-8000-000000000033', lead_id: '77770001-0012-4000-8000-000000000012', type: 'email',     title: 'Retainer proposal sent',                  description: 'Sent a monthly retainer proposal: $2,500/mo for SEO audits, 4 blog posts, and monthly reporting.',                                                                  occurred_at: daysAgo(24), scheduled_at: null, completed: true, created_at: daysAgo(24), updated_at: daysAgo(24) },
  { id: 'li-0034-4000-8000-000000000034', lead_id: '77770001-0012-4000-8000-000000000012', type: 'email',     title: 'Retainer accepted!',                      description: 'Tom signed the retainer. Starting March 1. This is a great recurring revenue add.',                                                                                  occurred_at: daysAgo(20), scheduled_at: null, completed: true, created_at: daysAgo(20), updated_at: daysAgo(20) },
];

export const demoLeadProposals: LeadProposal[] = [
  // Nathan Cross — proposal in draft
  { id: 'lp-0001-4000-8000-000000000001', lead_id: '77770001-0001-4000-8000-000000000001', title: 'Cross Legal Group — Website Redesign',             description: '8-page professional website with attorney profiles, blog, client portal, and contact forms. Built on Next.js with Sanity CMS.',                                 estimated_value: 18000, status: 'draft',    sent_at: null,       created_at: daysAgo(8),  updated_at: daysAgo(3) },

  // Yuki Tanaka — proposal sent
  { id: 'lp-0002-4000-8000-000000000002', lead_id: '77770001-0002-4000-8000-000000000002', title: 'Kaizen Fitness — Brand Identity + Landing Page',    description: 'Full brand identity package (logo, colors, typography, brand guide) plus a high-converting landing page with app waitlist signup. Phase 1 of 2.',                    estimated_value: 25000, status: 'sent',     sent_at: daysAgo(7), created_at: daysAgo(9),  updated_at: daysAgo(7) },

  // Amanda Chen — drafting
  { id: 'lp-0003-4000-8000-000000000003', lead_id: '77770001-0007-4000-8000-000000000007', title: 'BrightWave AI — Brand + Website + Pitch Deck',      description: 'Complete brand identity, 6-page marketing website, and investor pitch deck. Tight timeline — must be ready for May 15 demo day.',                                   estimated_value: 45000, status: 'draft',    sent_at: null,       created_at: daysAgo(2),  updated_at: daysAgo(1) },

  // Robert Simmons — rejected
  { id: 'lp-0004-4000-8000-000000000004', lead_id: '77770001-0008-4000-8000-000000000008', title: 'Heartland Brewing — Website Redesign',              description: 'Scaled-back redesign with events calendar, taproom menu, and merch shop. Built on WordPress for easier self-management.',                                           estimated_value: 15000, status: 'rejected', sent_at: daysAgo(22), created_at: daysAgo(23), updated_at: daysAgo(15) },

  // Tom Nguyen retainer — accepted
  { id: 'lp-0005-4000-8000-000000000005', lead_id: '77770001-0012-4000-8000-000000000012', title: 'Peak Outdoor — Monthly SEO + Content Retainer',     description: 'Ongoing monthly retainer: technical SEO audits, 4 blog posts per month, keyword research, and monthly analytics reporting.',                                        estimated_value: 8500,  status: 'accepted', sent_at: daysAgo(24), created_at: daysAgo(25), updated_at: daysAgo(20) },

  // Olivia Grant — small proposal draft
  { id: 'lp-0006-4000-8000-000000000006', lead_id: '77770001-0003-4000-8000-000000000003', title: 'Sunnyside Cafe — Simple Website + Online Ordering', description: '4-page cafe website with menu, hours/location, about story, and Square Online ordering integration.',                                                                estimated_value: 5000,  status: 'draft',    sent_at: null,       created_at: daysAgo(6),  updated_at: daysAgo(6) },
];

export const demoLeadFields: LeadField[] = [
  // Nathan Cross fields
  { id: 'lf-0001-4000-8000-000000000001', lead_id: '77770001-0001-4000-8000-000000000001', field_key: 'website',             value: 'https://crosslegalgroup.com',                                  created_at: daysAgo(24), updated_at: daysAgo(24) },
  { id: 'lf-0002-4000-8000-000000000002', lead_id: '77770001-0001-4000-8000-000000000001', field_key: 'industry',            value: 'Legal',                                                        created_at: daysAgo(24), updated_at: daysAgo(24) },
  { id: 'lf-0003-4000-8000-000000000003', lead_id: '77770001-0001-4000-8000-000000000001', field_key: 'product_service',     value: 'Corporate law & estate planning',                               created_at: daysAgo(24), updated_at: daysAgo(24) },
  { id: 'lf-0004-4000-8000-000000000004', lead_id: '77770001-0001-4000-8000-000000000001', field_key: 'location',            value: 'Washington, DC',                                               created_at: daysAgo(24), updated_at: daysAgo(24) },
  { id: 'lf-0005-4000-8000-000000000005', lead_id: '77770001-0001-4000-8000-000000000001', field_key: 'services_interested', value: 'Web Design,Web Dev',                                           created_at: daysAgo(18), updated_at: daysAgo(18) },
  { id: 'lf-0006-4000-8000-000000000006', lead_id: '77770001-0001-4000-8000-000000000001', field_key: 'budget_range',        value: '$15K-$50K',                                                    created_at: daysAgo(18), updated_at: daysAgo(18) },
  { id: 'lf-0007-4000-8000-000000000007', lead_id: '77770001-0001-4000-8000-000000000001', field_key: 'timeline',            value: '1-3 Months',                                                   created_at: daysAgo(18), updated_at: daysAgo(18) },
  { id: 'lf-0008-4000-8000-000000000008', lead_id: '77770001-0001-4000-8000-000000000001', field_key: 'referred_by',         value: 'David Lawson (Crest Financial)',                                created_at: daysAgo(24), updated_at: daysAgo(24) },
  { id: 'lf-0009-4000-8000-000000000009', lead_id: '77770001-0001-4000-8000-000000000001', field_key: 'priority',            value: 'Hot',                                                          created_at: daysAgo(10), updated_at: daysAgo(10) },
  { id: 'lf-0010-4000-8000-000000000010', lead_id: '77770001-0001-4000-8000-000000000001', field_key: 'pros',                value: 'Clear Vision,Good Budget,Quick Decision Maker',                created_at: daysAgo(10), updated_at: daysAgo(10) },
  { id: 'lf-0011-4000-8000-000000000011', lead_id: '77770001-0001-4000-8000-000000000001', field_key: 'goals',               value: 'Modernize their online presence to attract younger corporate clients and improve attorney recruitment.', created_at: daysAgo(18), updated_at: daysAgo(18) },

  // Yuki Tanaka fields
  { id: 'lf-0012-4000-8000-000000000012', lead_id: '77770001-0002-4000-8000-000000000002', field_key: 'website',             value: 'https://kaizenfit.com (placeholder)',                           created_at: daysAgo(17), updated_at: daysAgo(17) },
  { id: 'lf-0013-4000-8000-000000000013', lead_id: '77770001-0002-4000-8000-000000000002', field_key: 'industry',            value: 'Fitness/Wellness',                                             created_at: daysAgo(17), updated_at: daysAgo(17) },
  { id: 'lf-0014-4000-8000-000000000014', lead_id: '77770001-0002-4000-8000-000000000002', field_key: 'product_service',     value: 'Personalized AI workout plans',                                created_at: daysAgo(17), updated_at: daysAgo(17) },
  { id: 'lf-0015-4000-8000-000000000015', lead_id: '77770001-0002-4000-8000-000000000002', field_key: 'location',            value: 'Honolulu, HI',                                                 created_at: daysAgo(17), updated_at: daysAgo(17) },
  { id: 'lf-0016-4000-8000-000000000016', lead_id: '77770001-0002-4000-8000-000000000002', field_key: 'services_interested', value: 'Branding,Web Design,Web Dev',                                  created_at: daysAgo(12), updated_at: daysAgo(12) },
  { id: 'lf-0017-4000-8000-000000000017', lead_id: '77770001-0002-4000-8000-000000000002', field_key: 'budget_range',        value: '$15K-$50K',                                                    created_at: daysAgo(12), updated_at: daysAgo(12) },
  { id: 'lf-0018-4000-8000-000000000018', lead_id: '77770001-0002-4000-8000-000000000002', field_key: 'timeline',            value: '1-3 Months',                                                   created_at: daysAgo(12), updated_at: daysAgo(12) },
  { id: 'lf-0019-4000-8000-000000000019', lead_id: '77770001-0002-4000-8000-000000000002', field_key: 'priority',            value: 'Hot',                                                          created_at: daysAgo(7),  updated_at: daysAgo(7) },
  { id: 'lf-0020-4000-8000-000000000020', lead_id: '77770001-0002-4000-8000-000000000002', field_key: 'pros',                value: 'Exciting Brand,Clear Vision,Good Budget,Growth Trajectory',    created_at: daysAgo(7),  updated_at: daysAgo(7) },
  { id: 'lf-0021-4000-8000-000000000021', lead_id: '77770001-0002-4000-8000-000000000002', field_key: 'goals',               value: 'Launch the Kaizen Fitness brand with a strong visual identity. Build a landing page to capture early signups before the app goes live in Q3.', created_at: daysAgo(12), updated_at: daysAgo(12) },
  { id: 'lf-0022-4000-8000-000000000022', lead_id: '77770001-0002-4000-8000-000000000002', field_key: 'pain_points',         value: 'No brand identity yet — just a name. Needs everything from scratch. Tight timeline for app store launch.', created_at: daysAgo(12), updated_at: daysAgo(12) },

  // Amanda Chen fields
  { id: 'lf-0023-4000-8000-000000000023', lead_id: '77770001-0007-4000-8000-000000000007', field_key: 'website',             value: 'https://brightwaveai.com (coming soon)',                       created_at: daysAgo(7),  updated_at: daysAgo(7) },
  { id: 'lf-0024-4000-8000-000000000024', lead_id: '77770001-0007-4000-8000-000000000007', field_key: 'industry',            value: 'Tech',                                                         created_at: daysAgo(7),  updated_at: daysAgo(7) },
  { id: 'lf-0025-4000-8000-000000000025', lead_id: '77770001-0007-4000-8000-000000000007', field_key: 'product_service',     value: 'AI-powered customer insights for e-commerce',                  created_at: daysAgo(7),  updated_at: daysAgo(7) },
  { id: 'lf-0026-4000-8000-000000000026', lead_id: '77770001-0007-4000-8000-000000000007', field_key: 'location',            value: 'San Francisco, CA',                                            created_at: daysAgo(7),  updated_at: daysAgo(7) },
  { id: 'lf-0027-4000-8000-000000000027', lead_id: '77770001-0007-4000-8000-000000000007', field_key: 'services_interested', value: 'Branding,Web Design,Web Dev,Print Design',                    created_at: daysAgo(4),  updated_at: daysAgo(4) },
  { id: 'lf-0028-4000-8000-000000000028', lead_id: '77770001-0007-4000-8000-000000000007', field_key: 'budget_range',        value: '$15K-$50K',                                                    created_at: daysAgo(4),  updated_at: daysAgo(4) },
  { id: 'lf-0029-4000-8000-000000000029', lead_id: '77770001-0007-4000-8000-000000000007', field_key: 'timeline',            value: 'Immediate',                                                    created_at: daysAgo(4),  updated_at: daysAgo(4) },
  { id: 'lf-0030-4000-8000-000000000030', lead_id: '77770001-0007-4000-8000-000000000007', field_key: 'priority',            value: 'Hot',                                                          created_at: daysAgo(2),  updated_at: daysAgo(2) },
  { id: 'lf-0031-4000-8000-000000000031', lead_id: '77770001-0007-4000-8000-000000000007', field_key: 'pros',                value: 'Good Budget,Quick Decision Maker,Exciting Brand,Growth Trajectory', created_at: daysAgo(2), updated_at: daysAgo(2) },
  { id: 'lf-0032-4000-8000-000000000032', lead_id: '77770001-0007-4000-8000-000000000007', field_key: 'cons',                value: 'Difficult Timeline',                                           created_at: daysAgo(2),  updated_at: daysAgo(2) },
  { id: 'lf-0033-4000-8000-000000000033', lead_id: '77770001-0007-4000-8000-000000000007', field_key: 'goals',               value: 'Launch brand and website before May 15 demo day. Need to impress VCs and early adopters with a polished, credible web presence.', created_at: daysAgo(4), updated_at: daysAgo(4) },
  { id: 'lf-0034-4000-8000-000000000034', lead_id: '77770001-0007-4000-8000-000000000007', field_key: 'first_analysis',      value: 'Biggest pipeline opportunity right now. $45K budget, decisive founder, strong product. Only risk is the aggressive timeline — 10 weeks for brand + site + pitch deck. Will need all hands on deck.', created_at: daysAgo(2), updated_at: daysAgo(2) },

  // Derek Holt fields
  { id: 'lf-0035-4000-8000-000000000035', lead_id: '77770001-0010-4000-8000-000000000010', field_key: 'website',             value: 'https://holtconstruction.com (outdated)',                      created_at: daysAgo(3),  updated_at: daysAgo(3) },
  { id: 'lf-0036-4000-8000-000000000036', lead_id: '77770001-0010-4000-8000-000000000010', field_key: 'industry',            value: 'Construction',                                                 created_at: daysAgo(3),  updated_at: daysAgo(3) },
  { id: 'lf-0037-4000-8000-000000000037', lead_id: '77770001-0010-4000-8000-000000000010', field_key: 'product_service',     value: 'Residential & commercial construction',                        created_at: daysAgo(3),  updated_at: daysAgo(3) },
  { id: 'lf-0038-4000-8000-000000000038', lead_id: '77770001-0010-4000-8000-000000000010', field_key: 'location',            value: 'Atlanta, GA',                                                  created_at: daysAgo(3),  updated_at: daysAgo(3) },
  { id: 'lf-0039-4000-8000-000000000039', lead_id: '77770001-0010-4000-8000-000000000010', field_key: 'services_interested', value: 'Web Design,Web Dev,Photography',                               created_at: daysAgo(3),  updated_at: daysAgo(3) },
  { id: 'lf-0040-4000-8000-000000000040', lead_id: '77770001-0010-4000-8000-000000000010', field_key: 'budget_range',        value: '$15K-$50K',                                                    created_at: daysAgo(3),  updated_at: daysAgo(3) },
  { id: 'lf-0041-4000-8000-000000000041', lead_id: '77770001-0010-4000-8000-000000000010', field_key: 'timeline',            value: '1-3 Months',                                                   created_at: daysAgo(3),  updated_at: daysAgo(3) },
  { id: 'lf-0042-4000-8000-000000000042', lead_id: '77770001-0010-4000-8000-000000000010', field_key: 'priority',            value: 'Warm',                                                         created_at: daysAgo(1),  updated_at: daysAgo(1) },
  { id: 'lf-0043-4000-8000-000000000043', lead_id: '77770001-0010-4000-8000-000000000010', field_key: 'pros',                value: 'Clear Vision,Easy to Work With',                               created_at: daysAgo(1),  updated_at: daysAgo(1) },

  // Olivia Grant fields
  { id: 'lf-0044-4000-8000-000000000044', lead_id: '77770001-0003-4000-8000-000000000003', field_key: 'industry',            value: 'F&B',                                                          created_at: daysAgo(10), updated_at: daysAgo(10) },
  { id: 'lf-0045-4000-8000-000000000045', lead_id: '77770001-0003-4000-8000-000000000003', field_key: 'location',            value: 'Portland, OR',                                                 created_at: daysAgo(10), updated_at: daysAgo(10) },
  { id: 'lf-0046-4000-8000-000000000046', lead_id: '77770001-0003-4000-8000-000000000003', field_key: 'services_interested', value: 'Web Design,Web Dev',                                           created_at: daysAgo(10), updated_at: daysAgo(10) },
  { id: 'lf-0047-4000-8000-000000000047', lead_id: '77770001-0003-4000-8000-000000000003', field_key: 'budget_range',        value: '$1K-$5K',                                                      created_at: daysAgo(10), updated_at: daysAgo(10) },
  { id: 'lf-0048-4000-8000-000000000048', lead_id: '77770001-0003-4000-8000-000000000003', field_key: 'timeline',            value: 'Immediate',                                                    created_at: daysAgo(10), updated_at: daysAgo(10) },
  { id: 'lf-0049-4000-8000-000000000049', lead_id: '77770001-0003-4000-8000-000000000003', field_key: 'priority',            value: 'Warm',                                                         created_at: daysAgo(8),  updated_at: daysAgo(8) },

  // Kevin Park fields
  { id: 'lf-0050-4000-8000-000000000050', lead_id: '77770001-0006-4000-8000-000000000006', field_key: 'industry',            value: 'Retail',                                                       created_at: daysAgo(11), updated_at: daysAgo(11) },
  { id: 'lf-0051-4000-8000-000000000051', lead_id: '77770001-0006-4000-8000-000000000006', field_key: 'location',            value: 'Vancouver, WA',                                                created_at: daysAgo(11), updated_at: daysAgo(11) },
  { id: 'lf-0052-4000-8000-000000000052', lead_id: '77770001-0006-4000-8000-000000000006', field_key: 'services_interested', value: 'Web Design,Web Dev',                                           created_at: daysAgo(11), updated_at: daysAgo(11) },
  { id: 'lf-0053-4000-8000-000000000053', lead_id: '77770001-0006-4000-8000-000000000006', field_key: 'budget_range',        value: '$5K-$15K',                                                     created_at: daysAgo(11), updated_at: daysAgo(11) },
  { id: 'lf-0054-4000-8000-000000000054', lead_id: '77770001-0006-4000-8000-000000000006', field_key: 'referred_by',         value: 'Tom Nguyen (Peak Outdoor)',                                    created_at: daysAgo(11), updated_at: daysAgo(11) },
  { id: 'lf-0055-4000-8000-000000000055', lead_id: '77770001-0006-4000-8000-000000000006', field_key: 'priority',            value: 'Warm',                                                         created_at: daysAgo(6),  updated_at: daysAgo(6) },
];

export const demoLeadContacts: LeadContact[] = [
  // Nathan Cross → his contact record
  { id: 'lc-0001-4000-8000-000000000001', lead_id: '77770001-0001-4000-8000-000000000001', contact_id: 'b2b2b2b2-0009-4000-8000-000000000009', role: 'Client',            custom_role: null, is_primary_client: true,  created_at: daysAgo(25), contact: contactRef('b2b2b2b2-0009-4000-8000-000000000009') },
  // Yuki Tanaka → her contact record
  { id: 'lc-0002-4000-8000-000000000002', lead_id: '77770001-0002-4000-8000-000000000002', contact_id: 'b2b2b2b2-0010-4000-8000-000000000010', role: 'Client',            custom_role: null, is_primary_client: true,  created_at: daysAgo(20), contact: contactRef('b2b2b2b2-0010-4000-8000-000000000010') },
  // Olivia Grant
  { id: 'lc-0003-4000-8000-000000000003', lead_id: '77770001-0003-4000-8000-000000000003', contact_id: 'b2b2b2b2-0011-4000-8000-000000000011', role: 'Client',            custom_role: null, is_primary_client: true,  created_at: daysAgo(15), contact: contactRef('b2b2b2b2-0011-4000-8000-000000000011') },
  // Marcus Lee
  { id: 'lc-0004-4000-8000-000000000004', lead_id: '77770001-0004-4000-8000-000000000004', contact_id: 'b2b2b2b2-0012-4000-8000-000000000012', role: 'Client',            custom_role: null, is_primary_client: true,  created_at: daysAgo(5),  contact: contactRef('b2b2b2b2-0012-4000-8000-000000000012') },
  // Diana Frost
  { id: 'lc-0005-4000-8000-000000000005', lead_id: '77770001-0005-4000-8000-000000000005', contact_id: 'b2b2b2b2-0013-4000-8000-000000000013', role: 'Client',            custom_role: null, is_primary_client: true,  created_at: daysAgo(3),  contact: contactRef('b2b2b2b2-0013-4000-8000-000000000013') },
  // Kevin Park
  { id: 'lc-0006-4000-8000-000000000006', lead_id: '77770001-0006-4000-8000-000000000006', contact_id: 'b2b2b2b2-0014-4000-8000-000000000014', role: 'Client',            custom_role: null, is_primary_client: true,  created_at: daysAgo(12), contact: contactRef('b2b2b2b2-0014-4000-8000-000000000014') },
  // Amanda Chen
  { id: 'lc-0007-4000-8000-000000000007', lead_id: '77770001-0007-4000-8000-000000000007', contact_id: 'b2b2b2b2-0015-4000-8000-000000000015', role: 'Client',            custom_role: null, is_primary_client: true,  created_at: daysAgo(10), contact: contactRef('b2b2b2b2-0015-4000-8000-000000000015') },
  // Robert Simmons
  { id: 'lc-0008-4000-8000-000000000008', lead_id: '77770001-0008-4000-8000-000000000008', contact_id: 'b2b2b2b2-0016-4000-8000-000000000016', role: 'Client',            custom_role: null, is_primary_client: true,  created_at: daysAgo(30), contact: contactRef('b2b2b2b2-0016-4000-8000-000000000016') },
  // Patricia Vega
  { id: 'lc-0009-4000-8000-000000000009', lead_id: '77770001-0009-4000-8000-000000000009', contact_id: 'b2b2b2b2-0017-4000-8000-000000000017', role: 'Client',            custom_role: null, is_primary_client: true,  created_at: daysAgo(8),  contact: contactRef('b2b2b2b2-0017-4000-8000-000000000017') },
  // Derek Holt
  { id: 'lc-0010-4000-8000-000000000010', lead_id: '77770001-0010-4000-8000-000000000010', contact_id: 'b2b2b2b2-0018-4000-8000-000000000018', role: 'Client',            custom_role: null, is_primary_client: true,  created_at: daysAgo(6),  contact: contactRef('b2b2b2b2-0018-4000-8000-000000000018') },
  // Mei-Lin Chang
  { id: 'lc-0011-4000-8000-000000000011', lead_id: '77770001-0011-4000-8000-000000000011', contact_id: 'b2b2b2b2-0019-4000-8000-000000000019', role: 'Client',            custom_role: null, is_primary_client: true,  created_at: daysAgo(2),  contact: contactRef('b2b2b2b2-0019-4000-8000-000000000019') },
  // Tom Nguyen retainer
  { id: 'lc-0012-4000-8000-000000000012', lead_id: '77770001-0012-4000-8000-000000000012', contact_id: 'b2b2b2b2-0005-4000-8000-000000000005', role: 'Client',            custom_role: null, is_primary_client: true,  created_at: daysAgo(28), contact: contactRef('b2b2b2b2-0005-4000-8000-000000000005') },
];

// ---------------------------------------------------------------------------
// PORTAL SETTINGS
// ---------------------------------------------------------------------------
export const demoPortalSettings: PortalSettings[] = [
  {
    id: 'ps-0001-4000-8000-000000000001',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    enabled: true,
    token: 'crest-financial-rebrand',
    pin: null,
    welcome_message: 'Welcome to the Crest Financial project portal! Here you can track our progress and download shared files.',
    logo_url: '',
    accent_color: siteConfig.colors.brand[500],
    show_progress: true,
    show_files: true,
    show_hours: true,
    show_updates: true,
    show_credentials: false,
    show_invoices: true,
    section_order: [...DEFAULT_SECTION_ORDER],
    notification_thresholds: [50, 75, 90, 100],
    alert_mode: 'percentage',
    dollar_interval: null,
    require_alert_approval: true,
    rearm_thresholds_on_budget_change: false,
    created_at: daysAgo(10),
    updated_at: daysAgo(1),
  },
  {
    id: 'ps-0002-4000-8000-000000000002',
    project_id: 'c3c3c3c3-0002-4000-8000-000000000002',
    enabled: true,
    token: 'bloomwell-health-app',
    pin: '1234',
    welcome_message: 'Welcome to the Bloomwell project hub! Track app development progress below.',
    logo_url: '',
    accent_color: '#EC4899',
    show_progress: true,
    show_files: true,
    show_hours: true,
    show_updates: true,
    show_credentials: false,
    show_invoices: true,
    section_order: [...DEFAULT_SECTION_ORDER],
    notification_thresholds: [50, 75, 90, 100],
    alert_mode: 'percentage',
    dollar_interval: null,
    require_alert_approval: true,
    rearm_thresholds_on_budget_change: false,
    created_at: daysAgo(8),
    updated_at: daysAgo(1),
  },
];

// ---------------------------------------------------------------------------
// PORTAL UPDATES
// ---------------------------------------------------------------------------
export const demoPortalUpdates: PortalUpdate[] = [
  {
    id: 'pu-0001-4000-8000-000000000001',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    title: 'Brand strategy finalized',
    content: 'We\'ve completed the brand strategy phase. The positioning statement, tone of voice, and audience personas are locked in. Moving on to visual identity exploration.',
    update_type: 'milestone',
    author_id: 'a1a1a1a1-0001-4000-8000-000000000001',
    pinned: false,
    created_at: daysAgo(14),
    updated_at: daysAgo(14),
  },
  {
    id: 'pu-0002-4000-8000-000000000002',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    title: 'Logo concepts ready for review',
    content: 'Three logo directions have been uploaded to the portal files section. Please review and share your feedback by end of week.',
    update_type: 'deliverable',
    author_id: 'a1a1a1a1-0002-4000-8000-000000000002',
    pinned: false,
    created_at: daysAgo(7),
    updated_at: daysAgo(7),
  },
  {
    id: 'pu-0003-4000-8000-000000000003',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    title: 'Website wireframes in progress',
    content: 'The team has started on homepage and key landing page wireframes. Expect a first draft next week.',
    update_type: 'general',
    author_id: 'a1a1a1a1-0003-4000-8000-000000000003',
    pinned: false,
    created_at: daysAgo(3),
    updated_at: daysAgo(3),
  },
  {
    id: 'pu-0004-4000-8000-000000000004',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    title: 'Client feedback incorporated',
    content: 'We\'ve incorporated your feedback on the color palette. The revised brand guidelines PDF has been uploaded.',
    update_type: 'note',
    author_id: 'a1a1a1a1-0001-4000-8000-000000000001',
    pinned: false,
    created_at: daysAgo(1),
    updated_at: daysAgo(1),
  },
];

// ---------------------------------------------------------------------------
// PORTAL UPDATE ATTACHMENTS
// ---------------------------------------------------------------------------
export const demoPortalUpdateAttachments: PortalUpdateAttachment[] = [
  {
    id: 'pua-0001-4000-8000-000000000001',
    update_id: 'pu-0002-4000-8000-000000000002', // Logo concepts
    name: 'logo-concept-A.png',
    file_url: '#',
    file_size: 540000,
    mime_type: 'image/png',
    uploaded_by: 'a1a1a1a1-0002-4000-8000-000000000002',
    created_at: daysAgo(7),
    updated_at: daysAgo(7),
  },
  {
    id: 'pua-0002-4000-8000-000000000002',
    update_id: 'pu-0002-4000-8000-000000000002', // Logo concepts
    name: 'logo-concept-B.png',
    file_url: '#',
    file_size: 620000,
    mime_type: 'image/png',
    uploaded_by: 'a1a1a1a1-0002-4000-8000-000000000002',
    created_at: daysAgo(7),
    updated_at: daysAgo(7),
  },
  {
    id: 'pua-0003-4000-8000-000000000003',
    update_id: 'pu-0004-4000-8000-000000000004', // Client feedback
    name: 'Revised-Brand-Guidelines.pdf',
    file_url: '#',
    file_size: 2100000,
    mime_type: 'application/pdf',
    uploaded_by: 'a1a1a1a1-0001-4000-8000-000000000001',
    created_at: daysAgo(1),
    updated_at: daysAgo(1),
  },
];

// ---------------------------------------------------------------------------
// CLIENT COMMUNICATIONS (email log)
// ---------------------------------------------------------------------------
const david = demoContacts.find(c => c.id === 'b2b2b2b2-0001-4000-8000-000000000001')!;
const monica = demoContacts.find(c => c.id === 'b2b2b2b2-0002-4000-8000-000000000002')!;

export const demoClientCommunications: ClientCommunication[] = [
  // Crest Financial (project 0001) — primary client: David Lawson
  {
    id: 'cc-0001-4000-8000-000000000001',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    contact_id: david.id,
    notification_type: 'portal_welcome',
    status: 'sent',
    subject: 'Welcome to the Crest Financial project portal',
    rendered_html: null,
    slot_overrides: {},
    metadata: {},
    triggered_by: DEMO_ADMIN_TEAM_MEMBER_ID,
    sent_at: daysAgo(10),
    dismissed_at: null,
    created_at: daysAgo(10),
    recipients: { to: [david.email], cc: [], bcc: [] },
    contact: { id: david.id, name: david.name, email: david.email },
  },
  {
    id: 'cc-0002-4000-8000-000000000002',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    contact_id: david.id,
    notification_type: 'budget_threshold',
    status: 'sent',
    subject: 'Crest Financial Rebrand has reached 50% of its budget',
    rendered_html: null,
    slot_overrides: {},
    metadata: { threshold: 50 },
    triggered_by: null,
    sent_at: daysAgo(6),
    dismissed_at: null,
    created_at: daysAgo(6),
    recipients: { to: [david.email], cc: [], bcc: [] },
    contact: { id: david.id, name: david.name, email: david.email },
  },
  {
    id: 'cc-0003-4000-8000-000000000003',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    contact_id: david.id,
    notification_type: 'project_summary',
    status: 'sent',
    subject: 'Project update: where things stand with Crest Financial Rebrand',
    rendered_html: null,
    slot_overrides: {},
    metadata: {},
    triggered_by: DEMO_ADMIN_TEAM_MEMBER_ID,
    sent_at: daysAgo(3),
    dismissed_at: null,
    created_at: daysAgo(3),
    recipients: { to: [david.email], cc: [], bcc: [] },
    contact: { id: david.id, name: david.name, email: david.email },
  },
  {
    id: 'cc-0004-4000-8000-000000000004',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    contact_id: david.id,
    notification_type: 'budget_threshold',
    status: 'pending',
    subject: 'Crest Financial Rebrand has reached 75% of its budget',
    rendered_html: null,
    slot_overrides: {},
    metadata: { threshold: 75 },
    triggered_by: null,
    sent_at: null,
    dismissed_at: null,
    created_at: hoursAgo(4),
    recipients: { to: [david.email], cc: [], bcc: [] },
    contact: { id: david.id, name: david.name, email: david.email },
  },
  {
    id: 'cc-0005-4000-8000-000000000005',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    contact_id: david.id,
    notification_type: 'dollar_interval',
    status: 'dismissed',
    subject: 'Milestone reached on Crest Financial Rebrand',
    rendered_html: null,
    slot_overrides: {},
    metadata: { milestone: 2000 },
    triggered_by: null,
    sent_at: null,
    dismissed_at: daysAgo(8),
    created_at: daysAgo(8),
    recipients: { to: [david.email], cc: [], bcc: [] },
    contact: { id: david.id, name: david.name, email: david.email },
  },

  // Bloomwell Health (project 0002) — primary client: Monica Reeves
  {
    id: 'cc-0006-4000-8000-000000000006',
    project_id: 'c3c3c3c3-0002-4000-8000-000000000002',
    contact_id: monica.id,
    notification_type: 'portal_welcome',
    status: 'sent',
    subject: 'Welcome to the Bloomwell project hub',
    rendered_html: null,
    slot_overrides: {},
    metadata: {},
    triggered_by: DEMO_ADMIN_TEAM_MEMBER_ID,
    sent_at: daysAgo(7),
    dismissed_at: null,
    created_at: daysAgo(7),
    recipients: { to: [monica.email], cc: [], bcc: [] },
    contact: { id: monica.id, name: monica.name, email: monica.email },
  },
  {
    id: 'cc-0007-4000-8000-000000000007',
    project_id: 'c3c3c3c3-0002-4000-8000-000000000002',
    contact_id: monica.id,
    notification_type: 'budget_extended',
    status: 'sent',
    subject: 'Bloomwell Health App budget updated',
    rendered_html: null,
    slot_overrides: {},
    metadata: {},
    triggered_by: DEMO_ADMIN_TEAM_MEMBER_ID,
    sent_at: daysAgo(2),
    dismissed_at: null,
    created_at: daysAgo(2),
    recipients: { to: [monica.email], cc: [], bcc: [] },
    contact: { id: monica.id, name: monica.name, email: monica.email },
  },
  {
    id: 'cc-0008-4000-8000-000000000008',
    project_id: 'c3c3c3c3-0002-4000-8000-000000000002',
    contact_id: monica.id,
    notification_type: 'budget_threshold',
    status: 'pending',
    subject: 'Bloomwell Health App has reached 90% of its budget',
    rendered_html: null,
    slot_overrides: {},
    metadata: { threshold: 90 },
    triggered_by: null,
    sent_at: null,
    dismissed_at: null,
    created_at: hoursAgo(1),
    recipients: { to: [monica.email], cc: [], bcc: [] },
    contact: { id: monica.id, name: monica.name, email: monica.email },
  },
];

// ---------------------------------------------------------------------------
// PORTAL FILES
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ENTITY FILES (attachments for leads, projects, contacts)
// visibility: 'internal' = admin only, 'external' = shared on client portal
// ---------------------------------------------------------------------------
export const demoEntityFiles: EntityFile[] = [
  // Lead files
  {
    id: 'ef-0001-4000-8000-000000000001',
    entity_type: 'lead',
    entity_id: '77770001-0001-4000-8000-000000000001', // Nathan Cross lead
    name: 'Cross-Legal-NDA.pdf',
    file_url: '#',
    file_size: 145000,
    mime_type: 'application/pdf',
    visibility: 'internal',
    uploaded_by: 'a1a1a1a1-0001-4000-8000-000000000001',
    created_at: daysAgo(8),
    updated_at: daysAgo(8),
  },
  {
    id: 'ef-0002-4000-8000-000000000002',
    entity_type: 'lead',
    entity_id: '77770001-0002-4000-8000-000000000002', // Yuki Tanaka lead
    name: 'Kaizen-Brand-Brief.docx',
    file_url: '#',
    file_size: 320000,
    mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    visibility: 'internal',
    uploaded_by: 'a1a1a1a1-0003-4000-8000-000000000003',
    created_at: daysAgo(6),
    updated_at: daysAgo(6),
  },
  // Project files (internal)
  {
    id: 'ef-0003-4000-8000-000000000003',
    entity_type: 'project',
    entity_id: 'c3c3c3c3-0001-4000-8000-000000000001', // Crest Financial Rebrand
    name: 'Meeting-Notes-Kickoff.pdf',
    file_url: '#',
    file_size: 89000,
    mime_type: 'application/pdf',
    visibility: 'internal',
    uploaded_by: 'a1a1a1a1-0001-4000-8000-000000000001',
    created_at: daysAgo(30),
    updated_at: daysAgo(30),
  },
  {
    id: 'ef-0004-4000-8000-000000000004',
    entity_type: 'project',
    entity_id: 'c3c3c3c3-0002-4000-8000-000000000002', // Bloomwell Health App
    name: 'HIPAA-Compliance-Checklist.xlsx',
    file_url: '#',
    file_size: 52000,
    mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    visibility: 'internal',
    uploaded_by: 'a1a1a1a1-0004-4000-8000-000000000004',
    created_at: daysAgo(12),
    updated_at: daysAgo(12),
  },
  // Project files (external / shared on portal)
  {
    id: 'ef-0007-4000-8000-000000000007',
    entity_type: 'project',
    entity_id: 'c3c3c3c3-0001-4000-8000-000000000001', // Crest Financial Rebrand
    name: 'Brand-Guidelines-v2.pdf',
    file_url: '#',
    file_size: 2400000,
    mime_type: 'application/pdf',
    visibility: 'external',
    uploaded_by: 'a1a1a1a1-0001-4000-8000-000000000001',
    created_at: daysAgo(5),
    updated_at: daysAgo(5),
  },
  {
    id: 'ef-0008-4000-8000-000000000008',
    entity_type: 'project',
    entity_id: 'c3c3c3c3-0001-4000-8000-000000000001', // Crest Financial Rebrand
    name: 'Logo-Finals.zip',
    file_url: '#',
    file_size: 8500000,
    mime_type: 'application/zip',
    visibility: 'external',
    uploaded_by: 'a1a1a1a1-0002-4000-8000-000000000002',
    created_at: daysAgo(3),
    updated_at: daysAgo(3),
  },
  {
    id: 'ef-0009-4000-8000-000000000009',
    entity_type: 'project',
    entity_id: 'c3c3c3c3-0002-4000-8000-000000000002', // Bloomwell Health App
    name: 'App-Wireframes.fig',
    file_url: '#',
    file_size: 3200000,
    mime_type: 'application/octet-stream',
    visibility: 'external',
    uploaded_by: 'a1a1a1a1-0004-4000-8000-000000000004',
    created_at: daysAgo(7),
    updated_at: daysAgo(7),
  },
  // Contact files
  {
    id: 'ef-0005-4000-8000-000000000005',
    entity_type: 'contact',
    entity_id: 'b2b2b2b2-0001-4000-8000-000000000001', // David Lawson
    name: 'Crest-MSA-Signed.pdf',
    file_url: '#',
    file_size: 210000,
    mime_type: 'application/pdf',
    visibility: 'internal',
    uploaded_by: 'a1a1a1a1-0001-4000-8000-000000000001',
    created_at: daysAgo(25),
    updated_at: daysAgo(25),
  },
  {
    id: 'ef-0006-4000-8000-000000000006',
    entity_type: 'contact',
    entity_id: 'b2b2b2b2-0003-4000-8000-000000000003', // Andre Williams
    name: 'NeoForge-Brand-Moodboard.png',
    file_url: '#',
    file_size: 4800000,
    mime_type: 'image/png',
    visibility: 'internal',
    uploaded_by: 'a1a1a1a1-0002-4000-8000-000000000002',
    created_at: daysAgo(20),
    updated_at: daysAgo(20),
  },
];

// ---------------------------------------------------------------------------
// TIME ENTRIES (start/stop pairs)
// ---------------------------------------------------------------------------
function dayAtTime(daysBack: number, hours: number, minutes = 0): string {
  const d = new Date(Date.now() - daysBack * 86_400_000);
  d.setHours(hours, minutes, 0, 0);
  return d.toISOString();
}

// Helper for demo rows: wraps a single [start, end] pair into the segments array shape.
function oneSegment(start: string, end: string) {
  return [{ start, end }];
}

export const demoTimeEntries: TimeEntry[] = [
  // Crest Financial Rebrand
  { id: 'te-0001-4000-8000-000000000001', project_id: 'c3c3c3c3-0001-4000-8000-000000000001', member_id: 'a1a1a1a1-0001-4000-8000-000000000001', start_time: dayAtTime(2, 9, 0),  end_time: dayAtTime(2, 12, 30), segments: oneSegment(dayAtTime(2, 9, 0),  dayAtTime(2, 12, 30)), description: 'Brand strategy workshop',        created_at: daysAgo(2), updated_at: daysAgo(2) },
  { id: 'te-0002-4000-8000-000000000002', project_id: 'c3c3c3c3-0001-4000-8000-000000000001', member_id: 'a1a1a1a1-0002-4000-8000-000000000002', start_time: dayAtTime(3, 10, 0), end_time: dayAtTime(3, 15, 0),  segments: oneSegment(dayAtTime(3, 10, 0), dayAtTime(3, 15, 0)),  description: 'Logo concept exploration',       created_at: daysAgo(3), updated_at: daysAgo(3) },
  { id: 'te-0003-4000-8000-000000000003', project_id: 'c3c3c3c3-0001-4000-8000-000000000001', member_id: 'a1a1a1a1-0003-4000-8000-000000000003', start_time: dayAtTime(5, 13, 0), end_time: dayAtTime(5, 15, 30), segments: oneSegment(dayAtTime(5, 13, 0), dayAtTime(5, 15, 30)), description: 'Typography and color system',    created_at: daysAgo(5), updated_at: daysAgo(5) },
  { id: 'te-0004-4000-8000-000000000004', project_id: 'c3c3c3c3-0001-4000-8000-000000000001', member_id: 'a1a1a1a1-0001-4000-8000-000000000001', start_time: dayAtTime(6, 14, 0), end_time: dayAtTime(6, 15, 30), segments: oneSegment(dayAtTime(6, 14, 0), dayAtTime(6, 15, 30)), description: 'Client feedback review',         created_at: daysAgo(6), updated_at: daysAgo(6) },
  // Bloomwell Health App
  { id: 'te-0005-4000-8000-000000000005', project_id: 'c3c3c3c3-0002-4000-8000-000000000002', member_id: 'a1a1a1a1-0004-4000-8000-000000000004', start_time: dayAtTime(1, 9, 0),  end_time: dayAtTime(1, 15, 0),  segments: oneSegment(dayAtTime(1, 9, 0),  dayAtTime(1, 15, 0)),  description: 'Homepage wireframes',            created_at: daysAgo(1), updated_at: daysAgo(1) },
  { id: 'te-0006-4000-8000-000000000006', project_id: 'c3c3c3c3-0002-4000-8000-000000000002', member_id: 'a1a1a1a1-0003-4000-8000-000000000003', start_time: dayAtTime(2, 10, 0), end_time: dayAtTime(2, 14, 0),  segments: oneSegment(dayAtTime(2, 10, 0), dayAtTime(2, 14, 0)),  description: 'Design review meeting',          created_at: daysAgo(2), updated_at: daysAgo(2) },
  { id: 'te-0007-4000-8000-000000000007', project_id: 'c3c3c3c3-0002-4000-8000-000000000002', member_id: 'a1a1a1a1-0001-4000-8000-000000000001', start_time: dayAtTime(4, 11, 0), end_time: dayAtTime(4, 13, 0),  segments: oneSegment(dayAtTime(4, 11, 0), dayAtTime(4, 13, 0)),  description: 'Sprint planning and task setup', created_at: daysAgo(4), updated_at: daysAgo(4) },
  { id: 'te-0008-4000-8000-000000000008', project_id: 'c3c3c3c3-0002-4000-8000-000000000002', member_id: 'a1a1a1a1-0004-4000-8000-000000000004', start_time: dayAtTime(7, 8, 30), end_time: dayAtTime(7, 16, 0),  segments: oneSegment(dayAtTime(7, 8, 30), dayAtTime(7, 16, 0)),  description: 'Auth flow implementation',       created_at: daysAgo(7), updated_at: daysAgo(7) },
];

// ---------------------------------------------------------------------------
// PROJECT INVOICES
// ---------------------------------------------------------------------------
export const demoProjectInvoices: ProjectInvoice[] = [
  // -----------------------------------------------------------------------
  // Crest Financial Rebrand — hourly project (hourly earnings come from
  // time entries). Older invoices use legacy `line_items: []` to exercise
  // the lazy-synth path in ensureLineItems. A newer recurring retainer
  // accrues daily across the default 30-day chart window.
  // -----------------------------------------------------------------------
  { id: 'inv-0001-4000-8000-000000000001', project_id: 'c3c3c3c3-0001-4000-8000-000000000001', invoice_number: 'INV-001', amount: 4500.00,  status: 'paid',    invoice_type: 'hourly', line_items: [], date: '2026-01-20', due_date: '2026-02-20', paid_date: '2026-02-10', description: 'Brand strategy phase - discovery workshops and competitive audit.',    file_url: null, file_name: null, file_size: null, mime_type: null, created_by: 'a1a1a1a1-0001-4000-8000-000000000001', created_at: daysAgo(84), updated_at: daysAgo(63) },
  { id: 'inv-0002-4000-8000-000000000002', project_id: 'c3c3c3c3-0001-4000-8000-000000000001', invoice_number: 'INV-002', amount: 6750.00,  status: 'sent',    invoice_type: 'hourly', line_items: [], date: '2026-02-15', due_date: '2026-03-15', paid_date: null,         description: 'Visual identity exploration - logo concepts, typography, and color system.', file_url: null, file_name: null, file_size: null, mime_type: null, created_by: 'a1a1a1a1-0001-4000-8000-000000000001', created_at: daysAgo(58), updated_at: daysAgo(30) },
  { id: 'inv-0003-4000-8000-000000000003', project_id: 'c3c3c3c3-0001-4000-8000-000000000001', invoice_number: 'INV-003', amount: 3200.00,  status: 'draft',   invoice_type: 'hourly', line_items: [], date: '2026-02-25', due_date: '2026-03-25', paid_date: null,         description: 'Collateral design - business cards, letterhead, presentation template.', file_url: null, file_name: null, file_size: null, mime_type: null, created_by: 'a1a1a1a1-0001-4000-8000-000000000001', created_at: daysAgo(48), updated_at: daysAgo(48) },
  // Crest — monthly retainer that amortizes $2500/mo into ~$80/day accrual.
  {
    id: 'inv-0010-4000-8000-000000000010', project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    invoice_number: 'INV-004', amount: 2500.00, status: 'sent', invoice_type: 'recurring',
    line_items: [
      { id: 'li-0010-a', position: 0, item_type: 'recurring', amount: 2500, description: 'Marketing retainer — strategy calls, creative oversight, social templates', service_start_date: '2026-03-15', service_end_date: '2026-04-14', recurrence_frequency: 'monthly' },
    ],
    date: '2026-03-15', due_date: '2026-04-14', paid_date: null,
    description: 'Monthly marketing retainer (Mar 15 - Apr 14).',
    file_url: null, file_name: null, file_size: null, mime_type: null,
    created_by: 'a1a1a1a1-0001-4000-8000-000000000001', created_at: daysAgo(30), updated_at: daysAgo(30),
  },

  // -----------------------------------------------------------------------
  // Bloomwell Health App — hourly project with a multi-line invoice that
  // combines billable hours and a monthly maintenance retainer.
  // -----------------------------------------------------------------------
  { id: 'inv-0004-4000-8000-000000000004', project_id: 'c3c3c3c3-0002-4000-8000-000000000002', invoice_number: 'INV-001', amount: 8750.00,  status: 'paid',    invoice_type: 'hourly', line_items: [], date: '2026-02-01', due_date: '2026-03-01', paid_date: '2026-02-18', description: 'Sprint 1 - project setup, auth flow, and database schema.',             file_url: null, file_name: null, file_size: null, mime_type: null, created_by: 'a1a1a1a1-0001-4000-8000-000000000001', created_at: daysAgo(72), updated_at: daysAgo(55) },
  { id: 'inv-0005-4000-8000-000000000005', project_id: 'c3c3c3c3-0002-4000-8000-000000000002', invoice_number: 'INV-002', amount: 10500.00, status: 'overdue', invoice_type: 'hourly', line_items: [], date: '2026-02-15', due_date: '2026-02-25', paid_date: null,         description: 'Sprint 2 - patient dashboard, appointment booking, messaging.',          file_url: null, file_name: null, file_size: null, mime_type: null, created_by: 'a1a1a1a1-0001-4000-8000-000000000001', created_at: daysAgo(58), updated_at: daysAgo(48) },
  // Bloomwell multi-line: billable hours, monthly retainer, and reimbursed travel.
  {
    id: 'inv-0008-4000-8000-000000000008', project_id: 'c3c3c3c3-0002-4000-8000-000000000002',
    invoice_number: 'INV-003', amount: 5450.00, status: 'sent', invoice_type: 'hourly',
    line_items: [
      { id: 'li-0008-a', position: 0, item_type: 'hourly',    amount: 2000, description: 'Billable hours (Mar 15 - Apr 12)', service_start_date: null,        service_end_date: null,        recurrence_frequency: null },
      { id: 'li-0008-b', position: 1, item_type: 'recurring', amount: 3000, description: 'Monthly maintenance retainer',      service_start_date: '2026-03-15', service_end_date: '2026-04-14', recurrence_frequency: 'monthly' },
      { id: 'li-0008-c', position: 2, item_type: 'reimbursement', amount: 450, description: 'Client-approved travel reimbursement', service_start_date: null, service_end_date: null, recurrence_frequency: null },
    ],
    date: '2026-03-15', due_date: '2026-04-15', paid_date: null,
    description: 'Combined billable hours, monthly retainer, and reimbursed travel.',
    file_url: null, file_name: null, file_size: null, mime_type: null,
    created_by: 'a1a1a1a1-0001-4000-8000-000000000001', created_at: daysAgo(30), updated_at: daysAgo(30),
  },

  // -----------------------------------------------------------------------
  // NeoForge Website — fixed-price project, split into three milestones so
  // two of the three accrue across the default chart window (development
  // sprint partially visible, launch phase fully visible).
  // -----------------------------------------------------------------------
  {
    id: 'inv-0006-4000-8000-000000000006', project_id: 'c3c3c3c3-0003-4000-8000-000000000003',
    invoice_number: 'INV-001', amount: 6000.00, status: 'paid', invoice_type: 'fixed',
    line_items: [
      { id: 'li-0006-a', position: 0, item_type: 'fixed', amount: 6000, description: '', service_start_date: '2026-01-25', service_end_date: '2026-02-15', recurrence_frequency: null },
    ],
    date: '2026-01-25', due_date: '2026-02-15', paid_date: '2026-02-10',
    description: 'Kickoff deposit — discovery, sitemap, and wireframes.',
    file_url: null, file_name: null, file_size: null, mime_type: null,
    created_by: 'a1a1a1a1-0002-4000-8000-000000000002', created_at: daysAgo(79), updated_at: daysAgo(63),
  },
  {
    id: 'inv-0007-4000-8000-000000000007', project_id: 'c3c3c3c3-0003-4000-8000-000000000003',
    invoice_number: 'INV-002', amount: 6000.00, status: 'sent', invoice_type: 'fixed',
    line_items: [
      { id: 'li-0007-a', position: 0, item_type: 'fixed', amount: 6000, description: '', service_start_date: '2026-02-20', service_end_date: '2026-03-31', recurrence_frequency: null },
    ],
    date: '2026-02-20', due_date: '2026-03-31', paid_date: null,
    description: 'Development sprint — page builds, CMS integration, and animation pass.',
    file_url: null, file_name: null, file_size: null, mime_type: null,
    created_by: 'a1a1a1a1-0002-4000-8000-000000000002', created_at: daysAgo(53), updated_at: daysAgo(53),
  },
  {
    id: 'inv-0009-4000-8000-000000000009', project_id: 'c3c3c3c3-0003-4000-8000-000000000003',
    invoice_number: 'INV-003', amount: 6000.00, status: 'sent', invoice_type: 'fixed',
    line_items: [
      { id: 'li-0009-a', position: 0, item_type: 'fixed', amount: 6000, description: '', service_start_date: '2026-04-01', service_end_date: '2026-04-30', recurrence_frequency: null },
    ],
    date: '2026-04-01', due_date: '2026-05-01', paid_date: null,
    description: 'Launch phase — QA, content migration, deploy, and handover.',
    file_url: null, file_name: null, file_size: null, mime_type: null,
    created_by: 'a1a1a1a1-0002-4000-8000-000000000002', created_at: daysAgo(13), updated_at: daysAgo(13),
  },

  // -----------------------------------------------------------------------
  // Solstice Realty Platform — hourly project with a paid multi-line
  // invoice (billable hours + IDX hosting retainer) and a forward-looking
  // recurring-only invoice for the following month.
  // -----------------------------------------------------------------------
  {
    id: 'inv-0011-4000-8000-000000000011', project_id: 'c3c3c3c3-0004-4000-8000-000000000004',
    invoice_number: 'INV-001', amount: 3800.00, status: 'paid', invoice_type: 'hourly',
    line_items: [
      { id: 'li-0011-a', position: 0, item_type: 'hourly',    amount: 3300, description: 'Billable hours — IDX integration scaffolding', service_start_date: null,        service_end_date: null,        recurrence_frequency: null },
      { id: 'li-0011-b', position: 1, item_type: 'recurring', amount: 500,  description: 'IDX feed hosting & maintenance',                service_start_date: '2026-03-01', service_end_date: '2026-03-31', recurrence_frequency: 'monthly' },
    ],
    date: '2026-03-05', due_date: '2026-04-05', paid_date: '2026-03-28',
    description: 'March billing — sprint hours + IDX hosting retainer.',
    file_url: null, file_name: null, file_size: null, mime_type: null,
    created_by: 'a1a1a1a1-0001-4000-8000-000000000001', created_at: daysAgo(40), updated_at: daysAgo(17),
  },
  {
    id: 'inv-0012-4000-8000-000000000012', project_id: 'c3c3c3c3-0004-4000-8000-000000000004',
    invoice_number: 'INV-002', amount: 500.00, status: 'sent', invoice_type: 'recurring',
    line_items: [
      { id: 'li-0012-a', position: 0, item_type: 'recurring', amount: 500, description: 'IDX feed hosting & maintenance', service_start_date: '2026-04-01', service_end_date: '2026-04-30', recurrence_frequency: 'monthly' },
    ],
    date: '2026-04-01', due_date: '2026-05-01', paid_date: null,
    description: 'April IDX hosting retainer.',
    file_url: null, file_name: null, file_size: null, mime_type: null,
    created_by: 'a1a1a1a1-0001-4000-8000-000000000001', created_at: daysAgo(13), updated_at: daysAgo(13),
  },
];

// ---------------------------------------------------------------------------
// NOTIFICATIONS
// ---------------------------------------------------------------------------
export const demoNotifications: Notification[] = [
  // Unread
  {
    id: 'notif-0001-4000-8000-000000000001',
    user_id: 'a1a1a1a1-0001-4000-8000-000000000001',
    title: 'You were assigned to "Design homepage hero"',
    message: 'Marcus Johnson assigned you to a task in Crest Financial Rebrand.',
    link: '/projects/c3c3c3c3-0001-4000-8000-000000000001',
    is_read: false,
    entity_type: 'task',
    entity_id: 'd4d4d4d4-0001-4000-8000-000000000001',
    created_at: hoursAgo(1),
  },
  {
    id: 'notif-0002-4000-8000-000000000002',
    user_id: 'a1a1a1a1-0001-4000-8000-000000000001',
    title: 'New comment on "Set up CI/CD pipeline"',
    message: 'Jake Thompson: "Deployed to staging — can you review?"',
    link: '/projects/c3c3c3c3-0002-4000-8000-000000000002',
    is_read: false,
    entity_type: 'comment',
    entity_id: 'd4d4d4d4-0005-4000-8000-000000000005',
    created_at: hoursAgo(3),
  },
  // Read
  {
    id: 'notif-0003-4000-8000-000000000003',
    user_id: 'a1a1a1a1-0001-4000-8000-000000000001',
    title: 'Lead "BrightWave AI" moved to Qualified',
    message: 'Emily Rodriguez updated the lead status.',
    link: '/leads/e5e5e5e5-0003-4000-8000-000000000003',
    is_read: true,
    entity_type: 'lead',
    entity_id: 'e5e5e5e5-0003-4000-8000-000000000003',
    created_at: hoursAgo(8),
  },
  {
    id: 'notif-0004-4000-8000-000000000004',
    user_id: 'a1a1a1a1-0001-4000-8000-000000000001',
    title: '"Create brand color palette" completed',
    message: 'Emily Rodriguez marked the task as done.',
    link: '/projects/c3c3c3c3-0001-4000-8000-000000000001',
    is_read: true,
    entity_type: 'task',
    entity_id: 'd4d4d4d4-0002-4000-8000-000000000002',
    created_at: hoursAgo(12),
  },
  {
    id: 'notif-0005-4000-8000-000000000005',
    user_id: 'a1a1a1a1-0001-4000-8000-000000000001',
    title: 'New team member joined',
    message: 'Priya Patel was added to the team as a guest.',
    link: '/team',
    is_read: true,
    entity_type: 'member',
    entity_id: 'a1a1a1a1-0005-4000-8000-000000000005',
    created_at: daysAgo(1),
  },
  {
    id: 'notif-0006-4000-8000-000000000006',
    user_id: 'a1a1a1a1-0001-4000-8000-000000000001',
    title: 'Lead "Kaizen Fitness" moved to Proposal',
    message: 'You updated the lead status.',
    link: '/leads/e5e5e5e5-0004-4000-8000-000000000004',
    is_read: true,
    entity_type: 'lead',
    entity_id: 'e5e5e5e5-0004-4000-8000-000000000004',
    created_at: daysAgo(2),
  },
  {
    id: 'notif-0007-4000-8000-000000000007',
    user_id: 'a1a1a1a1-0001-4000-8000-000000000001',
    title: '"Write API documentation" moved to In Review',
    message: 'Jake Thompson updated the task status.',
    link: '/projects/c3c3c3c3-0002-4000-8000-000000000002',
    is_read: true,
    entity_type: 'task',
    entity_id: 'd4d4d4d4-0007-4000-8000-000000000007',
    created_at: daysAgo(3),
  },
  {
    id: 'notif-0008-4000-8000-000000000008',
    user_id: 'a1a1a1a1-0001-4000-8000-000000000001',
    title: 'Bloomwell Health App project created',
    message: 'A new project was created from lead conversion.',
    link: '/projects/c3c3c3c3-0002-4000-8000-000000000002',
    is_read: true,
    entity_type: 'project',
    entity_id: 'c3c3c3c3-0002-4000-8000-000000000002',
    created_at: daysAgo(5),
  },
];

// ---------------------------------------------------------------------------
// PROJECT GOALS
// ---------------------------------------------------------------------------
export const demoProjectGoals: ProjectGoal[] = [
  // Crest Financial Rebrand — 3 goals
  {
    id: 'goal-0001-4000-8000-000000000001',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    title: 'Finalize brand guidelines document',
    description: 'Complete the brand guide including logo usage, color palette, typography, and tone of voice.',
    target_date: '2026-03-15',
    status: 'active',
    created_by: 'a1a1a1a1-0001-4000-8000-000000000001',
    archived_at: null,
    created_at: daysAgo(30),
    updated_at: daysAgo(2),
  },
  {
    id: 'goal-0002-4000-8000-000000000002',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    title: 'Launch redesigned website',
    description: 'Deploy the new crestfinancial.com with updated branding, responsive layout, and CMS.',
    target_date: '2026-04-30',
    status: 'active',
    created_by: 'a1a1a1a1-0001-4000-8000-000000000001',
    archived_at: null,
    created_at: daysAgo(28),
    updated_at: daysAgo(5),
  },
  {
    id: 'goal-0003-4000-8000-000000000003',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    title: 'Competitor brand audit',
    description: 'Analyze top 5 competing financial advisory firms for design trends and positioning gaps.',
    target_date: '2026-02-28',
    status: 'achieved',
    created_by: 'a1a1a1a1-0006-4000-8000-000000000006',
    archived_at: null,
    created_at: daysAgo(25),
    updated_at: daysAgo(8),
  },

  // Bloomwell Health App — 2 goals
  {
    id: 'goal-0004-4000-8000-000000000004',
    project_id: 'c3c3c3c3-0002-4000-8000-000000000002',
    title: 'Ship MVP of patient portal',
    description: 'Auth, appointment scheduling, and secure messaging between patients and providers.',
    target_date: '2026-04-15',
    status: 'active',
    created_by: 'a1a1a1a1-0001-4000-8000-000000000001',
    archived_at: null,
    created_at: daysAgo(15),
    updated_at: daysAgo(1),
  },
  {
    id: 'goal-0005-4000-8000-000000000005',
    project_id: 'c3c3c3c3-0002-4000-8000-000000000002',
    title: 'HIPAA compliance review',
    description: 'Ensure all data handling, storage, and transmission meets HIPAA requirements.',
    target_date: '2026-03-30',
    status: 'active',
    created_by: 'a1a1a1a1-0007-4000-8000-000000000007',
    archived_at: null,
    created_at: daysAgo(12),
    updated_at: daysAgo(3),
  },

  // NeoForge Website — 1 goal (no autonomous, but still has a goal)
  {
    id: 'goal-0006-4000-8000-000000000006',
    project_id: 'c3c3c3c3-0003-4000-8000-000000000003',
    title: 'Go live before Series B demo day',
    description: 'Website must be fully deployed and polished for investor presentations.',
    target_date: '2026-03-31',
    status: 'active',
    created_by: 'a1a1a1a1-0001-4000-8000-000000000001',
    archived_at: null,
    created_at: daysAgo(20),
    updated_at: daysAgo(4),
  },
];

// ---------------------------------------------------------------------------
// TASK SUGGESTIONS
// ---------------------------------------------------------------------------
export const demoTaskSuggestions: TaskSuggestion[] = [
  // Pending suggestions
  {
    id: 'sug-0001-4000-8000-000000000001',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    goal_id: 'goal-0001-4000-8000-000000000001',
    proposed_by: 'a1a1a1a1-0006-4000-8000-000000000006',
    assigned_to: null,
    title: 'Create color palette usage examples for dark backgrounds',
    description: 'The current brand guide only shows the palette on white. We need examples of how the primary and accent colors work on dark navy and charcoal backgrounds common in financial dashboards.',
    reasoning: 'The web team flagged that they\'re guessing at color combos for the dark-themed dashboard sections. Having explicit guidance will prevent inconsistencies.',
    priority: 'medium',
    effort_estimate: 'small',
    task_type: 'marketing',
    status: 'pending',
    reviewed_by: null,
    reviewed_at: null,
    rejection_reason: null,
    info_request: null,
    converted_task_id: null,
    metadata: {},
    created_at: hoursAgo(3),
    updated_at: hoursAgo(3),
  },
  {
    id: 'sug-0002-4000-8000-000000000002',
    project_id: 'c3c3c3c3-0002-4000-8000-000000000002',
    goal_id: 'goal-0004-4000-8000-000000000004',
    proposed_by: 'a1a1a1a1-0007-4000-8000-000000000007',
    assigned_to: null,
    title: 'Add session timeout handling for patient portal',
    description: 'Implement a 15-minute idle timeout with a warning modal at 12 minutes. On timeout, clear sensitive data from memory and redirect to login.',
    reasoning: 'HIPAA security rule §164.312(a)(2)(iii) requires automatic logoff. This is a compliance blocker for the MVP launch.',
    priority: 'high',
    effort_estimate: 'medium',
    task_type: 'engineering',
    status: 'pending',
    reviewed_by: null,
    reviewed_at: null,
    rejection_reason: null,
    info_request: null,
    converted_task_id: null,
    metadata: {},
    created_at: hoursAgo(5),
    updated_at: hoursAgo(5),
  },
  {
    id: 'sug-0003-4000-8000-000000000003',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    goal_id: 'goal-0002-4000-8000-000000000002',
    proposed_by: 'a1a1a1a1-0006-4000-8000-000000000006',
    assigned_to: null,
    title: 'Set up staging environment with CMS preview mode',
    description: 'Deploy a staging branch to Vercel with draft content preview so the Crest team can review pages before they go live.',
    reasoning: 'The client has requested a way to preview content changes. This also unblocks the content team from waiting on dev deploys.',
    priority: 'medium',
    effort_estimate: 'medium',
    task_type: 'engineering',
    status: 'pending',
    reviewed_by: null,
    reviewed_at: null,
    rejection_reason: null,
    info_request: null,
    converted_task_id: null,
    metadata: {},
    created_at: hoursAgo(8),
    updated_at: hoursAgo(8),
  },
  {
    id: 'sug-0004-4000-8000-000000000004',
    project_id: 'c3c3c3c3-0002-4000-8000-000000000002',
    goal_id: 'goal-0005-4000-8000-000000000005',
    proposed_by: 'a1a1a1a1-0007-4000-8000-000000000007',
    assigned_to: null,
    title: 'Audit third-party dependencies for HIPAA BAA coverage',
    description: 'Review every third-party service (Supabase, Twilio, SendGrid, etc.) and verify a signed Business Associate Agreement is in place or an alternative is available.',
    reasoning: 'We currently use 4 third-party services that handle PHI. Without signed BAAs we cannot pass a compliance audit.',
    priority: 'urgent',
    effort_estimate: 'large',
    task_type: 'audit',
    status: 'pending',
    reviewed_by: null,
    reviewed_at: null,
    rejection_reason: null,
    info_request: null,
    converted_task_id: null,
    metadata: {},
    created_at: hoursAgo(12),
    updated_at: hoursAgo(12),
  },

  // Needs info
  {
    id: 'sug-0005-4000-8000-000000000005',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    goal_id: 'goal-0001-4000-8000-000000000001',
    proposed_by: 'a1a1a1a1-0006-4000-8000-000000000006',
    assigned_to: null,
    title: 'Add motion design guidelines to brand document',
    description: 'Define easing curves, animation durations, and transition patterns for interactive elements on the website.',
    reasoning: 'The dev team is using inconsistent animation timings across components. A standard set of motion tokens would fix this.',
    priority: 'low',
    effort_estimate: 'small',
    task_type: 'marketing',
    status: 'needs_info',
    reviewed_by: 'a1a1a1a1-0001-4000-8000-000000000001',
    reviewed_at: daysAgo(1),
    rejection_reason: null,
    info_request: 'Should we match Crest\'s existing motion patterns from their current mobile app, or start fresh with our own system?',
    converted_task_id: null,
    metadata: {},
    created_at: daysAgo(2),
    updated_at: daysAgo(1),
  },

  // Approved
  {
    id: 'sug-0006-4000-8000-000000000006',
    project_id: 'c3c3c3c3-0002-4000-8000-000000000002',
    goal_id: 'goal-0004-4000-8000-000000000004',
    proposed_by: 'a1a1a1a1-0007-4000-8000-000000000007',
    assigned_to: 'a1a1a1a1-0004-4000-8000-000000000004',
    title: 'Build appointment booking flow with calendar integration',
    description: 'Create a multi-step booking form: select provider → pick date/time → confirm. Integrate with Google Calendar API for availability.',
    reasoning: 'Appointment scheduling is the #1 requested feature in patient surveys. It\'s core to the MVP scope.',
    priority: 'high',
    effort_estimate: 'large',
    task_type: 'engineering',
    status: 'approved',
    reviewed_by: 'a1a1a1a1-0001-4000-8000-000000000001',
    reviewed_at: daysAgo(2),
    rejection_reason: null,
    info_request: null,
    converted_task_id: 'd4d4d4d4-0003-4000-8000-000000000003',
    metadata: {},
    created_at: daysAgo(5),
    updated_at: daysAgo(2),
  },

  // Rejected
  {
    id: 'sug-0007-4000-8000-000000000007',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    goal_id: 'goal-0002-4000-8000-000000000002',
    proposed_by: 'a1a1a1a1-0006-4000-8000-000000000006',
    assigned_to: null,
    title: 'Migrate from Next.js to Astro for better performance',
    description: 'Rewrite the Crest website using Astro for faster page loads and smaller bundle sizes.',
    reasoning: 'Astro ships zero JS by default which would improve Core Web Vitals scores significantly.',
    priority: 'medium',
    effort_estimate: 'large',
    task_type: 'engineering',
    status: 'rejected',
    reviewed_by: 'a1a1a1a1-0001-4000-8000-000000000001',
    reviewed_at: daysAgo(3),
    rejection_reason: 'We\'re too far along with Next.js and the team is already trained on it. The performance gain doesn\'t justify the rewrite cost at this stage.',
    info_request: null,
    converted_task_id: null,
    metadata: {},
    created_at: daysAgo(6),
    updated_at: daysAgo(3),
  },
  {
    id: 'sug-0008-4000-8000-000000000008',
    project_id: 'c3c3c3c3-0002-4000-8000-000000000002',
    goal_id: 'goal-0005-4000-8000-000000000005',
    proposed_by: 'a1a1a1a1-0007-4000-8000-000000000007',
    assigned_to: null,
    title: 'Implement end-to-end encryption for all patient messages',
    description: 'Add E2EE using Signal Protocol for the in-app messaging feature between patients and providers.',
    reasoning: 'E2EE would provide the highest level of data protection for PHI in transit.',
    priority: 'high',
    effort_estimate: 'large',
    task_type: 'engineering',
    status: 'rejected',
    reviewed_by: 'a1a1a1a1-0001-4000-8000-000000000001',
    reviewed_at: daysAgo(4),
    rejection_reason: 'TLS encryption in transit + AES-256 at rest meets HIPAA requirements. E2EE adds significant complexity (key management, no server-side search) for minimal compliance benefit at this stage.',
    info_request: null,
    converted_task_id: null,
    metadata: {},
    created_at: daysAgo(7),
    updated_at: daysAgo(4),
  },
];

// ---------------------------------------------------------------------------
// AGENT ACTIVITY
// ---------------------------------------------------------------------------
export const demoAgentActivity: AgentActivity[] = [
  {
    id: 'aact-0001-4000-8000-000000000001',
    agent_id: 'a1a1a1a1-0006-4000-8000-000000000006',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    activity_type: 'suggestion_created',
    title: 'Proposed: Color palette usage examples for dark backgrounds',
    description: 'Atlas analyzed the brand guide and identified a gap in dark-background color usage documentation.',
    reference_type: 'suggestion',
    reference_id: 'sug-0001-4000-8000-000000000001',
    metadata: {},
    created_at: hoursAgo(3),
  },
  {
    id: 'aact-0002-4000-8000-000000000002',
    agent_id: 'a1a1a1a1-0007-4000-8000-000000000007',
    project_id: 'c3c3c3c3-0002-4000-8000-000000000002',
    activity_type: 'suggestion_created',
    title: 'Proposed: Session timeout handling for patient portal',
    description: 'Scout identified a HIPAA compliance gap in the current authentication flow.',
    reference_type: 'suggestion',
    reference_id: 'sug-0002-4000-8000-000000000002',
    metadata: {},
    created_at: hoursAgo(5),
  },
  {
    id: 'aact-0003-4000-8000-000000000003',
    agent_id: 'a1a1a1a1-0007-4000-8000-000000000007',
    project_id: 'c3c3c3c3-0002-4000-8000-000000000002',
    activity_type: 'research_completed',
    title: 'Completed HIPAA technical safeguards research',
    description: 'Scout reviewed HIPAA §164.312 technical safeguards and compiled a checklist of requirements relevant to the patient portal architecture.',
    reference_type: null,
    reference_id: null,
    metadata: { findings_count: 12 },
    created_at: hoursAgo(8),
  },
  {
    id: 'aact-0004-4000-8000-000000000004',
    agent_id: 'a1a1a1a1-0006-4000-8000-000000000006',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    activity_type: 'research_completed',
    title: 'Completed competitor brand analysis',
    description: 'Atlas analyzed 5 competing financial advisory firms for visual identity trends, color usage, and digital presence quality.',
    reference_type: 'goal',
    reference_id: 'goal-0003-4000-8000-000000000003',
    metadata: { competitors_analyzed: 5 },
    created_at: daysAgo(1),
  },
  {
    id: 'aact-0005-4000-8000-000000000005',
    agent_id: 'a1a1a1a1-0006-4000-8000-000000000006',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    activity_type: 'suggestion_created',
    title: 'Proposed: Staging environment with CMS preview',
    description: 'Atlas identified that content reviewers are blocked waiting on developer deploys.',
    reference_type: 'suggestion',
    reference_id: 'sug-0003-4000-8000-000000000003',
    metadata: {},
    created_at: hoursAgo(8),
  },
  {
    id: 'aact-0006-4000-8000-000000000006',
    agent_id: 'a1a1a1a1-0007-4000-8000-000000000007',
    project_id: 'c3c3c3c3-0002-4000-8000-000000000002',
    activity_type: 'suggestion_created',
    title: 'Proposed: Audit third-party dependencies for BAA coverage',
    description: 'Scout flagged 4 third-party services that handle PHI without confirmed Business Associate Agreements.',
    reference_type: 'suggestion',
    reference_id: 'sug-0004-4000-8000-000000000004',
    metadata: {},
    created_at: hoursAgo(12),
  },
  {
    id: 'aact-0007-4000-8000-000000000007',
    agent_id: 'a1a1a1a1-0007-4000-8000-000000000007',
    project_id: 'c3c3c3c3-0002-4000-8000-000000000002',
    activity_type: 'task_started',
    title: 'Started working on appointment booking flow',
    description: 'Scout began implementing the multi-step appointment booking form after the suggestion was approved.',
    reference_type: 'task',
    reference_id: 'd4d4d4d4-0003-4000-8000-000000000003',
    metadata: {},
    created_at: daysAgo(1),
  },
  {
    id: 'aact-0008-4000-8000-000000000008',
    agent_id: 'a1a1a1a1-0006-4000-8000-000000000006',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    activity_type: 'status_changed',
    title: 'Marked "Competitor brand audit" goal as achieved',
    description: 'Atlas completed the analysis and the goal has been marked as achieved.',
    reference_type: 'goal',
    reference_id: 'goal-0003-4000-8000-000000000003',
    metadata: {},
    created_at: daysAgo(8),
  },
];

// ---------------------------------------------------------------------------
// PORTAL ANALYTICS (demo)
// ---------------------------------------------------------------------------
//
// The real analytics modal hits /api/projects/[id]/portal-analytics. Demo mode
// short-circuits that and synthesizes a plausible rollup so the UI is never
// empty in demos.

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

interface DemoSessionSeed extends Partial<PortalSessionSummary> {
  session_id: string;
  portal_settings_id: string;
  project_id: string;
  started_at: string;
  last_seen_at: string;
}

function buildDemoSession(seed: DemoSessionSeed): PortalSessionSummary {
  const start = new Date(seed.started_at).getTime();
  const end = new Date(seed.last_seen_at).getTime();
  return {
    session_id: seed.session_id,
    portal_settings_id: seed.portal_settings_id,
    project_id: seed.project_id,
    started_at: seed.started_at,
    last_seen_at: seed.last_seen_at,
    duration_seconds: Math.max(0, Math.round((end - start) / 1000)),
    event_count: seed.event_count ?? 6,
    views: seed.views ?? 1,
    files_downloaded: seed.files_downloaded ?? 0,
    files_previewed: seed.files_previewed ?? 0,
    invoices_viewed: seed.invoices_viewed ?? 0,
    invoice_pdfs_downloaded: seed.invoice_pdfs_downloaded ?? 0,
    sections_viewed: seed.sections_viewed ?? 3,
    credentials_submitted: seed.credentials_submitted ?? 0,
    pin_failures: seed.pin_failures ?? 0,
    had_failed_pin: seed.had_failed_pin ?? false,
    ip_address: seed.ip_address ?? null,
    ip_hash: seed.ip_hash ?? null,
    user_agent: seed.user_agent ?? null,
    referrer: seed.referrer ?? null,
    device_type: seed.device_type ?? 'desktop',
    browser: seed.browser ?? 'Chrome 138',
    os: seed.os ?? 'macOS 15',
    accept_language: seed.accept_language ?? 'en-US,en;q=0.9',
    timezone: seed.timezone ?? 'America/Denver',
    language: seed.language ?? 'en-US',
    screen_width: seed.screen_width ?? 1920,
    screen_height: seed.screen_height ?? 1080,
    viewport_width: seed.viewport_width ?? 1440,
    viewport_height: seed.viewport_height ?? 900,
    connection_type: seed.connection_type ?? '4g',
    color_scheme: seed.color_scheme ?? 'light',
    reduced_motion: seed.reduced_motion ?? false,
  };
}

const DEMO_SESSION_SEEDS: DemoSessionSeed[] = [
  {
    session_id: '11111111-1111-4111-8111-000000000001',
    portal_settings_id: 'ps-0001-4000-8000-000000000001',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    started_at: minutesAgo(45),
    last_seen_at: minutesAgo(38),
    event_count: 12, views: 1, files_previewed: 2, files_downloaded: 1, invoices_viewed: 1, invoice_pdfs_downloaded: 1, sections_viewed: 5,
    ip_address: '174.62.83.41', ip_hash: 'a1b2c3d4e5f60718',
    user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    browser: 'Safari 18', os: 'macOS 15', device_type: 'desktop',
    timezone: 'America/New_York', language: 'en-US',
    viewport_width: 1680, viewport_height: 1050,
  },
  {
    session_id: '11111111-1111-4111-8111-000000000002',
    portal_settings_id: 'ps-0001-4000-8000-000000000001',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    started_at: hoursAgo(6),
    last_seen_at: new Date(Date.now() - 6 * 3_600_000 + 4 * 60_000).toISOString(),
    event_count: 8, views: 1, files_previewed: 1, sections_viewed: 4,
    ip_address: '174.62.83.41', ip_hash: 'a1b2c3d4e5f60718',
    user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    browser: 'Safari iOS 18', os: 'iOS 18.0', device_type: 'mobile',
    timezone: 'America/New_York', language: 'en-US',
    screen_width: 393, screen_height: 852, viewport_width: 393, viewport_height: 660,
    connection_type: '4g',
  },
  {
    session_id: '11111111-1111-4111-8111-000000000003',
    portal_settings_id: 'ps-0001-4000-8000-000000000001',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    started_at: daysAgo(2),
    last_seen_at: new Date(Date.now() - 2 * 86_400_000 + 11 * 60_000).toISOString(),
    event_count: 16, views: 2, files_previewed: 4, files_downloaded: 3, invoices_viewed: 2, invoice_pdfs_downloaded: 1, sections_viewed: 6,
    ip_address: '174.62.83.41', ip_hash: 'a1b2c3d4e5f60718',
    browser: 'Chrome 138', os: 'Windows 10/11', device_type: 'desktop',
    timezone: 'America/New_York', language: 'en-US',
    viewport_width: 1920, viewport_height: 1080,
  },
  {
    session_id: '11111111-1111-4111-8111-000000000004',
    portal_settings_id: 'ps-0001-4000-8000-000000000001',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    started_at: daysAgo(5),
    last_seen_at: new Date(Date.now() - 5 * 86_400_000 + 2 * 60_000).toISOString(),
    event_count: 5, views: 1, sections_viewed: 2,
    ip_address: '45.92.176.11', ip_hash: '7f8e9d0c1b2a3344',
    browser: 'Firefox 130', os: 'Linux', device_type: 'desktop',
    timezone: 'Europe/London', language: 'en-GB',
    color_scheme: 'dark',
  },
  {
    session_id: '11111111-1111-4111-8111-000000000005',
    portal_settings_id: 'ps-0001-4000-8000-000000000001',
    project_id: 'c3c3c3c3-0001-4000-8000-000000000001',
    started_at: daysAgo(8),
    last_seen_at: new Date(Date.now() - 8 * 86_400_000 + 30_000).toISOString(),
    event_count: 3, views: 0, pin_failures: 3, had_failed_pin: true,
    ip_address: '203.0.113.99', ip_hash: '0000deadbeef0001',
    browser: 'Chrome 138', os: 'Windows 10/11', device_type: 'desktop',
    timezone: 'Asia/Shanghai', language: 'zh-CN',
  },
];

/** Synthesize a 30-day analytics rollup for one demo portal. The session ids
 *  are stable so expanding a row twice shows the same timeline. */
export function buildDemoPortalAnalytics(
  portalSettingsId: string,
  projectId: string,
): PortalAnalyticsResponse {
  const sessions = DEMO_SESSION_SEEDS
    .filter(s => s.portal_settings_id === portalSettingsId)
    .map(buildDemoSession);

  const totals = {
    total_events: sessions.reduce((s, x) => s + x.event_count, 0),
    total_sessions: sessions.length,
    unique_ip_hashes: new Set(sessions.map(s => s.ip_hash).filter(Boolean)).size,
    last_seen_at: sessions[0]?.last_seen_at ?? null,
    avg_duration_seconds: sessions.length === 0
      ? 0
      : Math.round(sessions.reduce((s, x) => s + x.duration_seconds, 0) / sessions.length),
    total_pin_failures: sessions.reduce((s, x) => s + x.pin_failures, 0),
  };

  return {
    range_days: 30,
    totals,
    // Left empty so the dashboard derives day buckets in the admin's local
    // timezone from the sessions array (matches the real API contract).
    views_by_day: [],
    sessions,
    top_sections: [
      { section: 'show_progress',    views: 5 },
      { section: 'show_files',       views: 4 },
      { section: 'show_invoices',    views: 3 },
      { section: 'show_hours',       views: 2 },
    ],
    top_files: [
      { file_id: 'demo-file-brand-guide',  name: 'Brand Guidelines v3.pdf',  mime_type: 'application/pdf', previews: 4, downloads: 2 },
      { file_id: 'demo-file-design-mocks', name: 'Homepage Mockups.zip',     mime_type: 'application/zip', previews: 3, downloads: 1 },
      { file_id: 'demo-file-final-assets', name: 'Final Logo Assets.zip',    mime_type: 'application/zip', previews: 1, downloads: 1 },
    ],
    top_invoices: [
      { invoice_id: `${projectId}-inv-001`, invoice_number: 'INV-001', amount: 4500, views: 3, pdf_downloads: 2 },
      { invoice_id: `${projectId}-inv-002`, invoice_number: 'INV-002', amount: 2800, views: 2, pdf_downloads: 0 },
    ],
    pin_failures: sessions
      .filter(s => s.had_failed_pin)
      .map(s => ({
        created_at: s.started_at,
        ip_address: s.ip_address,
        ip_hash: s.ip_hash,
        user_agent: s.user_agent,
        country_hint: null,
      })),
  };
}
