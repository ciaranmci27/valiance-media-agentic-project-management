/**
 * Every withApi route names its permission. withApi used to infer one from
 * URL substrings when a route left it out, so a new route with `/tasks` or
 * `/context` in its path could silently get the wrong gate. The option is now
 * required by type; this test reads every route file's source so a cast or a
 * spread cannot slip one through either.
 *
 * withApi has no opt-out: every call needs an API key. Signed-in or public
 * routes are not withApi routes (custom ones say auth 'session' or 'public'
 * in src/custom/api.ts, and 'api-key' there requires a permission by type).
 *
 * It also pins a sample of routes to the gate they had when inference was
 * removed, so the switch to explicit permissions changed none of them.
 *
 *   npm run -s test:route-permissions
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

const APP = join(__dirname, '..');
const API_DIR = join(APP, 'src', 'app', 'api');

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

/**
 * The gate each route had through inference before it was removed (and, for
 * inbox, agents, questions, chat and POST /notifications, the explicit value
 * they already carried). An array is written as its sorted keys joined by ','.
 */
const EXPECTED: Record<string, string> = {
  // tasks
  'GET /api/v1/tasks': 'tasks.read',
  'POST /api/v1/tasks': 'tasks.create',
  'GET /api/v1/tasks/next': 'tasks.read',
  'GET /api/v1/tasks/[id]': 'tasks.read',
  'PATCH /api/v1/tasks/[id]': 'tasks.manage_assigned',
  'DELETE /api/v1/tasks/[id]': 'tasks.manage_all',
  'POST /api/v1/tasks/[id]/comments': 'tasks.read',
  'DELETE /api/v1/tasks/[id]/comments/[commentId]': 'tasks.read',
  'POST /api/v1/tasks/[id]/reviews': 'tasks.manage_all',
  // A host key (agents.host, 20261127002000) also claims, for an agent it serves.
  'POST /api/v1/tasks/[id]/claim': 'agents.host,tasks.manage_assigned',
  'PUT /api/v1/tasks/[id]/subtasks/reorder': 'tasks.manage_assigned',
  // context
  'GET /api/v1/projects/[id]/context': 'project_context.read',
  'POST /api/v1/projects/[id]/context': 'project_context.manage',
  'GET /api/v1/projects/[id]/context/search': 'project_context.read',
  'DELETE /api/v1/projects/[id]/context/[entryId]': 'project_context.manage',
  // projects
  'GET /api/v1/projects': 'projects.read',
  'POST /api/v1/projects': 'projects.manage',
  'PATCH /api/v1/projects/[id]': 'projects.manage',
  'POST /api/v1/projects/[id]/archive': 'projects.manage',
  'GET /api/v1/projects/[id]/credentials': 'credentials.reveal_shared',
  'GET /api/v1/projects/[id]/credentials/[credentialId]/reveal': 'credentials.reveal_shared',
  'PATCH /api/v1/projects/[id]/credentials/[credentialId]': 'credentials.manage',
  'POST /api/v1/projects/[id]/contacts': 'contacts.manage',
  'GET /api/v1/projects/[id]/goals': 'goals.read',
  // initiatives (20261126000100_initiatives.sql): no new permission. Reading
  // follows the project; writing needs tasks.create there; the log needs the
  // right to comment on its tasks.
  'GET /api/v1/projects/[id]/initiatives': 'projects.read',
  'POST /api/v1/projects/[id]/initiatives': 'tasks.create',
  'GET /api/v1/projects/[id]/initiatives/[initiativeId]': 'projects.read',
  'PATCH /api/v1/projects/[id]/initiatives/[initiativeId]': 'tasks.create',
  'DELETE /api/v1/projects/[id]/initiatives/[initiativeId]': 'projects.manage,tasks.create',
  'GET /api/v1/projects/[id]/initiatives/[initiativeId]/entries': 'tasks.read',
  'POST /api/v1/projects/[id]/initiatives/[initiativeId]/entries': 'tasks.read',
  'PATCH /api/v1/projects/[id]/initiatives/[initiativeId]/entries/[entryId]': 'tasks.read',
  'DELETE /api/v1/projects/[id]/initiatives/[initiativeId]/entries/[entryId]': 'tasks.read',
  'PUT /api/v1/projects/[id]/portal': 'portal.manage',
  // other inferred families
  'GET /api/v1/leads/[id]/contacts': 'leads.read',
  'POST /api/v1/entity-files': 'files.upload',
  'PATCH /api/v1/entity-files/[fileId]': 'files.manage',
  'GET /api/v1/notifications': 'notifications.manage_own',
  'POST /api/v1/notifications/mark-all-read': 'notifications.manage_own',
  'GET /api/v1/audit-log/[entityType]/[entityId]': 'audit.read',
  'GET /api/v1/activities': 'audit.read',
  'POST /api/v1/team-members': 'team.manage',
  // already explicit
  'POST /api/v1/notifications': 'notifications.send',
  'GET /api/v1/inbox/queue': 'inbound_email.read',
  'POST /api/v1/inbox/messages/[id]/plan': 'inbound_email.triage',
  'GET /api/v1/agents': 'team.read',
  'POST /api/v1/agents': 'team.manage',
  // questions.ask (20261125001400_external_agents.sql): asking with no task or project, without tasks.read.
  'POST /api/v1/questions': 'questions.ask,tasks.read',
  // approvals.decide: a key that only decides approvals (the named person's own key).
  'POST /api/v1/questions/[id]/answer': 'approvals.decide,questions.ask,tasks.read',
  'GET /api/v1/chat/messages': 'notifications.manage_own',
  'POST /api/v1/chat/messages/[id]/reply': 'notifications.manage_own',
};

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(path, out);
    else if (entry.name === 'route.ts') out.push(path);
  }
  return out;
}

