'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, Trash2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/inputs/Checkbox';
import { Select, type SelectOption } from '@/components/ui/inputs/Select';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { toast } from '@/components/ui/Toast';
import { useApp } from '@/lib/store';
import { workspaceApi } from '@/lib/agent-workspace';
import { invalidateTables } from '@/lib/query-cache';
import type { ChatConnectionView, ChatListenMode } from '@/lib/chat/types';
import { demoBlocked } from './demo';

const LISTEN_OPTIONS: SelectOption[] = [
  { value: 'mentions', label: 'When mentioned', detail: 'Answers when someone mentions the bot or the agent' },
  { value: 'all', label: 'Reads everything', detail: 'Reads the whole group to understand it, and still answers only when mentioned' },
];

/** Where a private chat's id comes from, per provider, when it cannot be found by name. */
const FIND_ID_HINT: Record<string, string> = {
  telegram: 'A private group has no name to look up: mention the bot there once, then pick the group from the ones it saw recently.',
  discord: 'Mention the bot in the channel once, then pick it from the ones it saw recently.',
  slack: 'A private channel: invite the bot first, then type the channel name.',
};

/**
 * A company connection's settings, inside its row (owner critique C10): one
 * plain line first ("You're set: messages to @Bot go to Alexa", or what to
 * pick), then everything optional folded under "Optional: add the bot to a
 * group": which agents answer there and channels mapped to an agent. A group
 * the bot saw recently can be picked instead of typing its name. Each change
 * saves at once (none in the demo).
 */
