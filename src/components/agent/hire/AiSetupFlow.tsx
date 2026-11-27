'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight, Bot, Check, Clock, KeyRound, ListChecks, Plug, Power, ShieldAlert, ShieldCheck, Sparkles } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useDemo } from '@/lib/demo-context';
import { invalidateTables, useRead } from '@/lib/query-cache';
import { aiSetupRead } from '@/lib/reads';
import { workspaceApi } from '@/lib/agent-workspace';
import { buildConnectInfo, type ConnectInfo } from '@/lib/agent-connect';
import { roleLabel } from '@/lib/agents-ui';
import {
  AI_SETUP_ABILITIES, AI_SETUP_EXAMPLES, AI_SETUP_KEY_NAME, AI_SETUP_MINUTES, aiSetupNever, aiSetupPrompt, minutesLeft,
  type AiSetupAgentView, type AiSetupConfirmView, type AiSetupKeyView, type AiSetupSessionView, type AiSetupView,
} from '@/lib/ai-setup';
import { permissionLabel } from '@/lib/access-control';
import { keyExpiry } from '@/lib/developers-settings';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Pill } from '@/components/ui/Pill';
import Modal from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { FlowShell, Stepper } from '@/components/ui/Stepper';
import { Bone, Skeleton } from '@/components/projects/TabLayout';
import { AgentAvatar } from '@/components/agent/AgentAvatar';
import { ConnectSnippets, CopyButton, SecretOnce } from '@/components/agent/ConnectPanel';
import { toast } from '@/components/ui/Toast';
import { formatDay, formatTime } from '@/lib/time-format';

/**
 * Hire an agent > Set it up with AI. Three parts on one page:
 * 1. Let your AI in: a connected AI tool (Connect AI) gets one hour of the
 *    agent setup tools, after a consent step that names exactly what that
 *    allows; without one, a one-hour setup key with copy-ready snippets.
 * 2. Ask it: a ready prompt to edit and copy, with examples per role.
 * 3. Watch it work: each agent it hires shows up as it goes, with its role,
 *    powers and projects and a link to review it; End now stops it early.
 * Every write the AI makes runs the same server rules as the step by step
 * flow. In the demo the session, the key and the agents are pretend.
 */

const STEPS = [
  { key: 'access', label: 'Let it in' },
  { key: 'ask', label: 'Ask it' },
  { key: 'review', label: 'Review' },
] as const;
const CONNECT_AI_HREF = '/settings/account#connect-ai';
const POLL_MS = 5000;

const timeOf = (iso: string) => formatTime(iso);
const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

