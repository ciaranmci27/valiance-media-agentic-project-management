/**
 * The approved-entry rule: approval locks time and money, not the notes.
 * Pure checks of the shared helper both edit routes use (v1 API and the app).
 *
 *   npm run -s test:time-lock
 */
import { APPROVED_ENTRY_EDITABLE_FIELDS, lockedApprovedFields } from '../src/lib/time-entry-lock';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

check('description alone is allowed', lockedApprovedFields({ description: 'Fixing bugs' }).length === 0);
check('linked tasks alone are allowed', lockedApprovedFields({ task_ids: ['a'] }).length === 0);
check('description and tasks together are allowed', lockedApprovedFields({ description: 'x', task_ids: [] }).length === 0);
check('the app route\'s id field is ignored', lockedApprovedFields({ id: 'e1', description: 'x' }).length === 0);
for (const field of ['start_time', 'end_time', 'segments', 'member_id', 'work_type', 'hourly_rate', 'approval_status']) {
  check(`${field} stays locked`, JSON.stringify(lockedApprovedFields({ [field]: 'x' })) === JSON.stringify([field]));
}
check('a mixed edit names only the locked fields',
  JSON.stringify(lockedApprovedFields({ description: 'x', start_time: 'y', task_ids: [] })) === JSON.stringify(['start_time']));
check('only description and task_ids are editable', [...APPROVED_ENTRY_EDITABLE_FIELDS].sort().join(',') === 'description,task_ids');

if (failures.length) {
  console.error(`time entry lock: ${failures.length} failed\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`time entry lock: ${passed} checks passed.`);
