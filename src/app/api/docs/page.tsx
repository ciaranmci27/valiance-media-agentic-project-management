import {
  BookOpen,
  Lock,
  FileJson,
  Users,
  UserCog,
  Activity,
  FolderKanban,
  UserPlus,
  Globe,
  CheckSquare,
  ListChecks,
  MessageSquare,
  Target,
  MessageCircle,
  FileText,
  ListFilter,
  Hash,
} from 'lucide-react';
import { headers } from 'next/headers';
import { endpoints, groups, METHOD_COLORS } from './docs-data';
import { DocsTocNav, type TocSection } from './DocsTocNav';

/* ── Helpers ───────────────────────────────────────────────── */

function slugify(name: string) {
  return name.toLowerCase().replace(/\s+/g, '-');
}

/* ── Static group icon + color mapping (full Tailwind classes for purge safety) ── */

const GROUP_META: Record<string, { icon: typeof Users; bg: string; text: string }> = {
  Contacts:             { icon: Users,         bg: 'bg-brand-50',  text: 'text-brand-600'  },
  'Team Members':       { icon: UserCog,       bg: 'bg-violet-50',  text: 'text-violet-600'  },
  Activities:           { icon: Activity,       bg: 'bg-sky-50',     text: 'text-sky-600'     },
  Projects:             { icon: FolderKanban,   bg: 'bg-blue-50',    text: 'text-blue-600'    },
  'Project Contacts':   { icon: UserPlus,       bg: 'bg-blue-50',    text: 'text-blue-600'    },
  Portal:               { icon: Globe,          bg: 'bg-teal-50',    text: 'text-teal-600'    },
  Tasks:                { icon: CheckSquare,    bg: 'bg-emerald-50', text: 'text-emerald-600' },
  Subtasks:             { icon: ListChecks,     bg: 'bg-emerald-50', text: 'text-emerald-600' },
  Comments:             { icon: MessageSquare,  bg: 'bg-cyan-50',    text: 'text-cyan-600'    },
  Leads:                { icon: Target,         bg: 'bg-amber-50',   text: 'text-amber-600'   },
  'Lead Contacts':      { icon: UserPlus,       bg: 'bg-amber-50',   text: 'text-amber-600'   },
  'Lead Interactions':  { icon: MessageCircle,  bg: 'bg-orange-50',  text: 'text-orange-600'  },
  'Lead Proposals':     { icon: FileText,       bg: 'bg-orange-50',  text: 'text-orange-600'  },
  'Lead Fields':        { icon: ListFilter,     bg: 'bg-amber-50',   text: 'text-amber-600'   },
};

/* ── Semantic parameter table ────────────────────────────── */