export function AiSetupFlow({ exitHref, onManual, projectName }: { exitHref: string; onManual: () => void; projectName: string | null }) {
  const { isDemoMode } = useDemo();
  const read = useRead(isDemoMode ? null : aiSetupRead);
  const demo = useDemoSetup(isDemoMode);
  const view: AiSetupView | null = isDemoMode ? demo.view : read.data ?? null;
  const [now, setNow] = useState(() => Date.now());
  const [consentFor, setConsentFor] = useState<{ id: string; client_name: string } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState<'start' | 'key' | 'end' | null>(null);
  const [secret, setSecret] = useState<{ sessionId: string; secret: string; connect: ConnectInfo } | null>(null);
  const [showKeyPath, setShowKeyPath] = useState(false);

  const live = view?.sessions.find((s) => s.active) ?? null;
  const agents = useMemo(() => {
    const seen = new Set<string>();
    return (view?.sessions ?? []).flatMap((s) => s.agents).filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
  }, [view]);
  // Every key the sessions made, and what they asked for that waits on your Allow.
  const keys = useMemo(() => (view?.sessions ?? []).flatMap((s) => s.keys ?? []), [view]);
  const pending = useMemo(() => (view?.sessions ?? []).flatMap((s) => s.confirms ?? []).filter((c) => c.status === 'pending'), [view]);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<AiSetupKeyView | null>(null);
  const connections = view?.connect_enabled ? view.connections : [];
  const chosen = connections.find((c) => c.id === picked) ?? connections[0] ?? null;

  // The clock for "52 min left", and the end of a session on its own.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  // While a session is live, look again every few seconds: an agent appears as the AI hires it.
  const reload = read.reload;
  useEffect(() => {
    if (isDemoMode || !live) return;
    const timer = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(timer);
  }, [isDemoMode, live, reload]);
  useEffect(() => {
    if (live && now >= new Date(live.expires_at).getTime() && !isDemoMode) reload();
  }, [now, live, isDemoMode, reload]);

  const refresh = () => {
    invalidateTables(['ai_setup_sessions']);
    reload();
  };

  const start = async (connection: { id: string; client_name: string }) => {
    setBusy('start');
    try {
      if (isDemoMode) demo.start('connection', connection.client_name);
      else {
        await workspaceApi('/api/workspace/ai-setup', { method: 'POST', body: { kind: 'connection', grant_id: connection.id } });
        refresh();
      }
      setConsentFor(null);
      toast('success', `${connection.client_name} can set up agents for the next hour`);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not start. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const makeKey = async () => {
    setBusy('key');
    try {
      if (isDemoMode) {
        const session = demo.start('key', AI_SETUP_KEY_NAME);
        setSecret({ sessionId: session.id, secret: `pk_setup_demo_${randomHex(20)}`, connect: buildConnectInfo(window.location.origin) });
      } else {
        const made = await workspaceApi<{ session: AiSetupSessionView; secret: string; connect: ConnectInfo }>('/api/workspace/ai-setup', { method: 'POST', body: { kind: 'key' } });
        setSecret({ sessionId: made.session.id, secret: made.secret, connect: made.connect });
        refresh();
      }
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not make the key. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const end = async (session: AiSetupSessionView) => {
    setBusy('end');
    try {
      if (isDemoMode) demo.end(session.id);
      else {
        await workspaceApi(`/api/workspace/ai-setup/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
        refresh();
      }
      if (secret?.sessionId === session.id) setSecret(null);
      toast('success', session.kind === 'key' ? 'Setup key stopped. The agents it made stay.' : `${session.client_name} can no longer set up agents. The agents it made stay.`);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not end it. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const decide = async (confirm: AiSetupConfirmView, allow: boolean) => {
    setDeciding(confirm.id);
    try {
      if (isDemoMode) demo.decide(confirm.id, allow);
      else {
        await workspaceApi(`/api/workspace/ai-setup/confirms/${encodeURIComponent(confirm.id)}`, { method: 'POST', body: { allow } });
        invalidateTables(['api_keys', 'webhook_endpoints']);
        refresh();
      }
      toast('success', allow ? (confirm.kind === 'webhook' ? `Webhook to ${confirm.host} is on` : `${confirm.agent_name ?? 'The agent'} can now ${confirm.scopes.length === 1 ? 'use that power' : 'use those powers'}`) : 'Declined. Nothing was added.');
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not save that. Try again.');
    } finally {
      setDeciding(null);
    }
  };

  const revoke = async (key: AiSetupKeyView) => {
    setRevoking(null);
    try {
      if (isDemoMode) demo.revoke(key.id);
      else {
        await workspaceApi(`/api/workspace/api-keys/${encodeURIComponent(key.id)}/revoke`, { method: 'POST' });
        invalidateTables(['api_keys']);
        refresh();
      }
      toast('success', `${key.name} revoked`);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not revoke it. Try again.');
    }
  };

  const current = !live ? 0 : agents.length ? 2 : 1;
  const toolName = live ? (live.kind === 'key' ? 'your AI tool' : live.client_name) : chosen?.client_name ?? 'your AI tool';

  return (
    <FlowShell
      title="Set it up with AI"
      subtitle={isDemoMode
        ? 'Describe the agent you want. In the demo, access and the agents your AI makes are pretend.'
        : 'Describe the agent you want. Your AI tool asks what it needs, then sets it up here while you watch.'}
      exitHref={exitHref}
      exitLabel={agents.length ? 'Close' : 'Cancel'}
      stepper={<Stepper steps={STEPS} current={current} reached={current} label="Setting up with AI" />}
      aside={<Aside onManual={onManual} />}
    >
      <div className="space-y-5">
        <Part n={1} done={!!live} title="Let your AI in" description={`For one hour it may hire agents and set them up for you, and nothing else beyond what it already does. It ends on its own.`}>
          {!view && (read.loading || isDemoMode) ? (
            <Skeleton label="Loading" className="space-y-2"><Bone className="h-16 rounded-xl" /></Skeleton>
          ) : !view ? (
            <p role="alert" className="flex flex-wrap items-center gap-3 text-sm text-zinc-300">
              Could not load this. <Button variant="secondary" size="sm" onClick={read.reload}>Try again</Button>
            </p>
          ) : !view.ready ? (
            <p className="rounded-xl bg-amber-500/[0.10] px-4 py-3 text-sm text-amber-100">
              This needs the workspace&apos;s latest database update. <Link href="/settings/updates" className="font-medium underline underline-offset-2">Open Updates</Link>, or set it up step by step.
            </p>
          ) : live ? (
            <LiveAccess session={live} now={now} busy={busy === 'end'} onEnd={() => end(live)} secret={secret?.sessionId === live.id ? secret : null} onNewKey={makeKey} keyBusy={busy === 'key'} isDemo={isDemoMode} />
          ) : connections.length > 0 && !showKeyPath ? (
            <div className="space-y-4">
              {connections.length > 1 && (
                <fieldset>
                  <legend className="mb-2 text-xs font-medium text-zinc-400">Which tool?</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {connections.map((c) => (
                      <label key={c.id} className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 ring-1 ring-inset transition-colors ${chosen?.id === c.id ? 'bg-brand-500/[0.14] ring-brand-400/60' : 'bg-white/[0.03] ring-white/[0.06] hover:bg-white/[0.05]'}`}>
                        <input type="radio" name="ai-tool" className="accent-[var(--color-brand-500)]" checked={chosen?.id === c.id} onChange={() => setPicked(c.id)} />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-white">{c.client_name}</span>
                          <span className="block truncate text-xs text-zinc-500">Signs in from {c.redirect_host}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              {chosen && (
                <div className="rounded-xl bg-white/[0.03] p-4 ring-1 ring-inset ring-white/[0.06]">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-zinc-200" aria-hidden="true"><Plug size={16} /></span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-white">{chosen.client_name} is connected</p>
                      <p className="text-xs text-zinc-400">Signs in from {chosen.redirect_host}. Today it works with your projects and tasks only.</p>
                    </div>
                  </div>
                  <Button className="mt-4 w-full sm:w-auto" icon={<Sparkles size={15} aria-hidden="true" />} onClick={() => { setNow(Date.now()); setConsentFor(chosen); }} disabled={busy !== null}>
                    Let {chosen.client_name} set up agents for the next hour
                  </Button>
                </div>
              )}
              <p className="text-xs text-zinc-500">
                Using a tool that is not connected?{' '}
                <button type="button" onClick={() => setShowKeyPath(true)} className="font-medium text-brand-300 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">Make a one-hour setup key</button>
              </p>
            </div>
          ) : (
            <KeyPath
              busy={busy === 'key'}
              onMake={makeKey}
              connectEnabled={view.connect_enabled}
              back={connections.length > 0 ? () => setShowKeyPath(false) : null}
            />
          )}
        </Part>

        <Part n={2} done={agents.length > 0} title="Tell it what you need" description="Copy this into your AI tool and change it to fit. It reads this app's setup guide first and asks you anything it needs.">
          <PromptBox projectName={projectName} />
        </Part>

        <Part n={3} done={false} title="Watch it work" description="Each agent it hires shows up here as it goes. Open one to check it, or change anything later on its profile.">
          <AgentList agents={agents} live={!!live} toolName={toolName} isDemo={isDemoMode} />
          <SetupConfirms confirms={pending} busyId={deciding} onDecide={decide} />
          <SetupKeys keys={keys} onRevoke={setRevoking} />
          {agents.length > 0 && live && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-4">
              <p className="text-sm text-zinc-400">All done? End its access now instead of waiting the hour out.</p>
              <Button variant="secondary" size="sm" icon={<Power size={13} aria-hidden="true" />} onClick={() => end(live)} disabled={busy !== null}>End access now</Button>
            </div>
          )}
        </Part>
      </div>

      <Modal isOpen={!!consentFor} onClose={() => setConsentFor(null)} title={`Let ${consentFor?.client_name ?? 'it'} set up agents?`} size="lg">
        {consentFor && <Consent name={consentFor.client_name} now={now} busy={busy === 'start'} onAllow={() => start(consentFor)} onCancel={() => setConsentFor(null)} />}
      </Modal>
      <ConfirmDialog
        isOpen={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => { if (revoking) void revoke(revoking); }}
        title="Revoke this key?"
        message={revoking ? `${revoking.name} stops working at once${revoking.agent_name ? `, so ${revoking.agent_name} cannot use it` : ''}. This cannot be undone; you can make a new key on the agent's Access.` : ''}
        confirmLabel="Revoke key"
        variant="danger"
      />
    </FlowShell>
  );
}

/** One numbered part of the page: a heading that says what it is for, then its body. */
function Part({ n, done, title, description, children }: { n: number; done: boolean; title: string; description: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`ai-part-${n}`} className="rounded-2xl bg-white/[0.025] p-4 ring-1 ring-inset ring-white/[0.06] sm:p-5">
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums ${done ? 'bg-brand-500/20 text-brand-200' : 'bg-white/[0.06] text-zinc-300'}`}
          aria-hidden="true"
        >
          {done ? <Check size={12} strokeWidth={3} /> : n}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={`ai-part-${n}`} className="text-base font-semibold tracking-tight text-white">{title}</h2>
          <p className="mt-0.5 text-sm leading-relaxed text-zinc-400">{description}</p>
        </div>
      </div>
      <div className="mt-4 sm:pl-9">{children}</div>
    </section>
  );
}

/** The consent step: exactly what an hour of setup allows, what it never does, and how it ends. */
function Consent({ name, now, busy, onAllow, onCancel }: { name: string; now: number; busy: boolean; onAllow: () => void; onCancel: () => void }) {
  const ends = timeOf(new Date(now + AI_SETUP_MINUTES * 60_000).toISOString());
  return (
    <div>
      <p className="text-sm text-zinc-300">For the next hour, {name} can:</p>
      <ul className="mt-3 space-y-2">
        {AI_SETUP_ABILITIES.map((line) => (
          <li key={line} className="flex gap-2.5 text-sm text-zinc-200">
            <Check size={15} className="mt-0.5 flex-shrink-0 text-brand-300" aria-hidden="true" />
            {line}
          </li>
        ))}
      </ul>
      <p className="mt-4 rounded-lg bg-white/[0.04] px-3.5 py-3 text-sm leading-relaxed text-zinc-300">{aiSetupNever(name)}</p>
      <p className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
        <Clock size={13} aria-hidden="true" />
        It ends on its own at {ends}. End it sooner here or in Settings &gt; Account &gt; Connect AI.
      </p>
      <div className="mt-5 flex flex-col-reverse gap-2 border-t border-white/[0.06] pt-4 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button icon={<ShieldCheck size={15} aria-hidden="true" />} onClick={onAllow} disabled={busy}>{busy ? 'Allowing' : 'Allow for one hour'}</Button>
      </div>
    </div>
  );
}

/** A live session: who, until when, End now; and for a setup key just made, the key and its snippets. */
function LiveAccess({ session, now, busy, onEnd, secret, onNewKey, keyBusy, isDemo }: {
  session: AiSetupSessionView; now: number; busy: boolean; onEnd: () => void;
  secret: { secret: string; connect: ConnectInfo } | null; onNewKey: () => void; keyBusy: boolean; isDemo: boolean;
}) {
  const left = minutesLeft(session.expires_at, now);
  const who = session.kind === 'key' ? 'Your setup key' : session.client_name;
  return (
    <div className="space-y-4">
      <div role="status" className="flex flex-col gap-3 rounded-xl bg-brand-500/[0.12] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="relative flex h-2.5 w-2.5 flex-shrink-0" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-brand-400" />
          </span>
          <p className="min-w-0 text-sm text-zinc-300">
            <span className="font-semibold text-white">{who} can set up agents</span>
            <span> until {timeOf(session.expires_at)} · {left > 0 ? `${left} min left` : 'ending now'}</span>
          </p>
        </div>
        <Button variant="secondary" size="sm" icon={<Power size={13} aria-hidden="true" />} onClick={onEnd} disabled={busy}>{busy ? 'Ending' : 'End now'}</Button>
      </div>
      {session.kind === 'key' && (secret ? (
        <>
          <SecretOnce
            secret={secret}
            heading={isDemo ? 'A sample key: the demo makes no real one.' : 'Copy the setup key now. It is not shown again.'}
            what="Setup key"
            copyLabel="Copy key"
            hint={isDemo ? 'It does not work anywhere. The snippets below show where a real key goes.' : <>Paste a snippet below into your AI tool. The key works only for setting up agents, and stops at {timeOf(session.expires_at)}.</>}
          />
          <ConnectSnippets connect={secret.connect} agentName="" secret={secret.secret} forYou />
        </>
      ) : (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-white/[0.04] px-4 py-3 text-sm text-zinc-300">
          Its secret was shown once. Lost it? Make a new one; this one stops.
          <Button variant="ghost" size="sm" icon={<KeyRound size={13} aria-hidden="true" />} onClick={onNewKey} disabled={keyBusy}>{keyBusy ? 'Making' : 'Make a new key'}</Button>
        </p>
      ))}
    </div>
  );
}

/** No connected tool (or the person chose the key): a one-hour setup key, and Connect AI as the better way. */
function KeyPath({ busy, onMake, connectEnabled, back }: { busy: boolean; onMake: () => void; connectEnabled: boolean; back: (() => void) | null }) {
  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-white/[0.03] p-4 ring-1 ring-inset ring-white/[0.06]">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-zinc-200" aria-hidden="true"><KeyRound size={16} /></span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white">A one-hour setup key</p>
            <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">It works only for setting up agents, carries only what you hold, and stops on its own. You get copy-ready settings for Claude Code, Codex or any MCP tool.</p>
          </div>
        </div>
        <Button className="mt-4 w-full sm:w-auto" icon={<KeyRound size={15} aria-hidden="true" />} onClick={onMake} disabled={busy}>{busy ? 'Making' : 'Make a one-hour setup key'}</Button>
      </div>
      {back ? (
        <p className="text-xs text-zinc-500">
          <button type="button" onClick={back} className="font-medium text-brand-300 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">Use your connected tool instead</button>
        </p>
      ) : connectEnabled ? (
        <Link
          href={CONNECT_AI_HREF}
          className="group flex items-center gap-3 rounded-xl px-4 py-3 ring-1 ring-inset ring-white/[0.06] transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <Plug size={16} className="flex-shrink-0 text-brand-300" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-sm">
            <span className="font-medium text-white">Better: connect Claude or ChatGPT</span>
            <span className="block text-xs text-zinc-400">It signs in as you, so no key changes hands. Then come back here.</span>
          </span>
          <ArrowRight size={15} className="flex-shrink-0 text-zinc-500 group-hover:text-zinc-300" aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}

/** The prompt to copy: a ready request with the guide-first tail, and examples per role to start from. */
function PromptBox({ projectName }: { projectName: string | null }) {
  const examples = useMemo(() => AI_SETUP_EXAMPLES.map((e) => (
    projectName && e.id === 'builder' ? { ...e, request: e.request.replace('the Website project', `the ${projectName} project`) } : e
  )), [projectName]);
  const first = projectName ? examples.find((e) => e.id === 'builder')! : examples[0];
  const [example, setExample] = useState(first.id);
  const [text, setText] = useState(() => aiSetupPrompt(first.request));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Start from an example">
        {examples.map((e) => (
          <button
            key={e.id}
            type="button"
            aria-pressed={example === e.id}
            onClick={() => { setExample(e.id); setText(aiSetupPrompt(e.request)); }}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${example === e.id ? 'bg-brand-500/20 text-brand-200 ring-1 ring-inset ring-brand-400/50' : 'bg-white/[0.04] text-zinc-300 hover:bg-white/[0.08] hover:text-white'}`}
          >
            {e.label}
          </button>
        ))}
      </div>
      <Textarea aria-label="Prompt for your AI tool" value={text} onChange={setText} rows={7} autoResize maxHeight={360} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">Change the names, projects and people to yours.</p>
        <CopyButton text={text} what="Prompt" label="Copy prompt" />
      </div>
    </div>
  );
}

