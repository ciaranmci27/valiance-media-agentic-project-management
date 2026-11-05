'use client';

import { Fragment, useMemo } from 'react';
import { linkParts } from '@/lib/communications/email/display';

/** Plain text with its web addresses as links that open in a new tab. Goes inside the caller's own paragraph. */
export function LinkedText({ text }: { text: string }) {
  const parts = useMemo(() => linkParts(text), [text]);
  return parts.map((part, index) => ('url' in part ? (
    <a
      key={index}
      href={part.url}
      target="_blank"
      rel="noopener noreferrer"
      className="pointer-events-auto rounded text-brand-300 underline decoration-brand-300/30 underline-offset-2 [overflow-wrap:anywhere] hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      {part.url}
    </a>
  ) : <Fragment key={index}>{part.text}</Fragment>));
}
