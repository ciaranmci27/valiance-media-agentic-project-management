# Valiance Media Agentic Project Management

Open-source agentic project management software. Manage projects, track leads, coordinate teams, and let AI agents propose and execute work — all from a single dashboard.

**Built with Next.js 16, React 19, Supabase, and Tailwind CSS v4.**

![License](https://img.shields.io/badge/license-MIT-blue)

---

## Features

### Project Management
- **Projects** with status tracking, color coding, team assignment, and progress visualization
- **Tasks** with priorities, tags, assignees, subtasks, comments, and rich text descriptions
- **Three views**: Kanban board, sortable list, and calendar
- **Bulk operations**: select multiple tasks for batch status changes or deletion
- **Time tracking**: start/stop timers and manual hour entries per project

### Lead Pipeline & CRM
- **Full lead lifecycle**: New → Contacted → Qualified → Proposal → Won/Lost
- **30+ custom lead fields** across business identity, opportunity assessment, and strategy categories
- **Interactions**: log calls, emails, meetings, and follow-ups
- **Proposals**: draft, send, and track proposals per lead
- **Lead conversion**: one-click conversion from lead to project with contact preservation
- **Pipeline Kanban** with deal value aggregation per stage

### Contacts
- Centralized contact database linked to projects and leads
- Role assignments (Client, Technical Contact, Billing, Stakeholder, etc.)
- Primary client designation per project

### Team Management
- Role-based access: Admin, Member, Guest, Agent
- Email invitations with role selection
- Avatar upload with crop modal
- Per-member timezone and notification preferences

### Agentic Workflows
- **AI agents as team members** — agents get API keys and propose work through the suggestions system
- **Task suggestions**: agents submit proposed tasks with reasoning, priority, and effort estimates
- **Approval workflow**: admins review, approve, reject, or request more info on suggestions
- **Bulk approve/reject** for efficient suggestion triage
- **Project goals**: set objectives that agents can align suggestions against
- **Autonomous mode**: per-project toggle to enable agent-driven task creation
- **Activity log**: full audit trail of agent actions

### Client Portal
- Token-based public portal per project (no login required)
- Optional PIN protection
- Configurable visibility: progress, proposals, files, hours, updates
- Custom branding: logo, accent color, welcome message
- File sharing with download links
- **Portal updates**: post timeline updates (milestones, deliverables, notes) visible to clients

### REST API
- **109 endpoints** covering tasks, projects, leads, contacts, team, agents, files, portal, notifications, and API keys
- API key authentication with full and read-only permission levels
- Pagination, filtering, sorting, and search on all list endpoints
- Timezone-aware time entry creation
- Rate limiting and audit logging
- Interactive API documentation at `/api/docs`

### Notifications & Audit
- Granular notification preferences per category (tasks, projects, leads, contacts, team, portal, time entries, agent)
- API-accessible notifications with mark-as-read and bulk mark-all-read
- Full audit log with before/after snapshots on every data change
- Activity feed on the dashboard

### Other
- **Demo mode**: explore all features with sample data, no database required
- **Dark theme** with teal brand accent
- **Keyboard shortcuts**
- **Responsive design**: mobile-first with touch-friendly interactions
- **File attachments** on leads, projects, and contacts

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| UI | React 19, Tailwind CSS v4 |
| Database | Supabase (PostgreSQL) with Row-Level Security |
| Auth | Supabase Auth (email/password, session-based) |
| Rich Text | TipTap v3 |
| Validation | Zod v4 |
| Icons | Lucide React |

---

## Getting Started

### Prerequisites
- Node.js 18+
- A [Supabase](https://supabase.com) project

### Setup

1. **Clone the repo**
   ```bash
   git clone https://github.com/ciaranmci27/valiance-media-agentic-project-management.git
   cd valiance-media-agentic-project-management
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   ```bash
   cp .env.example .env.local
   ```
   Fill in your Supabase credentials:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
   ```

4. **Set up the database**

   Run the SQL migrations in `supabase/` against your Supabase project to create all required tables, indexes, and RLS policies.

5. **Start the dev server**
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000).

### Demo Mode

To try the app without a database, set:
```
NEXT_PUBLIC_DEMO_MODE=true
```
This loads sample data in-memory. Nothing persists.

### Enabling Agentic Features

Set the following to enable the Agent Hub:
```
NEXT_PUBLIC_ENABLE_AGENTS=true
```
Then create a team member with the `agent` role and generate an API key for it.

---

## API Quick Start

Generate an API key from **Settings → API Keys**, then:

```bash
# List your projects
curl -H "x-api-key: your-key" https://your-app.com/api/v1/projects

# Create a task
curl -X POST -H "x-api-key: your-key" -H "Content-Type: application/json" \
  -d '{"title": "New task", "project_id": "...", "status": "todo"}' \
  https://your-app.com/api/v1/tasks

# Submit an agent suggestion
curl -X POST -H "x-api-key: your-key" -H "Content-Type: application/json" \
  -d '{"title": "Suggested task", "project_id": "...", "reasoning": "..."}' \
  https://your-app.com/api/v1/task-suggestions
```

Full API documentation is available at `/api/docs` in your running instance.

---

## Project Structure

```
src/
├── app/
│   ├── (auth)/          # Login page
│   ├── (dashboard)/     # All authenticated pages
│   │   ├── dashboard/   # Main dashboard
│   │   ├── projects/    # Project list & detail
│   │   ├── my-tasks/    # Personal task view
│   │   ├── leads/       # Lead pipeline & detail
│   │   ├── contacts/    # Contact database
│   │   ├── team/        # Team management
│   │   ├── settings/    # Profile, notifications, API keys
│   │   └── agent/       # Agent hub (suggestions, activity)
│   ├── portal/          # Public client portal
│   └── api/             # REST API endpoints
├── components/          # Reusable UI components
├── contexts/            # React context providers
├── lib/                 # Supabase client, queries, utilities
├── schemas/             # Zod validation schemas
└── types/               # TypeScript type definitions
```

---

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

---

## License

[MIT](LICENSE)

---

Built by [Valiance Media](https://valiancemedia.com)
