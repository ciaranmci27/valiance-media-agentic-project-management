'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Trash2, UsersRound, Wand2 } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/inputs/Select';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { toast } from '@/components/ui/Toast';
import { workspaceApi } from '@/lib/agent-workspace';
import { useDemo } from '@/lib/demo-context';
import { invalidateTables, useRead } from '@/lib/query-cache';
import { allGroupsRead, assistantSetupsReadFor } from '@/lib/reads';
import { skippedSetupWords, type AssistantSetupView, type ProvisionPreview } from '@/lib/assistant';
import { demoBlocked } from './demo';

const ROLE_WORDS: Record<string, string> = { owner: 'Owners', admin: 'Admins', member: 'Members', guest: 'Guests' };

const PREVIEW_NAMES = 8;
/** People per provisioning call; the loop runs until nobody is left or a round makes nobody new. */
const PAGE = 200;
const MAX_ROUNDS = 50;

/**
 * Who gets an assistant: roles and groups, each on or off, and one button
 * that gives everyone they match theirs. The button shows who first (a dry
 * run), then makes them, page by page, until nobody is missing, and says
 * how many people got one and how many could not. A setup that cannot be
 * used (its template is gone, or its feature is off) says why on its row
 * and in the preview. New people in a listed role or group get theirs when
 * they join it, and someone whose role changes to a listed one gets theirs
 * then too.
 */
