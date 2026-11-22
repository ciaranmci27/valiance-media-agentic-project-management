/**
 * Polices an install's own migrations (supabase/migrations/custom/*.sql): they
 * may create, alter and drop objects in the install's own schema only
 * (`pm_custom` since 2.0; files dated before 2.0 used `custom`, which the
 * 2.0 move renamed), so core's schema stays exactly what each release expects
 * and core migrations never collide with an install's tables.
 *
 * Allowed: CREATE SCHEMA [IF NOT EXISTS] pm_custom; tables, views, functions,
 * types and the rest named pm_custom.<name>; indexes, policies and triggers ON
 * pm_custom.<table>; grants on schema pm_custom or its objects; data changes
 * to its tables; foreign keys that reference pm tables (the target of a
 * statement is checked, not what it reads or references). Transaction
 * control, SET, SELECT and NOTIFY pass. Anything else fails with the statement.
 *
 * DO blocks are checked statement by statement; EXECUTE of a string literal is
 * checked as SQL, any other dynamic SQL fails because it cannot be read.
 * Function bodies are not checked: they run later, as the install's code.
 */

type TokenKind = 'word' | 'qident' | 'string' | 'dollar' | 'punct' | 'other';
interface Token {
  kind: TokenKind;
  /** Lowercased for words; exact for quoted identifiers; the contents for strings. */
  value: string;
  start: number;
  end: number;
}

export interface SqlViolation {
  statement: string;
  reason: string;
}

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      // Postgres block comments nest.
      let depth = 0;
      do {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      } while (i < n && depth > 0);
      continue;
    }
    const start = i;
    if (c === "'" || ((c === 'e' || c === 'E') && sql[i + 1] === "'")) {
      const backslashes = c !== "'";
      i += backslashes ? 2 : 1;
      let value = '';
      while (i < n) {
        if (backslashes && sql[i] === '\\') { value += sql[i + 1] ?? ''; i += 2; continue; }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { value += "'"; i += 2; continue; }
          i++;
          break;
        }
        value += sql[i++];
      }
      tokens.push({ kind: 'string', value, start, end: i });
      continue;
    }
    if (c === '$') {
      const tag = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const bodyEnd = close === -1 ? n : close;
        tokens.push({ kind: 'dollar', value: sql.slice(i + tag[0].length, bodyEnd), start, end: close === -1 ? n : close + tag[0].length });
        i = close === -1 ? n : close + tag[0].length;
        continue;
      }
    }
    if (c === '"') {
      i++;
      let value = '';
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { value += '"'; i += 2; continue; }
          i++;
          break;
        }
        value += sql[i++];
      }
      tokens.push({ kind: 'qident', value, start, end: i });
      continue;
    }
    const word = sql.slice(i).match(/^[A-Za-z_][A-Za-z0-9_$]*/);
    if (word) {
      i += word[0].length;
      tokens.push({ kind: 'word', value: word[0].toLowerCase(), start, end: i });
      continue;
    }
    i++;
    tokens.push({ kind: ';.(),'.includes(c) ? 'punct' : 'other', value: c, start, end: i });
  }
  return tokens;
}

function splitStatements(tokens: Token[]): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    if (token.kind === 'punct' && token.value === ';') {
      if (current.length) out.push(current);
      current = [];
    } else current.push(token);
  }
  if (current.length) out.push(current);
  return out;
}

const GENERIC_KINDS = new Set([
  'table', 'view', 'sequence', 'type', 'domain', 'function', 'procedure', 'routine',
  'aggregate', 'index', 'statistics', 'collation',
]);
const DATABASE_WIDE = new Set([
  'extension', 'role', 'user', 'group', 'database', 'tablespace', 'publication', 'subscription',
  'cast', 'language', 'server', 'event', 'operator', 'transform', 'access', 'conversion', 'owned', 'system', 'large',
]);

/** The install's own schema the file is checked against (set by checkCustomSql). */
let schema = 'pm_custom';
const onlyCustom = () => `custom migrations may only change objects in schema ${schema}`;

class Reader {
  i = 0;
  constructor(public t: Token[]) {}

