const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
  ndash: '\u2013', mdash: '\u2014', hellip: '...', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"',
  copy: '(c)', reg: '(R)', trade: '(TM)', bull: '*', middot: '*', euro: 'EUR', pound: 'GBP',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return safeCodePoint(parseInt(lower.slice(2), 16), match);
    if (lower.startsWith('#')) return safeCodePoint(parseInt(lower.slice(1), 10), match);
    return NAMED_ENTITIES[lower] ?? match;
  });
}

function safeCodePoint(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback;
  try { return String.fromCodePoint(code); } catch { return fallback; }
}

/**
 * HTML email to readable plain text: no markup, scripts or styles; block
 * elements and line breaks become newlines; list items get a dash; link
 * targets follow their text when they differ. Display and reading only: the
 * result is never rendered as HTML.
 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, '').trim();
      const target = href.trim();
      if (!label) return target;
      if (/^mailto:/i.test(target) || target === label || !/^https?:/i.test(target)) return label;
      return `${label} (${target})`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|ul|ol|section|article|header|footer)\s*>/gi, '\n')
    .replace(/<(p|div|tr|h[1-6]|blockquote|table|ul|ol|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  text = decodeEntities(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return text.trim();
}
