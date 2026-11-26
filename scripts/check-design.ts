/**
 * Keeps screens on DESIGN.md's Rules (binding): scans src (core and
 * src/custom) for markup the Rules ban, and fails when any file has more of
 * it than the ratchet baseline allows.
 *
 *   npm run check:design                    # fails on anything new
 *   npm run check:design -- --update-baseline   # lock in a lower count
 *   npm run check:design -- --baseline-new-rules   # once, after adding a rule: its backlog today
 *
 * The baseline (scripts/design-baseline.json) is the count per rule per file
 * when the Rules were adopted: the migration backlog. A file may only go
 * down. A new file, or a new rule hit in a file, fails. `--update-baseline`
 * rewrites it only when nothing went up, so a count can never be raised by
 * hand through this script.
 *
 * Every failure prints file:line, the rule and the DESIGN.md rule to follow.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface DesignRule {
  id: string;
  /** The DESIGN.md rule (or section) to follow. */
  ref: string;
  /** What to do instead, in one line. */
  hint: string;
}

export const RULES: Record<string, DesignRule> = {
  'type-scale': { id: 'type-scale', ref: 'Rule 2', hint: 'Use the type scale: text-[11px], text-xs, text-sm, text-base, text-lg or the page title.' },
  'hand-pill': { id: 'hand-pill', ref: 'Rule 7', hint: 'Use <Pill tone="..."> (src/components/ui/Pill.tsx), not a hand-rolled tinted span.' },
  'status-ink': { id: 'status-ink', ref: 'Rule 13', hint: 'Status ink below 300 is never text: use the 300 shade, or a Pill.' },
  'left-stripe': { id: 'left-stripe', ref: 'Signature', hint: 'Soft filled surfaces, never a left-border accent stripe.' },
  'hex-color': { id: 'hex-color', ref: 'Tokens', hint: 'Use a token both themes define (bg-white/[0.04], text-zinc-*, brand, status), never a hex in className.' },
  'native-title': { id: 'native-title', ref: 'Rule 11', hint: 'Use <Tooltip> (or IconButton, whose label is its tooltip), never a native title= on a control.' },
  'trash-confirm': { id: 'trash-confirm', ref: 'Rule 6', hint: 'Moving to Trash acts at once and leaves an <UndoLine> (or toast with Undo); no ConfirmDialog.' },
  'load-more': { id: 'load-more', ref: 'Rule 4', hint: 'End long lists with <ShowMore> ("Show 24 more of 76"); never "Load more" or "Show all".' },
  'title-case-dialog': { id: 'title-case-dialog', ref: 'Rule 12', hint: 'Dialog titles are sentence case; a confirm title is a question ("Revoke this key?").' },
  'placeholder-dots': { id: 'placeholder-dots', ref: 'Rule 12', hint: 'Placeholders end without dots ("Search contacts").' },
  'card-padding': { id: 'card-padding', ref: 'Rule 17', hint: 'A glass card is padded p-4, with lg:p-5 on wide cards (or use <Card>); cards at one level share one padding.' },
  'section-gap': { id: 'section-gap', ref: 'Rule 17', hint: 'Sections and cards on a page sit 24px apart: space-y-6 or gap-6 on the page body.' },
};

export type RuleId = keyof typeof RULES;

export interface Finding {
  file: string;
  line: number;
  rule: RuleId;
  text: string;
}

/** Shared pieces (src/components/ui) may draw what screens may not: tinted pill recipes, status ink. */
const UI_DIR = 'src/components/ui/';

const STATUS_COLORS = 'emerald|amber|red|sky|rose|green|yellow|orange|blue|violet|purple|teal|cyan|lime|pink|fuchsia|indigo|brand';

