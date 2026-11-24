import { defineAgentProfiles } from '@/lib/extensions';

/**
 * This install's own agent profiles, listed after core's (generic,
 * coordinator, builder, auditor, reviewer) wherever an agent's profile is
 * picked: the Team page, create_agent and the agents API. A profile decides
 * which MCP tools an agent member sees, by name (pm_guide always); leave
 * tools out for every tool its keys allow. It only narrows what the agent's
 * keys could do. Data only: it runs in the browser and the server. A value
 * that repeats a core one, or a tool that does not exist, stops the build.
 *
 * Example:
 *   {
 *     value: 'support-desk',
 *     label: 'Support desk',
 *     description: 'Answers questions on tasks and logs what it did.',
 *     tools: ['search_tasks', 'get_task', 'add_task_comment', 'ask_human', 'get_question', 'log_activity'],
 *   },
 */
export default defineAgentProfiles([]);
