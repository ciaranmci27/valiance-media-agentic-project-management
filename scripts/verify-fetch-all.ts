/**
 * fetchAllRows reads a whole dataset in as few requests as it can without
 * ever trusting a capped page: the first page's exact total ends the read,
 * a server cap below the page size still reads on, and a query that does not
 * pass the count falls back to stopping on an empty page.
 *
 * Run: npx tsx scripts/verify-fetch-all.ts
 */
import assert from 'node:assert/strict';
import { fetchAllRows } from '@/lib/supabase/fetch-all';

function table(size: number, cap: number, withCount = true) {
  const calls: { from: number; count?: string }[] = [];
  const rows = Array.from({ length: size }, (_, i) => i);
  const page = async (from: number, to: number, count: 'exact' | undefined) => {
    calls.push({ from, count });
    return {
      data: rows.slice(from, Math.min(to + 1, from + cap)),
      error: null,
      count: withCount && count ? size : null,
    };
  };
  return { calls, page };
}

async function main() {
  let t = table(250, 1000);
  assert.deepEqual(await fetchAllRows(t.page), Array.from({ length: 250 }, (_, i) => i));
  assert.equal(t.calls.length, 1, 'A dataset under one page is one request');
  assert.equal(t.calls[0].count, 'exact', 'The first page asks for the total');

  t = table(2500, 1000);
  assert.equal((await fetchAllRows(t.page)).length, 2500);
  assert.equal(t.calls.length, 3, 'Three pages and no empty probe');
  assert.equal(t.calls[1].count, undefined, 'Only the first page counts');

  t = table(1000, 1000);
  assert.equal((await fetchAllRows(t.page)).length, 1000);
  assert.equal(t.calls.length, 1, 'One exactly full page stops on the total');

  t = table(1700, 500);
  assert.equal((await fetchAllRows(t.page)).length, 1700, 'A server cap below the page size never truncates');
  assert.deepEqual(t.calls.map((c) => c.from), [0, 500, 1000, 1500]);

  t = table(0, 1000);
  assert.deepEqual(await fetchAllRows(t.page), []);
  assert.equal(t.calls.length, 1);

  t = table(1200, 1000, false);
  assert.equal((await fetchAllRows(t.page)).length, 1200, 'Without a count it reads until an empty page');
  assert.equal(t.calls.length, 3);

  await assert.rejects(fetchAllRows(async () => ({ data: null, error: new Error('boom') })), /boom/);
  console.log('fetchAllRows: totals, multiple pages, exact page, server cap, empty, no-count fallback and errors passed.');
}

void main();
