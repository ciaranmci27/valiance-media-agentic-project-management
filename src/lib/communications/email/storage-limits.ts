/** The storage bucket every inbox file (raw message, attachment, meeting text) goes to. */
export const INBOUND_EMAIL_BUCKET = 'inbound-email';
/** The bucket's per-object limit (50 MiB); a larger raw message is not stored. */
export const MAX_OBJECT_BYTES = 52_428_800;
