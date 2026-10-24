'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { normalizeContentId } from '@/lib/inbound-email/display';

/**
 * Renders inbound email HTML (untrusted, from strangers) inside a sandboxed
 * iframe: no scripts (no allow-scripts), no forms, nothing remote but images
 * (a Content-Security-Policy that allows inline styles, data: fonts and
 * images over https), and links open in a new tab. Images load so the email
 * reads as designed, without a referrer. Inline images (cid:) point at the
 * stored attachment. The markup is sanitized first as a second fence.
 * Height follows the document so the frame reads as inline content.
 */

function policy(origin: string): string {
  return `default-src 'none'; img-src data: https: ${origin}; style-src 'unsafe-inline'; font-src data:; form-action 'none'`;
}

/**
 * Email is designed for white paper in every theme, so the frame (and the
 * iframe element behind it, before the document paints) is always white.
 */
const PAPER = '#ffffff';

const BASE_STYLES = `
  html, body { margin: 0; background: ${PAPER}; }
  body { padding: 16px 18px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.6; color: #1f2937; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  blockquote { margin: 10px 0; padding: 2px 0 2px 12px; border-left: 3px solid #d1d5db; color: #4b5563; }
  a { color: #1d4ed8; }
`;

/** CSS treats `<!--` and `-->` at the top level as nothing; mail clients (Outlook) still wrap styles in them. */
function unwrapStyleComments(node: Node) {
  if (node.nodeName.toLowerCase() !== 'style') return;
  const css = node.textContent ?? '';
  if (css.includes('<!--') || css.includes('-->')) node.textContent = css.replace(/<!--|-->/g, '');
}

function addLinkSafety(node: Element) {
  if (node.nodeName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
}

/**
 * Drops the earlier emails a reply quotes (see hasQuotedHtml): Gmail's and
 * Yahoo's quote blocks, Apple Mail's cited blockquotes, Thunderbird's cite
 * prefix and its quote, and Outlook's reply header with everything after it.
 */
function removeQuotedHistory(root: Element) {
  root.querySelectorAll('.gmail_quote, .gmail_quote_container, .yahoo_quoted, blockquote[type="cite" i]').forEach((node) => node.remove());
  for (const prefix of root.querySelectorAll('.moz-cite-prefix')) {
    if (prefix.nextElementSibling?.matches('blockquote')) prefix.nextElementSibling.remove();
    prefix.remove();
  }
  for (const marker of root.querySelectorAll('#divRplyFwdMsg, #appendonsend')) {
    let node: ChildNode | null = marker;
    while (node) {
      const next: ChildNode | null = node.nextSibling;
      node.remove();
      node = next;
    }
  }
}

/** The sanitized email as a whole document, our policy and styles first in its head. */
function buildDocument(html: string, inlineImages: Record<string, string>, hideQuoted: boolean): string {
  // Never hand unsanitized mail to the frame (no DOM on the server).
  if (typeof window === 'undefined' || !DOMPurify.isSupported) return '';
  // Before DOMPurify's own checks, which would drop a whole <style> whose text contains "<!".
  DOMPurify.addHook('uponSanitizeElement', unwrapStyleComments);
  DOMPurify.addHook('afterSanitizeAttributes', addLinkSafety);
  let root: Node;
  try {
    root = DOMPurify.sanitize(html, {
      // Keep the head: emails carry their styles there.
      WHOLE_DOCUMENT: true,
      RETURN_DOM: true,
      FORBID_TAGS: ['base', 'meta', 'link', 'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'source'],
      FORBID_ATTR: ['srcset', 'action', 'formaction', 'ping'],
    });
  } finally {
    DOMPurify.removeHook('uponSanitizeElement', unwrapStyleComments);
    DOMPurify.removeHook('afterSanitizeAttributes', addLinkSafety);
  }

  // Work on the parsed tree, never on the markup text: the policy goes in as
  // the head's first children, ahead of anything the email brought.
  // With WHOLE_DOCUMENT and RETURN_DOM, DOMPurify hands back the <html> element.
  const doc = root.ownerDocument;
  if (!doc || root.nodeType !== Node.ELEMENT_NODE) return '';
  const documentElement = root as Element;
  if (hideQuoted) removeQuotedHistory(documentElement);
  for (const image of documentElement.querySelectorAll('img[src^="cid:" i]')) {
    const url = inlineImages[normalizeContentId(image.getAttribute('src')!.slice(4))];
    if (url) image.setAttribute('src', url);
    else image.removeAttribute('src');
  }
  let head = documentElement.querySelector('head');
  if (!head) {
    head = doc.createElement('head');
    documentElement.insertBefore(head, documentElement.firstChild);
  }
  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  const policyTag = doc.createElement('meta');
  policyTag.setAttribute('http-equiv', 'Content-Security-Policy');
  policyTag.setAttribute('content', policy(window.location.origin));
  // A srcdoc page takes the app's referrer policy; this keeps the app's address from every image host.
  const referrer = doc.createElement('meta');
  referrer.setAttribute('name', 'referrer');
  referrer.setAttribute('content', 'no-referrer');
  const base = doc.createElement('base');
  base.setAttribute('target', '_blank');
  const style = doc.createElement('style');
  style.textContent = BASE_STYLES;
  head.prepend(charset, policyTag, referrer, base, style);
  return `<!DOCTYPE html>${documentElement.outerHTML}`;
}

const NO_IMAGES: Record<string, string> = {};

/**
 * `inlineImages` maps a Content-ID (see normalizeContentId) to the image's
 * URL. `hideQuoted` shows a reply without the history it quotes.
 */
export function EmailBodyFrame({ html, title, inlineImages = NO_IMAGES, hideQuoted = false }: {
  html: string;
  title: string;
  inlineImages?: Record<string, string>;
  hideQuoted?: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  const srcDoc = useMemo(() => buildDocument(html, inlineImages, hideQuoted), [html, inlineImages, hideQuoted]);

  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => () => observer.current?.disconnect(), []);

  // Follow the document's height as it lays out (fonts, tables, data: images).
  const syncHeight = () => {
    try {
      const doc = frameRef.current?.contentDocument;
      if (!doc?.body) return;
      // The whole email, so it scrolls with the thread rather than in a box of its own.
      const measure = () => setHeight(Math.min(Math.max(Math.ceil(doc.body.getBoundingClientRect().height) + 4, 80), 20000));
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
      className="block w-full rounded-lg border border-white/[0.08]"
      // Not bg-white: the light theme remaps white to ink, which flashed dark before the email painted.
      style={{ height, backgroundColor: PAPER, colorScheme: 'light' }}
    />
  );
}
