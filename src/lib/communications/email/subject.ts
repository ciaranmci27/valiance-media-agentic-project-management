/**
 * Subject normalization for threading: strips reply and forward prefixes in
 * the common languages (Re, Fwd, Fw, AW, WG, SV, VS, TR, with optional
 * counters such as "Re[2]:"), bracket tags such as "[EXTERNAL]", and repeats
 * of both, then collapses whitespace and lowercases.
 */

const PREFIX = /^\s*(?:re|fwd?|aw|wg|sv|vs|tr)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]\s*/i;
const BRACKET_TAG = /^\s*\[[^\]]{0,80}\]\s*/;
const FORWARD_PREFIX = /^(?:fwd?|wg|tr)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]/i;

export function normalizeSubject(subject: string | null | undefined): string {
  let value = (subject ?? '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 50; i++) {
    const next = value.replace(PREFIX, '').replace(BRACKET_TAG, '');
    if (next === value) break;
    value = next;
  }
  return value.replace(/\s*\((?:fwd|fw)\)\s*$/i, '').trim().toLowerCase();
}

/** Whether any prefix in the subject's prefix chain is a forward (Fwd, Fw, WG, TR). */
export function hasForwardPrefix(subject: string | null | undefined): boolean {
  let value = (subject ?? '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 50; i++) {
    if (FORWARD_PREFIX.test(value)) return true;
    const next = value.replace(PREFIX, '').replace(BRACKET_TAG, '');
    if (next === value) return false;
    value = next;
  }
  return false;
}
