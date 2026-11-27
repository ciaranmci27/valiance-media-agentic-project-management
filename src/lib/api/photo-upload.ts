import type { SupabaseClient } from '@supabase/supabase-js';
import { sniffImage } from '@/lib/brand/validate';
import { pmStorage } from '@/lib/supabase/storage';
import { BUCKETS } from '@/lib/supabase/schema';
import { ApiError, badRequest } from './errors';

/**
 * A picture uploaded over the API (a person's or an agent's picture, a
 * contact's photo): one multipart field named file, PNG or JPG, at most
 * PHOTO_MAX_BYTES. Stored where the app stores it (the avatars bucket, one
 * fixed name per record, replaced in place), answered as the public link the
 * record keeps, with a version so screens show the new one.
 */

export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
/** The request the route reads: the file plus the form's own overhead. */
export const PHOTO_BODY_BYTES = PHOTO_MAX_BYTES + 64 * 1024;

/** The bytes and type of the one file sent, checked before anything is stored. */
export async function readPhoto(request: Request): Promise<{ bytes: Uint8Array; contentType: string }> {
  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get('file');
  } catch {
    throw badRequest('Send the picture as multipart form data in a field named file', { reason: 'not_multipart' });
  }
  if (!file || typeof file === 'string') throw badRequest('Send the picture in a field named file', { reason: 'no_file' });
  if (file.size > PHOTO_MAX_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'A picture can be at most 2 MB', { reason: 'too_large', max_bytes: PHOTO_MAX_BYTES });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const image = sniffImage(bytes, 'light');
  if (!image) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use a PNG or JPG picture', { reason: 'not_an_image' });
  return { bytes, contentType: image.contentType };
}

/** Stores it at the record's fixed name (team/<id>.jpg, contacts/<id>.jpg, as the app does) and answers its link. */
export async function storePhoto(db: SupabaseClient, path: string, photo: { bytes: Uint8Array; contentType: string }): Promise<string> {
  const storage = pmStorage(db).from(BUCKETS.avatars);
  const { error } = await storage.upload(path, photo.bytes, { upsert: true, contentType: photo.contentType });
  if (error) throw new ApiError(500, 'INTERNAL_ERROR', `The picture did not upload: ${error.message}`, { reason: 'upload_failed' });
  const { data: { publicUrl } } = storage.getPublicUrl(path);
  return `${publicUrl}?t=${Date.now()}`;
}
