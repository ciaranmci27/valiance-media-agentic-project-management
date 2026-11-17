# Design

Mode: Converge
Kind: application

The PM and CRM app: projects, tasks, the Inbox (email and meetings), leads, contacts, team, the client portal. Dark first, with a light theme a person can switch to. Drafted from the code on 2026-11-17; the owner picks the reference screens.

## Tokens

All in `src/app/globals.css`, one source of truth:

- **Brand**: `--color-brand-50` to `--color-brand-700` (teal, `#5b8a8a` at 500), injected at runtime from `src/site-config.ts` by `ThemeProvider`. Copper (`--color-copper`) is the one accent beside it. Site config holds brand only.
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

Shared, in `src/components/ui/`: `Button` (primary, secondary, ghost, danger; sm, md, lg), `Modal`, `ConfirmDialog` (with `trash` for soft deletes), `Tooltip`, `Popover`, `RowActionsMenu`, `Toast` (`toast()`), `Avatar`, `Badge`, `CountBadge`, `DataTable`, `KpiTile`, `Sparkline`, `SectionHeader`, `Select`, `Toggle`, `FilePreviewModal`, inputs in `ui/inputs/`.

Inbox pieces, in `src/components/inbox/`: `inbox-badges.tsx` (state dots, trust, project chips, time formats), `NotePill` (pill that opens a card, in `ThreadView.tsx`), `MeetingParts.tsx` (meeting details, the transcript reader, the suggestions checklist with Add all and Nothing to do).

## Signature

- **Liquid glass on near-black**: translucent cards over a deep base, with a quiet teal glow reserved for what you can act on (`liquid-primary`). Glass blur is webkit-only by design.
- **Soft filled surfaces, never stripes**: state is a low-alpha fill (`bg-white/[0.04]`, `bg-amber-500/[0.14]`), never a left-border accent.
- **Pills that open cards**: the agent's work under a message is one line of small pills (Summary, 2 tasks, 1 reminder, Question for you) that each open a paragraph-width card, so nothing spreads across the page.
- **Plain, short words**: labels say what happens ("Add all 7", "Nothing to do", "Mark handled"). Results read as one plain line ("Added 7 suggestions"). Status and loader copy is three words, present tense. No em dashes.
- **Undo over confirm**: anything reversible acts at once and leaves one plain line with Undo in place; a confirmation is only for what cannot be undone.
- **Dense but calm**: 11 to 13px meta text, generous line height in reading areas (email bodies, transcripts), tabular numbers for times and counts.

## Reference screens

Owner to pick 2 or 3. Candidates: the Inbox (list plus thread), a project's Tasks board, the task panel.

## Still converging

- Status colors use Tailwind palette classes (emerald, amber, red, sky) rather than named status tokens.
- `Toast` has no action slot; Undo lives in place in the view that made the change (the "Not a task" receipt, the meeting checklist's "Added 7 suggestions" line).
- Several older screens hand-roll pill and menu markup that `NotePill` and `RowActionsMenu` now cover.
- `ConfirmDialog` takes a plain string message only; a confirmation that must list items needs a variant.
