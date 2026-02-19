'use client';

import { useState } from 'react';
import { endpoints, groups, METHOD_COLORS } from './docs-data';

export default function ApiDocsPage() {
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);

  const filteredEndpoints = activeGroup
    ? endpoints.filter(e => e.group === activeGroup)
    : endpoints;

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="max-w-5xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-zinc-900">ProjectEM API Reference</h1>
          <p className="text-zinc-500 mt-2">
            REST API for managing projects, tasks, leads, contacts, and more.
            All requests require an <code className="px-1.5 py-0.5 bg-zinc-100 rounded text-sm">x-api-key</code> header.
          </p>
        </div>

        {/* Auth info */}
        <div className="bg-white rounded-xl border border-zinc-200 p-5 mb-6">
          <h2 className="text-lg font-semibold text-zinc-900 mb-3">Authentication</h2>
          <p className="text-sm text-zinc-600 mb-3">
            Include your API key in the <code className="px-1.5 py-0.5 bg-zinc-100 rounded text-xs">x-api-key</code> header of every request.
          </p>
          <div className="bg-zinc-900 rounded-lg p-4">
            <code className="text-sm text-emerald-400">
              curl -H &quot;x-api-key: pk_live_abc123...&quot; \<br />
              &nbsp;&nbsp;https://your-domain.com/api/v1/contacts
            </code>
          </div>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <div className="p-3 bg-zinc-50 rounded-lg">
              <p className="font-medium text-zinc-700">Rate Limit</p>
              <p className="text-zinc-500">120 requests/minute per key</p>
            </div>
            <div className="p-3 bg-zinc-50 rounded-lg">
              <p className="font-medium text-zinc-700">Pagination</p>
              <p className="text-zinc-500">?page=1&limit=25 (max 100)</p>
            </div>
            <div className="p-3 bg-zinc-50 rounded-lg">
              <p className="font-medium text-zinc-700">Read-only Keys</p>
              <p className="text-zinc-500">Block POST/PUT/PATCH/DELETE</p>
            </div>
          </div>
        </div>

        {/* Response format */}
        <div className="bg-white rounded-xl border border-zinc-200 p-5 mb-6">
          <h2 className="text-lg font-semibold text-zinc-900 mb-3">Response Format</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-medium text-emerald-600 uppercase mb-2">Success</p>
              <pre className="bg-zinc-900 rounded-lg p-3 text-xs text-zinc-300 overflow-x-auto">{`{
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
              <p className="text-xs font-medium text-red-600 uppercase mb-2">Error</p>
              <pre className="bg-zinc-900 rounded-lg p-3 text-xs text-zinc-300 overflow-x-auto">{`{
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

        {/* Group filter */}
        <div className="flex flex-wrap gap-2 mb-6">
          <button
            onClick={() => setActiveGroup(null)}
            className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
              !activeGroup
                ? 'bg-zinc-900 text-white border-zinc-900'
                : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
            }`}
          >
            All ({endpoints.length})
          </button>
          {groups.map(group => {
            const count = endpoints.filter(e => e.group === group).length;
            return (
              <button
                key={group}
                onClick={() => setActiveGroup(activeGroup === group ? null : group)}
                className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                  activeGroup === group
                    ? 'bg-zinc-900 text-white border-zinc-900'
                    : 'bg-white text-zinc-600 border-zinc-200 hover:border-zinc-300'
                }`}
              >
                {group} ({count})
              </button>
            );
          })}
        </div>

        {/* Endpoints list */}
        <div className="space-y-2">
          {filteredEndpoints.map((ep) => {
            const key = `${ep.method}-${ep.path}`;
            const isExpanded = expandedPath === key;
            return (
              <div
                key={key}
                className="bg-white rounded-lg border border-zinc-200 overflow-hidden"
              >
                <button
                  onClick={() => setExpandedPath(isExpanded ? null : key)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50 transition-colors"
                >
                  <span className={`px-2 py-0.5 rounded text-xs font-bold ${METHOD_COLORS[ep.method] || 'bg-zinc-100'}`}>
                    {ep.method}
                  </span>
                  <code className="text-sm text-zinc-700 font-mono flex-1">{ep.path}</code>
                  <span className="text-xs text-zinc-400">{ep.description}</span>
                </button>

                {isExpanded && (
                  <div className="px-4 pb-4 border-t border-zinc-100 pt-3 space-y-3">
                    <p className="text-sm text-zinc-600">{ep.description}</p>

                    {ep.params && ep.params.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-zinc-500 uppercase mb-1">Path Parameters</p>
                        <div className="space-y-1">
                          {ep.params.map(p => (
                            <div key={p.name} className="flex items-center gap-2 text-sm">
                              <code className="text-indigo-600 font-mono">{p.name}</code>
                              <span className="text-zinc-400">{p.type}</span>
                              {p.required && <span className="text-red-400 text-xs">required</span>}
                              <span className="text-zinc-500">{p.description}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {ep.queryParams && ep.queryParams.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-zinc-500 uppercase mb-1">Query Parameters</p>
                        <div className="space-y-1">
                          {ep.queryParams.map(p => (
                            <div key={p.name} className="flex items-center gap-2 text-sm">
                              <code className="text-indigo-600 font-mono">{p.name}</code>
                              <span className="text-zinc-400">{p.type}</span>
                              <span className="text-zinc-500">{p.description}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {ep.body && ep.body.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-zinc-500 uppercase mb-1">Request Body</p>
                        <div className="space-y-1">
                          {ep.body.map(p => (
                            <div key={p.name} className="flex items-center gap-2 text-sm">
                              <code className="text-indigo-600 font-mono">{p.name}</code>
                              <span className="text-zinc-400">{p.type}</span>
                              {p.required && <span className="text-red-400 text-xs">required</span>}
                              <span className="text-zinc-500">{p.description}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
