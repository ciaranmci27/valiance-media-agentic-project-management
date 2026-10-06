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

/**
 * A provider's header map ({ name: value } or { name: [values] }) as lines,
 * names lowercased. Order within a repeated header is kept.
 */
export function headerLinesFromMap(map: Record<string, unknown> | null | undefined): HeaderLine[] {
  const lines: HeaderLine[] = [];
  for (const [name, value] of Object.entries(map ?? {})) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item === 'string') lines.push({ name: name.toLowerCase(), value: item.slice(0, 20_000) });
    }
  }
  return lines;
}
