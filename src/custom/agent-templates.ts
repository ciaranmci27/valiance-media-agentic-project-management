import { defineAgentTemplates } from '@/lib/extensions';

/**
 * This install's own agent templates, listed after core's by
 * list_agent_templates (GET /api/v1/agent-templates) and applied with
 * apply_agent_template. Server only. A template only suggests a setup: the
 * rules it sets and the scopes of a key made from it still pass every check
 * of the agent setup API. A key that repeats a core template's stops the build.
 *
 * Example:
 *   {
 *     key: 'release-notes',
 *     label: 'Release notes writer',
 *     description: 'Turns finished work into release notes each Friday.',
 *     rules: { agent_self_assign: false, agent_close_policy: 'review', agent_create_policy: 'approval' },
 *     scopes: ['tasks.read', 'projects.read', 'notifications.send'],
 *     context: 'Each Friday, read the tasks finished this week and draft release notes...',
 *     webhook_events: ['task.updated'],
 *   },
 */
export default defineAgentTemplates([]);
