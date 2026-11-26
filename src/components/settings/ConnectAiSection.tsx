'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Bot, KeyRound, Loader2, Sparkles, Unplug } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { NewApiKeyDialog } from '@/components/settings/NewApiKeyDialog';
import { CopyButton } from '@/components/agent/ConnectPanel';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toast';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { workspaceApi } from '@/lib/agent-workspace';
import { invalidateTables, useRead } from '@/lib/query-cache';
import { myConnectionsRead } from '@/lib/reads';
import { timeAgo } from '@/lib/task-times';
import { appLocale } from '@/lib/region';
import { CONNECT_MEMORY_SCOPE, connectAbilities, connectKeyPreset, connectToolGuides, type ConnectionView, type ConnectToolGuide } from '@/lib/connect-ai';
import type { AiSetupSessionView } from '@/lib/ai-setup';

const LINK = 'rounded font-medium text-brand-300 underline underline-offset-2 hover:decoration-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(appLocale(), { hour: 'numeric', minute: '2-digit' });

const connectedOn = (iso: string) => new Date(iso).toLocaleDateString(appLocale(), { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Settings > Account > Connect AI: use Claude, ChatGPT, Cursor, Claude Code
 * or Codex with your own work. One address to paste, two or three steps per
 * tool, the tool signs in as you (OAuth) and you choose Allow. Below, the
 * apps connected now, each with Disconnect. A tool that cannot sign in gets
 * a personal key instead, with the same access ticked. Plain words only:
 * no scopes, headers or tokens unless the person opens the key fallback.
 */
export function ConnectAiSection({ canMakeKeys }: { canMakeKeys: boolean }) {
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const read = useRead(myConnectionsRead(isDemoMode));
  const view = read.data;
  const [tool, setTool] = useState<ConnectToolGuide['id']>('claude');
  const [removing, setRemoving] = useState<ConnectionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const guides = useMemo(() => (view ? connectToolGuides(view.mcp_url, view.workspace_name) : []), [view]);
  const guide = guides.find((g) => g.id === tool) ?? guides[0];
  const preset = useMemo(() => ({
    ...connectKeyPreset(access),
    pasteHint: 'Paste the key into your tool where it asks for an API key or header. It sends it as x-api-key.',
  }), [access]);
  const isOwner = access?.role === 'owner';
  const [ending, setEnding] = useState<string | null>(null);
  const setupSessions = view?.setup_sessions ?? [];
  const setupFor = (grantId: string) => setupSessions.find((session) => session.grant_id === grantId) ?? null;
  const keySessions = setupSessions.filter((session) => session.kind === 'key');

  // Ending a setup session is undone by starting a new one from Hire an agent, so it acts at once.
  const endSetup = async (session: AiSetupSessionView) => {
    setEnding(session.id);
    try {
      await workspaceApi(`/api/workspace/ai-setup/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
      invalidateTables(['ai_setup_sessions']);
      toast('success', session.kind === 'key' ? 'Setup key stopped' : `${session.client_name} can no longer set up agents`);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not end it. Try again.');
    } finally {
      setEnding(null);
    }
  };

  const disconnect = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await workspaceApi(`/api/workspace/me/connections/${encodeURIComponent(removing.id)}`, { method: 'DELETE' });
      invalidateTables(['oauth_grants']);
      toast('success', `${removing.client_name} disconnected`);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not disconnect. Try again.');
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  };

  const blocked = !view ? null
    : !view.ready ? 'not_ready'
      : !view.enabled ? 'off'
        : !view.api_enabled ? 'api_off'
          : view.scopes.length === 0 ? 'no_access' : null;

  return (
    <section id="connect-ai" className="glass-card scroll-mt-6 rounded-xl p-4 lg:p-6" aria-labelledby="connect-ai-heading">
      <SettingsSectionHeader
        icon={Sparkles}
        headingId="connect-ai-heading"
        title="Connect AI"
        description="Use Claude, ChatGPT or another AI tool with your projects and tasks. It signs in as you and can only do what you can do here."
      />

      {read.loading && !view ? (
        <div className="flex items-center gap-2 text-sm text-zinc-400" role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />Loading
        </div>
      ) : read.failed && !view ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-zinc-300">
          Could not load Connect AI.
          <Button variant="secondary" size="sm" onClick={read.reload}>Try again</Button>
        </div>
      ) : view ? (
        <div className="space-y-6">
          {blocked && (
            <p role="status" className="rounded-lg bg-amber-500/[0.14] px-3.5 py-3 text-sm text-amber-100">
              {blocked === 'not_ready' && (isOwner
                ? <>Connect AI needs this workspace&apos;s latest database update. <Link href="/settings/updates" className={LINK}>Open Updates</Link></>
                : 'Connect AI is not ready in this workspace yet. Ask an Owner to apply the latest update.')}
              {blocked === 'off' && (isOwner
                ? <>Connecting AI tools is turned off for this workspace. <Link href="/settings/security#connect-ai-setting" className={LINK}>Turn it on in Security</Link></>
                : 'Connecting AI tools is turned off for this workspace. Ask an Owner to turn it on.')}
              {blocked === 'api_off' && (isOwner
                ? <>API access is turned off for this workspace, so AI tools cannot connect. <Link href="/settings/security#api-access" className={LINK}>Turn on API access in Security</Link></>
                : 'API access is turned off for this workspace, so AI tools cannot connect. Ask an Owner to turn it on in Settings > Security.')}
              {blocked === 'no_access' && 'You have no access to share with an AI tool yet. Ask an Owner to give you some in Team > Roles & permissions, on the API tab.'}
            </p>
          )}

          {!blocked && (
            <>
              <div>
                <p className="mb-2 text-xs font-medium text-zinc-400">Your address for AI tools</p>
                <div className="flex flex-col gap-2 rounded-lg border border-white/[0.08] px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
                  <code className="min-w-0 flex-1 break-all font-mono text-xs text-zinc-200">{view.mcp_url}</code>
                  <div className="flex-shrink-0">
                    <CopyButton text={view.mcp_url} what="Address" label="Copy address" />
                  </div>
                </div>
              </div>

              {guide && (
                <div className="overflow-hidden rounded-2xl bg-white/[0.025] ring-1 ring-inset ring-white/[0.06]">
                  <div role="tablist" aria-label="Your AI tool" className="flex overflow-x-auto border-b border-white/[0.06] px-2 scrollbar-none">
                    {guides.map((g) => (
                      <button
                        key={g.id}
                        id={`connect-tab-${g.id}`}
                        type="button"
                        role="tab"
                        aria-selected={guide.id === g.id}
                        aria-controls="connect-tab-panel"
                        onClick={() => setTool(g.id)}
                        className={`relative whitespace-nowrap px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${guide.id === g.id ? 'text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
                      >
                        {g.label}
                        <span aria-hidden="true" className={`absolute inset-x-2 bottom-0 h-0.5 rounded-full ${guide.id === g.id ? 'bg-brand-400' : 'bg-transparent'}`} />
                      </button>
                    ))}
                  </div>
                  <div id="connect-tab-panel" role="tabpanel" aria-labelledby={`connect-tab-${guide.id}`} className="p-4">
                    <ol className="space-y-3">
                      {guide.steps.map((step, index) => (
                        <li key={step} className="flex gap-3 text-sm text-zinc-200">
                          <span aria-hidden="true" className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-brand-500/15 text-[11px] font-semibold tabular-nums text-brand-200">{index + 1}</span>
                          <span className="min-w-0 flex-1">
                            {step}
                            {guide.snippet?.step === index && <Snippet snippet={guide.snippet} />}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                </div>
              )}

              <div className="rounded-lg bg-white/[0.03] px-3.5 py-3">
                <p className="text-xs font-medium text-zinc-400">What a connected tool can do</p>
                <p className="mt-1 text-sm text-zinc-300">{connectAbilities(view.scopes).join('. ')}. Never settings, people, agents or keys.</p>
              </div>
            </>
          )}

          <div>
            <p className="mb-2 text-xs font-medium text-zinc-400">Connected apps</p>
            {view.connections.length === 0 ? (
              <p className="rounded-lg bg-white/[0.03] px-4 py-3 text-sm text-zinc-400">No AI tools connected yet. Once you choose Allow in a tool, it shows here.</p>
            ) : (
              <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-lg border border-white/[0.08]" aria-label="Connected apps">
                {view.connections.map((connection) => (
                  <li key={connection.id} className="flex items-center justify-between gap-3 bg-surface-raised px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-zinc-100">{connection.client_name}</p>
                      <p className="mt-0.5 truncate text-xs text-zinc-400">
                        Connected {connectedOn(connection.connected_at)}
                        <span aria-hidden="true"> · </span>
                        {connection.last_used_at ? `Last used ${timeAgo(connection.last_used_at).toLowerCase()}` : 'Not used yet'}
                        <span aria-hidden="true"> · </span>
                        Signs in from {connection.redirect_host}
                      </p>
                      {setupFor(connection.id) && (
                        <SetupLine session={setupFor(connection.id)!} busy={ending === setupFor(connection.id)!.id} onEnd={endSetup} />
                      )}
                      <p className="mt-0.5 text-xs text-zinc-400">
                        {connection.scopes.includes(CONNECT_MEMORY_SCOPE)
                          ? 'Can read and add to your memory. To stop that, disconnect it and connect again without it.'
                          : 'Cannot read your memory.'}
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Unplug size={13} aria-hidden="true" />}
                      onClick={() => setRemoving(connection)}
                      disabled={isDemoMode || busy}
                      aria-label={`Disconnect ${connection.client_name}`}
                    >
                      Disconnect
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {keySessions.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium text-zinc-400">Setting up agents</p>
              <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-lg border border-white/[0.08]" aria-label="Setup keys">
                {keySessions.map((session) => (
                  <li key={session.id} className="bg-surface-raised px-3 py-2.5">
                    <p className="truncate text-sm font-medium text-zinc-100">{session.client_name}</p>
                    <SetupLine session={session} busy={ending === session.id} onEnd={endSetup} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {canMakeKeys && !blocked && (
            <div className="flex flex-col gap-3 border-t border-white/[0.06] pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-zinc-400">Tool cannot sign in? Give it a personal key with the same access.</p>
              <Button variant="secondary" size="sm" icon={<KeyRound size={13} aria-hidden="true" />} onClick={() => setKeyOpen(true)} disabled={isDemoMode}>
                Use a personal key instead
              </Button>
            </div>
          )}
        </div>
      ) : null}

      <ConfirmDialog
        isOpen={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={disconnect}
        title={`Disconnect ${removing?.client_name ?? 'this app'}?`}
        message={removing ? `${removing.client_name} stops working with your projects and tasks right away. To use it again, connect it again from the tool.` : ''}
        confirmLabel="Disconnect"
        doubleConfirm={false}
      />
      {canMakeKeys && <NewApiKeyDialog isOpen={keyOpen} onClose={() => setKeyOpen(false)} preset={preset} />}
    </section>
  );
}

function Snippet({ snippet }: { snippet: NonNullable<ConnectToolGuide['snippet']> }) {
  return (
    <span className="mt-2 block">
      <span className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-lg bg-black/25 p-3 font-mono text-xs leading-relaxed text-zinc-100">{snippet.text}</pre>
        <span className="flex-shrink-0"><CopyButton text={snippet.text} what={snippet.label} /></span>
      </span>
    </span>
  );
}

/** A live AI setup session under its tool: until when, with End now. */
function SetupLine({ session, busy, onEnd }: { session: AiSetupSessionView; busy: boolean; onEnd: (session: AiSetupSessionView) => void }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-brand-500/[0.10] px-2.5 py-1.5 text-xs text-zinc-200">
      <span className="flex min-w-0 items-center gap-1.5">
        <Bot size={12} aria-hidden="true" className="flex-shrink-0" />
        Can set up agents until {timeOf(session.expires_at)}.{' '}
        <Link href="/agent/new?mode=ai" className={LINK}>See what it made</Link>
      </span>
      <button
        type="button"
        onClick={() => onEnd(session)}
        disabled={busy}
        className="rounded font-medium text-brand-300 underline underline-offset-2 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-60"
      >
        {busy ? 'Ending' : 'End now'}
      </button>
    </div>
  );
}
