/**
 * The design check (scripts/check-design.ts) catches what DESIGN.md's Rules
 * ban, lets the right markup through, and its ratchet only goes down.
 *
 *   npm run test:check-design
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDesign, compare, countFindings, isTitleCase, scanSource, type Finding, type RuleId } from './check-design';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

const SCREEN = 'src/components/example/Screen.tsx';
const UI = 'src/components/ui/Example.tsx';
const rulesIn = (source: string, file = SCREEN) => scanSource(file, source).map((f) => f.rule);
const has = (source: string, rule: RuleId, file = SCREEN) => rulesIn(source, file).includes(rule);

// ── Must fail ────────────────────────────────────────────────────────────

const MUST_FAIL: [RuleId, string][] = [
  ['type-scale', '<h2 className="text-[15px] font-semibold">Needs you</h2>'],
  ['type-scale', '<p className="text-[13px]">Meta</p>'],
  ['type-scale', '<span className="text-[10px] uppercase">New</span>'],
  ['hand-pill', '<span className="rounded-full bg-amber-500/[0.14] px-2 py-0.5 text-[11px] text-amber-300">Waiting</span>'],
  ['hand-pill', '<span className="px-1.5 rounded-full text-[10px] bg-brand-500/15 text-brand-300">Suggested</span>'],
  ['hand-pill', '<span className="text-xs bg-red-500/[0.12] rounded-full">Overdue</span>'],
  ['status-ink', '<p className="text-amber-200">Question for you</p>'],
  ['status-ink', '<p className="text-sm text-red-100">Could not save</p>'],
  ['status-ink', '<span className="text-emerald-50">Done</span>'],
  ['left-stripe', '<div className="border-l-4 border-brand-500 pl-3">Note</div>'],
  ['left-stripe', '<div className="border-l-2">Quote</div>'],
  ['hex-color', '<div className="bg-[#08090C] text-white">Dark</div>'],
  ['hex-color', '<span className="text-[#5b8a8a]">Teal</span>'],
  ['native-title', '<button type="button" title="Copy link" onClick={copy}><Copy /></button>'],
  ['native-title', '<Button\n  variant="ghost"\n  title="Open as page"\n  onClick={open}\n>Open</Button>'],
  ['native-title', '<a href={url} title="Opens in a new tab">Link</a>'],
  ['trash-confirm', '<ConfirmDialog\n  isOpen={open}\n  trash\n  title="Move this task to Trash?"\n  message="x"\n  onClose={close}\n  onConfirm={go}\n/>'],
  ['trash-confirm', '<ConfirmDialog trash={true} isOpen title="Move to Trash?" message="x" onClose={a} onConfirm={b} />'],
  ['load-more', '<Button onClick={more}>Load more</Button>'],
  ['load-more', "const label = 'Show all';"],
  ['title-case-dialog', '<Modal isOpen title="Edit Contact" onClose={close}>x</Modal>'],
  ['title-case-dialog', '<ConfirmDialog isOpen title="Remove Portal PIN" message="x" onClose={a} onConfirm={b} />'],
  ['title-case-dialog', "<Modal isOpen title={'Keyboard Shortcuts'} onClose={close}>x</Modal>"],
  ['placeholder-dots', '<TextInput placeholder="Search contacts..." value={q} onChange={setQ} />'],
  ['placeholder-dots', "<input placeholder={'Type a note…'} />"],
  ['card-padding', '<div className="p-6 glass-card rounded-xl">x</div>'],
  ['card-padding', "<div className={cn('lg:p-6 glass-card', extra)}>x</div>"],
  ['eyebrow', '<p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Details</p>'],
  ['eyebrow', "const label = 'text-[11px] font-medium tracking-wide uppercase text-zinc-500';"],
  ['dialog-title', '<Modal isOpen title="Convert this lead into a new project" onClose={close}>x</Modal>'],
  ['dialog-title', "<Modal isOpen title={editing ? 'Edit retainer' : 'Set up a brand new retainer'} onClose={close}>x</Modal>"],
  ['dialog-title', '<Modal isOpen title="Billing" onClose={close}>x</Modal>'],
];
for (const [rule, source] of MUST_FAIL) check(`fails: ${rule} on ${JSON.stringify(source.slice(0, 60))}`, has(source, rule), rulesIn(source));

// ── Must pass ────────────────────────────────────────────────────────────

const MUST_PASS: [RuleId, string, string?][] = [
  ['type-scale', '<p className="text-[11px] text-zinc-400">Meta</p>'],
  ['type-scale', '<h2 className="text-sm font-semibold">Recent activity</h2>'],
  ['hand-pill', '<Pill tone="waiting" dot>Waiting</Pill>'],
  ['hand-pill', '<span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-zinc-300">Company-wide</span>'],
  ['hand-pill', '<span className="rounded-full bg-amber-500/[0.14] px-2 py-0.5 text-[11px] text-amber-300">x</span>', UI],
  ['hand-pill', '<div className="rounded-full bg-brand-500 h-2 w-2" />'],
  ['status-ink', '<p className="text-amber-300">Question for you</p>'],
  ['status-ink', '<span className="text-amber-200">ok in a shared piece</span>', UI],
  ['status-ink', '<div className="bg-amber-200/10">fill, not text</div>'],
  ['left-stripe', '<div className="border-l border-white/[0.06]">Hairline column</div>'],
  ['hex-color', '<div className="bg-white/[0.04] text-zinc-300">Token</div>'],
  ['native-title', '<Modal isOpen title="Edit contact" onClose={close}>x</Modal>'],
  ['native-title', '<IconButton icon={<Copy />} label="Copy link" onClick={copy} />'],
  ['native-title', '<Tooltip content="Copy link"><button type="button" aria-label="Copy link"><Copy /></button></Tooltip>'],
  ['trash-confirm', '<ConfirmDialog isOpen title="Revoke this key?" message="x" onClose={a} onConfirm={b} />'],
  ['trash-confirm', '<UndoLine onUndo={restore}>Moved to Trash</UndoLine>'],
  ['load-more', '<ShowMore shown={24} total={76} onMore={more} />'],
  ['load-more', '// never write Load more here; comments are fine'],
  ['title-case-dialog', '<ConfirmDialog isOpen title="Revoke this key?" message="x" onClose={a} onConfirm={b} />'],
  ['title-case-dialog', '<Modal isOpen title="Connect Slack to this project" onClose={close}>x</Modal>'],
  ['title-case-dialog', '<Modal isOpen title="New API key" onClose={close}>x</Modal>'],
  ['title-case-dialog', '<Modal isOpen title={`Edit ${name}`} onClose={close}>x</Modal>'],
  ['placeholder-dots', '<TextInput placeholder="Search contacts" value={q} onChange={setQ} />'],
  ['eyebrow', '<GroupLabel>Today</GroupLabel>'],
  ['eyebrow', '<p className="text-[11px] font-semibold uppercase tracking-wider">x</p>', 'src/components/ui/GroupLabel.tsx'],
  ['eyebrow', '<TextInput inputClassName="font-mono uppercase" />'],
  ['eyebrow', '<p className="text-xs font-semibold text-zinc-400">Details</p>'],
  ['dialog-title', '<Modal isOpen title="Edit contact" onClose={close}>x</Modal>'],
  ['dialog-title', "<Modal isOpen title={editing ? 'Edit retainer' : 'New retainer'} onClose={close}>x</Modal>"],
  ['dialog-title', '<Modal isOpen title={`Edit ${name}`} onClose={close}>x</Modal>'],
  ['dialog-title', "<Modal isOpen title={kind === 'email' ? 'Pick an email' : `Approve ${n} suggestions`} onClose={close}>x</Modal>"],
  ['dialog-title', '<ConfirmDialog isOpen title="Move this task to another project?" message="x" onClose={a} onConfirm={b} />'],
];
for (const [rule, source, file] of MUST_PASS) check(`passes: ${rule} on ${JSON.stringify(source.slice(0, 60))}`, !has(source, rule, file), rulesIn(source, file));

// Rule 17: card padding and the page body's section gap.
const PAGE = 'src/app/(protected)/example/page.tsx';
check('fails: card-padding on p-4 lg:p-6', has('<div className="glass-card rounded-xl p-4 lg:p-6">x</div>', 'card-padding'));
check('fails: card-padding on p-6', has('<section className="glass-card p-6 rounded-xl">x</section>', 'card-padding'));
check('fails: card-padding on p-3', has("<div className={`glass-card rounded-xl p-3 ${extra}`}>x</div>", 'card-padding'));
check('passes: card-padding on p-4 lg:p-5', !has('<div className="glass-card rounded-xl p-4 lg:p-5">x</div>', 'card-padding'));
check('passes: card-padding on a card padding its own rows (px-5 only)', !has('<div className="glass-card overflow-hidden rounded-xl">x</div>', 'card-padding'));
check('passes: card-padding ignores padding outside the card class', !has('<div className="p-8"><div className="glass-card p-4">x</div></div>', 'card-padding'));
check('fails: section-gap on a page body with space-y-4', has('<div className="p-4 lg:p-6 space-y-4">x</div>', 'section-gap', PAGE));
check('fails: section-gap on a page body with gap-5', has('<div className="flex flex-col gap-5 px-4 lg:px-6">x</div>', 'section-gap', PAGE));
check('passes: section-gap on space-y-6', !has('<div className="p-4 lg:p-6 space-y-6">x</div>', 'section-gap', PAGE));
check('passes: section-gap only looks at pages', !has('<div className="p-4 lg:p-6 space-y-4">x</div>', 'section-gap'));
check('passes: section-gap ignores rows inside a card', !has('<ul className="space-y-2">x</ul>', 'section-gap', PAGE));

check('title case: "Add Task to Project" is Title Case', isTitleCase('Add Task to Project'));
check('title case: "Move this task to Trash?" is sentence case', !isTitleCase('Move this task to Trash?'));
check('title case: one word is never Title Case', !isTitleCase('Settings'));

// Lines and the rule reference come through, so a failure points at the fix.
{
  const findings = scanSource(SCREEN, 'const a = 1;\n\n<h2 className="text-[15px]">x</h2>\n');
  check('finding: reports the line', findings[0]?.line === 3, findings);
}

// ── Ratchet ──────────────────────────────────────────────────────────────

const finding = (file: string, rule: RuleId, line = 1): Finding => ({ file, rule, line, text: '' });
const base = countFindings([finding('a.tsx', 'type-scale'), finding('a.tsx', 'type-scale', 2), finding('b.tsx', 'hand-pill')]);

{
  const same = compare(base, base);
  check('ratchet: same counts raise nothing', same.raised.length === 0 && same.lowered.length === 0, same);
  const up = compare(base, countFindings([finding('a.tsx', 'type-scale'), finding('a.tsx', 'type-scale', 2), finding('a.tsx', 'type-scale', 3), finding('b.tsx', 'hand-pill')]));
  check('ratchet: one more in a file is raised', up.raised.length === 1 && up.raised[0].file === 'a.tsx' && up.raised[0].now === 3, up);
  const fresh = compare(base, countFindings([...[finding('a.tsx', 'type-scale'), finding('a.tsx', 'type-scale', 2), finding('b.tsx', 'hand-pill')], finding('c.tsx', 'status-ink')]));
  check('ratchet: a new file with a hit is raised', fresh.raised.some((r) => r.file === 'c.tsx' && r.baseline === 0), fresh);
  const newRule = compare(base, countFindings([finding('a.tsx', 'type-scale'), finding('a.tsx', 'type-scale', 2), finding('b.tsx', 'hand-pill'), finding('b.tsx', 'load-more')]));
  check('ratchet: a new rule hit in a known file is raised', newRule.raised.some((r) => r.file === 'b.tsx' && r.rule === 'load-more'), newRule);
  const down = compare(base, countFindings([finding('a.tsx', 'type-scale')]));
  check('ratchet: fewer is lowered, not raised', down.raised.length === 0 && down.lowered.length === 2, down);
}

// checkDesign end to end on a temporary baseline file.
{
  const dir = mkdtempSync(join(tmpdir(), 'check-design-'));
  const path = join(dir, 'baseline.json');
  try {
    writeFileSync(path, JSON.stringify({ note: 'test', rules: base }));
    const up = checkDesign(dir, { baselinePath: path, findings: [finding('a.tsx', 'type-scale'), finding('a.tsx', 'type-scale', 2), finding('a.tsx', 'type-scale', 9), finding('b.tsx', 'hand-pill')] });
    check('check: a raised count exits 1', up.exitCode === 1, up.messages);
    check('check: the failure names file:line', up.messages.some((m) => m.includes('a.tsx:9')), up.messages);
    check('check: the failure names the DESIGN.md rule', up.messages.some((m) => m.includes('DESIGN.md Rule 2')), up.messages);

    const refused = checkDesign(dir, { baselinePath: path, update: true, findings: [finding('a.tsx', 'type-scale'), finding('a.tsx', 'type-scale', 2), finding('b.tsx', 'hand-pill'), finding('b.tsx', 'hand-pill', 2)] });
    const afterRefusal = JSON.parse(readFileSync(path, 'utf8')).rules;
    check('update: refused when anything went up', refused.exitCode === 1 && afterRefusal['hand-pill']['b.tsx'] === 1, afterRefusal);

    const lowered = checkDesign(dir, { baselinePath: path, update: true, findings: [finding('a.tsx', 'type-scale')] });
    const afterLower = JSON.parse(readFileSync(path, 'utf8')).rules;
    check('update: lowers the baseline when counts went down', lowered.exitCode === 0 && afterLower['type-scale']['a.tsx'] === 1 && !afterLower['hand-pill']['b.tsx'], afterLower);

    const regrow = checkDesign(dir, { baselinePath: path, findings: [finding('a.tsx', 'type-scale'), finding('b.tsx', 'hand-pill')] });
    check('check: what was fixed cannot come back', regrow.exitCode === 1, regrow.messages);

    const clean = checkDesign(dir, { baselinePath: path, findings: [finding('a.tsx', 'type-scale')] });
    check('check: unchanged counts pass', clean.exitCode === 0, clean.messages);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A rule added after the baseline: it fails until seeded, seeding records only that rule, and then it ratchets.
{
  const dir = mkdtempSync(join(tmpdir(), 'check-design-seed-'));
  const path = join(dir, 'baseline.json');
  try {
    const old = countFindings([finding('a.tsx', 'type-scale')]);
    delete (old as Record<string, unknown>)['card-padding'];
    writeFileSync(path, JSON.stringify({ note: 'test', rules: old }));
    const today = [finding('a.tsx', 'type-scale'), finding('a.tsx', 'card-padding'), finding('b.tsx', 'card-padding')];
    const unseeded = checkDesign(dir, { baselinePath: path, findings: today });
    check('seed: a new rule with hits fails before it is seeded', unseeded.exitCode === 1 && unseeded.messages.some((m) => m.includes('--baseline-new-rules')), unseeded.messages);
    const seeded = checkDesign(dir, { baselinePath: path, seedNewRules: true, findings: [...today, finding('a.tsx', 'type-scale', 2)] });
    const after = JSON.parse(readFileSync(path, 'utf8')).rules;
    check('seed: records the new rule only', after['card-padding']['a.tsx'] === 1 && after['card-padding']['b.tsx'] === 1 && after['type-scale']['a.tsx'] === 1, after);
    check('seed: never raises a known rule', seeded.exitCode === 1, seeded.messages);
    const more = checkDesign(dir, { baselinePath: path, findings: [...today, finding('b.tsx', 'card-padding', 2)] });
    check('seed: the new rule then ratchets', more.exitCode === 1, more.messages);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The real tree passes against the committed baseline.
{
  const result = checkDesign(process.cwd());
  check('repo: src passes against scripts/design-baseline.json', result.exitCode === 0, result.messages.slice(0, 12));
}

if (failures.length) {
  console.error(`check-design: ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
console.log(`check-design: ${passed} passed`);