/** A permission's source as a comparable string: a literal, sorted literals, or the expression's text. */
function permissionValue(expr: ts.Expression, sf: ts.SourceFile): string {
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (ts.isArrayLiteralExpression(expr) && expr.elements.every(ts.isStringLiteralLike)) {
    return expr.elements.map((e) => (e as ts.StringLiteralLike).text).sort().join(',');
  }
  return expr.getText(sf);
}

function main() {
  const found = new Map<string, string>();
  let calls = 0;
  for (const file of routeFiles(API_DIR)) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const route = '/' + relative(join(APP, 'src', 'app'), file).split(sep).slice(0, -1).join('/');
    const visit = (node: ts.Node, exportName: string | null) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) exportName = node.name.text;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'withApi') {
        calls++;
        const label = `${exportName ?? 'withApi'} ${route}`;
        const options = node.arguments[1];
        const prop = options && ts.isObjectLiteralExpression(options)
          ? options.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === 'permission')
          : undefined;
        const value = prop && ts.isPropertyAssignment(prop) ? prop.initializer
          : prop && ts.isShorthandPropertyAssignment(prop) ? prop.name : undefined;
        const empty = !!value && ts.isArrayLiteralExpression(value) && value.elements.length === 0;
        check(`${label} names a permission in its withApi options`, !!value && !empty);
        if (value) found.set(label, permissionValue(value, sf));
      }
      ts.forEachChild(node, (child) => visit(child, exportName));
    };
    visit(sf, null);
  }
  check('found withApi routes to check', calls > 250, calls);

  for (const [label, expected] of Object.entries(EXPECTED)) {
    check(`${label} keeps ${expected}`, found.get(label) === expected, found.get(label) ?? 'route not found');
  }
  check('the sample covers at least 15 routes', Object.keys(EXPECTED).length >= 15);

  const middleware = readFileSync(join(APP, 'src', 'lib', 'api', 'middleware.ts'), 'utf8');
  check('withApi infers no permission from the path', !/inferredPermission/.test(middleware));
  check('withApi requires its permission option', /\n\s+permission: PermissionKey \| PermissionKey\[\];/.test(middleware));

  if (failures.length) {
    console.error(`route-permissions: ${failures.length} failed, ${passed} passed`);
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
  console.log(`route-permissions: all ${passed} checks passed (${calls} withApi routes)`);
}

main();
