// Common TLDs to strip from project names before slugifying
const TLD_PATTERN = /\.(com|net|org|io|ai|co|dev|app|me|us|uk|ca|de|fr|au|info|biz|tv|xyz)$/i;

/**
 * Shared slug logic: strip TLD, replace non-alphanumeric with hyphens,
 * collapse consecutive hyphens, trim leading/trailing hyphens.
 */
function slugify(name: string): string {
  return name
    .replace(TLD_PATTERN, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Generate a lowercase slug for DB storage and query matching.
 * e.g. "AcmeLegal.com" -> "acmelegal"
 *      "Crest Financial Rebrand" -> "crest-financial-rebrand"
 */
export function generatePortalSlug(name: string): string {
  return slugify(name).toLowerCase();
}

/**
 * Generate a display-cased slug preserving the original casing.
 * e.g. "AcmeLegal.com" -> "AcmeLegal"
 *      "Crest Financial Rebrand" -> "Crest-Financial-Rebrand"
 */
export function generatePortalSlugDisplay(name: string): string {
  return slugify(name);
}
