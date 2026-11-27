/**
 * The work screens' small rules (projects, tasks, inbox), pure and fast:
 * - The Inbox says plainly that it could not confirm a sender, with the
 *   email check's own words (DKIM, DMARC) only as the detail behind it.
 * - Undo after moving several tasks to Trash restores a parent before its
 *   subtasks, so no subtask waits on a parent that is not back yet.
 *
 *   npm run -s test:work-screens
 */
import { trustWords } from '../src/lib/communications/trust-words';
import { restoreOrder } from '../src/lib/trash-undo';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

const JARGON = /\b(DKIM|DMARC|SPF|authentication|verified|aligned)\b/i;

// A confirmed sender: nothing to say.
check('trust: a confirmed sender gets no note', trustWords('trusted', 'DKIM pass aligned with crest.example') === null);

// The demo's own unknown reason, the one the owner flagged.
const unknown = trustWords('unknown', 'No authentication results to rely on');
check('trust: unknown says it plainly', unknown?.line === 'We could not confirm this sender.', unknown);
check('trust: unknown line has no developer words', !!unknown && !JARGON.test(unknown.line), unknown);
check('trust: unknown keeps the check result as the detail', unknown?.detail === 'Email check result: No authentication results to rely on.', unknown);
check('trust: unknown with no result says nothing (the badge is enough)', trustWords('unknown', null) === null);

const untrusted = trustWords('untrusted', 'DKIM failed for the From domain.');
check('trust: untrusted warns in plain words', !!untrusted && !JARGON.test(untrusted.line) && /care/.test(untrusted.line), untrusted);
check('trust: untrusted detail keeps the reason once, without a doubled full stop', untrusted?.detail === 'Email check result: DKIM failed for the From domain.', untrusted);
check('trust: untrusted with no reason still warns, with no detail', trustWords('untrusted', '  ')?.detail === null && !!trustWords('untrusted', '  ')?.line);

// Undo order: parents first, the rest in the order they came.
const order = restoreOrder([
  { id: 'sub-a', parentId: 'parent' },
  { id: 'other', parentId: null },
  { id: 'parent', parentId: null },
  { id: 'sub-b', parentId: 'parent' },
  { id: 'orphan', parentId: 'not-in-the-selection' },
]).map((item) => item.id);
check('undo: a parent comes back before its subtasks', order.indexOf('parent') < order.indexOf('sub-a') && order.indexOf('parent') < order.indexOf('sub-b'), order);
check('undo: a subtask whose parent was not moved restores in its place', order.indexOf('orphan') < order.indexOf('sub-a'), order);
check('undo: nothing is lost or doubled', order.length === 5 && new Set(order).size === 5, order);
check('undo: one item stays one item', restoreOrder([{ id: 'x' }]).map((i) => i.id).join() === 'x');

if (failures.length) {
  console.error(`work screens: ${passed} checks passed, ${failures.length} failed:`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log(`work screens: ${passed} checks passed.`);
