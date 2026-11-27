import { z } from 'zod';

export const uuid = z.string().uuid();
export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex color like #FF0000');
export const nonEmptyString = z.string().min(1, 'Must not be empty');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().optional(),
});

// ── Dates ───────────────────────────────────────────────────────────────

/** The years a date the API takes may fall in: wide enough for any real plan, never year 9999. */
export const DATE_YEAR_MIN = 1900;
export const DATE_YEAR_MAX = 2200;

/** Whether `value` is a real calendar date, YYYY-MM-DD, between DATE_YEAR_MIN and DATE_YEAR_MAX. */
export function isApiDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (y < DATE_YEAR_MIN || y > DATE_YEAR_MAX) return false;
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

/** YYYY-MM-DD, optionally an ISO 8601 / RFC 3339 time after T or a space, optionally Z or an offset. */
const ISO_DATE_TIME = /^(\d{4}-\d{2}-\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d{1,9})?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/**
 * The calendar date of an ISO 8601 date or date-time, as YYYY-MM-DD, or null
 * when it is not one (a day that does not exist, a time past 23:59:59, an
 * offset past 14 hours, out of range, or anything else). A date-time gives
 * the date it is written with: the day in its own offset (the UTC day for Z,
 * the wall-clock day when no offset is given). That reading is exact and
 * never shifts the day an agent meant.
 */
export function apiDateOf(value: string): string | null {
  const match = ISO_DATE_TIME.exec(value.trim());
  if (!match) return null;
  const [, day, hours, minutes, seconds, zone] = match;
  if (hours !== undefined && (Number(hours) > 23 || Number(minutes) > 59 || (seconds !== undefined && Number(seconds) > 59))) return null;
  if (zone && zone.toUpperCase() !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    if (Number(digits.slice(0, 2)) > 14 || (digits.length > 2 && Number(digits.slice(2)) > 59)) return null;
  }
  return isApiDate(day) ? day : null;
}

const DATE_MESSAGE = `Use a real calendar date, YYYY-MM-DD (an ISO 8601 date-time is read as its date), between ${DATE_YEAR_MIN} and ${DATE_YEAR_MAX}`;

/**
 * A calendar date the API stores (a due date, a reminder day, a target).
 * Takes YYYY-MM-DD or any ISO 8601 date-time (apiDateOf) and stores
 * YYYY-MM-DD; refuses a day that does not exist (2026-02-30), anything that
 * is not a date, and years outside 1900 to 2200. 422 names the field.
 */
export const calendarDate = z.string().transform((value, ctx) => {
  const day = apiDateOf(value);
  if (day === null) {
    ctx.addIssue({ code: 'custom', message: DATE_MESSAGE });
    return z.NEVER;
  }
  return day;
});

/**
 * calendarDate for a date that could always be cleared: these fields took any
 * string before dates were checked, so an empty string still clears it (null).
 */
export const clearableDate = z.union([z.literal(''), calendarDate]).transform((value) => (value === '' ? null : value));

// ── Text ────────────────────────────────────────────────────────────────

/** Caps on the text the API stores: far past real use, short of a payload that bloats every list read. */
export const TEXT_MAX = {
  title: 500,
  name: 200,
  description: 100_000,
  comment: 50_000,
  tag: 50,
  tags: 50,
  criterion: 2_000,
} as const;

const cap = (field: string, max: number) => `${field} is at most ${max.toLocaleString('en-US')} characters`;

/** A title: trimmed, not blank, at most TEXT_MAX.title. */
export const titleText = (field = 'title') =>
  z.string().trim().min(1, `${field} cannot be blank`).max(TEXT_MAX.title, cap(field, TEXT_MAX.title));

/** A name: trimmed, not blank, at most TEXT_MAX.name. */
export const nameText = (field = 'name') =>
  z.string().trim().min(1, `${field} cannot be blank`).max(TEXT_MAX.name, cap(field, TEXT_MAX.name));

/** Long free text (a description, notes): kept as written, at most TEXT_MAX.description. */
export const longText = (field = 'description') => z.string().max(TEXT_MAX.description, cap(field, TEXT_MAX.description));

/** A comment: kept as written (an indented first line stays), not blank, at most TEXT_MAX.comment. */
export const commentText = (field = 'text') =>
  z.string().max(TEXT_MAX.comment, cap(field, TEXT_MAX.comment)).refine((value) => value.trim().length > 0, `${field} cannot be blank`);

/** An acceptance criterion: kept as written, not blank, at most TEXT_MAX.criterion. */
export const criterionText = (field = 'criterion') =>
  z.string().max(TEXT_MAX.criterion, cap(field, TEXT_MAX.criterion)).refine((value) => value.trim().length > 0, `${field} cannot be blank`);

/** Tags: each trimmed and at most TEXT_MAX.tag, blanks dropped, at most TEXT_MAX.tags of them. */
export const tagList = z.array(z.string().trim().max(TEXT_MAX.tag, cap('a tag', TEXT_MAX.tag)))
  .max(TEXT_MAX.tags, `At most ${TEXT_MAX.tags} tags`)
  .transform((tags) => tags.filter((tag) => tag.length > 0));

/** NUL, or half of a surrogate pair: Postgres stores neither in text or jsonb. */
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** How deep a request body may nest: far past any real one, short of a stack a walk could exhaust. */
export const BODY_DEPTH_MAX = 64;

export interface BodyProblem {
  /** Where: "title", "tags[2]", "action.summary"; "(body)" for the body itself. */
  path: string;
  /** invalid_text: a string (or key) the database cannot store. too_deep: nested past BODY_DEPTH_MAX. */
  reason: 'invalid_text' | 'too_deep';
}

/**
 * The first problem in a JSON body, or null. Walks with its own stack, never
 * recursion, so no body can exhaust the call stack. `text: false` checks
 * only the depth (before the schema parses it); the text check runs on what
 * the schema kept, so a field the schema cleans, or a key it drops, passes.
 */
export function bodyProblem(value: unknown, options: { text?: boolean } = {}): BodyProblem | null {
  const text = options.text !== false;
  const stack: Array<[unknown, string, number]> = [[value, '', 0]];
  while (stack.length) {
    const [item, path, depth] = stack.pop()!;
    if (typeof item === 'string') {
      if (text && UNSTORABLE.test(item)) return { path: path || '(body)', reason: 'invalid_text' };
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    if (depth >= BODY_DEPTH_MAX) return { path: path || '(body)', reason: 'too_deep' };
    const children: Array<[unknown, string, number]> = [];
    if (Array.isArray(item)) {
      item.forEach((child, i) => children.push([child, `${path}[${i}]`, depth + 1]));
    } else {
      for (const [key, child] of Object.entries(item)) {
        const at = path ? `${path}.${key}` : key;
        if (text && UNSTORABLE.test(key)) return { path: at, reason: 'invalid_text' };
        children.push([child, at, depth + 1]);
      }
    }
    // Reversed onto the stack, so the first field is checked first.
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return null;
}
