import { z } from 'zod';

export const credentialCategoryEnum = z.enum([
  'login', 'api_key', 'ssh_key', 'database', 'hosting',
  'cms', 'ftp', 'dns', 'email', 'other',
]);

export const createCredentialSchema = z.object({
  label: z.string().min(1, 'Label is required'),
  category: credentialCategoryEnum.default('login'),
  username: z.string().default(''),
  password: z.string().default(''),
  url: z.string().default(''),
  notes: z.string().default(''),
});

export const updateCredentialSchema = z.object({
  label: z.string().min(1).optional(),
  category: credentialCategoryEnum.optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  url: z.string().optional(),
  notes: z.string().optional(),
});

export const portalSubmitCredentialSchema = z.object({
  label: z.string().min(1, 'Label is required'),
  category: credentialCategoryEnum.default('login'),
  username: z.string().default(''),
  password: z.string().default(''),
  url: z.string().default(''),
  notes: z.string().default(''),
  submitted_by_name: z.string().default(''),
});