export function CompanyChatPanel({ connection, isDemo = false }: { connection: ChatConnectionView; isDemo?: boolean }) {
  const { team } = useApp();
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [channel, setChannel] = useState('');
  const [channelAgent, setChannelAgent] = useState('');
  const [listen, setListen] = useState<ChatListenMode>('mentions');
  const [channelError, setChannelError] = useState<string | null>(null);
  const [groupsOpen, setGroupsOpen] = useState(connection.channels.length > 0);
  const handle = connection.bot_handle || `the ${connection.provider_label} bot`;

  const base = `/api/workspace/chat-connections/${connection.id}`;
  const agentOptions: SelectOption[] = connection.agents.map((agent) => ({ value: agent.id, label: agent.name }));
  const agentName = (id: string) => connection.agents.find((agent) => agent.id === id)?.name ?? 'Agent';
  const fallback = connection.agents.find((agent) => agent.is_default);

  const save = async (key: string, path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown, done?: string) => {
    if (demoBlocked(isDemo)) return false;
    setBusy(key);
    try {
      await workspaceApi<ChatConnectionView>(`${base}${path}`, { method, ...(body === undefined ? {} : { body }) });
      invalidateTables(['chat_connections']);
      if (done) toast('success', done);
      return true;
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'Could not save. Try again.';
      if (key === 'add-channel') setChannelError(message);
      else toast('error', message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const addChannel = async () => {
    const agent = channelAgent || fallback?.id || connection.agents[0]?.id;
    if (!channel.trim()) return setChannelError('Name the channel, or paste its id.');
    if (!agent) return setChannelError('Pick the agent that answers first.');
    setChannelError(null);
    if (await save('add-channel', '/channels', 'POST', { channel: channel.trim(), agent_id: agent, listen }, 'Channel mapped')) {
      setChannel('');
      setListen('mentions');
    }
  };

  return (
    <div className="mt-3 space-y-4 border-t border-white/[0.06] pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {fallback ? (
          <p className="flex min-w-0 items-start gap-2 text-sm text-zinc-200">
            <CheckCircle2 size={15} className="mt-0.5 flex-shrink-0 text-emerald-300" aria-hidden="true" />
            <span>You&apos;re set: messages to {handle} go to <span className="font-medium">{fallback.name}</span>.{connection.agents.length > 1 ? ` Mention another agent by name to reach it.` : ''}</span>
          </p>
        ) : (
          <p className="text-sm text-zinc-300">Pick the agent that answers messages to {handle}.</p>
        )}
        <Button size="sm" variant={fallback ? 'ghost' : 'secondary'} onClick={() => { if (!demoBlocked(isDemo)) setChoosing(true); }}>{connection.agents.length ? 'Change' : 'Pick the agent'}</Button>
      </div>

      <div>
        <button
          type="button"
          aria-expanded={groupsOpen}
          onClick={() => setGroupsOpen((open) => !open)}
          className="inline-flex items-center gap-1.5 rounded text-xs font-medium text-zinc-400 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <ChevronDown size={13} aria-hidden="true" className={`transition-transform ${groupsOpen ? 'rotate-180' : ''}`} />
          Optional: add the bot to a {connection.provider === 'telegram' ? 'group' : 'channel'}{connection.channels.length ? ` (${connection.channels.length})` : ''}
        </button>
        {groupsOpen && <div className="mt-2">
        <p className="text-[11px] text-zinc-500">Add the bot to a {connection.provider === 'telegram' ? 'group' : 'channel'}, then choose which agent answers there.</p>
        {connection.channels.length > 0 && (
          <ul className="mt-1.5 divide-y divide-white/[0.06]">
            {connection.channels.map((route) => (
              <li key={route.id} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center">
                <div className="min-w-0 sm:w-40">
                  <p className="truncate text-sm text-zinc-100">{route.channel_name ?? route.channel_id}</p>
                </div>
                <div className="grid flex-1 grid-cols-[1fr_1fr_auto] items-center gap-2">
                  <div className="min-w-0"><Select size="sm" ariaLabel={`Agent for ${route.channel_name ?? route.channel_id}`} value={route.agent_id} options={agentOptions}
                    disabled={busy === route.id} onChange={(value) => { if (value !== route.agent_id) void save(route.id, `/channels/${route.id}`, 'PATCH', { agent_id: value }); }} /></div>
                  <div className="min-w-0"><Select size="sm" ariaLabel={`What ${agentName(route.agent_id)} hears in ${route.channel_name ?? route.channel_id}`} value={route.listen} options={LISTEN_OPTIONS}
                    disabled={busy === route.id} onChange={(value) => { if (value !== route.listen) void save(route.id, `/channels/${route.id}`, 'PATCH', { listen: value }); }} /></div>
                  <button
                    type="button"
                    disabled={busy === route.id}
                    onClick={() => void save(route.id, `/channels/${route.id}`, 'DELETE', undefined, 'Channel unmapped')}
                    className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-rose-500/15 hover:text-rose-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500"
                    aria-label={`Unmap ${route.channel_name ?? route.channel_id}`}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <form className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start" onSubmit={(event) => { event.preventDefault(); void addChannel(); }}>
          <TextInput size="sm" aria-label="Group or channel" placeholder={connection.provider === 'telegram' ? 'Group name' : 'Channel name, like #general'} value={channel}
            onChange={(value) => { setChannel(value); setChannelError(null); }} />
          <Select size="sm" ariaLabel="Agent for the new channel" value={channelAgent || fallback?.id || ''} options={agentOptions} placeholder="Agent"
            disabled={connection.agents.length === 0} onChange={setChannelAgent} />
          <Select size="sm" ariaLabel="What it hears in the new channel" value={listen} options={LISTEN_OPTIONS} onChange={(value) => setListen(value as ChatListenMode)} />
          <Button size="sm" type="submit" variant="secondary" disabled={busy === 'add-channel'}>{busy === 'add-channel' ? 'Adding' : 'Add'}</Button>
        </form>
        {channelError && <p className="mt-2 text-sm text-red-300" role="alert">{channelError}</p>}
        {(connection.recent_channels ?? []).length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-zinc-500">Seen recently:</span>
            {(connection.recent_channels ?? []).map((recent) => (
              <button key={recent.id} type="button" onClick={() => { setChannel(recent.id); setChannelError(null); }}
                className="rounded-full bg-white/[0.05] px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.09] hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                aria-label={`Use ${recent.name ?? recent.id}`}>
                {recent.name ?? recent.id}
              </button>
            ))}
          </div>
        )}
        {FIND_ID_HINT[connection.provider] && <p className="mt-1.5 text-[11px] text-zinc-500">{FIND_ID_HINT[connection.provider]}</p>}
        </div>}
      </div>

      <ChooseAgentsDialog
        isOpen={choosing}
        connection={connection}
        candidates={connection.candidates
          ?? team.filter((member) => member.role === 'agent' && !member.delegate_of && member.status !== 'suspended').map((member) => ({ id: member.id, name: member.name, can_act_for: true }))}
        onClose={() => setChoosing(false)}
      />
    </div>
  );
}

type Candidate = { id: string; name: string; can_act_for: boolean };

/** Which company agents the connection reaches, and the default among them. */
function ChooseAgentsDialog({ isOpen, connection, candidates, onClose }: {
  isOpen: boolean;
  connection: ChatConnectionView;
  candidates: Candidate[];
  onClose: () => void;
}) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Who answers" size="md">
      {isOpen && <ChooseAgents connection={connection} candidates={candidates} onClose={onClose} />}
    </Modal>
  );
}

function ChooseAgents({ connection, candidates, onClose }: { connection: ChatConnectionView; candidates: Candidate[]; onClose: () => void }) {
  const [picked, setPicked] = useState<string[]>(() => connection.agents.map((agent) => agent.id));
  const [fallback, setFallback] = useState<string>(() => connection.agents.find((agent) => agent.is_default)?.id ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Agents already on it stay listed even if the team list has not loaded them.
  const rows = useMemo(() => {
    const byId = new Map<string, Candidate>(candidates.map((agent) => [agent.id, agent]));
    for (const agent of connection.agents) if (!byId.has(agent.id)) byId.set(agent.id, { id: agent.id, name: agent.name, can_act_for: true });
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [candidates, connection.agents]);
  const defaultId = picked.includes(fallback) ? fallback : picked[0] ?? '';
  // Taking an agent off takes its channel mappings with it: say which, before saving.
  const unmapped = connection.agents.filter((agent) => !picked.includes(agent.id)).map((agent) => ({
    name: agent.name,
    channels: connection.channels.filter((route) => route.agent_id === agent.id).map((route) => route.channel_name ?? route.channel_id),
  })).filter((entry) => entry.channels.length > 0);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await workspaceApi<ChatConnectionView>(`/api/workspace/chat-connections/${connection.id}/agents`, { method: 'PUT', body: { agent_ids: picked, default_agent_id: defaultId || null } });
      invalidateTables(['chat_connections']);
      toast('success', 'Agents saved');
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {rows.length === 0 ? (
        <p className="rounded-lg bg-white/[0.03] px-3 py-2 text-sm text-zinc-400">No company agents yet. Hire one from Agents first.</p>
      ) : (
        <ul className="max-h-72 space-y-1 overflow-y-auto">
          {rows.map((agent) => {
            const blocked = !agent.can_act_for && !picked.includes(agent.id);
            return (
              <li key={agent.id} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-white/[0.03]">
                <Checkbox
                  checked={picked.includes(agent.id)}
                  disabled={blocked}
                  onChange={(checked) => setPicked((prev) => (checked ? [...prev, agent.id] : prev.filter((id) => id !== agent.id)))}
                  label={agent.name}
                  description={agent.can_act_for ? undefined : 'Needs "Act for a person" on its Access tab'}
                />
                {!agent.can_act_for && (
                  <Button size="sm" variant="ghost" href={`/ai/agents/${agent.id}?tab=access`}>Open Access</Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Select label="Answers messages to the bot" value={defaultId} options={picked.map((id) => ({ value: id, label: rows.find((agent) => agent.id === id)?.name ?? 'Agent' }))}
        placeholder="Pick an agent first" disabled={picked.length === 0} onChange={setFallback} helperText="Direct messages, and mentions in a group with no agent of its own." />
      {unmapped.length > 0 && (
        <p role="note" className="flex items-start gap-2 rounded-lg bg-amber-500/[0.12] px-3 py-2 text-sm text-zinc-200">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-amber-300" aria-hidden="true" />
          <span>{unmapped.map((entry) => `Removing ${entry.name} unmaps ${entry.channels.join(', ')}`).join('. ')}.</span>
        </p>
      )}
      {error && <p role="alert" className="rounded-lg bg-red-500/[0.12] px-3 py-2 text-sm text-red-300">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={() => { void save(); }} disabled={saving}>{saving ? 'Saving' : 'Save agents'}</Button>
      </div>
    </div>
  );
}
