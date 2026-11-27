/**
 * The end-to-end suite's browser finder and skip logic (scripts/e2e/browser.ts,
 * 08-browser.ts), without a browser or the local stack:
 * - CHROME_PATH wins when it names a file; a CHROME_PATH that is not there
 *   is said, never silently replaced by another browser.
 * - Otherwise the first common path for the platform that exists.
 * - None found (or PM_E2E_BROWSER=off): the browser scenario prints
 *   "skipped: no browser" with why, passes, and touches nothing (no
 *   browser launched, no people, no database).
 * - playwright-core is a dev dependency at an exact version, loaded only
 *   when a browser runs.
 *
 *   npm run -s test:e2e-browser
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMON_BROWSER_PATHS, findBrowser, skippedLine } from './e2e/browser';
import { runBrowserFlows } from './e2e/08-browser';
import type { Ctx } from './e2e/harness';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

const only = (...paths: string[]) => (path: string) => paths.includes(path);

async function main() {
  // Finding a browser.
  const named = findBrowser({ CHROME_PATH: '/opt/chrome/chrome' }, 'linux', only('/opt/chrome/chrome', '/usr/bin/google-chrome'));
  check('CHROME_PATH wins when it names a file', named.path === '/opt/chrome/chrome' && 'source' in named && named.source === 'CHROME_PATH', named);
  const missing = findBrowser({ CHROME_PATH: '/nowhere/chrome' }, 'linux', only('/usr/bin/google-chrome'));
  check('a CHROME_PATH that is not there is said, not replaced by another browser', missing.path === null && 'reason' in missing && missing.reason.includes('/nowhere/chrome'), missing);
  const common = findBrowser({}, 'linux', only('/usr/bin/chromium'));
  check('without CHROME_PATH, the first common path that exists (Chromium here)', common.path === '/usr/bin/chromium' && 'source' in common && common.source === 'common path', common);
  const order = findBrowser({}, 'linux', only('/usr/bin/chromium', '/usr/bin/google-chrome'));
  check('Chrome before Chromium when both are there', order.path === '/usr/bin/google-chrome', order);
  const mac = findBrowser({}, 'darwin', only(COMMON_BROWSER_PATHS.darwin[0]));
  check('macOS: the Chrome app', mac.path === COMMON_BROWSER_PATHS.darwin[0], mac);
  const none = findBrowser({}, 'linux', () => false);
  check('none found: no path, and the reason says to set CHROME_PATH', none.path === null && 'reason' in none && none.reason.includes('CHROME_PATH'), none);
  check('an unknown platform finds none', findBrowser({}, 'aix', () => true).path === null);
  const off = findBrowser({ PM_E2E_BROWSER: 'off', CHROME_PATH: '/opt/chrome/chrome' }, 'linux', () => true);
  check('PM_E2E_BROWSER=off skips the browser on purpose', off.path === null && 'reason' in off && off.reason === 'PM_E2E_BROWSER=off', off);
  check('the skip line starts "skipped: no browser"', 'reason' in none && skippedLine(none).startsWith('skipped: no browser ('));

  // Skipping: prints the line, passes, touches nothing.
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { printed.push(args.join(' ')); };
  const touched: string[] = [];
  const ctx = new Proxy({}, { get: (_target, key) => { touched.push(String(key)); throw new Error(`the skipped scenario read ctx.${String(key)}`); } }) as Ctx;
  let outcome: string | Error;
  try {
    outcome = await runBrowserFlows(ctx, { path: null, reason: 'no Chrome or Chromium in the usual places (set CHROME_PATH)' });
  } catch (error) {
    outcome = error as Error;
  } finally {
    console.log = log;
  }
  check('no browser: the scenario passes as skipped', outcome === 'skipped', outcome instanceof Error ? outcome.message : outcome);
  check('no browser: it prints one "skipped: no browser" step', printed.length === 1 && /ok {2}skipped: no browser \(/.test(printed[0]), printed);
  check('no browser: nothing is launched or read (no people, no database, no base URL)', touched.length === 0, touched);

  // The dependency.
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  check('playwright-core is a dev dependency at an exact version, never shipped to the app', /^\d+\.\d+\.\d+$/.test(pkg.devDependencies?.['playwright-core'] ?? '') && !pkg.dependencies?.['playwright-core'],
    pkg.devDependencies?.['playwright-core']);
  const browserSource = readFileSync(join(__dirname, 'e2e', 'browser.ts'), 'utf8');
  check('playwright-core is loaded only when a browser runs (a dynamic import; types only at the top)',
    /await import\('playwright-core'\)/.test(browserSource) && !/^import (?!type )[^\n]*'playwright-core'/m.test(browserSource));
  const run = readFileSync(join(__dirname, 'e2e', 'run.ts'), 'utf8');
  check('the browser scenario is in the suite', run.includes("import browserFlows from './08-browser'") && /SCENARIOS[^\n]*browserFlows/.test(run));

  if (failures.length) {
    console.error(`e2e-browser: ${failures.length} failed, ${passed} passed`);
    for (const failure of failures) console.error(`  x ${failure}`);
    process.exit(1);
  }
  console.log(`e2e-browser: all ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
