'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronDown, Pause, Play, Search, Trash2 } from 'lucide-react';
import { invalidateTables } from '@/lib/query-cache';
import {
  cleanSettings, roleLabel, settingsSummary, validateSettings, windowOf, INSTRUCTIONS_MAX, showMoreLabel,
} from '@/lib/agents-ui';
import { fieldErrorsFrom, workspaceApi, type ProjectAgentAssignment, type SettingsValues } from '@/lib/agent-workspace';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { RowActionsMenu } from '@/components/ui/RowActionsMenu';
import { toast } from '@/components/ui/Toast';
import { AgentAvatar, PresencePill } from '@/components/agent/AgentAvatar';
import { InstructionsField, SettingsForm } from '@/components/agent/SettingsForm';

/**
 * Agent assignments (pm.project_agents) as a calm list that holds a hundred:
 * one row each (who or where, role, template, status, a settings summary),
 * opening in place to its settings form and instructions, saved with one
 * PUT. Pause and resume act at once; remove leaves an Undo line in place.
 * The same list serves a project's Agents tab (rows are agents) and an
 * agent's Projects tab (rows are projects).
 */

const PAGE = 20;

export type AssignmentRow = ProjectAgentAssignment & { project_id: string; project_name?: string };

export async function saveAssignment(projectId: string, agentId: string, body: {
  status?: 'active' | 'paused';
  template_key?: string | null;
  settings?: SettingsValues;
  instructions?: string;
}) {
  await workspaceApi(`/api/workspace/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}`, { method: 'PUT', body });
  invalidateTables(['project_agents']);
}