export function AssistantSetupsSection() {
  const { isDemoMode } = useDemo();
  const read = useRead(assistantSetupsReadFor(isDemoMode));
  const groups = useRead(allGroupsRead(isDemoMode)).data ?? [];
  const setups = useMemo(() => read.data ?? [], [read.data]);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProvisionPreview | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const taken = useMemo(() => new Set(setups.map((setup) => setup.match_role ? `role:${setup.match_role}` : `group:${setup.match_group_id}`)), [setups]);
  const options = [
    ...Object.entries(ROLE_WORDS).filter(([role]) => !taken.has(`role:${role}`)).map(([role, label]) => ({ value: `role:${role}`, label, group: 'Roles' })),
    ...groups.filter((group) => !taken.has(`group:${group.id}`)).map((group) => ({ value: `group:${group.id}`, label: group.name, group: 'Groups' })),
  ];

  const refresh = () => invalidateTables(['assistant_setups', 'team_members']);
  const run = async (key: string, work: () => Promise<void>) => {
    if (demoBlocked(isDemoMode)) return;
    setBusy(key);
    try {
      await work();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const add = () => run('add', async () => {
    const [kind, id] = adding.split(':');
    await workspaceApi('/api/workspace/assistants/setups', { method: 'POST', body: kind === 'role' ? { match_role: id } : { match_group_id: id } });
    setAdding('');
    setPreview(null);
    refresh();
  });
  const toggle = (setup: AssistantSetupView, enabled: boolean) => run(setup.id, async () => {
    await workspaceApi(`/api/workspace/assistants/setups/${setup.id}`, { method: 'PATCH', body: { enabled } });
    setPreview(null);
    refresh();
  });
  const remove = (setup: AssistantSetupView) => run(setup.id, async () => {
    await workspaceApi(`/api/workspace/assistants/setups/${setup.id}`, { method: 'DELETE' });
    setPreview(null);
    refresh();
    toast('success', 'Removed. Assistants it already gave stay with their people.');
  });
  const showPreview = () => run('preview', async () => {
    setResult(null);
    setPreview(await workspaceApi<ProvisionPreview>('/api/workspace/assistants/provision', { method: 'POST', body: { dry_run: true, limit: PAGE } }));
  });
  const giveEveryone = () => run('give', async () => {
    const given = new Set<string>();
    let failed = new Set<string>();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const page = await workspaceApi<ProvisionPreview>('/api/workspace/assistants/provision', { method: 'POST', body: { limit: PAGE } });
      const before = given.size;
      for (const agent of page.agents) if (agent.agent_id) given.add(agent.person.id);
      // Whoever this round could not give one to; a later round may.
      failed = new Set(page.agents.filter((agent) => !agent.agent_id && !given.has(agent.person.id)).map((agent) => agent.person.id));
      // Done when nobody is left, or a round makes nobody new (the rest keep failing).
      if (page.remaining === 0 || page.agents.length === 0 || given.size === before) break;
    }
    setPreview(null);
    const gave = given.size === 0 ? 'Nobody new got one.' : `Gave ${given.size} ${given.size === 1 ? 'person' : 'people'} their assistant.`;
    setResult(failed.size > 0 ? `${gave} ${failed.size} couldn't be given one: try again, or check the agent service.` : given.size === 0 ? 'Everyone already has theirs.' : gave);
    invalidateTables(['team_members', 'api_keys']);
  });

  const label = (setup: AssistantSetupView) => setup.match_role ? ROLE_WORDS[setup.match_role] ?? setup.match_role : setup.match_group_name ?? 'A removed group';
  const enabledCount = setups.filter((setup) => setup.enabled).length;

  return (
    <section className="glass-card rounded-xl p-4 lg:p-5" aria-labelledby="assistant-setups-heading">
      <SettingsSectionHeader
        icon={UsersRound}
        headingId="assistant-setups-heading"
        title="Who gets one"
        description="Pick roles or groups. People who join one, or move into a listed role, get their assistant then; give everyone already here theirs in one step."
      />

      {setups.length > 0 && (
        <ul className="mb-4 divide-y divide-white/[0.06] overflow-hidden rounded-lg border border-white/[0.08]">
          {setups.map((setup) => (
            <li key={setup.id} className="flex items-center justify-between gap-3 bg-surface-raised px-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-zinc-100">{label(setup)}</p>
                {setup.skipped_reason ? (
                  <p className="flex items-start gap-1.5 text-xs text-amber-300">
                    <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" aria-hidden="true" />{skippedSetupWords(setup.skipped_reason)}
                  </p>
                ) : (
                  <p className="truncate text-xs text-zinc-500">{setup.match_role ? 'Everyone with this role' : 'Everyone in this group'}</p>
                )}
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                <Toggle size="sm" checked={setup.enabled} disabled={busy === setup.id} onChange={(value) => void toggle(setup, value)} aria-label={`${label(setup)} get an assistant`} />
                <button
                  type="button"
                  onClick={() => void remove(setup)}
                  disabled={busy === setup.id}
                  className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-rose-500/15 hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500"
                  aria-label={`Stop giving ${label(setup)} an assistant`}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {read.loading && !read.data && <p className="mb-4 text-sm text-zinc-400" role="status">Loading</p>}
      {read.data && setups.length === 0 && (
        <p className="mb-4 rounded-lg bg-white/[0.03] px-4 py-3 text-sm text-zinc-400">Nobody gets one yet. Start with Members, the most common choice.</p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[220px] flex-1 sm:max-w-xs">
          <Select label="Add a role or group" value={adding} onChange={setAdding} options={options} placeholder="Choose" searchable={options.length > 8} emptyText="Every role and group is listed" />
        </div>
        <Button variant="secondary" disabled={!adding || busy === 'add'} onClick={() => void add()}>Add</Button>
      </div>

      <div className="mt-5 border-t border-white/[0.06] pt-5">
        {result && <p className="mb-3 text-sm text-emerald-300" role="status">{result}</p>}
        {preview ? (
          <div className="rounded-lg bg-white/[0.04] px-4 py-3">
            {preview.skipped_setups.length > 0 && (
              <ul className="mb-3 space-y-1">
                {preview.skipped_setups.map((skip) => {
                  const setup = setups.find((row) => row.id === skip.setup_id);
                  return (
                    <li key={skip.setup_id} className="flex items-start gap-1.5 text-sm text-amber-300">
                      <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                      <span><span className="font-medium">{setup ? label(setup) : 'A setup'}:</span> {skippedSetupWords(skip.reason)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {preview.total_missing === 0 ? (
              <p className="text-sm text-zinc-300">{preview.skipped_setups.length > 0 ? 'Nobody else is missing one from the setups that work.' : 'Everyone these roles and groups match already has theirs.'}</p>
            ) : (
              <>
                <p className="text-sm text-zinc-200">
                  {preview.total_missing} {preview.total_missing === 1 ? 'person gets' : 'people get'} an assistant:{' '}
                  <span className="text-zinc-400">
                    {preview.agents.slice(0, PREVIEW_NAMES).map((agent) => agent.person.name).join(', ')}
                    {preview.total_missing > Math.min(PREVIEW_NAMES, preview.agents.length) ? ` and ${preview.total_missing - Math.min(PREVIEW_NAMES, preview.agents.length)} more` : ''}
                  </span>
                </p>
                <p className="mt-1 text-xs text-zinc-500">Each one starts working once your agent service (above) collects its key. Nothing is sent to anyone.</p>
              </>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {preview.total_missing > 0 && (
                <Button disabled={busy === 'give'} onClick={() => void giveEveryone()}>
                  {busy === 'give' ? 'Giving' : `Give ${preview.total_missing} ${preview.total_missing === 1 ? 'person' : 'people'} their assistant`}
                </Button>
              )}
              <Button variant="ghost" onClick={() => setPreview(null)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <Button icon={<Wand2 size={14} aria-hidden="true" />} disabled={enabledCount === 0 || busy === 'preview'} onClick={() => void showPreview()}>
            Give everyone their assistant
          </Button>
        )}
      </div>
    </section>
  );
}
