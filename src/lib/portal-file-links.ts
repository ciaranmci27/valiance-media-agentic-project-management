import type { SupabaseClient } from '@supabase/supabase-js';
import { signStoredFileUrls } from '@/lib/storage/sign-stored-file';

/** How long a portal page's file links last; the page fetches fresh ones before they run out. */
export const PORTAL_LINK_SECONDS = 3600;

export interface PortalFileLinks {
  /** Shared project files, by entity file id. */
  files: Record<string, string>;
  /** Invoice PDFs, by invoice id. */
  invoices: Record<string, string>;
  /** Portal update attachments, by attachment id. */
  attachments: Record<string, string>;
}

/**
 * Fresh links for every file a portal shows, signed in one batch per bucket:
 * the same files, under the same settings and modules, as the portal payload
 * (/api/portal/[token]). An outside link maps to itself; a file that cannot
 * be signed is left out.
 */
export async function portalFileLinks(
  service: SupabaseClient,
  settings: { project_id: string; show_files?: boolean | null; show_invoices?: boolean | null; show_updates?: boolean | null },
  modules: ReadonlySet<string>,
): Promise<PortalFileLinks> {
  const [files, invoices, attachments] = await Promise.all([
    settings.show_files
      ? service.from('entity_files').select('id, file_url').eq('entity_type', 'project').eq('entity_id', settings.project_id)
        .eq('visibility', 'external').is('deleted_at', null)
      : Promise.resolve({ data: [] }),
    settings.show_invoices && modules.has('billing')
      ? service.from('project_invoices').select('id, file_url').eq('project_id', settings.project_id)
        .neq('status', 'draft').is('deleted_at', null).not('file_url', 'is', null)
      : Promise.resolve({ data: [] }),
    settings.show_updates
      ? service.from('portal_update_attachments').select('id, file_url, update:portal_updates!inner(project_id, deleted_at)')
        .eq('update.project_id', settings.project_id).is('update.deleted_at', null).is('deleted_at', null)
      : Promise.resolve({ data: [] }),
  ]);
  const rows = (answer: { data: unknown }) => ((answer.data ?? []) as { id: string; file_url: string | null }[]);
  const all = [...rows(files), ...rows(invoices), ...rows(attachments)];
  const signed = await signStoredFileUrls(service, all.map((row) => row.file_url), PORTAL_LINK_SECONDS);
  const byId = (list: { id: string; file_url: string | null }[]) => Object.fromEntries(
    list.flatMap((row) => {
      const url = row.file_url ? signed.get(row.file_url) : null;
      return url ? [[row.id, url]] : [];
    }),
  );
  return { files: byId(rows(files)), invoices: byId(rows(invoices)), attachments: byId(rows(attachments)) };
}