async function removeAssignment(projectId: string, agentId: string) {
  await workspaceApi(`/api/workspace/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
  invalidateTables(['project_agents']);
}

export function AssignmentList({ rows, mode, canEdit, templateLabels, empty, toolbar }: {
  rows: AssignmentRow[];
  /** project: rows name agents (a project's Agents tab); agent: rows name projects (a profile). */
  mode: 'project' | 'agent';
  /** One answer for every row, or per row (an agent's owner edits only their own agents' rows). */
  canEdit: boolean | ((row: AssignmentRow) => boolean);
  templateLabels: ReadonlyMap<string, string>;
  empty: ReactNode;
  /** Actions beside the search (Add agent to project). */
  toolbar?: ReactNode;
}) {
  const [q, setQ] = useState('');
  const [pages, setPages] = useState(1);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [removed, setRemoved] = useState<AssignmentRow | null>(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? rows.filter((r) => [r.agent_name, r.project_name, r.agent_role, r.template_key && templateLabels.get(r.template_key)]
        .some((v) => typeof v === 'string' && v.toLowerCase().includes(needle)))
      : rows;
    return [...list].sort((a, b) => Number(a.status === 'paused') - Number(b.status === 'paused')
      || (mode === 'project' ? a.agent_name : a.project_name ?? '').localeCompare(mode === 'project' ? b.agent_name : b.project_name ?? ''));
  }, [rows, q, mode, templateLabels]);
  const { shown, hidden } = windowOf(filtered, pages, PAGE);
  const keyOf = (r: AssignmentRow) => `${r.project_id}:${r.agent_id}`;

  const undoRemove = async () => {
    if (!removed) return;
    const row = removed;
    setRemoved(null);
    try {
      await saveAssignment(row.project_id, row.agent_id, { status: row.status, template_key: row.template_key, settings: row.settings, instructions: row.instructions });
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not put it back');
    }
  };

  return (
    <div>
      {(rows.length > 6 || toolbar) && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          {rows.length > 6 && (
            <div className="w-full sm:w-64">
              <TextInput
                type="search"
                aria-label={mode === 'project' ? 'Search agents' : 'Search projects'}
                placeholder={mode === 'project' ? 'Search agents' : 'Search projects'}
                value={q}
                onChange={(v) => { setQ(v); setPages(1); }}
                leftIcon={Search}
                clearable
              />
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">{toolbar}</div>
        </div>
      )}

      {removed && (
        <p role="status" className="mb-3 flex items-center gap-3 rounded-xl bg-white/[0.04] px-4 py-2.5 text-sm text-zinc-300">
          Removed {mode === 'project' ? removed.agent_name : removed.project_name ?? 'the project'}.
          <button type="button" onClick={undoRemove} className="font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded">Undo</button>
        </p>
      )}

      {rows.length === 0 ? empty : filtered.length === 0 ? (
        <p className="py-10 text-center text-sm text-zinc-400">Nothing matches {`"${q}"`}.</p>
      ) : (
        <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-2xl bg-white/[0.02] ring-1 ring-inset ring-white/[0.06]">
          {shown.map((row) => (
            <AssignmentItem
              key={keyOf(row)}
              row={row}
              mode={mode}
              canEdit={typeof canEdit === 'function' ? canEdit(row) : canEdit}
              templateLabel={row.template_key ? templateLabels.get(row.template_key) ?? row.template_key : null}
              open={openKey === keyOf(row)}
              onToggle={() => setOpenKey(openKey === keyOf(row) ? null : keyOf(row))}
              onRemoved={() => { setRemoved(row); setOpenKey(null); }}
            />
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <div className="mt-3 flex justify-center">
          <Button variant="ghost" size="sm" onClick={() => setPages(pages + 1)}>{showMoreLabel(hidden, PAGE)}</Button>
        </div>
      )}
    </div>
  );
}

function AssignmentItem({ row, mode, canEdit, templateLabel, open, onToggle, onRemoved }: {
  row: AssignmentRow;
  mode: 'project' | 'agent';
  canEdit: boolean;
  templateLabel: string | null;
  open: boolean;
  onToggle: () => void;
  onRemoved: () => void;
}) {
  const [settings, setSettings] = useState<SettingsValues>(row.settings ?? {});
  const [instructions, setInstructions] = useState(row.instructions ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'save' | 'status' | 'remove' | null>(null);
  const schema = row.settings_schema ?? [];
  const dirty = JSON.stringify(cleanSettings(settings)) !== JSON.stringify(cleanSettings(row.settings ?? {})) || instructions !== (row.instructions ?? '');
  const paused = row.status === 'paused';
  const panelId = `assignment-${row.project_id}-${row.agent_id}`;

  const save = async () => {
    const local = validateSettings(schema, settings);
    if (instructions.length > INSTRUCTIONS_MAX) local.instructions = `Keep instructions under ${INSTRUCTIONS_MAX} characters.`;
    setErrors(local);
    if (Object.keys(local).length) return;
    setBusy('save');
    try {
      await saveAssignment(row.project_id, row.agent_id, { settings: cleanSettings(settings), instructions: instructions.trim() });
      toast('success', 'Saved');
    } catch (error) {
      setErrors(fieldErrorsFrom(error));
      toast('error', error instanceof Error ? error.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  };

  const setStatus = async (status: 'active' | 'paused') => {
    setBusy('status');
    try {
      await saveAssignment(row.project_id, row.agent_id, { status });
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not change it');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('remove');
    try {
      await removeAssignment(row.project_id, row.agent_id);
      onRemoved();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not remove it');
      setBusy(null);
    }
  };

  const title = mode === 'project' ? row.agent_name : row.project_name ?? 'Project';
  const href = mode === 'project' ? `/agent/${row.agent_id}` : `/projects/${row.project_id}?tab=agents`;

  return (
    <li className={paused ? 'bg-white/[0.01]' : ''}>
      <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
        {mode === 'project' ? (
          <AgentAvatar id={row.agent_id} name={row.agent_name} src={row.avatar_url} presence={paused ? 'paused' : null} size="md" />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <Link href={href} className="truncate text-sm font-semibold text-white hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded">{title}</Link>
            {row.agent_role && mode === 'project' && <span className="text-xs text-zinc-400">{roleLabel(row.agent_role)}</span>}
            {paused && <PresencePill presence="paused" />}
          </div>
          <p className="mt-0.5 truncate text-xs text-zinc-500">
            {[templateLabel ?? 'No template', settingsSummary(schema, row.settings ?? {}), row.instructions?.trim() ? 'Has instructions' : null].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={panelId}
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {canEdit ? 'Settings' : 'Details'}
            <ChevronDown size={14} className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
          {canEdit && (
            <RowActionsMenu
              label={`Actions for ${title}`}
              actions={[
                paused
                  ? { label: 'Resume', icon: <Play size={14} />, onClick: () => void setStatus('active') }
                  : { label: 'Pause here', icon: <Pause size={14} />, onClick: () => void setStatus('paused') },
                { label: mode === 'project' ? 'Remove from project' : 'Remove from this project', icon: <Trash2 size={14} />, variant: 'danger', divider: true, onClick: () => void remove() },
              ]}
            />
          )}
        </div>
      </div>
      {open && (
        <div id={panelId} className="animate-slideDown border-t border-white/[0.04] bg-white/[0.015] px-4 pb-5 pt-4 sm:px-5">
          <SettingsForm schema={schema} values={settings} onChange={setSettings} errors={errors} disabled={!canEdit || busy !== null} idPrefix={panelId} />
          <div className="mt-4">
            <InstructionsField id={`${panelId}-instructions`} value={instructions} onChange={setInstructions} error={errors.instructions} disabled={!canEdit || busy !== null} />
          </div>
          {canEdit && (
            <div className="mt-4 flex items-center justify-end gap-2">
              {dirty && (
                <Button variant="ghost" size="sm" onClick={() => { setSettings(row.settings ?? {}); setInstructions(row.instructions ?? ''); setErrors({}); }}>
                  Discard
                </Button>
              )}
              <Button size="sm" onClick={save} disabled={!dirty || busy !== null}>{busy === 'save' ? 'Saving' : 'Save'}</Button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
