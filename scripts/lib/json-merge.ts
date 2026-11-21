/**
 * Three-way merge for the two core JSON files installs legitimately change:
 * package.json (dependencies, scripts) and vercel.json (crons).
 *
 *   base   = the file at the common ancestor
 *   ours   = the install's copy (the client)
 *   theirs = the release being merged in (upstream)
 *
 * A value changed on one side only takes that side. When both sides changed it
 * differently, objects merge key by key; anything else takes the release's
 * value and is reported, because the release's core code depends on it. Two
 * exceptions keep an install's own additions: a dependency or script the
 * release removed but the install changed stays, and vercel.json crons merge
 * entry by entry (see mergeCrons).
 *
 * Output is deterministic: keys keep ours' order with new keys appended, and a
 * dependency map that was alphabetical stays alphabetical.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export type MergeFile = 'package.json' | 'vercel.json';

export interface MergeNote {
  /** Dotted path of the value, e.g. "scripts.dev" or "crons[/api/x]". */
  path: string;
  /** Which side the merged file kept. */
  took: 'ours' | 'theirs';
  reason: string;
  ours?: Json;
  theirs?: Json;
}

export interface MergeResult {
  merged: Json;
  notes: MergeNote[];
}

/** package.json maps where the release's entry wins a disagreement. */
const PACKAGE_MAPS = new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'overrides', 'scripts']);

const MISSING = Symbol('missing');
type Slot = Json | typeof MISSING;

