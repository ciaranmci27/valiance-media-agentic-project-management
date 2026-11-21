/**
 * Which files belong to the install and which to core.
 *
 * An install adds its own work only in client-owned paths; core never edits
 * them after shipping their stubs, so release merges never conflict there.
 * Everything else is core and arrives with each release.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Core files an install legitimately changes; the upgrade merges them as JSON (the lockfile is regenerated). */
export const CLIENT_EDITABLE_CORE = ['package.json', 'package-lock.json', 'vercel.json'] as const;

/** True for paths the install owns. Paths are relative to the app root, with forward slashes. */
export function isClientOwned(path: string): boolean {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (p.startsWith('src/custom/') || p.startsWith('supabase/migrations/custom/') || p.startsWith('public/custom/')) return true;
  if (p === '.claude/settings.local.json') return true;
  // Core skills are named pm-*; any other skill folder is the install's.
  const skill = p.match(/^\.claude\/skills\/([^/]+)\//);
  if (skill) return !skill[1].startsWith('pm-');
  // Agent definitions and commands, files or folders: pm-* are core, the rest the install's.
  const agentOrCommand = p.match(/^\.claude\/(?:agents|commands)\/([^/]+)/);
  if (agentOrCommand) return !agentOrCommand[1].startsWith('pm-');
  // The install's own CI: .github/workflows/custom-*.yml (or .yaml).
  if (/^\.github\/workflows\/custom-[^/]+\.ya?ml$/.test(p)) return true;
  const base = p.split('/').pop() ?? '';
  if (base.startsWith('.env') && base !== '.env.example') return true;
  return false;
}

/** Files an install may change without check:core flagging them. */
export function isAllowedInstallChange(path: string): boolean {
  return isClientOwned(path) || (CLIENT_EDITABLE_CORE as readonly string[]).includes(path);
}

/**
 * The source install is the monorepo the releases are cut from: its git top
 * level holds app/package.json. In the public repo and every install, the app
 * is the top level.
 */
export function isSourceMonorepo(appRoot: string): boolean {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: appRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return existsSync(join(top, 'app', 'package.json'));
  } catch {
    return false;
  }
}
