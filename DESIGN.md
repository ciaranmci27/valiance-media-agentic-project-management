# Design

Mode: Converge
Kind: application

The PM and CRM app: projects, tasks, the Inbox (email and meetings), leads, contacts, team, the client portal. Dark first, with a light theme a person can switch to. Drafted from the code on 2026-11-17.

## Tokens

All in `src/app/globals.css`, one source of truth:

- **Brand**: `--color-brand-50` to `--color-brand-700` (teal, `#5b8a8a` at 500), generated from the color an Owner picks in Settings > Workspace > Brand and injected at runtime by `ThemeProvider` (defaults in `src/lib/brand/defaults.ts`). Copper (`--color-copper`) is the one accent beside it. The brand settings hold the brand only; fonts and surfaces stay in CSS.
- **Surfaces**: `--color-surface` (page), `--color-surface-raised` (cards, modals), `--color-surface-overlay` (menus, popovers, tooltips), `--color-surface-border`. Glass: `--glass-bg`, `--glass-bg-strong`, `--glass-highlight`, `--glass-blur`.
- **Ink**: `--ink` is the RGB the white alpha utilities (`bg-white/[0.04]`, `text-zinc-*`) resolve through, so `[data-theme="light"]` remaps them without per-component work. Write `bg-white/[0.0x]` and `text-zinc-*` in components; never a hex.
- **Type**: DM Sans (`--font-sans`) for everything, DM Mono (`--font-mono`) only for codes and ids. Sizes in use: `text-[11px]` meta, `text-xs` secondary, `text-sm` body, `text-base`/`text-lg` view titles.
- **Inputs**: `--color-input-*` and `--radius-input`, `--radius-input-sm`.
- **Elevation**: `--shadow-card`, `--shadow-card-hover`, `--shadow-overlay`, `--shadow-glow` (brand-derived).
- **Status colors**: Tailwind's emerald (done, tasks), amber (waiting, reminders, needs you), red (urgent, errors), sky (replies owed), at low alpha fills (`bg-amber-500/[0.14]`) with 200 to 300 ink.

## Page anatomy

- Shell: always-dark sidebar (`src/components/layout/Sidebar.tsx`, `data-theme="dark"`), then the page body. No header bar beyond `Header.tsx`.
- A page body is a `glass-card` (rounded-xl) or a column of them. List and detail views split into a list column (320 to 380px) and a detail pane on desktop, and take turns on phones (a back button on the detail).
- A detail header: title (`h2`, semibold, tight tracking), one wrapping row of status, project chips and counts, then actions on the right in one bordered button group (`RowActionsMenu` for the rest).
- Sections inside a pane are separated by `border-white/[0.06]` hairlines, not boxes.

## Components

Shared, in `src/components/ui/`: `Button` (primary, secondary, ghost, danger; sm, md, lg), `Modal`, `ConfirmDialog` (with `trash` for soft deletes), `Tooltip`, `Popover`, `RowActionsMenu`, `Toast` (`toast()`), `Avatar`, `Badge`, `CountBadge`, `DataTable`, `StatStrip`, `Sparkline`, `SectionHeader`, `Select`, `Toggle`, `FilePreviewModal`, inputs in `ui/inputs/`.

`StatStrip` is the one way to show a row of numbers: one surface (or `bare` inside a card), stats side by side with hairlines once its own width fits them all, a label and value list below that. Label 12px zinc-500 and value 20px semibold tabular in the row; label 14px zinc-300 and value 16px in the list. Props per stat: `label`, `value` (null shows `empty` muted), `context`, `tone` (default, success, warning, danger, info), `icon`, `href` or `onSelect` with `selected`, `spark`. The row switch is the `strip-row` variant in `globals.css`.

The side panel, `TaskPanelShell` (`src/components/tasks/`), is the one slide-out: a task, a new task's draft, and editing a project (`ProjectForm`) open in it. 480px from the right on desktop, full screen on phones; Escape, the backdrop or the X closes it. A form in it groups fields into hairline sections, one column, with the save bar pinned at the bottom, and asks before discarding unsaved edits.

