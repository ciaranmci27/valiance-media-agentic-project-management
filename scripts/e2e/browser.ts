/**
 * The browser side of the end-to-end suite: the system Chrome driven by
 * playwright-core (no browser is downloaded). When no browser is found the
 * browser scenarios say "skipped: no browser" and pass, so an install
 * without Chrome still runs every API scenario.
 *
 * Which browser: CHROME_PATH when it names a file, else the first common
 * path that exists (Chrome, Chromium, Edge; Linux, macOS, Windows).
 * PM_E2E_BROWSER=off skips the browser on purpose.
 *
 * Pages are loaded with the same patience as the API calls (retry.ts): a
 * page the dev server answers mid-compile (a 5xx that is not the app's own)
 * is loaded again within the retry budget, then the page waits for the
 * network to go quiet. Selectors are by role and label, as people read the
 * screen, never by class names.
 */
import { existsSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { isCompileAnswer, RETRY_BUDGET_MS } from './retry';

/** Where a browser usually lives, most likely first. */
export const COMMON_BROWSER_PATHS: Record<string, string[]> = {
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge'],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

export type BrowserFound = { path: string; source: 'CHROME_PATH' | 'common path' } | { path: null; reason: string };

/**
 * The browser to drive, or why there is none. Pure: the environment, the
 * platform and the file check are passed in (the unit test fakes them).
 */
export function findBrowser(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
): BrowserFound {
  if (env.PM_E2E_BROWSER === 'off') return { path: null, reason: 'PM_E2E_BROWSER=off' };
  const named = env.CHROME_PATH?.trim();
  if (named) {
    // A named browser that is not there is said, not silently replaced.
    return exists(named) ? { path: named, source: 'CHROME_PATH' } : { path: null, reason: `CHROME_PATH ${named} does not exist` };
  }
  const found = (COMMON_BROWSER_PATHS[platform] ?? []).find((path) => exists(path));
  return found ? { path: found, source: 'common path' } : { path: null, reason: 'no Chrome or Chromium in the usual places (set CHROME_PATH)' };
}

/** The one line a skipped browser scenario prints. */
export const skippedLine = (found: Extract<BrowserFound, { path: null }>) => `skipped: no browser (${found.reason})`;

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

/** Starts the found browser headless, one context and page, desktop size. playwright-core is loaded only here. */
export async function launch(path: string, baseUrl: string): Promise<BrowserSession> {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: path, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(30_000);
  const page = await context.newPage();
  return { browser, context, page, close: async () => { await context.close().catch(() => {}); await browser.close().catch(() => {}); } };
}

/**
 * Opens a path and waits for the page to settle: loaded again while the dev
 * server answers mid-compile (within RETRY_BUDGET_MS), then the network
 * quiet. Answers the final status.
 */
export async function gotoReady(page: Page, path: string, budgetMs = RETRY_BUDGET_MS): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let wait = 250;
  for (;;) {
    let status = 0;
    let text = '';
    try {
      const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
      status = response?.status() ?? 0;
      text = status >= 500 ? await response!.text().catch(() => '') : '';
    } catch (error) {
      // The connection dropped while the server restarted a route: try again.
      if (Date.now() > deadline) throw error;
      await page.waitForTimeout(wait);
      wait = Math.min(wait * 2, 4_000);
      continue;
    }
    if (status === 0 || !isCompileAnswer(status, text, 'GET') || Date.now() > deadline) {
      await page.waitForLoadState('networkidle').catch(() => {});
      return status;
    }
    await page.waitForTimeout(wait);
    wait = Math.min(wait * 2, 4_000);
  }
}

/** Signs in through the login page, as a person does, and waits for the app shell. */
export async function signInPage(page: Page, email: string, password: string): Promise<void> {
  await gotoReady(page, '/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 60_000 });
  await page.waitForLoadState('networkidle').catch(() => {});
}
