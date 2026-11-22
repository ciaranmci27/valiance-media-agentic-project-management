/**
 * Where the app lives in Supabase (2.0): its own schema, `pm`, so it can
 * share a project with a company's other apps. Every Supabase client the app
 * makes reads and writes it by default (`db: { schema: PM_SCHEMA }`);
 * `pm_custom` holds an install's own tables.
 *
 * Storage buckets are global in a Supabase project, so the app's carry a
 * `pm-` prefix. Installs from before 2.0 keep their old buckets until 2.1:
 * reads that miss in the new bucket try the old one (see storage.ts), while
 * `npm run storage:copy-to-pm` copies the files across.
 */
export const PM_SCHEMA = 'pm';
export const PM_CUSTOM_SCHEMA = 'pm_custom';

/** Client options every app client passes. */
export const PM_DB = { schema: PM_SCHEMA } as const;

export const BUCKETS = {
  avatars: 'pm-avatars',
  brand: 'pm-brand',
  entityFiles: 'pm-entity-files',
  inboundEmail: 'pm-inbound-email',
  portalFiles: 'pm-portal-files',
  taskFiles: 'pm-task-files',
} as const;

export type BucketId = typeof BUCKETS[keyof typeof BUCKETS];

/** The name each bucket had before 2.0 (read-only fallback until 2.1). */
export const LEGACY_BUCKET: Record<BucketId, string> = {
  'pm-avatars': 'avatars',
  'pm-brand': 'brand',
  'pm-entity-files': 'entity-files',
  'pm-inbound-email': 'inbound-email',
  'pm-portal-files': 'portal-files',
  'pm-task-files': 'task-files',
};
