import { useState } from 'react';

/**
 * Return the same reference for as long as `value` serializes to the same
 * JSON. The invoice preview rebuilds its PDF whenever its data object
 * changes identity, and the store hands it a fresh object more often than
 * the content changes: an optimistic write, then the server's echo of the
 * same row. Keyed on content, one customizer toggle is one rebuild.
 *
 * `keyOf` picks what counts as content. Pass one when the value carries a
 * field that changes on every build without meaning anything to the reader,
 * such as a generated-at timestamp.
 *
 * Uses the documented "adjust state during render" pattern: when the key
 * moves, state is updated in the same render and the new value is returned
 * immediately, so nothing is a render behind.
 */
export function useContentStable<T>(value: T, keyOf: (value: T) => string = JSON.stringify): T {
  const key = keyOf(value);
  const [held, setHeld] = useState({ key, value });
  if (held.key !== key) {
    setHeld({ key, value });
    return value;
  }
  return held.value;
}
