import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { ContactEmail, ContactEmailDraft } from '@/lib/types';
import { fetchContactEmails, insertContactEmail, patchContactEmail, removeContactEmail } from '@/lib/supabase/queries';

/**
 * A contact's email addresses, saved as one list: the contact form in the app
 * (store saveContactEmails) and PUT /api/v1/contacts/{id}/emails both write
 * through here, so they keep the same rules. The primary address is mirrored
 * to contacts.email by the database.
 */

/** Addresses on one contact, in one save. */
export const CONTACT_EMAILS_MAX = 50;

/** The list a save takes: rows with an id are kept (and edited), rows without one are added, rows left out go. */
export const contactEmailsSchema = z.object({
  emails: z.array(z.object({
    id: z.uuid('id must be the uuid of one of this contact\'s addresses').optional(),
    email: z.string().trim().toLowerCase().pipe(z.email('Each email must be a valid address')),
    label: z.string().trim().max(100).nullable().optional(),
    is_primary: z.boolean().optional(),
  }).strict()).max(CONTACT_EMAILS_MAX, `At most ${CONTACT_EMAILS_MAX} addresses`),
}).strict();
export type ContactEmailsInput = z.infer<typeof contactEmailsSchema>;

/** Drafts as saved: trimmed, lowercase, empty ones dropped, and which one is primary (the one marked, else the first). */
export function cleanContactEmailDrafts(drafts: ContactEmailDraft[]) {
  const cleaned = drafts
    .map(draft => ({ ...draft, email: draft.email.trim().toLowerCase(), label: draft.label?.trim() || null }))
    .filter(draft => draft.email);
  const primary = cleaned.find(draft => draft.is_primary)?.email ?? cleaned[0]?.email ?? '';
  return { cleaned, primary };
}

/**
 * Makes a contact's addresses exactly these drafts and answers the saved
 * rows. Throws the database error as is (23505: an address twice on one
 * contact).
 */
export async function writeContactEmails(supabase: SupabaseClient, contactId: string, drafts: ContactEmailDraft[]): Promise<ContactEmail[]> {
  const { cleaned, primary } = cleanContactEmailDrafts(drafts);
  // Diff against what the server holds now: a new contact gets its
  // primary row from the database, so local state may not have it yet.
  const current = await fetchContactEmails(supabase, contactId);
  const keep = new Set(cleaned.map(draft => draft.id).filter(Boolean));
  for (const row of current) {
    if (!keep.has(row.id) && !cleaned.some(draft => !draft.id && draft.email === row.email)) {
      await removeContactEmail(supabase, row.id);
    }
  }
  // An address is unique per contact, so a write must never land on an
  // address another row still holds: free addresses before taking them.
  // Edits run once their new address is free; a swap (a cycle) parks one
  // row by deleting it and adds it back last; new rows go in after edits.
  const held = new Map(current.filter(row => keep.has(row.id) || cleaned.some(draft => !draft.id && draft.email === row.email)).map(row => [row.email, row.id]));
  const edits: { id: string; email: string; label: string | null }[] = [];
  const inserts: { email: string; label: string | null }[] = [];
  for (const draft of cleaned) {
    const existing = current.find(row => row.id === draft.id) ?? (!draft.id ? current.find(row => row.email === draft.email) : undefined);
    if (existing) {
      if (existing.email !== draft.email || (existing.label ?? null) !== draft.label) {
        edits.push({ id: existing.id, email: draft.email, label: draft.label });
      }
    } else {
      inserts.push({ email: draft.email, label: draft.label });
    }
  }
  const emailOf = (id: string) => [...held].find(([, rowId]) => rowId === id)?.[0];
  while (edits.length > 0) {
    const ready = edits.findIndex(edit => !held.has(edit.email) || held.get(edit.email) === edit.id);
    if (ready === -1) {
      // Every remaining edit waits on another: park the first one.
      const [parked] = edits.splice(0, 1);
      await removeContactEmail(supabase, parked.id);
      held.delete(emailOf(parked.id) ?? '');
      inserts.push({ email: parked.email, label: parked.label });
      continue;
    }
    const [edit] = edits.splice(ready, 1);
    await patchContactEmail(supabase, edit.id, { email: edit.email, label: edit.label });
    held.delete(emailOf(edit.id) ?? '');
    held.set(edit.email, edit.id);
  }
  for (const insert of inserts) {
    await insertContactEmail(supabase, { contact_id: contactId, email: insert.email, label: insert.label });
  }
  if (primary) {
    const saved = await fetchContactEmails(supabase, contactId);
    const target = saved.find(row => row.email === primary);
    if (target && !target.is_primary) await patchContactEmail(supabase, target.id, { is_primary: true });
  }
  return fetchContactEmails(supabase, contactId);
}
