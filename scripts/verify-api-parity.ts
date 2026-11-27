/**
 * API and MCP parity (owner decisions 2026-11-27): everything a person can do
 * in the app, an agent's key can do over REST and MCP, with the same
 * permission, except what handles a credential or secret.
 *
 * Static, over every parity tool (src/lib/mcp/parity) and parity docs entry
 * (src/app/api/docs/parity):
 * - each tool's route exists, is documented, and names the same permission
 *   in withApi as the tool does (so the tool is listed exactly when the call
 *   can pass);
 * - each documented parity route has a tool, or is REST only with a reason;
 * - a people-only tool's route refuses agents (assertPersonCaller), an
 *   Owner's switch refuses everyone else (assertOwnerCaller);
 * - the tools.ts comment says what stays off MCP now.
 *
 * Behaviour, per area (scripts/parity/*.ts), on one real database: at least
 * one allowed and one refused call per area, over REST and over MCP.
 *
 *   npm run -s test:api-parity
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { PARITY_TOOLS } from '../src/lib/mcp/parity';
import { PARITY_ENDPOINTS } from '../src/app/api/docs/parity';
import { endpoints } from '../src/app/api/docs/docs-data';
import { TRASH_PERMISSIONS } from '../src/lib/supabase/trash';
import { API_ENDPOINT_PERMISSIONS } from '../src/lib/access-control';
import { createHarness, type Harness } from './parity/harness';
import { trashArea } from './parity/trash';
import { projectsArea } from './parity/projects';
import { workspaceArea } from './parity/workspace';
import { assistantsArea } from './parity/assistants';
import { notificationsArea } from './parity/notifications';
import { inboxArea } from './parity/inbox';
import { crmArea } from './parity/crm';
import { moneyArea } from './parity/money';
import { workArea } from './parity/work';
import { emailArea } from './parity/email';
import { settingsArea } from './parity/settings';

const APP = join(__dirname, '..');

let passed = 0;
const failures: string[] = [];
const check: Harness['check'] = (label, ok, detail) => {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)?.slice(0, 1200)}`);
};

/** Permission constants a route may name instead of a literal, by identifier. */
const NAMED_PERMISSIONS: Record<string, readonly string[]> = { TRASH_PERMISSIONS, API_ENDPOINT_PERMISSIONS };
// Every other parity route names its permission as a literal in withApi, so this test reads it.

/**
 * Documented parity routes with no tool, and why. Only what handles a
 * secret or credential, a binary upload, or a file download stays off MCP.
 */
const REST_ONLY: Record<string, string> = Object.fromEntries(
  PARITY_ENDPOINTS.filter((doc) => doc.restOnly).map((doc) => [`${doc.method} ${doc.path}`, doc.restOnly as string]),
);

const docPath = (path: string) => path.replace(/\{(\w+)\}/g, ':$1');
const routeFile = (path: string) => join(APP, 'src', 'app', ...path.replace(/^\//, '').split('/').map((part) => part.replace(/^\{(\w+)\}$/, '[$1]')), 'route.ts');

/** The permission a route file's export names in withApi, as sorted keys joined by ',' (or null). */
function routePermission(file: string, method: string): string | null {
  // A path that serves another route's handler (export { GET } from '../emails/route') names that one's permission.
  const reexport = new RegExp(`export \\{[^}]*\\b${method}\\b[^}]*\\} from '(\\.[^']+)'`).exec(readFileSync(file, 'utf8'));
  if (reexport) return routePermission(join(file, '..', `${reexport[1]}.ts`), method);
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let found: string | null = null;
  const visit = (node: ts.Node, exportName: string | null) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) exportName = node.name.text;
    if (exportName === method && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'withApi') {
      const options = node.arguments[1];
      if (options && ts.isObjectLiteralExpression(options)) {
        const prop = options.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === 'permission');
        const value = prop && ts.isPropertyAssignment(prop) ? prop.initializer : prop && ts.isShorthandPropertyAssignment(prop) ? prop.name : undefined;
        if (value && ts.isStringLiteralLike(value)) found = value.text;
        else if (value && ts.isArrayLiteralExpression(value) && value.elements.every(ts.isStringLiteralLike)) found = value.elements.map((e) => (e as ts.StringLiteralLike).text).sort().join(',');
        else if (value && ts.isIdentifier(value) && NAMED_PERMISSIONS[value.text]) found = [...NAMED_PERMISSIONS[value.text]].sort().join(',');
        // [...API_ENDPOINT_PERMISSIONS]: any scope, each route deciding the rest itself.
        else if (value && ts.isArrayLiteralExpression(value) && value.elements.length === 1 && ts.isSpreadElement(value.elements[0])
          && ts.isIdentifier(value.elements[0].expression) && NAMED_PERMISSIONS[value.elements[0].expression.text]) {
          found = [...NAMED_PERMISSIONS[value.elements[0].expression.text]].sort().join(',');
        }
        else if (value) found = `unresolved:${value.getText(sf)}`;
      }
    }
    ts.forEachChild(node, (child) => visit(child, exportName));
  };
  visit(sf, null);
  return found;
}