  word(offset = 0): string | undefined {
    const token = this.t[this.i + offset];
    return token?.kind === 'word' ? token.value : undefined;
  }
  /** Advances past the words if they all match here. */
  accept(...words: string[]): boolean {
    if (words.every((w, k) => this.word(k) === w)) { this.i += words.length; return true; }
    return false;
  }
  punct(value: string): boolean {
    const token = this.t[this.i];
    if (token?.kind === 'punct' && token.value === value) { this.i++; return true; }
    return false;
  }
  ident(): string | undefined {
    const token = this.t[this.i];
    if (token?.kind === 'word' || token?.kind === 'qident') { this.i++; return token.value; }
    return undefined;
  }
  /** schema.name (or schema.table.column): the parts, or undefined when no name is here. */
  qname(): string[] | undefined {
    const first = this.ident();
    if (first === undefined) return undefined;
    const parts = [first];
    while (this.t[this.i]?.kind === 'punct' && this.t[this.i].value === '.') {
      this.i++;
      const next = this.ident();
      if (next === undefined) break;
      parts.push(next);
    }
    return parts;
  }
  skipParens() {
    if (!(this.t[this.i]?.kind === 'punct' && this.t[this.i].value === '(')) return;
    let depth = 0;
    do {
      const token = this.t[this.i++];
      if (token.kind === 'punct' && token.value === '(') depth++;
      if (token.kind === 'punct' && token.value === ')') depth--;
    } while (this.i < this.t.length && depth > 0);
  }
  /** Moves to the next top-level occurrence of a word; false when there is none. */
  seek(word: string): boolean {
    let depth = 0;
    for (let k = this.i; k < this.t.length; k++) {
      const token = this.t[k];
      if (token.kind === 'punct' && token.value === '(') depth++;
      else if (token.kind === 'punct' && token.value === ')') depth--;
      else if (depth === 0 && token.kind === 'word' && token.value === word) { this.i = k + 1; return true; }
    }
    return false;
  }
  /** name[(args)][, name[(args)]...] */
  nameList(): string[][] {
    const names: string[][] = [];
    for (;;) {
      this.accept('only');
      const name = this.qname();
      if (!name) break;
      names.push(name);
      this.skipParens();
      if (!this.punct(',')) break;
    }
    return names;
  }
}

const label = (parts: string[]) => parts.join('.');

/** Reason string when a target is not in schema custom; null when it is. */
function target(parts: string[] | undefined, what = 'an object'): string | null {
  if (!parts) return `could not read the name of ${what}; ${onlyCustom()}`;
  if (parts.length < 2) return `names ${label(parts)} without a schema; write ${schema}.${parts[0]}`;
  if (parts[0] !== schema) return `touches ${label(parts)}; ${onlyCustom()}`;
  return null;
}

function targets(list: string[][], what?: string): string | null {
  if (!list.length) return target(undefined, what);
  for (const parts of list) {
    const reason = target(parts, what);
    if (reason) return reason;
  }
  return null;
}

function schemas(list: string[][]): string | null {
  if (!list.length) return `could not read the schema name; ${onlyCustom()}`;
  const other = list.find(parts => parts.length !== 1 || parts[0] !== schema);
  return other ? `touches schema ${label(other)}; ${onlyCustom()}` : null;
}

function checkCreate(r: Reader): string | null {
  while (r.accept('or', 'replace') || ['temp', 'temporary', 'unlogged', 'unique', 'materialized', 'recursive', 'constraint', 'trusted', 'procedural'].some(w => r.accept(w)));
  const kind = r.word();
  if (!kind) return `could not read what this creates; ${onlyCustom()}`;
  r.i++;
  if (kind === 'schema') {
    r.accept('if', 'not', 'exists');
    return schemas([r.qname() ?? []].filter(p => p.length));
  }
  if (kind === 'index') {
    r.accept('concurrently');
    r.accept('if', 'not', 'exists');
    if (r.word() !== 'on') r.ident();
    if (!r.accept('on')) return `could not read the indexed table; ${onlyCustom()}`;
    r.accept('only');
    return target(r.qname(), 'the indexed table');
  }
  if (kind === 'policy' || kind === 'trigger') {
    r.ident();
    if (!r.seek('on')) return `could not read the ${kind}'s table; ${onlyCustom()}`;
    return target(r.qname(), `the ${kind}'s table`);
  }
  if (kind === 'rule') {
    r.ident();
    if (!r.seek('to')) return `could not read the rule's table; ${onlyCustom()}`;
    return target(r.qname(), "the rule's table");
  }
  if (kind === 'foreign' && r.accept('table')) {
    r.accept('if', 'not', 'exists');
    return target(r.qname());
  }
  if (GENERIC_KINDS.has(kind)) {
    r.accept('if', 'not', 'exists');
    return target(r.qname());
  }
  if (DATABASE_WIDE.has(kind) || kind === 'foreign') return `creates a database-wide object (${kind}); ${onlyCustom()}`;
  return `creates a ${kind}, which custom migrations cannot; ${onlyCustom()}`;
}

