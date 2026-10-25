'use client';

import type { Read } from '@/lib/query-cache';
import type { EmployeeEarningsData } from '@/lib/types';

/**
 * Payroll: time entries, rates, adjustments, payouts and allocations, as the
 * person may see them. One cached read for the store's earnings, the payroll
 * panel and the compensation modal, which each fetched it before. Its own
 * module (not reads.ts) because the store imports it.
 */
export const payrollRead: Read<EmployeeEarningsData> = {
  key: 'payroll',
  tables: ['project_time_entries'],
  load: async () => {
    const response = await fetch('/api/workspace/payroll', { cache: 'no-store' });
    const payload = await response.json().catch(() => null) as { data?: EmployeeEarningsData; error?: string } | null;
    if (!response.ok || !payload?.data) throw new Error(payload?.error || 'Failed to load payroll');
    return payload.data;
  },
};