function staticChecks() {
  const names = PARITY_TOOLS.map((tool) => tool.name);
  check('static: parity tool names are unique', new Set(names).size === names.length, names);
  for (const tool of PARITY_TOOLS) {
    const toolPermission = (Array.isArray(tool.permission) ? [...tool.permission] : [tool.permission]).sort().join(',');
    for (const route of tool.routes) {
      const file = routeFile(route.path);
      check(`static: ${tool.name} calls a route file that exists (${route.path})`, existsSync(file));
      if (!existsSync(file)) continue;
      check(`static: ${tool.name}'s route ${route.method} ${route.path} is documented`,
        endpoints.some((e) => e.method === route.method && e.path === docPath(route.path)));
      const permission = routePermission(file, route.method);
      check(`static: ${tool.name} names the same permission as ${route.method} ${route.path}`, permission === toolPermission, { tool: toolPermission, route: permission });
      // Comments stripped, so a call only named in a comment does not count.
      const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      if (tool.peopleOnly) check(`static: ${tool.name} is people only and its route refuses agents`, /assertPersonCaller\(/.test(source));
    }
  }
  for (const doc of PARITY_ENDPOINTS) {
    if (!doc.path.startsWith('/api/v1/')) continue;
    const label = `${doc.method} ${doc.path}`;
    const hasTool = PARITY_TOOLS.some((tool) => tool.routes.some((route) => route.method === doc.method && docPath(route.path) === doc.path));
    check(`static: ${label} has a tool or a stated REST-only reason`, hasTool || (REST_ONLY[label]?.length ?? 0) > 10);
    check(`static: ${label} names its scopes`, Array.isArray(doc.scopes) && doc.scopes.length > 0);
  }
}

async function main() {
  staticChecks();
  const harness = await createHarness(check);
  try {
    // --area=<name> runs one area's behaviour checks (the static ones always run).
    const only = process.argv.find((arg) => arg.startsWith('--area='))?.slice(7);
    const areas: Array<[string, (h: Harness) => Promise<void>]> = [['trash', trashArea], ['projects', projectsArea], ['workspace', workspaceArea], ['assistants', assistantsArea], ['notifications', notificationsArea], ['inbox', inboxArea], ['crm', crmArea], ['money', moneyArea], ['work', workArea], ['email', emailArea], ['settings', settingsArea]];
    for (const [name, area] of areas.filter(([n]) => !only || n === only)) {
      const before = failures.length;
      try {
        await area(harness);
      } catch (error) {
        check(`${name}: ran without throwing`, false, (error as Error).stack);
      }
      if (failures.length > before) console.error(`api-parity: area ${name} has failures`);
    }
  } finally {
    await harness.close();
  }
  if (failures.length) {
    console.error(`api-parity: ${failures.length} failed, ${passed} passed`);
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exit(1);
  }
  console.log(`api-parity: all ${passed} checks passed (${PARITY_TOOLS.length} tools)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
