import { withApi } from '@/lib/api/middleware';
import { paginated, created } from '@/lib/api/response';
import { createEntityFileSchema } from '@/lib/schemas';
import { badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { parsePagination } from '@/lib/api/pagination';
import { z } from 'zod';

const ENTITY_TYPES = ['lead', 'project', 'contact'] as const;

const postSchema = createEntityFileSchema.extend({
  entity_type: z.enum(ENTITY_TYPES),
  entity_id: z.string().uuid('Invalid entity ID'),
  uploaded_by: z.string().uuid('Invalid member ID').nullable().default(null),
});

export const GET = withApi(async ({ supabase, searchParams }) => {
  const { page, limit, offset } = parsePagination(searchParams);

  const entityType = searchParams.get('entity_type');
  const entityId = searchParams.get('entity_id');
  const visibility = searchParams.get('visibility');

  if (!entityType || !entityId) {
    throw badRequest('entity_type and entity_id query parameters are required');
  }

  if (!ENTITY_TYPES.includes(entityType as any)) {
    throw badRequest(`entity_type must be one of: ${ENTITY_TYPES.join(', ')}`);
  }

  if (visibility && visibility !== 'internal' && visibility !== 'external') {
    throw badRequest('visibility must be one of: internal, external');
  }

  let query = supabase
    .from('entity_files')
    .select('*', { count: 'exact' })
    .eq('entity_type', entityType)
    .eq('entity_id', entityId);

  if (visibility) {
    query = query.eq('visibility', visibility);
  }

  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
});

export const POST = withApi(async ({ supabase, body, apiKeyId, teamMemberId }) => {
  const entry = body as z.infer<typeof postSchema>;

  const { data, error } = await supabase
    .from('entity_files')
    .insert({
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      name: entry.name,
      file_url: entry.file_url,
      file_size: entry.file_size,
      mime_type: entry.mime_type,
      visibility: entry.visibility || 'internal',
      uploaded_by: entry.uploaded_by,
    })
    .select()
    .single();

  if (error) throw error;

  logAudit(supabase, {
    method: 'POST',
    endpoint: '/api/v1/entity-files',
    entityType: 'entity_file',
    entityId: data.id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    afterSnapshot: data,
    statusCode: 201,
  });

  return created(data);
}, { schema: postSchema });