/** The agents the AI made, newest first, each linking to its profile. */
function AgentList({ agents, live, toolName, isDemo }: { agents: AiSetupAgentView[]; live: boolean; toolName: string; isDemo: boolean }) {
  if (agents.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-dashed border-white/[0.10] px-4 py-5">
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-white/[0.04] text-zinc-400" aria-hidden="true"><Bot size={16} /></span>
        <p className="text-sm text-zinc-400" role="status">
          {live ? `Waiting for ${toolName}. Ask it with the prompt above; agents show up here as it hires them.` : 'Agents your AI hires show up here.'}
        </p>
      </div>
    );
  }
  return (
    <ul className="space-y-2" aria-label="Agents it made" aria-live="polite">
      {agents.map((agent) => (
        <li key={agent.id} className="animate-slideInUp flex flex-col gap-3 rounded-xl bg-white/[0.03] px-4 py-3 ring-1 ring-inset ring-white/[0.06] sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <AgentAvatar id={agent.id} name={agent.name} src={agent.avatar} presence="idle" size="md" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">{agent.name}</p>
              <p className="truncate text-xs text-zinc-400">
                {[agent.title, agent.agent_role ? roleLabel(agent.agent_role) : null].filter((v, i, all) => v && all.indexOf(v) === i).join(' · ') || 'Agent'}
              </p>
              <p className="mt-0.5 truncate text-xs text-zinc-500">
                {agent.powers ? `${agent.powers} ${agent.powers === 1 ? 'power' : 'powers'}` : 'No key yet'}
                <span aria-hidden="true"> · </span>
                {agent.projects.length ? agent.projects.map((p) => p.name).join(', ') : 'No projects'}
              </p>
            </div>
          </div>
          <Button variant="secondary" size="sm" href={`/ai/agents/${agent.id}`} icon={<ArrowRight size={13} aria-hidden="true" />} onClick={isDemo && agent.id.startsWith('demo-') ? (e: React.MouseEvent) => { e.preventDefault(); toast('info', 'This agent is pretend in the demo.'); } : undefined}>
            Review
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * What the AI asked for that only you can allow: sensitive powers for a key
 * it made (money, people, settings, acting for someone, keys, webhooks,
 * credentials), or a webhook to a new web address (made switched off).
 */
function SetupConfirms({ confirms, busyId, onDecide }: { confirms: AiSetupConfirmView[]; busyId: string | null; onDecide: (c: AiSetupConfirmView, allow: boolean) => void }) {
  if (confirms.length === 0) return null;
  return (
    <div className="mt-4 border-t border-white/[0.06] pt-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
        <ShieldAlert size={16} className="text-zinc-400" aria-hidden="true" />
        Waiting for your Allow
      </h3>
      <p className="mt-0.5 text-xs text-zinc-400">Your AI asked for these. Nothing here works until you allow it.</p>
      <ul className="mt-3 divide-y divide-white/[0.06]" aria-label="Waiting for your Allow">
        {confirms.map((c) => (
          <li key={c.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-white">
                {c.kind === 'webhook'
                  ? <>A webhook to <span className="font-medium">{c.host}</span>{c.agent_name ? ` for ${c.agent_name}` : ''}</>
                  : <>{c.agent_name ?? 'An agent'}{c.key_name ? `'s key` : ''} asks to {c.scopes.length === 1 ? 'have one more power' : `have ${c.scopes.length} more powers`}</>}
              </p>
              <p className="mt-0.5 text-xs text-zinc-400">
                {c.kind === 'webhook' ? 'It is switched off until you allow it. Allow only an address you know.' : c.scopes.map((scope) => permissionLabel(scope)).join(', ')}
              </p>
            </div>
            <div className="flex flex-shrink-0 gap-2">
              <Button variant="ghost" size="sm" onClick={() => onDecide(c, false)} disabled={busyId !== null}>Decline</Button>
              <Button size="sm" onClick={() => onDecide(c, true)} disabled={busyId !== null}>{busyId === c.id ? 'Saving' : 'Allow'}</Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Every key the AI made, with when it ends and Revoke. */
function SetupKeys({ keys, onRevoke }: { keys: AiSetupKeyView[]; onRevoke: (key: AiSetupKeyView) => void }) {
  if (keys.length === 0) return null;
  return (
    <div className="mt-4 border-t border-white/[0.06] pt-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
        <KeyRound size={16} className="text-zinc-400" aria-hidden="true" />
        Keys it made
      </h3>
      <p className="mt-0.5 text-xs text-zinc-400">Each one stays after the hour ends. Revoke any you did not expect.</p>
      <ul className="mt-3 divide-y divide-white/[0.06]" aria-label="Keys it made">
        {keys.map((key) => {
          const ends = keyExpiry(key.expires_at, new Date(), formatDay);
          return (
            <li key={key.id} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-white">
                  <span className="min-w-0 truncate">{key.name}</span>
                  {key.revoked_at && <Pill tone="neutral">Revoked</Pill>}
                </p>
                <p className="mt-0.5 text-xs text-zinc-400">
                  {[key.agent_name, `${key.scopes.length} ${key.scopes.length === 1 ? 'power' : 'powers'}`, key.revoked_at ? null : ends.label].filter(Boolean).join(' · ')}
                </p>
              </div>
              {!key.revoked_at && <Button variant="secondary" size="sm" onClick={() => onRevoke(key)}>Revoke</Button>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Aside({ onManual }: { onManual: () => void }) {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-white/[0.03] p-5 ring-1 ring-inset ring-white/[0.06]">
        <p className="flex items-center gap-2 text-sm font-semibold text-white"><ShieldCheck size={15} className="text-brand-300" aria-hidden="true" />Same rules as by hand</p>
        <ul className="mt-3 space-y-2 text-xs leading-relaxed text-zinc-400">
          <li>Every change goes through the checks the step by step screens use.</li>
          <li>It never gives an agent more than you hold.</li>
          <li>It stops on its own after an hour, or when you end it.</li>
          <li>The audit log records each change as made by your AI, for you.</li>
        </ul>
      </div>
      <button
        type="button"
        onClick={onManual}
        className="group flex w-full items-center gap-3 rounded-2xl bg-white/[0.02] p-4 text-left ring-1 ring-inset ring-white/[0.06] transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <ListChecks size={16} className="flex-shrink-0 text-zinc-400 group-hover:text-zinc-200" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-white">Rather do it yourself?</span>
          <span className="block text-xs text-zinc-400">Set it up step by step</span>
        </span>
        <ArrowRight size={15} className="flex-shrink-0 text-zinc-500 group-hover:text-zinc-300" aria-hidden="true" />
      </button>
    </div>
  );
}

// ── The demo ────────────────────────────────────────────────────────────

/**
 * A pretend session for the demo: a connected Claude, a session that starts
 * and ends on the page, and the moment the AI hires agents (two of the
 * demo's own agents appear a few seconds apart, so Review opens a real
 * demo profile).
 */
function useDemoSetup(isDemo: boolean) {
  const { team, projects } = useApp();
  const [sessions, setSessions] = useState<AiSetupSessionView[]>([]);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const pool = useMemo<AiSetupAgentView[]>(() => {
    const open = projects.filter((p) => p.status !== 'archived').slice(0, 3).map((p) => ({ id: p.id, name: p.name }));
    const agents = team.filter((m) => m.role === 'agent' && m.status !== 'suspended').slice(0, 2);
    const fallback = [{ id: 'demo-alexa', name: 'Alexa', title: 'Chief of staff', avatar: null }, { id: 'demo-nova', name: 'Nova', title: 'Builder', avatar: null }];
    return (agents.length >= 2 ? agents : fallback).map((m, i) => ({
      id: m.id, name: m.name, avatar: (m as { avatar?: string | null }).avatar || null, title: (m as { title?: string | null }).title || null,
      agent_role: i === 0 ? 'orchestrator' : 'builder', status: 'active', created_at: new Date().toISOString(),
      powers: i === 0 ? 9 : 6, projects: i === 0 ? open : open.slice(0, 1),
    }));
  }, [team, projects]);

  const view: AiSetupView | null = isDemo ? {
    ready: true, may_start: true, connect_enabled: true,
    connections: [{ id: 'demo-claude', client_name: 'Claude', redirect_host: 'claude.ai' }],
    sessions, mcp_url: typeof window === 'undefined' ? '' : `${window.location.origin}/api/mcp`,
  } : null;

  const start = (kind: 'connection' | 'key', clientName: string): AiSetupSessionView => {
    const now = Date.now();
    const session: AiSetupSessionView = {
      id: `demo-session-${randomHex(4)}`, kind, client_name: clientName, grant_id: kind === 'connection' ? 'demo-claude' : null,
      created_at: new Date(now).toISOString(), expires_at: new Date(now + AI_SETUP_MINUTES * 60_000).toISOString(), ended_at: null, active: true, agents: [],
      keys: [], confirms: [],
    };
    setSessions((list) => [session, ...list.map((s) => (s.active ? { ...s, active: false, ended_at: new Date(now).toISOString() } : s))]);
    // The pretend AI hires one agent, then another, each with a key; the first asks to act for people.
    pool.forEach((agent, i) => {
      timers.current.push(window.setTimeout(() => {
        const at = new Date().toISOString();
        const key: AiSetupKeyView = {
          id: `demo-key-${randomHex(4)}`, name: `${agent.name} key`, key_prefix: 'pk_demo_', agent_id: agent.id, agent_name: agent.name,
          scopes: Array.from({ length: agent.powers }, (_, n) => `scope.${n}`), created_at: at, expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString(), revoked_at: null,
        };
        const asks: AiSetupConfirmView[] = i === 0
          ? [{ id: `demo-confirm-${randomHex(4)}`, kind: 'key_scopes', agent_id: agent.id, agent_name: agent.name, key_name: key.name, scopes: ['agents.act_for', 'approvals.decide'], host: null, status: 'pending', created_at: at }]
          : [{ id: `demo-confirm-${randomHex(4)}`, kind: 'webhook', agent_id: agent.id, agent_name: agent.name, key_name: null, scopes: [], host: 'hooks.example.com', status: 'pending', created_at: at }];
        setSessions((list) => list.map((s) => (s.id === session.id && s.active
          ? { ...s, agents: [{ ...agent, created_at: at }, ...s.agents], keys: [key, ...s.keys], confirms: [...s.confirms, ...asks] }
          : s)));
      }, 3500 + i * 4500));
    });
    return session;
  };

  const decide = (id: string, allow: boolean) => setSessions((list) => list.map((s) => ({
    ...s, confirms: s.confirms.map((c) => (c.id === id ? { ...c, status: allow ? 'allowed' as const : 'declined' as const } : c)),
  })));
  const revoke = (id: string) => setSessions((list) => list.map((s) => ({
    ...s, keys: s.keys.map((k) => (k.id === id ? { ...k, revoked_at: new Date().toISOString() } : k)),
  })));

  const end = (id: string) => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    setSessions((list) => list.map((s) => (s.id === id ? { ...s, active: false, ended_at: new Date().toISOString() } : s)));
  };

  return { view, start, end, decide, revoke };
}
