/**
 * The shared read cache (src/lib/query-cache.ts): a read again after a write
 * (`force`) gets an answer from after the write, even while an earlier
 * request for the same read is still running, and that earlier answer never
 * overwrites it when it lands late. Plain loads still share one request.
 *
 * Run: npx tsx --tsconfig tsconfig.mcp-test.json scripts/verify-query-cache.ts
 */
import { loadRead, peekRead, type Read } from '../src/lib/query-cache';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

/** A read whose server is a value the test changes, answering after a delay it controls. */
function fakeServer(key: string) {
  let value = 'before the write';
  let calls = 0;
  const pending: Array<() => void> = [];
  const read: Read<string> = {
    key,
    load: () => {
      calls++;
      const answer = value; // what the server held when the request reached it
      return new Promise<string>((resolve) => pending.push(() => resolve(answer)));
    },
  };
  return {
    read,
    write: (next: string) => { value = next; },
    calls: () => calls,
    /** Answer the requests in the order given (0 = the first one made). */
    answer: (order: number[]) => { const all = [...pending]; for (const index of order) all[index]?.(); },
  };
}

async function main() {
  // A refresh started before the write is still running when the caller writes and reads again.
  const thread = fakeServer('thread:a');
  const early = loadRead(thread.read);
  thread.write('after the write');
  const forced = loadRead(thread.read, { force: true });
  check('a forced read starts its own request instead of joining the running one', thread.calls() === 2, thread.calls());
  thread.answer([1, 0]); // the forced one answers first, the early one lands late
  check('the forced read answers with data from after the write', (await forced) === 'after the write', await forced);
  check('the early request still answers its own caller', (await early) === 'before the write', await early);
  check('the late, older answer does not overwrite the newer one in the cache', peekRead(thread.read) === 'after the write', peekRead(thread.read));

  // In order, the newer answer wins too.
  const list = fakeServer('thread:b');
  const first = loadRead(list.read);
  list.write('after the write');
  const second = loadRead(list.read, { force: true });
  list.answer([0, 1]);
  await Promise.all([first, second]);
  check('answering in order keeps the newer answer', peekRead(list.read) === 'after the write', peekRead(list.read));

  // Without force, concurrent callers share one request.
  const shared = fakeServer('thread:c');
  const one = loadRead(shared.read);
  const two = loadRead(shared.read);
  check('plain loads share one request', shared.calls() === 1 && one === two, shared.calls());
  shared.answer([0]);
  await one;
  check('a fresh cached answer is used without a request', (await loadRead(shared.read)) === 'before the write' && shared.calls() === 1, shared.calls());

  if (failures.length) {
    console.error(`query cache: ${passed} checks passed, ${failures.length} failed:\n - ${failures.join('\n - ')}`);
    process.exitCode = 1;
  } else {
    console.log(`query cache: ${passed} checks passed.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
