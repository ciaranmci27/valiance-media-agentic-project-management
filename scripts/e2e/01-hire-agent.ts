/**
 * 1. Hire an agent: the Owner hires one from the Hire an agent screen's route
 * (session), with a project and a key; mints a second key from the agent's
 * page; the agent reads its own context over MCP (pm_guide) and over REST,
 * and sees the project it was hired onto.
 */
import { KeyCaller, OWNER_SETUP_SCOPES, check, dataOf, equal, hire, makeProject, personalKey, step, tag, type Ctx } from './harness';
import type { Scenario } from './run';

const scenario: Scenario = {
  name: 'Hire an agent, mint its key, it reads its context over MCP',
  async run(ctx: Ctx) {
    const { owner } = ctx.people;
    const ownerKey = (await personalKey(ctx, owner, OWNER_SETUP_SCOPES, 'owner setup')).caller;
    const project = await makeProject(ctx, ownerKey, 'Hire');
    step(`Owner made project "${project.name}" over the API`);

    const templates = dataOf(await owner.get('/api/workspace/agent-templates'), 200, 'agent templates');
    const list = Array.isArray(templates) ? templates : templates.templates ?? [];
    check(list.some((t: { key: string }) => t.key === 'builder'), 'The builder template is offered on Hire an agent', templates);
    step(`Hire an agent offers ${list.length} templates, builder among them`);

    const name = `E2E Hire ${tag}`;
    const hired = await hire(ctx, {
      name, template_key: 'builder', project_ids: [project.id],
      scopes: ['tasks.read', 'projects.read', 'agent_activity.write'],
    });
    equal(hired.agent.name, name, 'hired agent name');
    check(hired.result.assignments?.some((a: { project_id: string }) => a.project_id === project.id), 'The hire assigned the agent to the project', hired.result.assignments);
    check(hired.result.agent.owners?.some((o: { id: string }) => o.id === owner.memberId), 'The Owner who hired it owns it', hired.result.agent.owners);
    check(hired.result.connect, 'The hire answers how its host connects', hired.result);
    step(`Owner hired "${name}" (builder) onto the project with a key, and owns it`);

    const minted = dataOf(await owner.post(`/api/workspace/agents/${hired.agent.id}/keys`, { name: `E2E second key ${tag}`, scopes: ['tasks.read'] }), 201, 'mint a second key');
    check(typeof minted.key?.secret === 'string' && minted.key.secret.length > 20, 'The minted key answer carries its secret once', { ...minted.key, secret: '<hidden>' });
    const second = new KeyCaller(ctx.baseUrl, minted.key.secret, 'second key');
    step('Owner minted a second key from the agent page; its secret is shown once');

    const rest = dataOf(await hired.key.get('/api/v1/agents/me/context?format=json'), 200, 'REST context');
    check(JSON.stringify(rest).includes(name) && JSON.stringify(rest).includes(project.name), 'REST context names the agent and its project', rest);
    const viaSecond = await second.get('/api/v1/agents/me/context?format=json');
    equal(viaSecond.status, 200, 'The second key reads the context too');
    step('Agent read its context over REST (/api/v1/agents/me/context) with either key: its name and project');

    // MCP: initialize, list tools, read its own context with pm_guide.
    const init = await hired.key.mcpConnect();
    check(init.serverInfo?.name, 'MCP initialize names the server', init);
    const tools = await hired.key.mcp('tools/list');
    const toolNames: string[] = (tools.body?.result?.tools ?? []).map((tool: { name: string }) => tool.name);
    check(toolNames.includes('pm_guide') && toolNames.includes('search_tasks'), 'MCP lists pm_guide and search_tasks for the agent', toolNames);
    step(`Agent connected over MCP (${toolNames.length} tools)`);

    const guide = await hired.key.tool('pm_guide');
    check(guide.ok === true, 'pm_guide answers ok', guide);
    equal(guide.you?.name, name, 'pm_guide names the agent');
    equal(guide.you?.role, 'agent', 'pm_guide role');
    check(JSON.stringify(guide.context ?? '').includes(project.name) || JSON.stringify(guide).includes(project.id), 'pm_guide context names the project it was hired onto', guide.context);
    step('Agent read its context with pm_guide: its name, role and project');

    const mcpTasks = await hired.key.tool('search_tasks', { project_id: project.id });
    check(mcpTasks && mcpTasks.ok !== false, 'search_tasks on its project answers', mcpTasks);
    step('search_tasks on its project answers over MCP');
  },
};

export default scenario;
