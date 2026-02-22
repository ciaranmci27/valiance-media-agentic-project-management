import { z } from 'zod';

export const upsertPortalSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  pin: z.string().nullable().optional(),
  welcome_message: z.string().optional(),
  logo_url: z.string().optional(),
  accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  show_progress: z.boolean().optional(),
  show_proposals: z.boolean().optional(),
  show_files: z.boolean().optional(),
  show_hours: z.boolean().optional(),
  show_updates: z.boolean().optional(),
});

export const createPortalUpdateSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  content: z.string().default(''),
  update_type: z.enum(['general', 'milestone', 'deliverable', 'note']).default('general'),
});

export const updatePortalUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().optional(),
  update_type: z.enum(['general', 'milestone', 'deliverable', 'note']).optional(),
  pinned: z.boolean().optional(),
});

export const createPortalFileSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  file_url: z.string().min(1, 'file_url is required'),
  file_size: z.number().int().min(0).default(0),
  mime_type: z.string().default('application/octet-stream'),
});

export const updatePortalFileSchema = z.object({
  name: z.string().min(1, 'Name is required'),
});
