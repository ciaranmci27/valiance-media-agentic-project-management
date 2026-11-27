import type { Page } from 'playwright-core';
import type { Scenario } from './run';
import { check, dataOf, equal, hire, makeProject, OWNER_SETUP_SCOPES, personalKey, retireAgent, step, tag, waitFor, type Ctx } from './harness';
import { findBrowser, gotoReady, launch, signInPage, skippedLine, type BrowserFound } from './browser';

/**
 * The screens people use, in a real browser (the system Chrome through
 * playwright-core), as the seeded Owner: sign in, answer a question in the
 * AI home's Needs you, hire a company agent step by step, edit an agent's
 * Access, and move a task to Trash and Undo. Each flow is checked in the
 * database afterwards, not only on screen. With no browser on the machine
 * it prints "skipped: no browser" and passes (browser.ts).
 */
export async function runBrowserFlows(ctx: Ctx, found: BrowserFound = findBrowser()): Promise<'skipped' | 'ran'> {
  if (found.path === null) {
    step(skippedLine(found));
    return 'skipped';
  }
  const session = await launch(found.path, ctx.baseUrl);
  try {
    const { page } = session;
    await signInPage(page, ctx.env.LOCAL_OWNER_EMAIL, ctx.env.LOCAL_OWNER_PASSWORD);
    check(!new URL(page.url()).pathname.startsWith('/login'), 'Signing in through the login page left the login page', page.url());
    step(`Browser (${found.source}): the Owner signed in through the login page`);

    await answerInNeedsYou(ctx, page);
    await hireStepByStep(ctx, page);
    await editAccess(ctx, page);
    await trashAndUndo(ctx, page);
  } finally {
    await session.close();
  }
  return 'ran';
}

/** An agent asks the Owner; the Owner answers with one tap in the AI home's Needs you. */
async function answerInNeedsYou(ctx: Ctx, page: Page): Promise<void> {
  const asker = await hire(ctx, { name: `E2E Asker ${tag}`, scopes: ['questions.ask', 'tasks.read'] });
  const text = `Ship the spring landing page today? ${tag}`;
  const asked = dataOf(await asker.key.post('/api/v1/questions', { question: text, asked_to: ctx.people.owner.memberId, choices: ['Ship it', 'Not yet'] }), 201, 'the agent asks the Owner');
  ctx.cleanup.add(`cancel question ${asked.id}`, () => ctx.db.query(`UPDATE pm.questions SET status = 'cancelled', cancelled_at = now() WHERE id = $1 AND status = 'open'`, [asked.id]));
  await gotoReady(page, '/ai');
  const row = page.getByRole('listitem').filter({ hasText: text });
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  await row.getByRole('button', { name: 'Ship it', exact: true }).click();
  const answered = await waitFor('the answer is stored', async () => {
    const found = (await ctx.db.query(`SELECT status, answer_choice, answered_by FROM pm.questions WHERE id = $1`, [asked.id])).rows[0];
    return found?.status === 'answered' ? found : null;
  });
  equal(answered.answer_choice, 'Ship it', 'answer chosen in Needs you');
  equal(answered.answered_by, ctx.people.owner.memberId, 'answered by the Owner');
  step('Browser: the Owner answered an agent\'s question with one tap in Needs you');
}

/** Hire a company agent through every step of the Hire screen, starting blank. */
async function hireStepByStep(ctx: Ctx, page: Page): Promise<void> {
  const name = `E2E Browser Hire ${tag}`;
  const next = (label = 'Next') => page.getByRole('button', { name: label, exact: true }).click();
  await gotoReady(page, '/ai/agents/new');
  await page.getByRole('radio', { name: /Company agent/ }).click();
  await next('Hire a company agent');
  await page.getByRole('radio', { name: /Start blank/ }).click();
  await next();
  await page.getByLabel('Name', { exact: false }).first().fill(name);
  await next(); // Who is it?
  await next(); // Who does it work for?
  await next(); // Who can use it?
  await page.getByRole('button', { name: /^(Next|Skip for now)$/ }).click(); // Where does it work?
  // What may it do? A blank start has no powers, and the step asks for at least one.
  await page.getByRole('checkbox', { name: 'Projects: View', exact: true }).first().check({ force: true }); // the styled box hides the real input
  await next('Review');
  await page.getByRole('button', { name: `Hire ${name}`, exact: true }).click();
  const agent = await waitFor('the hired agent', async () =>
    (await ctx.db.query(`SELECT id, role, status FROM pm.team_members WHERE name = $1`, [name])).rows[0] ?? null, 30_000);
  ctx.cleanup.add(`retire agent ${agent.id}`, () => retireAgent(ctx.db, agent.id));
  equal(agent.role, 'agent', 'hired member is an agent');
  // The key shows once; the flow ends on "It works, try it".
  await page.getByRole('button', { name: /^(I saved the key|Next)$/ }).click();
  await page.getByText('It works, try it').waitFor({ state: 'visible' });
  step(`Browser: the Owner hired ${name} step by step, and it is an agent in the team`);
}

/** Turn on Ask first on an agent's Access tab; it saves at once. */
async function editAccess(ctx: Ctx, page: Page): Promise<void> {
  const agent = await hire(ctx, { name: `E2E Access ${tag}`, scopes: ['tasks.read'] });
  await gotoReady(page, `/ai/agents/${agent.agent.id}?tab=access`);
  const toggle = page.getByRole('switch', { name: 'Ask first' });
  await toggle.waitFor({ state: 'visible' });
  check((await toggle.getAttribute('aria-checked')) === 'false', 'Ask first starts off');
  await toggle.click();
  const saved = await waitFor('Ask first is saved', async () => {
    const row = (await ctx.db.query(`SELECT ask_first FROM pm.team_members WHERE id = $1`, [agent.agent.id])).rows[0];
    return row?.ask_first === true ? row : null;
  });
  check(saved.ask_first === true, 'Ask first is on in the database');
  step('Browser: the Owner turned on Ask first on an agent\'s Access tab, saved at once');
}

/** Move a task to Trash from its panel, then Undo from the toast. */
async function trashAndUndo(ctx: Ctx, page: Page): Promise<void> {
  const ownerKey = (await personalKey(ctx, ctx.people.owner, OWNER_SETUP_SCOPES, 'browser setup')).caller;
  const project = await makeProject(ctx, ownerKey, 'Browser trash', [ctx.people.owner.memberId]);
  const task = dataOf(await ownerKey.post('/api/v1/tasks', { project_id: project.id, title: `E2E Trash me ${tag}`, assignee_ids: [ctx.people.owner.memberId] }), 201, 'a task to trash');
  await gotoReady(page, `/projects/${project.id}?task=${task.id}`);
  await page.getByRole('button', { name: 'Task actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
  await waitFor('the task is in Trash', async () =>
    (await ctx.db.query(`SELECT 1 FROM pm.tasks WHERE id = $1 AND deleted_at IS NOT NULL`, [task.id])).rows[0] ?? null);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await waitFor('the task is back', async () =>
    (await ctx.db.query(`SELECT 1 FROM pm.tasks WHERE id = $1 AND deleted_at IS NULL`, [task.id])).rows[0] ?? null);
  step('Browser: the Owner moved a task to Trash from its panel and brought it back with Undo');
}

const scenario: Scenario = {
  name: 'Browser: sign in, Needs you, hire step by step, Access, Trash and Undo',
  run: async (ctx) => { await runBrowserFlows(ctx); },
};

export default scenario;