Guided flows, in `src/components/ui/Stepper.tsx`: `FlowShell` (full page, a way out, the stepper, an optional aside), `Stepper` (numbered on desktop, "Step 2 of 6" with a bar on phones), `StepPanel`, `StepFooter` (Back, and a Next that names what it does: "Hire Nova"), `ChoiceCard`, `ChatSetupAside`. Hiring an agent (`/agent/new`) and setting up a project (`/projects/new`) are built from these; a new guided setup is too. A short create flow inside a `Modal` (New API key and New webhook endpoint in Settings > Developers) uses `Stepper`, `StepPanel` and `StepFooter` without `FlowShell`, and `SecretOnce` (`src/components/agent/ConnectPanel.tsx`) for a secret shown once.

Agent pieces, in `src/components/agent/`: `AgentAvatar` (initials on one of the `--color-avatar-1..8` tones, picked from the name, with a presence dot; a working agent's ring breathes, still under reduced motion), `PresencePill`, `OwnerStack`, `SettingsForm` (a form drawn from a template's settings fields), `AssignmentList` (agents on projects, a hundred deep), `ScopePicker` and `RulesFields`, `ConnectSnippets`. Logic behind them is pure, in `src/lib/agents-ui.ts`.

Assistant pieces, in `src/components/assistant/` (My Assistant, `/assistant`, for every person; plain words only, never keys, scopes or templates): `AssistantSettingsCard` (name, color, how it writes, a note, four switches, pause), `AssistantActivityBand` (what it did, each line with Undo in place), `AssistantChatCard` (connect a chat in two steps). Settings > Assistants is in `src/components/settings/assistants/`. Rules behind them are in `src/lib/assistant.ts`.

Inbox pieces, in `src/components/inbox/`: `inbox-badges.tsx` (state dots, trust, project chips, time formats), `agent-card.tsx` (every agent card in a conversation: `cardChrome`, `quietCardChrome`, `AgentCardHeader` with the Agent pill and a one-line "what it did", `CardSummary`, `NotePill` (pill that opens a card), `NoteCardHeader`; the triage card and the reply draft card are both built from it), `MeetingParts.tsx` (meeting details, the transcript reader, the suggestions checklist with Add all and Nothing to do).

## Signature

- **Liquid glass on near-black**: translucent cards over a deep base, with a quiet teal glow reserved for what you can act on (`liquid-primary`). Glass blur is webkit-only by design.
- **Soft filled surfaces, never stripes**: state is a low-alpha fill (`bg-white/[0.04]`, `bg-amber-500/[0.14]`), never a left-border accent.
- **Pills that open cards**: the agent's work under a message is one line of small pills (Summary, 2 tasks, 1 reminder, Question for you) that each open a paragraph-width card, so nothing spreads across the page.
- **Plain, short words**: labels say what happens ("Add all 7", "Nothing to do", "Mark handled"). Results read as one plain line ("Added 7 suggestions"). Status and loader copy is three words, present tense. No em dashes.
- **Undo over confirm**: anything reversible acts at once and leaves one plain line with Undo in place; a confirmation is only for what cannot be undone.
- **Numbers in a row are one stat strip, never a grid of separate tiles**; on phones the strip becomes a label and value list. No odd stat stranded on its own row.
- **Built for a hundred**: lists of agents, assignments, brief entries and needs-you items search, filter and show a window with "Show 24 more of 76", never a row of one tile per agent.
- **Guided setups that create something with its own page are full pages** (an agent, a project): one step at a time, each checked before Next, with the same flow family everywhere. A short create flow that ends in a secret or a list row (an API key, a webhook endpoint) may be a step dialog; while a secret that is never shown again is on screen, only an explicit Done closes it (no backdrop, Escape or X).
- **Dense but calm**: 11 to 13px meta text, generous line height in reading areas (email bodies, transcripts), tabular numbers for times and counts.

## Reference screens

Match new work to these: the Inbox (list plus thread), a project's Tasks board, the task panel.

## Still converging

- Status colors use Tailwind palette classes (emerald, amber, red, sky) rather than named status tokens.
- `Toast` has no action slot; Undo lives in place in the view that made the change (the "Not a task" receipt, the meeting checklist's "Added 7 suggestions" line).
- Several older screens hand-roll pill and menu markup that `NotePill` and `RowActionsMenu` now cover.
- `ConfirmDialog` takes a plain string message only; a confirmation that must list items needs a variant.
