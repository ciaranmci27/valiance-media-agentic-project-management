'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';

/**
 * Renders inbound email HTML (untrusted, from strangers) inside a sandboxed
 * iframe: no scripts (no allow-scripts), no forms, no remote content (a
 * Content-Security-Policy that allows only inline styles and data: images,
 * so tracking pixels and remote images never load), and links open in a new
 * tab. The markup is sanitized first as a second fence. Height follows the
 * document so the frame reads as inline content.
 */

const CSP = "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:; form-action 'none'";

const HEAD = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><base target="_blank"><style>
  html, body { margin: 0; background: #ffffff; }
  body { padding: 16px 18px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.6; color: #1f2937; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  blockquote { margin: 10px 0; padding: 2px 0 2px 12px; border-left: 3px solid #d1d5db; color: #4b5563; }
  a { color: #1d4ed8; }
</style>`;

function sanitize(html: string): string {
  // Never hand unsanitized mail to the frame (no DOM on the server).
  if (typeof window === 'undefined' || !DOMPurify.isSupported) return '';
  const hook = (node: Element) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  };
  DOMPurify.addHook('afterSanitizeAttributes', hook);
  try {
    return DOMPurify.sanitize(html, {
      // Keep the head: emails carry their styles there.
      WHOLE_DOCUMENT: true,
      FORBID_TAGS: ['base', 'meta', 'link', 'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'source'],
      FORBID_ATTR: ['srcset', 'action', 'formaction', 'ping'],
    });
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes');
  }
}

/** True when the email asks for images from the web (blocked here). */
export function hasRemoteImages(html: string): boolean {
  return /<img[^>]+src\s*=\s*["']?\s*(https?:)?\/\//i.test(html) || /url\(\s*["']?\s*(https?:)?\/\//i.test(html);
}

export function EmailBodyFrame({ html, title }: { html: string; title: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  const srcDoc = useMemo(() => {
    const clean = sanitize(html);
    // Our policy and styles go first in the head, ahead of anything the email brought.
    return /<head[^>]*>/i.test(clean)
      ? `<!DOCTYPE html>${clean.replace(/<head[^>]*>/i, (head) => `${head}${HEAD}`)}`
      : `<!DOCTYPE html><html><head>${HEAD}</head><body>${clean}</body></html>`;
  }, [html]);

  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => () => observer.current?.disconnect(), []);

  // Follow the document's height as it lays out (fonts, tables, data: images).
  const syncHeight = () => {
    try {
      const doc = frameRef.current?.contentDocument;
      if (!doc?.body) return;
      const measure = () => setHeight(Math.min(Math.max(Math.ceil(doc.body.getBoundingClientRect().height) + 4, 80), 1400));
      measure();
      observer.current?.disconnect();
      observer.current = new ResizeObserver(measure);
      observer.current.observe(doc.body);
    } catch {
      // Keep the fallback height.
    }
  };

  return (
    <iframe
      ref={frameRef}
      title={title}
      // allow-same-origin only lets this page measure the height; without
      // allow-scripts nothing inside can run.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      onLoad={syncHeight}
      className="block w-full rounded-lg border border-white/[0.08] bg-white"
      style={{ height }}
    />
  );
}