const RE = {
  textSize: /(?<![\w-])text-\[(\d*\.?\d+)(px|rem|em)\]/g,
  pillRound: /(?<![\w-])rounded-full(?![\w-])/,
  pillTint: new RegExp(`(?<![\\w-])bg-(?:${STATUS_COLORS})-\\d{2,3}\\/`),
  pillText: /(?<![\w-])text-(?:\[10px\]|\[11px\]|xs)(?![\w-])/,
  statusInk: /(?<![\w-])text-(?:amber|emerald|red|sky|rose|green|yellow)-(?:50|100|200)(?![\w-])/g,
  leftStripe: /(?<![\w-])border-l-(?:[2-8]|\[\d+px\])(?![\w-])/g,
  hex: /(?<![\w-])(?:bg|text|border|ring|fill|stroke|from|to|via|shadow|outline|decoration|divide|caret|accent)-\[#[0-9a-fA-F]{3,8}\]/g,
  loadMore: /\b(?:Load more|Show all)\b/g,
  placeholder: /placeholder=\{?\s*(["'`])((?:(?!\1).)*?)(\.\.\.|…)\1/g,
  /** The whole class string holding glass-card, both sides of it: "p-6 glass-card rounded-xl". */
  glassCard: /[^"'`]*(?<![\w-])glass-card(?![\w-])[^"'`]*/g,
  /** All-sides padding, with its breakpoint: p-6, lg:p-6, p-[18px]. */
  padding: /(?<![\w:-])((?:sm|md|lg|xl|2xl):)?p-(\d+(?:\.\d+)?|\[[^\]]+\])(?![\w-])/g,
  /** The page body wrapper under Header (p-4 lg:p-6 or px-4 lg:px-6). */
  pageBody: /(?<![\w:-])p(x?)-4 lg:p\1-6(?![\w-])/,
  sectionGap: /(?<![\w:-])(?:space-y|gap)-(\d+(?:\.\d+)?)(?![\w-])/g,
};

/** A glass card's padding: p-4, or p-5 and lg:p-5 for a wide card (p-0 for one that pads its rows). */
const CARD_PADDING = new Set(['p-0', 'p-4', 'p-5', 'lg:p-5']);

/** Page files, where the page body's section gap is checked. */
const isPageFile = (file: string) => file.startsWith('src/app/') && file.endsWith('/page.tsx');

/** Interactive tags a native title= tooltip must not sit on. */
const INTERACTIVE_TAGS = new Set(['button', 'a', 'Button', 'Link', 'ToolbarButton', 'IconButton', 'input', 'select', 'summary']);

/** Words that keep their capital mid-title: product nouns, names and acronyms. */
const PROPER = new Set([
  'Trash', 'Inbox', 'Settings', 'Owner', 'Owners', 'Google', 'GitHub', 'Slack', 'Telegram', 'Discord', 'Stripe', 'Vercel',
  'Supabase', 'MCP', 'AI', 'API', 'PIN', 'SMTP', 'URL', 'CSV', 'PDF', 'ID', 'OK', 'I', 'Resend', 'Gmail', 'Outlook', 'Zoom',
]);

/** True when a title reads as Title Case: a later word starts with a capital that is not a name or acronym. */
export function isTitleCase(title: string): boolean {
  const words = title.replace(/[^\p{L}\p{N}'\s-]/gu, ' ').split(/\s+/).filter(Boolean);
  return words.slice(1).some((word) => {
    if (word.length < 2 || !/^\p{Lu}/u.test(word)) return false;
    if (/^\p{Lu}+$/u.test(word)) return false; // an acronym
    return !PROPER.has(word);
  });
}

/** Lines that are only comments carry no markup. */
const isCommentLine = (line: string) => /^\s*(\/\/|\/?\*)/.test(line);

/**
 * Every JSX opening tag in the source with its attributes text and line,
 * for the rules that look at one tag across lines (title=, trash, dialog titles).
 */
export function jsxTags(source: string): { name: string; attrs: string; line: number }[] {
  const out: { name: string; attrs: string; line: number }[] = [];
  const open = /<([A-Za-z][\w.]*)(?=[\s/>])/g;
  let match: RegExpExecArray | null;
  while ((match = open.exec(source))) {
    const start = match.index;
    // Skip generics and comparisons: a tag opens after (, =, {, >, return, newline or start.
    const before = source.slice(Math.max(0, start - 12), start);
    if (!/(^|[\s(=,{>?:&|]|return)\s*$/.test(before)) continue;
    let i = open.lastIndex;
    let depth = 0;
    let quote: string | null = null;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (quote) {
        if (ch === '\\') { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
    }
    const attrs = source.slice(open.lastIndex, i);
    out.push({ name: match[1], attrs, line: source.slice(0, start).split('\n').length });
  }
  return out;
}

/** A tag attribute's string value: name="x", name='x', name={'x'} or name={`x`} without ${}. */
export function stringAttr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)'|\\{\\s*(?:'([^']*)'|"([^"]*)"|\`([^\`$]*)\`)\\s*\\})`).exec(attrs);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? null;
}

/** The banned markup in one file. `file` is relative to the app folder, with forward slashes. */
export function scanSource(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const inUi = file.startsWith(UI_DIR);
  const lines = source.split(/\r?\n/);
  const add = (rule: RuleId, line: number, text: string) => findings.push({ file, line, rule, text: text.trim().slice(0, 160) });

  lines.forEach((text, index) => {
    const line = index + 1;
    if (isCommentLine(text)) return;
    for (const m of text.matchAll(RE.textSize)) {
      if (!(m[1] === '11' && m[2] === 'px')) add('type-scale', line, m[0]);
    }
    if (!inUi && RE.pillRound.test(text) && RE.pillTint.test(text) && RE.pillText.test(text)) add('hand-pill', line, text);
    if (!inUi) for (const m of text.matchAll(RE.statusInk)) add('status-ink', line, m[0]);
    for (const m of text.matchAll(RE.leftStripe)) add('left-stripe', line, m[0]);
    for (const m of text.matchAll(RE.hex)) add('hex-color', line, m[0]);
    for (const m of text.matchAll(RE.loadMore)) add('load-more', line, m[0]);
    for (const m of text.matchAll(RE.placeholder)) add('placeholder-dots', line, m[0]);
    for (const card of text.matchAll(RE.glassCard)) {
      for (const p of card[0].matchAll(RE.padding)) if (!CARD_PADDING.has(p[0])) add('card-padding', line, `glass-card ${p[0]}`);
    }
    if (isPageFile(file) && RE.pageBody.test(text)) {
      for (const g of text.matchAll(RE.sectionGap)) if (g[1] !== '6') add('section-gap', line, g[0]);
    }
  });

  for (const tag of jsxTags(source)) {
    if (INTERACTIVE_TAGS.has(tag.name) && /(?:^|\s)title=/.test(tag.attrs)) add('native-title', tag.line, `<${tag.name} title=`);
    if (tag.name === 'ConfirmDialog' && /(?:^|\s)trash(?=[\s/=]|$)/.test(tag.attrs)) add('trash-confirm', tag.line, '<ConfirmDialog trash');
    if (tag.name === 'Modal' || tag.name === 'ConfirmDialog') {
      const title = stringAttr(tag.attrs, 'title');
      if (title && isTitleCase(title)) add('title-case-dialog', tag.line, `${tag.name} title="${title}"`);
    }
  }
  return findings;
}

// ── Files ────────────────────────────────────────────────────────────────

/** Every .tsx file under src, relative to the app folder. */
export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.tsx')) out.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(join(root, 'src'));
  return out.sort();
}

export function scanTree(root: string): Finding[] {
  return sourceFiles(root).flatMap((file) => scanSource(file, readFileSync(join(root, file), 'utf8')));
}

// ── Ratchet ──────────────────────────────────────────────────────────────

/** rule -> file -> count. */
export type Counts = Record<string, Record<string, number>>;

export interface Baseline {
  note: string;
  rules: Counts;
}

export function countFindings(findings: Finding[]): Counts {
  const counts: Counts = {};
  for (const id of Object.keys(RULES)) counts[id] = {};
  for (const f of findings) counts[f.rule][f.file] = (counts[f.rule][f.file] ?? 0) + 1;
  return counts;
}

export interface Comparison {
  /** Rule and file pairs above the baseline, with the counts. */
  raised: { rule: RuleId; file: string; baseline: number; now: number }[];
  /** Rule and file pairs below it (fixed since). */
  lowered: { rule: RuleId; file: string; baseline: number; now: number }[];
}

export function compare(baseline: Counts, now: Counts): Comparison {
  const raised: Comparison['raised'] = [];
  const lowered: Comparison['lowered'] = [];
  for (const rule of Object.keys(RULES) as RuleId[]) {
    const was = baseline[rule] ?? {};
    const is = now[rule] ?? {};
    for (const file of new Set([...Object.keys(was), ...Object.keys(is)])) {
      const b = was[file] ?? 0;
      const n = is[file] ?? 0;
      if (n > b) raised.push({ rule, file, baseline: b, now: n });
      else if (n < b) lowered.push({ rule, file, baseline: b, now: n });
    }
  }
  return { raised, lowered };
}

export function totals(counts: Counts): Record<string, number> {
  return Object.fromEntries(Object.keys(RULES).map((rule) => [rule, Object.values(counts[rule] ?? {}).reduce((a, b) => a + b, 0)]));
}

/** Counts sorted by rule then file, for a stable, reviewable baseline file. */
export function sortedCounts(counts: Counts): Counts {
  const out: Counts = {};
  for (const rule of Object.keys(RULES)) {
    out[rule] = {};
    for (const file of Object.keys(counts[rule] ?? {}).sort()) if (counts[rule][file] > 0) out[rule][file] = counts[rule][file];
  }
  return out;
}

export const BASELINE_NOTE = 'Banned markup per DESIGN.md rule per file when the Rules were adopted (2026-11-26). Counts may only go down: npm run check:design -- --update-baseline.';

export interface DesignCheckResult {
  exitCode: number;
  messages: string[];
  comparison: Comparison;
  counts: Counts;
}

/** The whole check. `update` rewrites the baseline when nothing went up. */
export function checkDesign(root: string, options: { update?: boolean; seedNewRules?: boolean; baselinePath?: string; findings?: Finding[] } = {}): DesignCheckResult {
  const baselinePath = options.baselinePath ?? join(root, 'scripts', 'design-baseline.json');
  const findings = options.findings ?? scanTree(root);
  const counts = countFindings(findings);
  const messages: string[] = [];
  const say = (line: string) => messages.push(line);

  const baseline: Baseline = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, 'utf8'))
    : { note: BASELINE_NOTE, rules: {} };
  // A rule added after the baseline was written has no counts yet. Seeding takes today's counts for
  // such rules only (never for a rule the baseline already has), so a new rule starts as a backlog.
  const unseeded = Object.keys(RULES).filter((rule) => !(rule in baseline.rules));
  if (unseeded.length && options.seedNewRules) {
    const current = sortedCounts(counts);
    for (const rule of unseeded) baseline.rules[rule] = current[rule];
    writeFileSync(baselinePath, `${JSON.stringify({ note: baseline.note ?? BASELINE_NOTE, rules: sortedCounts(baseline.rules) }, null, 2)}\n`);
    say(`Baseline seeded for new rule(s): ${unseeded.join(', ')}.`);
  } else if (unseeded.length) {
    say(`New rule(s) with no baseline yet: ${unseeded.join(', ')}. Run npm run check:design -- --baseline-new-rules once to record today's count as their backlog.`);
  }
  const comparison = compare(baseline.rules, counts);

  if (comparison.raised.length) {
    say(`Design check failed: ${comparison.raised.length} file and rule pair(s) have more banned markup than before.`);
    for (const r of comparison.raised) {
      const rule = RULES[r.rule];
      say(`\n${r.file}: ${rule.id} (DESIGN.md ${rule.ref}), ${r.now} now, ${r.baseline} allowed`);
      for (const f of findings.filter((x) => x.file === r.file && x.rule === r.rule)) say(`  ${f.file}:${f.line}  ${f.text}`);
      say(`  Fix: ${rule.hint}`);
    }
    say('\nFollow DESIGN.md "Rules (binding)". The baseline only goes down; it cannot be raised to make this pass.');
    if (options.update) say('Baseline not updated: something went up.');
    return { exitCode: 1, messages, comparison, counts };
  }

  const total = Object.values(totals(counts)).reduce((a, b) => a + b, 0);
  if (comparison.lowered.length) {
    const fixed = comparison.lowered.reduce((sum, l) => sum + l.baseline - l.now, 0);
    if (options.update) {
      writeFileSync(baselinePath, `${JSON.stringify({ note: BASELINE_NOTE, rules: sortedCounts(counts) }, null, 2)}\n`);
      say(`Baseline lowered: ${fixed} fewer, ${total} left to move onto the Rules.`);
    } else {
      say(`Design check passed. ${fixed} fewer than the baseline: run npm run check:design -- --update-baseline to lock that in.`);
    }
  } else {
    say(`Design check passed. ${total} known item(s) left to move onto the Rules; nothing new.`);
    if (options.update) say('Baseline unchanged: nothing went down.');
  }
  return { exitCode: 0, messages, comparison, counts };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--write-initial-baseline')) {
      // One-off: the count on the day the Rules were adopted. Refuses to overwrite.
      const path = join(process.cwd(), 'scripts', 'design-baseline.json');
      if (existsSync(path)) throw new Error('scripts/design-baseline.json exists; use --update-baseline, which only lowers it.');
      const counts = countFindings(scanTree(process.cwd()));
      writeFileSync(path, `${JSON.stringify({ note: BASELINE_NOTE, rules: sortedCounts(counts) }, null, 2)}\n`);
      console.log('Wrote the initial baseline:', totals(counts));
      process.exit(0);
    }
    const result = checkDesign(process.cwd(), { update: args.includes('--update-baseline'), seedNewRules: args.includes('--baseline-new-rules') });
    for (const line of result.messages) (result.exitCode ? console.error : console.log)(line);
    if (args.includes('--totals')) console.log(totals(result.counts));
    process.exit(result.exitCode);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
