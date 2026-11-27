import 'server-only';
import type { HttpMethod } from '../core';
import * as agentsPauseAll from '@/app/api/v1/agents/pause-all/route';
import * as workspaceModules from '@/app/api/v1/workspace/modules/route';
import * as workspaceBrand from '@/app/api/v1/workspace/brand/route';
import * as workspaceRegion from '@/app/api/v1/workspace/region/route';
import * as workspaceDataRetention from '@/app/api/v1/workspace/data-retention/route';
import * as workspaceAuditSettings from '@/app/api/v1/workspace/audit-settings/route';
import * as workspaceRetentionPreview from '@/app/api/v1/workspace/retention-preview/route';
import * as workspaceKeySettings from '@/app/api/v1/workspace/key-settings/route';
import * as workspacePersonalKeySettings from '@/app/api/v1/workspace/key-settings/personal/route';
import * as workspaceWebhookRetries from '@/app/api/v1/workspace/webhook-retries/route';
import * as auditLog from '@/app/api/v1/audit-log/route';
import * as auditLogEntity from '@/app/api/v1/audit-log/[entityType]/[entityId]/route';

/** Pause every agent and workspace settings: the v1 route module behind each tool path (routes.ts merges these). */
export const WORKSPACE_ROUTE_MODULES: Record<string, Partial<Record<HttpMethod, unknown>>> = {
  '/api/v1/agents/pause-all': agentsPauseAll,
  '/api/v1/workspace/modules': workspaceModules,
  '/api/v1/workspace/brand': workspaceBrand,
  '/api/v1/workspace/region': workspaceRegion,
  '/api/v1/workspace/data-retention': workspaceDataRetention,
  '/api/v1/workspace/audit-settings': workspaceAuditSettings,
  '/api/v1/workspace/retention-preview': workspaceRetentionPreview,
  '/api/v1/workspace/key-settings': workspaceKeySettings,
  '/api/v1/workspace/key-settings/personal': workspacePersonalKeySettings,
  '/api/v1/workspace/webhook-retries': workspaceWebhookRetries,
  // Existing routes no tool called before.
  '/api/v1/audit-log': auditLog,
  '/api/v1/audit-log/{entityType}/{entityId}': auditLogEntity,
};
