/**
 * 7. Guests, end to end: a client guest on one project sees that project,
 * its tasks and the people on it (no emails), and nothing else: no other
 * project or its tasks, no agents, groups or questions, and cannot make
 * keys, tasks, notices or template runs. Reads go through the same doors the
 * app's screens use (session routes and the browser's database reads).
 */
import { OWNER_SETUP_SCOPES, check, dataOf, equal, makeProject, personalKey, step, tag, type Ctx, type Json } from './harness';
import type { Scenario } from './run';

const scenario: Scenario = {
  name: 'Guests: what a guest can and cannot see',
  async run(ctx: Ctx) {
    const { owner, requester, guest, outsider } = ctx.people;
    const ownerKey = (await personalKey(ctx, owner, [...OWNER_SETUP_SCOPES, 'questions.ask'], 'owner setup')).caller;
    const client = await makeProject(ctx, ownerKey, 'Guest client', [requester.memberId, guest.memberId]);
    const hidden = await makeProject(ctx, ownerKey, 'Guest hidden', [requester.memberId, outsider.memberId]);
    const clientTask = dataOf(await ownerKey.post('/api/v1/tasks', { project_id: client.id, title: `Client review ${tag}`, assignee_ids: [requester.memberId] }), 201, 'client task');
    const hiddenTask = dataOf(await ownerKey.post('/api/v1/tasks', { project_id: hidden.id, title: `Internal margin notes ${tag}` }), 201, 'hidden task');
    step(`Owner made a client project (with ${guest.name}, a guest) and an internal one without them`);

    // ── Projects and tasks ──
    const projects = dataOf(await guest.get('/api/workspace/projects'), 200, 'guest projects');
    const projectIds = (Array.isArray(projects) ? projects : projects.projects ?? []).map((p: Json) => p.id);
    check(projectIds.includes(client.id) && !projectIds.includes(hidden.id), 'The guest\'s project list has the client project only', projects);
    const tasks = await guest.rest(`tasks?select=id,project_id&project_id=in.(${client.id},${hidden.id})&deleted_at=is.null`);
    equal(tasks.status, 200, 'guest task read');
    const seen = (tasks.body as Json[]).map((t) => t.id);
    check(seen.includes(clientTask.id) && !seen.includes(hiddenTask.id), 'The guest reads the client task and never the internal one', tasks.body);
    const byId = await guest.rest(`tasks?select=id,title&id=eq.${hiddenTask.id}`);
    check(byId.status === 200 && byId.body.length === 0, 'Asking for the internal task by id returns nothing', byId.body);
    const hiddenProject = await guest.rest(`projects?select=id,name&id=eq.${hidden.id}`);
    check(hiddenProject.status === 200 && hiddenProject.body.length === 0, 'The internal project row is invisible to the guest', hiddenProject.body);
    step('Projects and tasks: the guest sees the client project and its task, never the internal project, even by id');

    // ── People ──
    const directory = dataOf(await guest.get('/api/workspace/team-directory'), 200, 'guest team directory');
    const people: Json[] = Array.isArray(directory) ? directory : directory.members ?? directory.people ?? [];
    const ids = people.map((p) => p.id);
    check(ids.includes(guest.memberId) && ids.includes(requester.memberId), 'The guest sees themselves and the people on their project', people);
    check(!ids.includes(outsider.memberId), 'The guest does not see people who share no project with them', people);
    check(people.every((p) => p.id === guest.memberId || p.email === undefined), 'The guest never sees anyone else\'s email', people);
    step('People: the guest sees who is on their project, no one else, and no one else\'s email');

    // ── Agents, groups, questions ──
    for (const path of ['/api/workspace/agents', '/api/workspace/agents/tree', '/api/workspace/agent-templates']) {
      const refused = await guest.get(path);
      equal(refused.status, 403, `guest ${path}`);
    }
    const groups = dataOf(await guest.get('/api/workspace/groups'), 200, 'guest groups');
    check((Array.isArray(groups) ? groups : groups.groups ?? []).length === 0, 'The guest sees no groups', groups);
    dataOf(await ownerKey.post('/api/v1/questions', { question: `Is the margin on this client acceptable? ${tag}`, task_id: clientTask.id, asked_to: requester.memberId }), 201, 'owner asks a question on the client task');
    const guestQuestions = await guest.get('/api/workspace/questions');
    const qList = guestQuestions.status === 200 ? (guestQuestions.body.data as Json[]) : [];
    check(guestQuestions.status === 403 || qList.every((q) => q.task_id !== clientTask.id), 'The guest never sees internal questions, even on their project\'s task', guestQuestions.body);
    step(`Agents (403), groups (none) and questions (${guestQuestions.status === 403 ? '403' : 'none'}) stay out of the guest's view`);

    // ── What a guest cannot do ──
    const key = await guest.post('/api/workspace/api-keys', { name: `E2E guest key ${tag}`, scopes: ['tasks.read'] });
    equal(key.status, 403, 'a guest makes an API key');
    const newTask = await guest.restInsert('tasks', { project_id: client.id, title: `Guest task ${tag}`, status: 'todo', priority: 'medium' });
    check(newTask.status === 401 || newTask.status === 403, 'A guest cannot add a task, even on their own project', newTask.body);
    const notice = await guest.post('/api/notifications', { recipient_ids: [requester.memberId], title: 'Hello from a guest' });
    equal(notice.status, 403, 'a guest sends a notice');
    const template = dataOf(await owner.post('/api/workspace/task-templates', { name: `E2E guest template ${tag}`, project_id: client.id, items: [{ title: 'Step one', due_in_days: 0 }] }), 201, 'owner makes a template');
    ctx.cleanup.add(`trash template ${template.id}`, () => ctx.db.query(`UPDATE pm.task_templates SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [template.id]));
    const run = await guest.post(`/api/workspace/task-templates/${template.id}/run`, {});
    equal(run.status, 403, 'a guest runs a template');
    const left = (await ctx.db.query(`SELECT count(*)::int AS n FROM pm.tasks WHERE project_id = $1 AND deleted_at IS NULL`, [client.id])).rows[0].n;
    equal(left, 1, 'tasks on the client project after the guest\'s attempts');
    step('The guest cannot make a key, a task, a notice or a template run (403 each); nothing was written');
  },
};

export default scenario;
