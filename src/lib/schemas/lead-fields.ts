import { z } from 'zod';

export const upsertLeadFieldsSchema = z.object({
  fields: z.array(
    z.object({
      field_key: z.string().min(1, 'field_key is required'),
      value: z.string(),
    })
  ).min(1, 'At least one field is required'),
});