function ParamTable({
  title,
  params,
  showRequired = false,
}: {
  title: string;
  params: { name: string; type: string; required?: boolean; description: string }[];
  showRequired?: boolean;
}) {
  if (!params || params.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">{title}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border border-zinc-100 rounded-lg overflow-hidden">
          <thead>
            <tr className="bg-zinc-50 border-b border-zinc-200">
              <th className="text-left py-2 px-3 text-xs font-medium text-zinc-500">Name</th>
              <th className="text-left py-2 px-3 text-xs font-medium text-zinc-500">Type</th>
              {showRequired && (
                <th className="text-left py-2 px-3 text-xs font-medium text-zinc-500">Required</th>
              )}
              <th className="text-left py-2 px-3 text-xs font-medium text-zinc-500">Description</th>
            </tr>
          </thead>
          <tbody>
            {params.map((p) => (
              <tr key={p.name} className="border-b border-zinc-50 last:border-0">
                <td className="py-2 px-3">
                  <code className="text-brand-600 font-mono text-xs">{p.name}</code>
                </td>
                <td className="py-2 px-3">
                  <code className="text-zinc-400 font-mono text-xs">{p.type}</code>
                </td>
                {showRequired && (
                  <td className="py-2 px-3">
                    {p.required ? (
                      <span className="text-red-500 text-xs font-medium">Yes</span>
                    ) : (
                      <span className="text-zinc-300 text-xs">No</span>
                    )}
                  </td>
                )}
                <td className="py-2 px-3 text-zinc-600 text-xs">{p.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Page ─────────────────────────────────────────────────── */

export default async function ApiDocsPage() {
  const host = (await headers()).get('host') ?? 'localhost:3000';
  const grouped = groups.map((g) => ({
    name: g,
    slug: slugify(g),
    endpoints: endpoints.filter((e) => e.group === g),
    meta: GROUP_META[g] ?? { icon: Hash, bg: 'bg-zinc-50', text: 'text-zinc-600' },
  }));

  const tocSections: TocSection[] = [
    {
      id: 'authentication',
      label: 'Authentication',
      mobileLabel: 'Auth',
      mobilePill: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
    },
    {
      id: 'response-format',
      label: 'Response Format',
      mobileLabel: 'Response',
      mobilePill: 'bg-blue-50 text-blue-700 hover:bg-blue-100',
    },
    ...grouped.map((g) => ({
      id: g.slug,
      label: g.name,
      count: g.endpoints.length,
    })),
  ];

  return (
    <div>
      {/* ── Page header ── */}
      <header className="bg-white border-b border-zinc-200">
        <div className="max-w-7xl mx-auto px-4 lg:px-6 py-6">
          <div className="flex items-center gap-3.5">
            <div className="p-2.5 bg-brand-50 rounded-xl">
              <BookOpen className="text-brand-600" size={24} />
            </div>
            <div>
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-2xl font-bold text-zinc-900">API Reference</h1>
                <span className="px-2 py-0.5 text-xs font-semibold bg-brand-50 text-brand-600 rounded-full">
                  v1
                </span>
                <span className="px-2 py-0.5 text-xs font-medium bg-zinc-100 text-zinc-500 rounded-full">
                  {endpoints.length} endpoints
                </span>
              </div>
              <p className="text-sm text-zinc-500 mt-1">
                REST API for managing projects, tasks, leads, contacts, and more.
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* ── TOC navigation (client component) + grid layout ── */}
      <DocsTocNav sections={tocSections} infoCutoff={2}>
        <main className="space-y-6 min-w-0">
          {/* ── Authentication ── */}
          <section id="authentication" className="scroll-mt-16 lg:scroll-mt-6">
            <div className="bg-white rounded-xl border border-zinc-200 p-5 lg:p-6">
              <div className="flex items-center gap-3 mb-5">
                <div className="p-2 bg-emerald-50 rounded-lg">
                  <Lock className="text-emerald-600" size={20} />
                </div>
                <div>
                  <h2 className="font-semibold text-zinc-900">Authentication</h2>
                  <p className="text-sm text-zinc-500">Include your API key in every request</p>
                </div>
              </div>

              <p className="text-sm text-zinc-600 mb-4">
                Include your API key in the{' '}
                <code className="px-1.5 py-0.5 bg-zinc-100 rounded text-xs font-mono">x-api-key</code>{' '}
                header of every request. Keys can be generated in{' '}
                <a
                  href="/settings"
                  className="text-brand-600 hover:text-brand-700 underline underline-offset-2"
                >
                  Settings
                </a>
                .
              </p>

              <div className="bg-zinc-900 rounded-lg p-4 mb-4">
                <pre className="text-sm text-emerald-400 font-mono overflow-x-auto whitespace-pre">{`curl -H "x-api-key: pk_live_abc123..." \\
  https://${host}/api/v1/contacts`}</pre>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-3 bg-zinc-50 rounded-lg border border-zinc-100">
                  <p className="text-sm font-medium text-zinc-700">Rate Limit</p>
                  <p className="text-xs text-zinc-500 mt-0.5">120 requests/minute per key</p>
                </div>
                <div className="p-3 bg-zinc-50 rounded-lg border border-zinc-100">
                  <p className="text-sm font-medium text-zinc-700">Pagination</p>
                  <p className="text-xs text-zinc-500 mt-0.5">?page=1&limit=25 (max 100)</p>
                </div>
                <div className="p-3 bg-zinc-50 rounded-lg border border-zinc-100">
                  <p className="text-sm font-medium text-zinc-700">Read-only Keys</p>
                  <p className="text-xs text-zinc-500 mt-0.5">Block POST/PUT/PATCH/DELETE</p>
                </div>
              </div>
            </div>
          </section>

          {/* ── Response Format ── */}
          <section id="response-format" className="scroll-mt-16 lg:scroll-mt-6">
            <div className="bg-white rounded-xl border border-zinc-200 p-5 lg:p-6">
              <div className="flex items-center gap-3 mb-5">
                <div className="p-2 bg-blue-50 rounded-lg">
                  <FileJson className="text-blue-600" size={20} />
                </div>
                <div>
                  <h2 className="font-semibold text-zinc-900">Response Format</h2>
                  <p className="text-sm text-zinc-500">
                    All responses follow a consistent JSON structure
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <p className="text-xs font-medium text-emerald-600 uppercase tracking-wide mb-2">
                    Success
                  </p>
                  <pre className="bg-zinc-900 rounded-lg p-4 text-xs text-zinc-300 font-mono overflow-x-auto">{`{
  "success": true,
  "data": { ... },
  "meta": {
    "page": 1,
    "limit": 25,
    "total": 150,
    "total_pages": 6
  }
}`}</pre>
                </div>
                <div>
                  <p className="text-xs font-medium text-red-600 uppercase tracking-wide mb-2">
                    Error
                  </p>
                  <pre className="bg-zinc-900 rounded-lg p-4 text-xs text-zinc-300 font-mono overflow-x-auto">{`{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "...",
    "details": [...]
  }
}`}</pre>
                </div>
              </div>
            </div>
          </section>

          {/* ── Endpoint Group Sections ── */}
          {grouped.map((group) => {
            const Icon = group.meta.icon;
            return (
              <section key={group.slug} id={group.slug} className="scroll-mt-16 lg:scroll-mt-6">
                <div className="bg-white rounded-xl border border-zinc-200 p-5 lg:p-6">
                  {/* Group header */}
                  <div className="flex items-center gap-3 mb-5">
                    <div className={`p-2 ${group.meta.bg} rounded-lg`}>
                      <Icon className={group.meta.text} size={20} />
                    </div>
                    <div>
                      <h2 className="font-semibold text-zinc-900">{group.name}</h2>
                      <p className="text-sm text-zinc-500">
                        {group.endpoints.length} endpoint
                        {group.endpoints.length !== 1 ? 's' : ''}
                      </p>
                    </div>
                  </div>

                  {/* Endpoints within this group */}
                  <div className="divide-y divide-zinc-100">
                    {group.endpoints.map((ep) => (
                      <div
                        key={`${ep.method}-${ep.path}`}
                        className="py-4 first:pt-0 last:pb-0"
                      >
                        {/* Endpoint header row */}
                        <div className="flex items-start gap-3">
                          <span
                            className={`px-2 py-0.5 rounded text-xs font-bold flex-shrink-0 mt-0.5 ${
                              METHOD_COLORS[ep.method] || 'bg-zinc-100'
                            }`}
                          >
                            {ep.method}
                          </span>
                          <div className="min-w-0 flex-1">
                            <code className="text-sm text-zinc-800 font-mono break-all">
                              {ep.path}
                            </code>
                            <p className="text-sm text-zinc-500 mt-0.5">{ep.description}</p>
                          </div>
                        </div>

                        {/* Always-visible parameter tables */}
                        {ep.params && ep.params.length > 0 && (
                          <ParamTable title="Path Parameters" params={ep.params} showRequired />
                        )}
                        {ep.queryParams && ep.queryParams.length > 0 && (
                          <ParamTable title="Query Parameters" params={ep.queryParams} />
                        )}
                        {ep.body && ep.body.length > 0 && (
                          <ParamTable title="Request Body" params={ep.body} showRequired />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            );
          })}
        </main>
      </DocsTocNav>
    </div>
  );
}
