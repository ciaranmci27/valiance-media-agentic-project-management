# Invoice Restructure: Line Items + Service Periods + Recurring Spread

## Goal
Support multi-line-item invoices (e.g. one $5,000 invoice = $2,000 hourly + $3,000 retainer) with explicit service periods so recurring/fixed revenue can be amortized across days on the finance chart.

## Phase 1 — Data model

- [ ] **Migration: `invoice_line_items` table**
  - `id uuid pk`, `invoice_id uuid fk → project_invoices.id on delete cascade`, `position int` (for ordering)
  - `item_type text` ('hourly' | 'fixed' | 'recurring')
  - `amount numeric not null`
  - `description text`
  - `service_start_date date null`, `service_end_date date null`
  - `recurrence_frequency text null` ('weekly' | 'monthly' | 'quarterly' | 'annual' — informational only; the actual spread uses service dates)
  - `created_at`, `updated_at`
- [ ] **Backfill**: for each existing `project_invoices` row insert one line item using its `amount`, `invoice_type`, `description`. Service dates left null on backfill.
- [ ] **Mark `project_invoices.invoice_type` as deprecated** (keep column for now to avoid breaking old code; remove in a later sweep). New writes still set it to the dominant line-item type so downstream filters keep working.
- [ ] **Types** (`src/lib/types.ts`): add `InvoiceLineItem` interface + `RecurrenceFrequency` union; extend `ProjectInvoice` with `line_items: InvoiceLineItem[]`.
- [ ] **Store** (`src/lib/store.tsx`): load line items alongside invoices; expose CRUD that writes parent invoice + line items in one transaction.

## Phase 2 — Invoice form (InvoicesPanel)

- [ ] Replace single type/amount fields with a **line-item editor**:
  - Repeatable rows: type dropdown · amount · description · service-start · service-end · (recurring only) frequency.
  - "Add line" button, per-row delete.
  - Live total = sum of line amounts (read-only summary above the rows).
- [ ] When type = `recurring`:
  - Auto-suggest `service_end` from `service_start` + frequency (e.g. monthly → +1 month - 1 day). User can override.
- [ ] When type = `fixed`:
  - Service start/end optional; if both set, used for amortization in chart.
- [ ] When type = `hourly`:
  - No service dates UI (already covered by time entries).
- [ ] Validation: total of line items ≥ 0; each amount ≥ 0; for recurring/fixed-with-period the start ≤ end.
- [ ] Update outstanding calc helper to consume line items (preserve the existing hourly vs non-hourly logic per `lessons.md`; just sum hourly/fixed across line items instead of reading top-level `invoice_type`).

## Phase 3 — Display surfaces

- [ ] **InvoicesPanel list rows**: show line-item type pills (Hourly · Fixed · Recurring) with per-line amounts when there are 2+ lines; collapse to single pill when only one.
- [ ] **Finance page Invoices section**: same treatment.
- [ ] **Client portal invoice card**: show line items breakdown.
- [ ] **Email templates** (`templates/client/*` and team notification): render line items table.

## Phase 4 — Finance chart amortization

- [ ] Build a `revenueByDay` map across the selected range:
  - For each line item with `service_start` + `service_end` overlapping the range: spread `amount / daysInPeriod` to each day in the overlap.
  - Items without service dates fall on the invoice `date` (single day).
  - Hourly items contribute nothing here (already represented by tracked time).
- [ ] Add a third stacked series **"Accrued revenue"** to the daily bar chart (color = brand-300 or copper accent — pick brand-system color, no hardcoded hex per global rule).
- [ ] Update tooltip to break out: hourly value · accrued revenue · payments received.
- [ ] Update `totalEarned` overview stat: replace the current `fixedRecurringInvoicedInRange` lump-sum with the **amortized** sum that falls inside the range. Hourly portion unchanged.
- [ ] Legend gets a third toggle.

