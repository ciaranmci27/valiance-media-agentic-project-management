/** A raw header: lowercase name, unfolded value. */
export interface HeaderLine {
  name: string;
  value: string;
}

/** Every value of a header, in message order (topmost first). */
export function headerValues(headers: readonly HeaderLine[], name: string): string[] {
  const wanted = name.toLowerCase();
  return headers.filter((header) => header.name.toLowerCase() === wanted).map((header) => header.value);
}

export function firstHeader(headers: readonly HeaderLine[], name: string): string | null {
  return headerValues(headers, name)[0] ?? null;
}

/** Resend sends a repeated header as one string holding a JSON array. */
function repeatedValues(value: string): string[] | null {
  if (!value.startsWith('["')) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A provider's header map ({ name: value }, { name: [values] } or
 * { name: '["value", ...]' }) as lines, names lowercased. Order within a
 * repeated header is kept.
 */
export function headerLinesFromMap(map: Record<string, unknown> | null | undefined): HeaderLine[] {
  const lines: HeaderLine[] = [];
  for (const [name, value] of Object.entries(map ?? {})) {
    const values = Array.isArray(value) ? value : typeof value === 'string' ? repeatedValues(value) ?? [value] : [value];
    for (const item of values) {
      if (typeof item === 'string') lines.push({ name: name.toLowerCase(), value: item.slice(0, 20_000) });
    }
  }
  return lines;
}
