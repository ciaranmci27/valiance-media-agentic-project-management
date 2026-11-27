/**
 * An HTML file's text with this page's script nonce on each of its
 * `<script>` tags, for a preview in a srcdoc frame: that frame takes the
 * page's Content-Security-Policy, so without the nonce none of the file's
 * scripts would run (they still run sandboxed, in an origin of their own,
 * exactly as before the nonce policy). The nonce goes first, so a nonce the
 * file carried itself is ignored. Inline handlers (onclick=) and
 * javascript: links stay blocked: a nonce cannot cover them. Without a
 * nonce the text is returned as it is.
 */
export function withScriptNonce(html: string, nonce: string | undefined): string {
  if (!nonce || !/^[A-Za-z0-9+/=_-]+$/.test(nonce)) return html;
  return html.replace(/<(script)(?=[\s>/])/gi, (_match, tag: string) => `<${tag} nonce="${nonce}"`);
}
