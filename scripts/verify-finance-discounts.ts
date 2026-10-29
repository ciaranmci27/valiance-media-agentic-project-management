/**
 * A discount line on a split retainer comes out of the company's share in
 * Finances and the Dashboard, the same way the database pays splits on it.
 *
 * Run: npm run test:finance-discounts
 */
import { computeFinanceAttribution, computeFinanceData, lineShareKey } from '@/lib/finance/summary';
import { spreadLineItem } from '@/lib/invoice-utils';

let failures = 0;
let passes = 0;
function check(label: string, actual: number, expected: number) {
  if (Math.abs(actual - expected) < 0.005) {
    passes += 1;
  } else {
    failures += 1;
    console.error(`FAIL ${label}: expected ${expected}, got ${actual}`);
  }
}

const retainer = {
  id: 'r1', position: 0, item_type: 'recurring' as const, amount: 2000, description: 'Monthly retainer',
  service_start_date: '2026-11-01', service_end_date: '2026-11-30', recurrence_frequency: 'monthly' as const,
};
const discount = { ...retainer, id: 'd1', position: 1, amount: -1000, description: 'Discount' };

function invoice(lineItems: unknown[]) {
  return {
    id: 'inv1', project_id: 'p1', invoice_number: 'INV-1', amount: 1000, status: 'sent',
    invoice_type: 'recurring', date: '2026-11-01', due_date: '2026-11-15', paid_date: null,
    line_items: lineItems, deleted_at: null,
  };
}

const base = {
  projects: [{ id: 'p1', name: 'Client' }] as never,
  timeEntries: [],
  team: [],
  rateByProject: new Map<string, number>(),
  now: Date.parse('2026-12-05T12:00:00Z'),
  timezone: 'UTC',
  range: { startKey: '2026-11-01', endKey: '2026-11-30' },
  // Brennan's 50% sits on the retainer line only.
  lineSharePercent: new Map([[lineShareKey('inv1', 'r1'), 50]]),
};

const spread = [...spreadLineItem(discount, '2026-11-01').values()].reduce((sum, value) => sum + value, 0);
check('a discount spreads across its service days', spread, -1000);

const without = computeFinanceData({ ...base, invoices: [invoice([retainer])] as never });
check('earned without the discount is the company half', without.earned, 1000);

const withDiscount = computeFinanceData({ ...base, invoices: [invoice([retainer, discount])] as never });
check('earned with the discount is the company half less the discount', withDiscount.earned, 0);

// Even a split saved on the discount line is ignored, as in the database.
const strayShare = computeFinanceData({
  ...base,
  lineSharePercent: new Map([[lineShareKey('inv1', 'r1'), 50], [lineShareKey('inv1', 'd1'), 50]]),
  invoices: [invoice([retainer, discount])] as never,
});
check('a split on a discount line is ignored', strayShare.earned, 0);

const attribution = computeFinanceAttribution({ ...base, invoices: [invoice([retainer, discount])] as never });
const business = attribution.rows.find((row) => row.id === 'business');
check('business revenue is the discounted charge', business?.grossRevenue ?? NaN, 1000);
check('split members keep their full share', business?.recordedCost ?? NaN, 1000);
check('business margin is zero', business?.contribution ?? NaN, 0);

console.log(`${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
