import { z } from 'zod';

export const credentialCategoryEnum = z.enum([
  'login', 'api_key', 'ssh_key', 'database', 'credit_card', 'ach',
]);

/** Category-specific payload values (see lib/credential-fields.ts).
 *  Entry count is capped: the portal endpoint is reachable with just a
 *  portal token + PIN, so an unbounded record would be a payload-size DoS. */
const credentialFieldsRecord = z.record(z.string().max(64), z.string().max(20000))
  .refine(f => Object.keys(f).length <= 40, 'Too many fields');

/** Legacy flat secret fields, kept so existing v1 API callers keep working.
 *  They are merged into the fields record server-side. */
const legacyFlatFields = {
  username: z.string().optional(),
  password: z.string().optional(),
  url: z.string().optional(),
  notes: z.string().optional(),
};

/** Builds the payload record from a parsed body: new-style `fields` wins
 *  over legacy flat keys. */
export function payloadFromBody(data: {
  fields?: Record<string, string>;
  username?: string;
  password?: string;
  url?: string;
  notes?: string;
}): Record<string, string> {
  const payload: Record<string, string> = {};
  if (data.username !== undefined) payload.username = data.username;
  if (data.password !== undefined) payload.password = data.password;
  if (data.url !== undefined) payload.url = data.url;
  if (data.notes !== undefined) payload.notes = data.notes;
  return { ...payload, ...(data.fields || {}) };
}

export const createCredentialSchema = z.object({
  label: z.string().min(1, 'Label is required'),
  category: credentialCategoryEnum.default('login'),
  fields: credentialFieldsRecord.optional(),
  ...legacyFlatFields,
});

export const updateCredentialSchema = z.object({
  label: z.string().min(1).optional(),
  category: credentialCategoryEnum.optional(),
  fields: credentialFieldsRecord.optional(),
  ...legacyFlatFields,
});

export const portalSubmitCredentialSchema = z.object({
  label: z.string().min(1, 'Label is required'),
  category: credentialCategoryEnum.default('login'),
  fields: credentialFieldsRecord.optional(),
  submitted_by_name: z.string().default(''),
  ...legacyFlatFields,
});
