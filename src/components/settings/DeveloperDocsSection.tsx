'use client';

import { useSyncExternalStore } from 'react';
import Link from 'next/link';
import { BookOpen, Sparkles } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { CopyButton } from '@/components/agent/ConnectPanel';
import { Button } from '@/components/ui/Button';
import { buildConnectInfo } from '@/lib/agent-connect';

const noSubscribe = () => () => {};

/**
 * Settings > Developers > MCP and API docs: the addresses a tool or AI
 * client connects to with an API key, and the docs. People connecting their
 * own AI tools are pointed to Connect AI in Settings > Account.
 */
export function DeveloperDocsSection() {
  // This tab's address: the server renders nothing for it, the browser fills it in.
  const origin = useSyncExternalStore(noSubscribe, () => window.location.origin, () => '');
  const info = origin ? buildConnectInfo(origin) : null;

  return (
    <section id="developer-docs" className="glass-card scroll-mt-6 rounded-xl p-4 lg:p-6" aria-labelledby="developer-docs-heading">
      <SettingsSectionHeader
        icon={BookOpen}
        title="MCP and API docs"
        headingId="developer-docs-heading"
        description="Point a tool or an AI client at these addresses and give it an API key. The docs list every endpoint and MCP tool."
        action={<Button href="/api/docs" size="sm" variant="secondary">API docs</Button>}
      />

      <ul className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.08]">
        <Address label="MCP server" value={info?.mcp_url ?? ''} what="MCP server URL" />
        <Address label="REST API" value={info?.api_base ?? ''} what="REST API URL" />
      </ul>

      <p className="mt-4 flex items-start gap-2 text-sm text-zinc-400">
        <Sparkles size={15} className="mt-0.5 flex-shrink-0 text-zinc-400" aria-hidden="true" />
        <span>
          Using Claude, ChatGPT or Cursor on your own work? <Link href="/ai?tab=assistant#connect-ai" className="rounded font-medium text-brand-300 underline underline-offset-2 hover:decoration-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">Connect AI</Link> signs them in as you, no key needed.
        </span>
      </p>
    </section>
  );
}

function Address({ label, value, what }: { label: string; value: string; what: string }) {
  return (
    <li className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <span className="w-24 flex-shrink-0 text-xs text-zinc-400">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <code className="min-w-0 flex-1 break-all font-mono text-xs text-zinc-200">{value || 'Loading'}</code>
        <div className="flex-shrink-0">
          <CopyButton text={value} what={what} />
        </div>
      </div>
    </li>
  );
}
