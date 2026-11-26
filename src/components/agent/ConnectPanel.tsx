'use client';

import { useState, type ReactNode } from 'react';
import { Check, Copy, Download, KeyRound } from 'lucide-react';
import { buildConnectInfo, connectSnippetsWithKey, CONNECT_KEY_ENV } from '@/lib/agent-connect';
import type { ConnectInfo, NewKey } from '@/lib/agent-workspace';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';

/**
 * How an agent's host connects: the key secret once (when one was just
 * made), then copy-ready snippets for Claude Code, Codex and any MCP client,
 * and the agent's AGENTS.md to download. The snippets read the key from
 * PM_API_KEY, except while a key just made is on screen: then they carry it
 * in their headers (never a URL) so they paste and work.
 */

const TABS = [
  { key: 'claude_code', label: 'Claude Code', hint: 'Run this in the agent’s terminal.', yourHint: 'Run this in your terminal, then start Claude Code there.' },
  { key: 'codex', label: 'Codex', hint: 'Add this to ~/.codex/config.toml.', yourHint: 'Add this to ~/.codex/config.toml.' },
  { key: 'generic_mcp_json', label: 'Any MCP client', hint: 'Add this server to the client’s MCP config.', yourHint: 'Add this server to your tool’s MCP config.' },
  { key: 'env', label: 'Env file', hint: 'For a host that reads its settings from the environment.', yourHint: 'For a tool that reads its settings from the environment.' },
] as const;

export function copyText(text: string, what: string) {
  void navigator.clipboard?.writeText(text).then(
    () => toast('success', `${what} copied`),
    () => toast('error', 'Could not copy. Select the text and copy it instead.'),
  );
}

export function CopyButton({ text, what, label = 'Copy' }: { text: string; what: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={done ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      onClick={() => { copyText(text, what); setDone(true); window.setTimeout(() => setDone(false), 1600); }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

/**
 * The secret, once. Leaving the step forgets it; only its prefix is kept
 * anywhere. An agent's key by default; a person's key or a webhook's signing
 * secret passes its own heading and hint.
 */
export function SecretOnce({ secret, heading = 'Copy the key now. It is not shown again.', hint, what = 'Key', copyLabel = 'Copy key' }: {
  secret: Pick<NewKey, 'secret'>;
  heading?: string;
  hint?: ReactNode;
  /** What the toast calls it ("Key copied"). */
  what?: string;
  copyLabel?: string;
}) {
  return (
    <div className="rounded-2xl bg-amber-500/[0.08] p-4 ring-1 ring-inset ring-amber-400/20 sm:p-5">
      <p className="flex items-center gap-2 text-sm font-semibold text-amber-300">
        <KeyRound size={15} aria-hidden="true" />
        {heading}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-amber-300/80">
        {hint ?? <>Put it in the agent&apos;s environment as <span className="font-mono">{CONNECT_KEY_ENV}</span>. Lost it? Make a new key and revoke this one. To change what it can do, use Edit on the key; no new key needed.</>}
      </p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 select-all break-all rounded-lg bg-black/30 px-3 py-2.5 font-mono text-xs text-white">{secret.secret}</code>
        <CopyButton text={secret.secret} what={what} label={copyLabel} />
      </div>
    </div>
  );
}

export function ConnectSnippets({ connect, agentName, onDownloadBrief, briefBusy, secret, forYou = false }: {
  connect?: ConnectInfo | null;
  agentName: string;
  /** Downloads the agent's AGENTS.md (its context pack). */
  onDownloadBrief?: () => void;
  briefBusy?: boolean;
  /** A key just made, while it is on screen: the snippets carry it in their headers so they paste and work. */
  secret?: string | null;
  /** The snippets are for the person's own AI tool (a setup key), not an agent's host. */
  forYou?: boolean;
}) {
  const info = connect ?? buildConnectInfo(typeof window === 'undefined' ? '' : window.location.origin);
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('claude_code');
  const current = TABS.find((t) => t.key === tab)!;
  const text = connectSnippetsWithKey(info, secret)[tab];
  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-2xl bg-white/[0.025] ring-1 ring-inset ring-white/[0.06]">
        <div role="tablist" aria-label={forYou ? 'Your AI tool' : 'Where the agent runs'} className="flex overflow-x-auto border-b border-white/[0.06] px-2 scrollbar-none">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`relative whitespace-nowrap px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${tab === t.key ? 'text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              {t.label}
              <span aria-hidden="true" className={`absolute inset-x-2 bottom-0 h-0.5 rounded-full ${tab === t.key ? 'bg-brand-400' : 'bg-transparent'}`} />
            </button>
          ))}
        </div>
        <div role="tabpanel" className="p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-zinc-400">{forYou ? current.yourHint : current.hint}{secret ? ' It holds the key, so keep it private.' : ''}</p>
            <CopyButton text={text} what={current.label} />
          </div>
          <pre className="mt-3 overflow-x-auto whitespace-pre rounded-lg bg-black/25 p-3 font-mono text-xs leading-relaxed text-zinc-100">{text}</pre>
        </div>
      </div>
      <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="text-zinc-500">MCP</dt>
        <dd className="min-w-0 truncate font-mono text-zinc-300">{info.mcp_url}</dd>
        <dt className="text-zinc-500">REST API</dt>
        <dd className="min-w-0 truncate font-mono text-zinc-300">{info.api_base}</dd>
      </dl>
      {onDownloadBrief && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white/[0.025] px-4 py-3 ring-1 ring-inset ring-white/[0.06]">
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">AGENTS.md</p>
            <p className="text-xs text-zinc-400">{agentName}&apos;s rules, projects and pinned brief, for its working folder.</p>
          </div>
          <Button variant="secondary" size="sm" icon={<Download size={13} aria-hidden="true" />} onClick={onDownloadBrief} disabled={briefBusy}>
            {briefBusy ? 'Preparing' : 'Download'}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Saves text as a file in the browser. */
export function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
