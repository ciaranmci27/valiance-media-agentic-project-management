# Lessons Learned

## Invoice Outstanding Calculation - DO NOT SIMPLIFY
The outstanding balance in `InvoicesPanel.tsx` has specific logic for hourly vs non-hourly projects:
- **Hourly**: `outstanding = max(0, billableTotal - totalPaid)` where `billableTotal = max(hourlyRate * totalHours, hourlyInvoiced) + fixedInvoiced`
- **Non-hourly**: `outstanding = max(0, totalInvoiced - totalPaid)`

This has been broken and fixed multiple times. Never simplify this to a single formula. The hourly/fixed invoice breakdown (`hourlyInvoiced`, `fixedInvoiced`) is load-bearing.
