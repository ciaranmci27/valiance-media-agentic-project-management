/**
 * What an agent may open. Each inbox lists the readable kinds
 * (agent_readable_types); everything else, and anything skipped or not yet
 * uploaded, never gets a signed URL. SVG is not an image here: it is a
 * document that can carry script.
 */

export type AttachmentKind = 'image' | 'pdf' | 'text' | 'other';

const IMAGE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/gif', 'image/webp',
  'image/bmp', 'image/tiff', 'image/heic', 'image/heif',
]);
const TEXT_TYPES = new Set(['text/plain', 'text/csv', 'text/markdown', 'text/tab-separated-values']);
const EXTENSIONS: Record<string, AttachmentKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  tif: 'image', tiff: 'image', heic: 'image', heif: 'image',
  pdf: 'pdf',
  txt: 'text', csv: 'text', md: 'text', tsv: 'text', log: 'text',
};

export function attachmentKind(contentType: string | null | undefined, filename: string | null | undefined): AttachmentKind {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (IMAGE_TYPES.has(type)) return 'image';
  if (type === 'application/pdf') return 'pdf';
  if (TEXT_TYPES.has(type)) return 'text';
  if (type === '' || type === 'application/octet-stream' || type === 'binary/octet-stream') {
    const extension = (filename ?? '').toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1];
    return (extension && EXTENSIONS[extension]) || 'other';
  }
  return 'other';
}
