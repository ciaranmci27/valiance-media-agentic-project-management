/**
 * Navigation: the AI nudge until AI is set up, and a page's tab row keeping what fits with the open tab always
 * shown. Pure logic; nothing touches a database.
 *
 *   npm run -s test:navigation
 */
import { aiNudge, type AiNudgeInput } from '@/lib/nav';
import { fitTabs } from '@/lib/tab-overflow';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

// ── The AI nudge ───────────────────────────────────────────────────────────
{
  const base: AiNudgeInput = { role: 'owner', aiEntry: true, hasAgents: false, assistantsOn: false, hasAssistant: false, chatApps: 0, linkedChats: null };
  check('an Owner with no agent or assistant is nudged to set up AI', aiNudge(base) === 'owner');
  check('an Owner with any agent is not', aiNudge({ ...base, hasAgents: true }) === null);
  check('nobody is nudged while AI is off for them', aiNudge({ ...base, aiEntry: false }) === null);
  const person: AiNudgeInput = { role: 'member', aiEntry: true, hasAgents: true, assistantsOn: true, hasAssistant: true, chatApps: 1, linkedChats: 0 };
  check('a member whose assistant has no chat linked is nudged to connect', aiNudge(person) === 'member');
  check('not once a chat is linked', aiNudge({ ...person, linkedChats: 1 }) === null);
  check('not while the links are still loading', aiNudge({ ...person, linkedChats: null }) === null);
  check('not with assistants off', aiNudge({ ...person, assistantsOn: false }) === null);
  check('not without an assistant of their own (an Owner gives them one)', aiNudge({ ...person, hasAssistant: false }) === null);
  check('not when there is no chat app to link', aiNudge({ ...person, chatApps: 0 }) === null);
  check('a member is never nudged to set up AI for the company', aiNudge({ ...person, hasAgents: false, assistantsOn: false }) === null);
}

// ── Tab rows: what fits, the open tab always shown ─────────────────────────
{
  const widths = [80, 60, 90, 70, 100, 110];
  check('everything fits: every tab, no More', fitTabs({ widths, moreWidth: 60, available: 600, activeIndex: 0, gap: 4 }).join() === '0,1,2,3,4,5');
  const narrow = fitTabs({ widths, moreWidth: 60, available: 310, activeIndex: 1, gap: 4 });
  check('too narrow: tabs in order as far as fit beside More', narrow.join() === '0,1,2', narrow);
  const far = fitTabs({ widths, moreWidth: 60, available: 310, activeIndex: 5, gap: 4 });
  check('the open tab under More takes the row\'s last place', far.join() === '0,5', far);
  const used = (list: number[]) => list.reduce((s, i) => s + widths[i], 0) + 4 * (list.length - 1) + 4 + 60;
  check('the row with More never overflows', used(narrow) <= 310 && used(far) <= 310, { narrow: used(narrow), far: used(far) });
  const tiny = fitTabs({ widths, moreWidth: 60, available: 50, activeIndex: 3, gap: 4 });
  check('however narrow, the open tab shows', tiny.join() === '3', tiny);
  check('no tabs, nothing to show', fitTabs({ widths: [], moreWidth: 60, available: 50, activeIndex: -1 }).length === 0);
}

if (failures.length) {
  console.error(`navigation: ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log(`navigation: all ${passed} checks passed`);
