/**
 * Guard: server code never reads, edits or deletes a record in Trash by
 * accident. Most server reads run on the service role, which skips the
 * database's Trash policies, so each query on a Trash table must say so
 * itself:
 *
 * - every `.from('<trash table>')` chain filters `deleted_at`, unless it only
 *   inserts, or the line (or one of the two above it) carries
 *   `// includes-deleted: <reason>` (Trash, restore, audit history);
 * - embedded child records in a select (`comments:task_comments(...)`) are
 *   filtered by their alias (`.is('comments.deleted_at', null)`); a singular
 *   alias (`project:projects(...)`) is a parent and is not;
 * - nothing calls `.delete()` on a Trash table: use moveToTrash().
 *
 *   npm run -s test:soft-delete-reads
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { TRASH_TABLES } from '../src/lib/supabase/trash';

const APP = join(__dirname, '..');
// All server code and the shared data layer. (Browser components read
// through RLS, which hides Trash; they still go through queries.ts.)
const SCOPE = [
  'src/app/api',
  'src/lib',
];

const tables = new Set<string>(TRASH_TABLES);
const PARENTS = new Set(['projects', 'leads', 'contacts']);
const MARK = 'includes-deleted:';

function files(path: string): string[] {
  const full = join(APP, path);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full).flatMap((name) => files(join(path, name))).filter((file) => /\.tsx?$/.test(file));
}

/** The query chain after `.from(...)`: up to the end of its statement. */
function chainFrom(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth < 0) return source.slice(start, i);
    } else if (c === ';' && depth === 0) return source.slice(start, i);
  }
  return source.slice(start);
}

function marked(lines: string[], line: number): boolean {
  return lines.slice(Math.max(0, line - 2), line + 1).some((text) => text.includes(MARK));
}

const problems: string[] = [];
let checked = 0;
for (const file of SCOPE.flatMap(files)) {
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');
  const where = (index: number) => {
    const line = source.slice(0, index).split('\n').length - 1;
    return { line, label: `${relative(APP, file).replace(/\\/g, '/')}:${line + 1}` };
  };

  for (const match of source.matchAll(/\.from\((['"`])([a-z_]+)\1\)/g)) {
    const table = match[2];
    if (!tables.has(table)) continue;
    checked++;
    const { line, label } = where(match.index!);
    const chain = chainFrom(source, match.index! + match[0].length);
    if (/\.delete\(/.test(chain)) {
      problems.push(`${label} deletes from ${table}; move it to Trash instead (moveToTrash)`);
      continue;
    }
    if (marked(lines, line)) continue;
    const insertOnly = /\.insert\(/.test(chain) && !/\.(update|upsert)\(/.test(chain);
    if (!insertOnly && !/deleted_at/.test(chain)) {
      problems.push(`${label} reads or writes ${table} without a deleted_at filter`);
    }
    for (const embed of chain.matchAll(/(?:\b([a-z_]+):)?\b([a-z_]+)(?:![a-z_]+)?\s*\(/g)) {
      const [, alias, embedded] = embed;
      if (!tables.has(embedded) || embedded === table) continue;
      const name = alias ?? embedded;
      // A parent row, not a list of children: a singular alias, or a project,
      // lead or contact embedded in a child's query.
      if (!name.endsWith('s') || (!alias && PARENTS.has(embedded))) continue;
      if (!chain.includes(`${name}.deleted_at`)) {
        problems.push(`${label} embeds ${embedded} as "${name}" without filtering ${name}.deleted_at`);
      }
    }
  }

  // A query on a table named at runtime cannot be checked here. (Buffer.from,
  // Array.from and storage buckets are not queries.)
  for (const match of source.matchAll(/(?<!Buffer|Array|storage|Uint8Array)\s*\.from\(([a-zA-Z_][\w.]*)\)/g)) {
    const { line, label } = where(match.index!);
    if (!marked(lines, line) && !/trash-checked:/.test(lines.slice(Math.max(0, line - 2), line + 1).join('\n'))) {
      problems.push(`${label} queries a table named at runtime (${match[1]}); mark it "// trash-checked: <why>"`);
    }
  }
}

console.log(`soft delete reads: ${checked} queries checked, ${problems.length} problems`);
for (const problem of problems) console.log(`  ${problem}`);
if (problems.length) process.exit(1);
