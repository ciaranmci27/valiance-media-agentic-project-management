import { MAX_TASK_FILE_BYTES } from '@/lib/task-files/client';

/**
 * What a client portal visitor may upload (deep security review of 2.0.50,
 * finding 12). A visitor is anyone holding the link, so nothing they send
 * may run or render as a page under the agency's address: web pages, SVG
 * (which carries script), XML and script files are refused, as are
 * programs. Files are capped at the app's own file limit, and a portal takes
 * at most PORTAL_UPLOADS_PER_DAY visitor files a day.
 *
 * Files the team adds are not affected: an HTML page a team member shares
 * still opens as a page in the portal.
 */

/** The same limit as every other file in the app (the storage bucket's). */
export const PORTAL_UPLOAD_MAX_BYTES = MAX_TASK_FILE_BYTES;
/** Visitor uploads one portal takes in 24 hours. */
export const PORTAL_UPLOADS_PER_DAY = 50;

const PROGRAMS = ['exe', 'bat', 'cmd', 'sh', 'msi', 'dll', 'scr', 'com', 'vbs', 'vbe', 'js', 'jse', 'ps1', 'wsf', 'wsh', 'hta', 'jar', 'app', 'apk', 'pif', 'cpl', 'reg', 'lnk'];
const ACTIVE = ['html', 'htm', 'xhtml', 'xht', 'shtml', 'mht', 'mhtml', 'svg', 'svgz', 'xml', 'xsl', 'xslt', 'mjs', 'cjs', 'php', 'swf'];
const REFUSED_EXTENSIONS = new Set([...PROGRAMS, ...ACTIVE]);

/** Types a browser renders or runs: never accepted from a visitor, and never shown as a page when one slipped in earlier. */
export function isActiveMime(mime: string | null | undefined): boolean {
  const type = (mime ?? '').toLowerCase().split(';')[0].trim();
  const subtype = type.split('/')[1] ?? '';
  if (!subtype) return false;
  // The whole subtype or its +suffix, never a substring: Office types
  // (application/vnd.openxmlformats-officedocument.*) carry "xml" inside their name and are documents.
  if (subtype === 'xml' || subtype.endsWith('+xml')) return true;
  return ACTIVE_SUBTYPES.has(subtype);
}

/** Subtypes a browser renders as a page or runs as a program. */
const ACTIVE_SUBTYPES = new Set([
  'html', 'xhtml', 'svg', 'javascript', 'x-javascript', 'ecmascript', 'x-ecmascript', 'jscript',
  'x-sh', 'x-csh', 'x-msdownload', 'x-shockwave-flash', 'x-msdos-program', 'x-php', 'hta', 'x-xslt', 'xslt',
]);

/** Why a visitor's file is refused, in plain words, or null when it may be uploaded. */
export function portalUploadProblem(file: { name: string; type?: string | null; size: number }): string | null {
  if (!file.size) return 'No file provided';
  if (file.size > PORTAL_UPLOAD_MAX_BYTES) return `File exceeds the ${Math.round(PORTAL_UPLOAD_MAX_BYTES / (1024 * 1024))} MB limit`;
  // Every part after a dot counts, so "invoice.pdf.html" and "page.html.pdf" are both refused.
  const parts = file.name.toLowerCase().split('.').slice(1).map((part) => part.trim());
  if (parts.some((part) => REFUSED_EXTENSIONS.has(part)) || isActiveMime(file.type)) {
    return 'This file type is not allowed. Send documents, images, spreadsheets or archives.';
  }
  return null;
}

/** The type the portal shows a file as: a visitor's active file is a plain download, never a page. */
export function portalShownMime(file: { mime_type: string | null; uploaded_by: string | null }): string {
  const mime = file.mime_type || 'application/octet-stream';
  return !file.uploaded_by && isActiveMime(mime) ? 'application/octet-stream' : mime;
}