function checkAlter(r: Reader): string | null {
  const kind = r.word();
  if (!kind) return `could not read what this alters; ${onlyCustom()}`;
  r.i++;
  if (kind === 'table' || kind === 'index' || kind === 'view' || kind === 'sequence') {
    r.accept('if', 'exists');
    r.accept('only');
    if (r.word() === 'all') return `alters every ${kind} in a tablespace; ${onlyCustom()}`;
    return target(r.qname());
  }
  if (kind === 'schema') return schemas([r.qname() ?? []].filter(p => p.length));
  if (kind === 'policy' || kind === 'trigger' || kind === 'rule') {
    r.ident();
    if (!r.accept('on')) return `could not read the ${kind}'s table; ${onlyCustom()}`;
    return target(r.qname(), `the ${kind}'s table`);
  }
  if (kind === 'default' && r.accept('privileges')) {
    if (!r.seek('in') || !r.accept('schema')) return `alters default privileges for every schema; limit it with IN SCHEMA ${schema}`;
    return schemas(r.nameList());
  }
  if (kind === 'publication') {
    // Realtime for an install's tables: adding or dropping custom tables only, never SET (it would replace core's list).
    r.ident();
    if (!(r.accept('add') || r.accept('drop'))) return `changes a publication's settings or table list; only ADD TABLE / DROP TABLE of ${schema} tables is allowed`;
    if (r.accept('tables', 'in', 'schema')) return schemas(r.nameList());
    r.accept('table');
    return targets(r.nameList(), 'a published table');
  }
  if (kind === 'materialized' && r.accept('view')) {
    r.accept('if', 'exists');
    return target(r.qname());
  }
  if (kind === 'foreign' && r.accept('table')) {
    r.accept('if', 'exists');
    r.accept('only');
    return target(r.qname());
  }
  if (GENERIC_KINDS.has(kind)) {
    r.accept('if', 'exists');
    return target(r.qname());
  }
  return `alters a ${kind}, which is outside schema ${schema}; ${onlyCustom()}`;
}

function checkDrop(r: Reader): string | null {
  const kind = r.word();
  if (!kind) return `could not read what this drops; ${onlyCustom()}`;
  r.i++;
  if (kind === 'schema') {
    r.accept('if', 'exists');
    return schemas(r.nameList());
  }
  if (kind === 'policy' || kind === 'trigger' || kind === 'rule') {
    r.accept('if', 'exists');
    r.ident();
    if (!r.accept('on')) return `could not read the ${kind}'s table; ${onlyCustom()}`;
    return target(r.qname(), `the ${kind}'s table`);
  }
  if ((kind === 'materialized' && r.accept('view')) || (kind === 'foreign' && r.accept('table')) || GENERIC_KINDS.has(kind)) {
    r.accept('concurrently');
    r.accept('if', 'exists');
    return targets(r.nameList());
  }
  return `drops a ${kind}, which is outside schema ${schema}; ${onlyCustom()}`;
}

function checkComment(r: Reader): string | null {
  if (!r.accept('on')) return `could not read what this comments on; ${onlyCustom()}`;
  const kind = r.word();
  if (!kind) return `could not read what this comments on; ${onlyCustom()}`;
  r.i++;
  if (kind === 'column') {
    const parts = r.qname();
    if (!parts || parts.length < 3) return `comments on column ${parts ? label(parts) : '?'} without a schema; write ${schema}.<table>.<column>`;
    return target(parts);
  }
  if (kind === 'schema') return schemas([r.qname() ?? []].filter(p => p.length));
  if (kind === 'policy' || kind === 'trigger' || kind === 'rule' || kind === 'constraint') {
    r.ident();
    if (!r.accept('on')) return `could not read the ${kind}'s table; ${onlyCustom()}`;
    r.accept('domain');
    return target(r.qname(), `the ${kind}'s table`);
  }
  if ((kind === 'materialized' && r.accept('view')) || (kind === 'foreign' && r.accept('table')) || GENERIC_KINDS.has(kind)) {
    return target(r.qname());
  }
  return `comments on a ${kind}, which is outside schema ${schema}; ${onlyCustom()}`;
}

function checkGrant(r: Reader): string | null {
  if (!r.seek('on')) return `grants or revokes a role membership; ${onlyCustom()}`;
  if (r.accept('schema')) return schemas(r.nameList());
  if (r.accept('all')) {
    r.i++; // tables | sequences | functions | procedures | routines
    if (!r.accept('in', 'schema')) return `could not read the schema of this grant; ${onlyCustom()}`;
    return schemas(r.nameList());
  }
  const kind = r.word();
  if (kind && ['database', 'tablespace', 'language', 'large', 'parameter', 'foreign'].includes(kind) && !(kind === 'foreign' && r.word(1) === 'table')) {
    return `grants on a database-wide object (${kind}); ${onlyCustom()}`;
  }
  if (kind === 'foreign') r.i += 2;
  else if (kind && ['table', 'sequence', 'function', 'procedure', 'routine', 'type', 'domain'].includes(kind)) r.i++;
  return targets(r.nameList(), 'a granted object');
}

