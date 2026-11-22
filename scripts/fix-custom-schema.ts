/**
 * 2.0 renamed an install's own schema from `custom` to `pm_custom` (the move
 * migration moves its tables, views and functions across). This updates the
 * install's code to the new name: in src/custom, `.schema('custom')` and SQL
 * text naming `custom.<name>` become `pm_custom`. Custom migration files are
 * left alone: those dated before 2.0 already ran and never run again, and
 * check:core reads them against the old name. New migrations use pm_custom.
 *
 *   npm run fix:custom-schema            rewrites, then lists what changed
 *   npm run fix:custom-schema -- --check  only lists what would change
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const DIR = join(ROOT, 'src', 'custom');
const check = process.argv.includes('--check');

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx|js|mjs|sql)$/.test(name) ? [path] : [];
  });
}

export function rewrite(text: string): string {
  return text
    .replace(/\.schema\((['"`])custom\1\)/g, '.schema($1pm_custom$1)')
    .replace(/(['"`][^'"`]*?)\bcustom\.(?=[a-z_])/g, '$1pm_custom.');
}

let changed = 0;
for (const path of files(DIR)) {
  const before = readFileSync(path, 'utf8');
  const after = rewrite(before);
  if (after === before) continue;
  changed += 1;
  console.log(`${check ? 'would change' : 'changed'} ${relative(ROOT, path)}`);
  if (!check) writeFileSync(path, after);
}
console.log(changed ? `${changed} file(s) ${check ? 'would change' : 'changed'}.` : 'Nothing names schema custom.');
