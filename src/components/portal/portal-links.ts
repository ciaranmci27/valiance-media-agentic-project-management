import type { PortalData } from '@/lib/types';
import type { PortalFileLinks } from '@/lib/portal-file-links';

/** Ask for fresh links once the ones on the page are this old (they last an hour). */
export const PORTAL_LINK_REFRESH_MS = 45 * 60 * 1000;

/** The portal payload with the fresh links put in place of the old ones (anything not in `links` keeps its link). */
export function withFreshLinks(data: PortalData, links: PortalFileLinks): PortalData {
  return {
    ...data,
    invoices: data.invoices.map((invoice) => (links.invoices[invoice.id] ? { ...invoice, file_url: links.invoices[invoice.id] } : invoice)),
    updates: (data.updates || []).map((update) => ({
      ...update,
      attachments: update.attachments.map((attachment) => (links.attachments[attachment.id]
        ? { ...attachment, file_url: links.attachments[attachment.id] } : attachment)),
    })),
  };
}

/** Project files with fresh links (files added on this page keep theirs until the next refresh signs them too). */
export function filesWithFreshLinks(files: PortalData['files'], links: PortalFileLinks): PortalData['files'] {
  return files.map((file) => (links.files[file.id] ? { ...file, file_url: links.files[file.id] } : file));
}