/** Data changes inside WITH statements: INSERT INTO, UPDATE ... SET, DELETE FROM, MERGE INTO. */
function checkDataChanges(tokens: Token[]): string | null {
  for (let k = 0; k < tokens.length; k++) {
    const r = new Reader(tokens);
    r.i = k;
    let name: string[] | undefined;
    if (r.accept('insert', 'into') || r.accept('merge', 'into')) name = r.qname();
    else if (r.accept('delete', 'from')) { r.accept('only'); name = r.qname(); }
    else if (r.accept('update')) {
      r.accept('only');
      const candidate = r.qname();
      r.accept('as');
      if (r.word() !== 'set') r.ident();
      if (candidate && r.word() === 'set') name = candidate;
      else continue;
    } else continue;
    const reason = target(name, 'a changed table');
    if (reason) return reason;
  }
  return null;
}

function checkStatement(tokens: Token[]): string | null {
  const r = new Reader(tokens);
  const head = r.word();
  if (!head) return `could not read this statement; ${onlyCustom()}`;
  r.i++;
  switch (head) {
    case 'begin': case 'commit': case 'end': case 'start': case 'rollback': case 'savepoint': case 'release':
    case 'set': case 'reset': case 'notify': case 'select': case 'values': case 'analyze':
      return null;
    case 'create': return checkCreate(r);
    case 'alter': return checkAlter(r);
    case 'drop': return checkDrop(r);
    case 'comment': return checkComment(r);
    case 'grant': case 'revoke': return checkGrant(r);
    case 'insert': case 'update': case 'delete': case 'merge': case 'with':
      return checkDataChanges(tokens);
    case 'truncate':
      r.accept('table');
      return targets(r.nameList(), 'a truncated table');
    case 'do': {
      const body = tokens.find(token => token.kind === 'dollar' || token.kind === 'string');
      if (!body) return 'could not read the DO block';
      return checkPlpgsql(body.value);
    }
    default:
      return `${head.toUpperCase()} statements are not allowed in custom migrations; ${onlyCustom()}`;
  }
}

const PLPGSQL_BREAKS = new Set(['then', 'else', 'loop', 'begin', 'exception', 'declare']);
const CHECKED_IN_BLOCKS = new Set(['create', 'alter', 'drop', 'comment', 'grant', 'revoke', 'truncate', 'insert', 'update', 'delete', 'merge', 'with']);

/** A DO body: split into statements at ; and block keywords, then check the SQL ones. */
function checkPlpgsql(body: string): string | null {
  const segments: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokenize(body)) {
    const isBreak = (token.kind === 'punct' && token.value === ';') || (token.kind === 'word' && PLPGSQL_BREAKS.has(token.value));
    if (isBreak) {
      if (current.length) segments.push(current);
      current = [];
    } else current.push(token);
  }
  if (current.length) segments.push(current);

  for (const segment of segments) {
    const head = segment[0]?.kind === 'word' ? segment[0].value : undefined;
    if (head === 'execute') {
      const literal = segment[1];
      if (literal && (literal.kind === 'string' || literal.kind === 'dollar') && segment.length === 2) {
        const inner = checkCustomSql(literal.value);
        if (inner.length) return `inside DO, ${inner[0].reason} (${inner[0].statement})`;
        continue;
      }
      return 'runs dynamic SQL (EXECUTE) inside DO, which cannot be checked; write the statement directly';
    }
    if (!head || !CHECKED_IN_BLOCKS.has(head)) continue;
    const reason = checkStatement(segment);
    if (reason) return `inside DO, ${reason} (${snippet(body, segment)})`;
  }
  return null;
}

function snippet(source: string, tokens: Token[]): string {
  const text = source.slice(tokens[0].start, tokens[tokens.length - 1].end).replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** Custom migrations dated before 2.0 were written for schema `custom`. */
export const PM_CUSTOM_FROM = '20261123000000';

/** The schema a custom migration file is checked against, from its name's date. */
export function customSchemaFor(fileName: string): 'custom' | 'pm_custom' {
  const date = /^(\d{8,14})/.exec(fileName)?.[1];
  return date && date.padEnd(14, '0') < PM_CUSTOM_FROM ? 'custom' : 'pm_custom';
}

/** Every statement in the file that steps outside the install's schema (pm_custom; `custom` for files before 2.0). */
export function checkCustomSql(sql: string, ownSchema: 'custom' | 'pm_custom' = 'pm_custom'): SqlViolation[] {
  schema = ownSchema;
  const violations: SqlViolation[] = [];
  for (const statement of splitStatements(tokenize(sql))) {
    const reason = checkStatement(statement);
    if (reason) violations.push({ statement: snippet(sql, statement), reason });
  }
  return violations;
}