## Phase 5 — Cleanup & verification

- [ ] Demo data (`src/lib/demo-data.ts`): add multi-line invoice example + recurring with service period so the chart visibly shows amortized retainer.
- [ ] Verify outstanding still matches between Overview and project details (regression risk per `lessons.md`).
- [ ] Type check + manual verification: load `/finances`, swap date ranges, confirm bars amortize correctly, hover tooltip shows three series.

## Open questions for user

1. **Backfill assumption**: should we leave existing recurring invoices with null service dates (they'll stack on invoice date), or auto-fill `service_start = invoice_date` and `service_end = invoice_date + 1 month` for any existing invoice with `invoice_type = 'recurring'`?
2. **Frequency dropdown values**: weekly / monthly / quarterly / annual enough? Anything else (biweekly, custom days)?
3. **Multiple line items per invoice**: should the line-item descriptions be required, or optional with the parent invoice description used as fallback?
4. **Existing `invoice_type` column**: keep writing it (dominant type by amount) for back-compat, or drop it entirely in this pass?

---

# Client Communications Overhaul

## Goal
Unify all client-facing email flows into a single "Communications" project tab, add preview-and-confirm for every manual send, add an opt-out approval gate for automations, fix the budget-extension edge case, add dollar-interval automation, and log every email (manual + automated + pending) in a per-project audit trail.

## Phase 1 — Data model

- [ ] **Migration: rename `project_notifications` → `client_communications` + extend**
  - `ALTER TABLE project_notifications RENAME TO client_communications`
  - Drop existing `notification_type` check, re-add with new values: `portal_welcome | project_summary | budget_threshold | dollar_interval | budget_extended`
  - Add columns: `status text NOT NULL DEFAULT 'sent' CHECK (status IN ('pending','sent','failed','dismissed'))`, `subject text`, `rendered_html text`, `slot_overrides jsonb DEFAULT '{}'`, `triggered_by uuid REFERENCES team_members(id) ON DELETE SET NULL`, `sent_at timestamptz`, `dismissed_at timestamptz`
  - Index on `(project_id, status)` for fast "pending" lookups
- [ ] **Migration: `portal_settings` additions**
  - `alert_mode text NOT NULL DEFAULT 'percentage' CHECK (alert_mode IN ('percentage','dollar_interval','none'))`
  - `dollar_interval numeric(12,2)` nullable
  - `require_alert_approval boolean NOT NULL DEFAULT true`
- [ ] Update `schema.sql` to match
- [ ] **Types** (`src/lib/types.ts`):
  - Add `ClientCommunication` interface (superset of old log row)
  - Add `CLIENT_COMM_TYPES`, `CLIENT_COMM_STATUSES` unions
  - Extend `PortalSettings` with `alert_mode`, `dollar_interval`, `require_alert_approval`
- [ ] **Portal schema** (`src/lib/schemas/portal.ts`): add the three new fields with validation

## Phase 2 — Email templates: slot-based overrides

Each template gets a `defaultSlots` export and accepts an optional `overrides?: Partial<Slots>` param.

- [ ] **Portal Welcome** slots: `subject`, `intro_paragraph`, `welcome_message`, `features_heading`, `closing_note`
- [ ] **Project Summary** slots: `subject`, `opening_line`, `closing_line`, `custom_paragraph` (optional, renders a paragraph between stats and CTA when non-empty)
- [ ] **Budget Threshold** slots: `subject`, `alert_paragraph`, `closing_line`
- [ ] **Budget Extended (NEW template)** slots: `subject`, `alert_paragraph`, `closing_line`. Content: greeting, "Your project budget has been updated" sentence, stat cards for New Budget / Used / Remaining, CTA to portal
- [ ] **Dollar Interval (NEW template)** slots: `subject`, `alert_paragraph`, `closing_line`. Content: greeting, "$X of tracked work on {project}" sentence, single stat card showing milestone reached, CTA

## Phase 3 — Server orchestration

- [ ] **Refactor `src/lib/email/client-notifications.ts`** (probably rename to `client-communications.ts`):
  - `previewCommunication(projectId, type, overrides?)` → returns `{ to, subject, html, text }` without sending
  - `sendCommunication(projectId, type, { overrides?, triggeredBy?, force? })` → renders, sends via `sendTransactional`, inserts `sent` row with rendered snapshot
  - `enqueuePendingCommunication(projectId, type, metadata)` → inserts `pending` row with rendered snapshot, fires internal team notification to project creator (fallback: project members)
  - `approveCommunication(commId, triggeredBy)` → sends the stored snapshot, updates status to `sent`
  - `dismissCommunication(commId, triggeredBy)` → updates status to `dismissed`
- [ ] **Budget mode routing** in a single `evaluateBudgetAlerts(projectId)` function:
  - Read `alert_mode` from portal_settings
  - Branch to `checkPercentageThresholds` or `checkDollarIntervals` or early-return for `none`
  - Each path respects `require_alert_approval`: enqueue pending vs. send directly
- [ ] **Budget extension handler** `handleBudgetChange(projectId, oldValue, newValue)`:
  - Sends (or enqueues) the `budget_extended` email
  - Silently inserts `sent` log rows for any percentage threshold already crossed at the new budget, so they won't re-fire
  - Called from project PATCH route when `budget_value` changes
- [ ] **Dollar interval logic**: dedup via `{ type: 'dollar_interval', milestone: 2000 }` metadata. Milestone = cumulative $ amount crossed. On each trigger, compute `currentAccrued`, find the highest milestone already sent, fire for each new multiple of `dollar_interval` between that and current.
- [ ] **Internal team notification helper** for pending alerts: use existing `notify()` pattern, target `project.created_by || project_members`, category: `budget_threshold` (reuse existing email pref)

## Phase 4 — API routes

- [ ] `GET /api/v1/projects/:id/client-communications` — list log entries, newest first, optionally filter `?status=pending`
- [ ] `GET /api/v1/projects/:id/client-communications/preview?type=X` — returns `{ to, subject, html }` for the modal
- [ ] `POST /api/v1/projects/:id/client-communications` — body: `{ type, overrides? }`, calls `sendCommunication` with `triggeredBy = current user`
- [ ] `PATCH /api/v1/projects/:id/client-communications/:commId` — body: `{ action: 'approve' | 'dismiss' }`
- [ ] Hook `handleBudgetChange` into the existing project PATCH route when `budget_value` changes
- [ ] Keep `evaluateBudgetAlerts` hook on time-entry stop + PATCH (replaces current `checkBudgetThresholds`)

## Phase 5 — Preview Modal (shared component)

- [ ] **`ClientEmailPreviewModal.tsx`**:
  - Props: `projectId`, `type`, `mode` (`'manual'` | `'pending-review'`), `commId?` (when reviewing a pending entry), `onSent`
  - Fetches defaults from `/preview` on open (or loads the stored snapshot if `commId`)
  - Left column: To (read-only), Subject input, one textarea per slot. Each slot has a "Reset" link. Debounced re-fetch of preview HTML on change.
  - Right column: iframe showing rendered HTML
  - Footer: `Cancel` / `Send Now` (manual) or `Approve & Send` / `Dismiss` (review)
  - Uses existing Modal/Dialog primitive in the project

## Phase 6 — Communications tab

- [ ] **New tab** on the project detail page (wherever Overview/Portal/Invoices/etc. tabs are registered)
- [ ] **`CommunicationsPanel.tsx`** sections:
  - **Actions row**: three buttons (`Welcome Email`, `Project Summary`, future: `Custom Message`). Each disabled with tooltip when primary client missing. Each opens the Preview Modal.
  - **Automation card**: radio for `alert_mode` (None / Percentage / Dollar intervals). Active mode shows its editor (threshold pills OR single numeric input for interval). Toggle for `require_alert_approval` (label: "Review before sending automated alerts"). Disabled for the whole card when no project budget AND alert mode is percentage (with an inline note).
  - **Log list**: chronological (newest first). Each row: type icon, subject, recipient name, status pill, timestamp. Pending rows get an amber highlight and a "Review" button. Clicking any row opens the Preview Modal in read-only mode showing the stored HTML snapshot. Status filter chips at the top (All / Sent / Pending / Dismissed / Failed).

## Phase 7 — Cleanup

- [ ] Remove "Send Welcome Email" button and threshold config from `PortalSettingsPanel.tsx`
- [ ] Remove "Send Summary" button from `InvoicesPanel.tsx`
- [ ] Update `src/lib/demo-data.ts`: add `alert_mode`, `dollar_interval`, `require_alert_approval` to portal settings; seed a handful of `client_communications` log entries (mix of sent / dismissed / one pending)
- [ ] Update `src/lib/store.tsx`: add `loadClientCommunications(projectId)`, local state slice, optimistic updates for approve/dismiss

## Phase 8 — Verification

- [ ] Type check
- [ ] Create a test project with a primary client + portal enabled. Verify Welcome Email flow: button → modal preview → edit subject + intro → send → log row appears
- [ ] Flip `alert_mode` to `dollar_interval`, set $2000, with `require_alert_approval = true`. Stop a timer that crosses $2000. Verify: (a) no email sent yet, (b) pending row appears, (c) creator receives internal notification, (d) opening review modal lets approve-or-dismiss, (e) approve sends the exact stored snapshot
- [ ] Flip `require_alert_approval = false`, stop another timer crossing $4000. Verify email sends immediately and logs as `sent`
- [ ] Extend budget from $2k to $4k. Verify: (a) `budget_extended` email queued, (b) old thresholds that are still crossed under new budget are silently marked sent so they don't re-fire
- [ ] Verify removed UI elements are gone from Portal Settings + Invoices panels

## Decisions locked in

- Per-project `require_alert_approval`, default `true`. No global settings table.
- Pending alerts notify `projects.created_by` (fallback: `project_members` if null).
- Alert modes are mutually exclusive (`none` / `percentage` / `dollar_interval`).
- Dollar intervals only supported when project is hourly with a rate.
- Rendered HTML stored as snapshot in log for audit/forever retention.
- Templates: editable slots (structured copy), never raw HTML.

---

# Bugfix: Dashboard activity inflated by board reorders (2026-07-29)

## Root cause
- Dashboard used `updated_at` of done tasks as the completion timestamp.
- Dropping a task into a board column resequences `sort_order` for every sibling that shifted; the generic `set_tasks_updated_at` trigger bumped `updated_at` on all of them.
- Result: completing 1 task counted every done task as "completed today" (28 instead of 1) and every done task showed "1 minute ago".

## Fix (all complete)
- [x] Migration `20260729144648_task_completed_at.sql`: add `tasks.completed_at`, backfill done tasks from `updated_at`, replace the tasks `updated_at` trigger with `handle_task_before_update` (stamps/clears `completed_at` on status transitions, skips the `updated_at` bump for sort_order-only writes) + `handle_task_before_insert`.
- [x] `schema.sql` updated in place (column + trigger functions).
- [x] `types.ts`: `Task.completed_at?: string | null`.
- [x] `store.tsx` `updateTask`: optimistic `completed_at` mirror + no local `updated_at` bump on reorder-only updates.
- [x] Dashboard `completedPerDay` uses `completed_at ?? updated_at` (fallback covers demo data).
- [x] Type check passes.

## Review
Verified all other `status === 'done'` usages are plain counts (no time inference). Activities feed is DB-loaded only, unaffected by reorders. API v1 task routes write through the same DB triggers, so they inherit the fix.
