import { z } from 'zod';
import { AGENT_CLOSE_POLICIES, AGENT_CREATE_POLICIES } from '@/lib/agent-rules';
import { agentProfileSchema } from '@/lib/mcp/profiles';
import { AGENT_ROLE_PATTERN } from '@/lib/project-agents';

/**
 * Bodies of the agent template and agent configuration routes
 * (/api/v1/agents/{id}/template, /api/v1/agents/import). A configuration
 * document is what GET /api/v1/agents/{id}/export answers: names and ids,
 * never a secret. Fields an import does not know are ignored, so a document
 * from a newer release still imports what this one understands.
 */

const ref = z.object({
  id: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(200),
});
export type ConfigRef = z.infer<typeof ref>;

export const agentConfigDocumentSchema = z.object({
  format: z.literal('pm-agent-config', 'format must be pm-agent-config'),
  version: z.literal(1, 'This release reads version 1 documents'),
  member: z.object({
    id: z.string().uuid().nullable().optional(),
    name: z.string().trim().min(1).max(100),
    title: z.string().trim().max(80).nullable().optional(),
    agent_profile: agentProfileSchema.optional(),
    agent_role: z.string().trim().regex(AGENT_ROLE_PATTERN, 'A role is lowercase words joined by dashes, 40 characters at most').nullable().optional(),
    description: z.string().trim().max(2000).nullable().optional(),
  }),
  owners: z.array(ref).max(20).optional(),
  rules: z.object({
    agent_self_assign: z.boolean().optional(),
    agent_close_policy: z.enum(AGENT_CLOSE_POLICIES).optional(),
    agent_create_policy: z.enum(AGENT_CREATE_POLICIES).optional(),
    agent_escalate_to: ref.nullable().optional(),
  }).optional(),
  projects: z.array(ref).max(500).optional(),
  keys: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    scopes: z.array(z.string().max(100)).min(1).max(100),
    permissions: z.enum(['scoped', 'read_only']).optional(),
  })).max(20).nullable().optional(),
  webhooks: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    url: z.string().trim().min(1).max(2000),
    events: z.array(z.string().max(100)).min(1).max(50),
    description: z.string().max(500).optional(),
    amount_basis: z.enum(['gross', 'net']).optional(),
    projects: z.array(ref).max(200).nullable().optional(),
    is_active: z.boolean().optional(),
  })).max(20).nullable().optional(),
  template: z.string().max(100).nullable().optional(),
});
export type AgentConfigDocument = z.infer<typeof agentConfigDocumentSchema>;

export const importAgentConfigSchema = z.object({
  document: agentConfigDocumentSchema,
  agent_id: z.string().uuid('agent_id must be a team member id').optional(),
  name: z.string().trim().min(1).max(100).optional(),
  email: z.string().trim().toLowerCase().email('Invalid email address').optional(),
  dry_run: z.boolean().optional(),
  create_keys: z.boolean().optional(),
  create_webhooks: z.boolean().optional(),
  // Owners to add besides the document's (people, never agents).
  owner_ids: z.array(z.string().uuid('owner_ids must be team member ids')).max(20).optional(),
}).strict();
export type ImportAgentConfig = z.infer<typeof importAgentConfigSchema>;

export const applyAgentTemplateSchema = z.object({
  template: z.string().trim().min(1).max(100),
  create_key: z.boolean().optional(),
  key_name: z.string().trim().min(1).max(100).optional(),
  read_only: z.boolean().optional(),
}).strict();
export type ApplyAgentTemplate = z.infer<typeof applyAgentTemplateSchema>;