function isObject(value: Slot): value is JsonObject {
  return value !== MISSING && typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function jsonEqual(a: Slot, b: Slot): boolean {
  if (a === b) return true;
  if (a === MISSING || b === MISSING || a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  const ak = Object.keys(a as JsonObject);
  const bk = Object.keys(b as JsonObject);
  return ak.length === bk.length && ak.every(key => key in (b as JsonObject) && jsonEqual((a as JsonObject)[key], (b as JsonObject)[key]));
}

const show = (slot: Slot): Json | undefined => (slot === MISSING ? undefined : slot);

function isSorted(keys: string[]): boolean {
  return keys.every((key, i) => i === 0 || keys[i - 1] <= key);
}

class Merger {
  notes: MergeNote[] = [];
  constructor(private file: MergeFile) {}

  value(base: Slot, ours: Slot, theirs: Slot, path: string[]): Slot {
    if (jsonEqual(ours, theirs)) return ours;
    if (jsonEqual(base, ours)) return theirs;
    if (jsonEqual(base, theirs)) return ours;

    // Both sides changed it, differently.
    if (this.file === 'vercel.json' && path.length === 1 && path[0] === 'crons' && isCronList(ours) && isCronList(theirs)) {
      return this.crons(isCronList(base) ? base : [], ours, theirs);
    }
    if (isObject(ours) && isObject(theirs)) {
      return this.object(isObject(base) ? base : {}, ours, theirs, path);
    }

    const where = path.join('.');
    const inPackageMap = this.file === 'package.json' && path.length === 2 && PACKAGE_MAPS.has(path[0]);
    if (inPackageMap && theirs === MISSING) {
      // The release dropped it, the install changed it: the install still uses it, and core no longer does.
      this.notes.push({ path: where, took: 'ours', reason: 'removed by the release but changed by this install; kept', ours: show(ours) });
      return ours;
    }
    this.notes.push({
      path: where,
      took: 'theirs',
      reason: inPackageMap ? 'changed on both sides; the release version wins' : 'changed on both sides; the release value wins',
      ours: show(ours),
      theirs: show(theirs),
    });
    return theirs;
  }

  object(base: JsonObject, ours: JsonObject, theirs: JsonObject, path: string[]): JsonObject {
    const keys = [...Object.keys(ours), ...Object.keys(theirs).filter(key => !(key in ours))];
    const out: JsonObject = {};
    const has = (obj: JsonObject, key: string): Slot => (Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : MISSING);
    for (const key of keys) {
      const merged = this.value(has(base, key), has(ours, key), has(theirs, key), [...path, key]);
      if (merged !== MISSING) out[key] = merged;
    }
    const isPackageMap = this.file === 'package.json' && path.length === 1 && PACKAGE_MAPS.has(path[0]) && path[0] !== 'scripts';
    if (isPackageMap && isSorted(Object.keys(ours))) {
      return Object.fromEntries(Object.keys(out).sort().map(key => [key, out[key]]));
    }
    return out;
  }

  /**
   * Crons merge by path: the union of both lists, the release's entry winning
   * a path both changed. A cron the release removed is removed unless the
   * install changed it; a cron the install removed stays removed unless the
   * release changed it. Order: ours, then the release's new entries.
   */
  crons(base: Cron[], ours: Cron[], theirs: Cron[]): Json[] {
    const b = keyCrons(base);
    const o = keyCrons(ours);
    const t = keyCrons(theirs);
    const keys = [...o.keys(), ...[...t.keys()].filter(key => !o.has(key))];
    const out: Json[] = [];
    for (const key of keys) {
      const bb: Slot = b.get(key) ?? MISSING;
      const oo: Slot = o.get(key) ?? MISSING;
      const tt: Slot = t.get(key) ?? MISSING;
      let merged: Slot;
      if (jsonEqual(oo, tt) || jsonEqual(bb, tt)) merged = oo;
      else if (jsonEqual(bb, oo)) merged = tt;
      else {
        // Both changed this cron. Entries are atomic: no field-by-field mixing.
        const path = `crons[${key}]`;
        if (tt === MISSING) {
          merged = oo;
          this.notes.push({ path, took: 'ours', reason: 'removed by the release but changed by this install; kept', ours: show(oo) });
        } else {
          merged = tt;
          const reason = oo === MISSING
            ? 'removed by this install but changed by the release; restored'
            : 'changed on both sides; the release entry wins';
          this.notes.push({ path, took: 'theirs', reason, ours: show(oo), theirs: show(tt) });
        }
      }
      if (merged !== MISSING) out.push(merged);
    }
    return out;
  }
}

type Cron = JsonObject & { path: string };

function isCronList(value: Slot): value is Cron[] {
  return Array.isArray(value) && value.every(item => isObject(item) && typeof item.path === 'string');
}

/** Keyed by path; a path listed twice keeps both entries as path#2, path#3... */
function keyCrons(list: Cron[]): Map<string, Cron> {
  const out = new Map<string, Cron>();
  const seen = new Map<string, number>();
  for (const cron of list) {
    const n = (seen.get(cron.path) ?? 0) + 1;
    seen.set(cron.path, n);
    out.set(n === 1 ? cron.path : `${cron.path}#${n}`, cron);
  }
  return out;
}

export function mergeJson(file: MergeFile, base: Json, ours: Json, theirs: Json): MergeResult {
  const merger = new Merger(file);
  const merged = merger.value(base, ours, theirs, []);
  return { merged: merged === MISSING ? {} : merged, notes: merger.notes };
}

/** Indentation and line ending of a JSON text, so the merged file looks like the install's copy. */
function formatOf(text: string): { indent: string; eol: string } {
  const indent = text.match(/^[{[]\r?\n([ \t]+)\S/)?.[1] ?? '  ';
  return { indent, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

/**
 * Merges three JSON texts. A missing base (the file was added on both sides)
 * merges from an empty object. Throws when a side is not valid JSON.
 */
export function mergeJsonText(file: MergeFile, base: string | null, ours: string, theirs: string): { text: string; notes: MergeNote[] } {
  const parse = (label: string, text: string): Json => {
    try {
      return JSON.parse(text) as Json;
    } catch (err) {
      throw new Error(`${file} (${label}) is not valid JSON: ${(err as Error).message}`);
    }
  };
  const { merged, notes } = mergeJson(file, base === null ? {} : parse('common ancestor', base), parse('this install', ours), parse('release', theirs));
  const { indent, eol } = formatOf(ours);
  return { text: JSON.stringify(merged, null, indent).replace(/\n/g, eol) + eol, notes };
}
