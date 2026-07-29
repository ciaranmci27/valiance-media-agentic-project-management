# Lessons Learned

## Invoice Outstanding Calculation - DO NOT SIMPLIFY
The outstanding balance in `InvoicesPanel.tsx` has specific logic for hourly vs non-hourly projects:
- **Hourly**: `outstanding = max(0, billableTotal - totalPaid)` where `billableTotal = max(hourlyRate * totalHours, hourlyInvoiced) + fixedInvoiced`
- **Non-hourly**: `outstanding = max(0, totalInvoiced - totalPaid)`

This has been broken and fixed multiple times. Never simplify this to a single formula. The hourly/fixed invoice breakdown (`hourlyInvoiced`, `fixedInvoiced`) is load-bearing.

## Theme Sweeps Must Grep Inline Styles, Not Just Classes
The dark/light redesign missed hardcoded light-era zinc hexes in inline `style={{}}` props (paused timer card border `#E4E4E7`, paused dots/text `#A1A1AA`, analytics filter toggles). Class-based utilities flip via the `--ink`/zinc remaps in `globals.css`, but inline hex values do not.
- When fixing any theme/border bug, grep the whole of `src` for the zinc hex ramp (`#E4E4E7|#D4D4D8|#F4F4F5|#A1A1AA|#52525B|#71717A`) and fix every themed-area hit in the same pass.
- Replacements: borders → `var(--color-surface-border)` (cards) or `var(--color-input-border)` (interactive), tints → `rgba(var(--ink), N)`, greys → `var(--color-zinc-*)` or input-text tokens.
- Intentionally light surfaces are exempt: `src/lib/invoice-pdf/`, `src/app/portal/`, email templates.
- `projectColor` fallbacks stay literal hexes because alpha suffixes get appended (`projectColor + '30'`).
