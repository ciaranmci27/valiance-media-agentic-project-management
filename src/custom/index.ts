import { defineExtensions } from '@/lib/extensions';

/**
 * This install's additions to the app's screens. Everything here renders in
 * the browser, inside the signed-in shell: fetch data through your own
 * /api/x routes (src/custom/api.ts) or the app's hooks, never with server
 * secrets. Wrap a heavy component in next/dynamic so it loads only when shown.
 *
 * Every item can take `module` (shown only while that module is on),
 * `permission` and `roles`. Duplicate slugs or keys stop the build with the
 * name to fix.
 *
 * Examples (icons from lucide-react, components from ./pages, ./widgets...):
 *
 *   navItems: [
 *     { href: '/x/reports', label: 'Reports', icon: BarChart3, after: '/projects' },
 *   ],
 *   pages: [
 *     // /x/reports, and /x/reports/<anything> with rest = ['<anything>']
 *     { slug: 'reports', title: 'Reports', component: ReportsPage, permission: 'projects.read_all' },
 *   ],
 *   projectTabs: [
 *     // ({ project }) => ..., after the core tabs, at ?tab=x-scorecard
 *     { key: 'scorecard', label: 'Scorecard', component: ScorecardTab, module: 'billing' },
 *   ],
 *   dashboardWidgets: [
 *     { key: 'targets', title: 'This month', icon: Target, placement: 'top', component: TargetsCard },
 *   ],
 *   settingsSections: [
 *     // /settings/custom/integrations, Owners only unless roles or permission say otherwise
 *     { key: 'integrations', label: 'Integrations', icon: Plug, component: IntegrationsSettings },
 *   ],
 */
export default defineExtensions({});
