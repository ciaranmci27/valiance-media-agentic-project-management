'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronDown, LogOut, Pause, Play, Search, Trash2 } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { invalidateTables } from '@/lib/query-cache';
import {
  cleanSettings, roleLabel, settingsDefaults, settingsSummary, validateSettings, windowOf, INSTRUCTIONS_MAX, showMoreLabel,
} from '@/lib/agents-ui';
import { fieldErrorsFrom, workspaceApi, type ProjectAgentAssignment, type SettingsField, type SettingsValues } from '@/lib/agent-workspace';
import { demoPutAssignment, demoRemoveAssignment, demoTakeOff } from '@/lib/demo-project-agents';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Select } from '@/components/ui/inputs/Select';
import { RowActionsMenu, type RowAction } from '@/components/ui/RowActionsMenu';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from '@/components/ui/Toast';
import { DEMO_NOTICE } from '@/components/agent/profile/LimitsPanel';
import { AgentAvatar, PresencePill } from '@/components/agent/AgentAvatar';
import { InstructionsField, SettingsForm } from '@/components/agent/SettingsForm';

/**
 * Agent assignments (pm.project_agents) as a calm list that holds a hundred:
 * one row each (who or where, role, template, status, a settings summary),
 * opening in place to its template, settings form and instructions, saved
 * with one PUT. Pause and resume act at once; removing the setup leaves an
 * Undo line in place for a few seconds and keeps the agent's project access
 * (a paused setup asks first: without it the agent works the project again).
 * Taking it off the project (useTakeOffProject) removes that access too, so
 * it asks first.
 * The same list serves a project's Agents tab (rows are agents) and an
 * agent's Projects tab (rows are projects). In the demo a project's Agents
 * tab changes the demo's copy (lib/demo-project-agents); a profile says
 * changes are not saved.
 */

const PAGE = 20;
/** How long the Undo line for a removed setup stays. */
const UNDO_MS = 10_000;

export type AssignmentRow = ProjectAgentAssignment & { project_id: string; project_name?: string };

/** A template a setup can follow: its key, name and settings form. */
export interface TemplateChoice { key: string; label: string; schema: SettingsField[] }

export interface AssignmentBodyInput {
  status?: 'active' | 'paused';
  template_key?: string | null;
  settings?: SettingsValues;
  instructions?: string;
}

/**
 * Saves a setup. demo: change the demo's copy instead (a project's Agents
 * tab), with schemaOf naming each template's settings form.
 */
export async function saveAssignment(projectId: string, agentId: string, body: AssignmentBodyInput, demo?: { schemaOf: (templateKey: string | null) => SettingsField[] }) {
  if (demo) demoPutAssignment(projectId, agentId, body, demo.schemaOf);
  else await workspaceApi(`/api/workspace/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}`, { method: 'PUT', body });
  invalidateTables(['project_agents']);
}

async function removeAssignment(projectId: string, agentId: string, demo = false) {
  if (demo) demoRemoveAssignment(projectId, agentId);
  else await workspaceApi(`/api/workspace/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
  invalidateTables(['project_agents']);
}

interface TakeOff { projectId: string; projectName: string; agentId: string; agentName: string; hasSetup: boolean }

/**
 * Takes an agent off a project: its project membership goes (the same
 * member change a project's Edit makes, so it needs project_members.manage
 * and a project the viewer reaches), and the database ends its setup there
 * with it. It loses access at once, so it asks first. Render `dialog` once
 * beside the rows. demoWrites: in the demo, change the demo's copy.
 */
export function useTakeOffProject(options: { demoWrites?: boolean } = {}) {
  const { projects, updateProject } = useApp();
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const [asking, setAsking] = useState<TakeOff | null>(null);
  const manageMembers = hasPermission(access, 'project_members.manage');
  const canTakeOff = (projectId: string) => isDemoMode || (manageMembers && projects.some((p) => p.id === projectId));

  const takeOff = async (target: TakeOff) => {
    if (isDemoMode) {
      if (!options.demoWrites) return void toast('info', DEMO_NOTICE);
      demoTakeOff(target.projectId, target.agentId);
      invalidateTables(['project_members', 'project_agents']);
      return void toast('success', `${target.agentName} is off ${target.projectName}`);
    }
    const project = projects.find((p) => p.id === target.projectId);
    if (!project) return void toast('error', 'You cannot change who is on that project');
    const saved = await updateProject(project.id, { member_ids: (project.member_ids ?? []).filter((id) => id !== target.agentId) });
    if (!saved) return;
    if (target.hasSetup) {
      // The database removes the setup with the membership; this covers a database before that update.
      try {
        await removeAssignment(target.projectId, target.agentId);
      } catch {
        // Already gone with the membership.
      }
    }
    invalidateTables(['project_members', 'project_agents']);
    toast('success', `${target.agentName} is off ${target.projectName}`);
  };

  const dialog = (
    <ConfirmDialog
      isOpen={!!asking}
      onClose={() => setAsking(null)}
      onConfirm={() => { if (asking) void takeOff(asking); setAsking(null); }}
      title={asking ? `Take ${asking.agentName} off ${asking.projectName}?` : 'Take it off this project?'}
      message={asking
        ? `It can no longer open ${asking.projectName} or work its tasks${asking.hasSetup ? ', and its settings and instructions there are removed' : ''}. Adding it back later starts a fresh setup.`
        : ''}
      confirmLabel="Take off"
      variant="danger"
      doubleConfirm={false}
    />
  );

  return { canTakeOff, request: setAsking, dialog };
}

export function AssignmentList({ rows, mode, canEdit, templateLabels, empty, toolbar, templates, canOpen, flags }: {
  rows: AssignmentRow[];
  /** project: rows name agents (a project's Agents tab); agent: rows name projects (a profile). */
  mode: 'project' | 'agent';
  /** One answer for every row, or per row (an agent's owner edits only their own agents' rows). */
  canEdit: boolean | ((row: AssignmentRow) => boolean);
  templateLabels: ReadonlyMap<string, string>;
  empty: ReactNode;
  /** Actions beside the search (Add agent to project). */
  toolbar?: ReactNode;
  /** The templates a setup can switch to ("Set up as"); left out, the template is not offered for change. */
  templates?: readonly TemplateChoice[];
  /** Whether the row's title links (an agent's profile opens only for agents.manage and its owners). */
  canOpen?: (row: AssignmentRow) => boolean;
  /** States the row carries beyond its own: the agent is suspended, or has lost its project access. */
  flags?: (row: AssignmentRow) => { suspended?: boolean; noAccess?: boolean };
}) {
  const [q, setQ] = useState('');
  const [pages, setPages] = useState(1);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [removed, setRemoved] = useState<AssignmentRow | null>(null);
  const [confirmPaused, setConfirmPaused] = useState<{ row: AssignmentRow; run: () => void } | null>(null);
  const demoWrites = mode === 'project';
  const takeOff = useTakeOffProject({ demoWrites });
  const { isDemoMode } = useDemo();

  // The Undo line goes after a few seconds; leaving the page takes it too.
  useEffect(() => {
    if (!removed) return;
    const timer = window.setTimeout(() => setRemoved(null), UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [removed]);

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
  const schemaOf = (row: AssignmentRow) => (key: string | null) => (key === row.template_key ? row.settings_schema ?? [] : templates?.find((t) => t.key === key)?.schema ?? []);

  const undoRemove = async () => {
    if (!removed) return;
    if (isDemoMode && !demoWrites) return void toast('info', DEMO_NOTICE);
    const row = removed;
    setRemoved(null);
    try {
      await saveAssignment(row.project_id, row.agent_id, { status: row.status, template_key: row.template_key, settings: row.settings, instructions: row.instructions },
        isDemoMode ? { schemaOf: schemaOf(row) } : undefined);
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
        <p role="status" className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-white/[0.04] px-4 py-2.5 text-sm text-zinc-300">
          Removed the setup on {mode === 'project' ? removed.agent_name : removed.project_name ?? 'the project'}. It keeps its access.
          <button type="button" onClick={undoRemove} className="rounded font-medium text-brand-300 hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">Undo</button>
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
              templates={templates}
              linked={canOpen ? canOpen(row) : true}
              flags={flags?.(row) ?? {}}
              demoWrites={demoWrites}
              open={openKey === keyOf(row)}
              onToggle={() => setOpenKey(openKey === keyOf(row) ? null : keyOf(row))}
              onRemoved={() => { setRemoved(row); setOpenKey(null); }}
              confirmPausedRemove={(run) => setConfirmPaused({ row, run })}
              onTakeOff={takeOff.canTakeOff(row.project_id)
                ? () => takeOff.request({ projectId: row.project_id, projectName: row.project_name ?? 'this project', agentId: row.agent_id, agentName: row.agent_name, hasSetup: true })
                : undefined}
            />
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <div className="mt-3 flex justify-center">
          <Button variant="ghost" size="sm" onClick={() => setPages(pages + 1)}>{showMoreLabel(hidden, PAGE)}</Button>
        </div>
      )}
      {takeOff.dialog}
      <ConfirmDialog
        isOpen={!!confirmPaused}
        onClose={() => setConfirmPaused(null)}
        onConfirm={() => { confirmPaused?.run(); setConfirmPaused(null); }}
        title={confirmPaused ? `Remove the paused setup on ${mode === 'project' ? confirmPaused.row.agent_name : confirmPaused.row.project_name ?? 'this project'}?` : 'Remove the paused setup?'}
        message={confirmPaused
          ? `The pause lives on the setup. Without it, ${confirmPaused.row.agent_name} keeps its access and starts working ${confirmPaused.row.project_name ?? 'this project'} again. To stop it here, keep the setup paused, or take it off the project.`
          : ''}
        confirmLabel="Remove and let it work"
        doubleConfirm={false}
      />
    </div>
  );
}

function AssignmentItem({ row, mode, canEdit, templateLabel, templates, linked, flags, demoWrites, open, onToggle, onRemoved, confirmPausedRemove, onTakeOff }: {
  row: AssignmentRow;
  mode: 'project' | 'agent';
  canEdit: boolean;
  templateLabel: string | null;
  templates?: readonly TemplateChoice[];
  linked: boolean;
  flags: { suspended?: boolean; noAccess?: boolean };
  /** In the demo, change the demo's copy (a project's Agents tab). */
  demoWrites: boolean;
  open: boolean;
  onToggle: () => void;
  onRemoved: () => void;
  /** Asks before removing a paused setup (removing it lifts the pause). */
  confirmPausedRemove: (run: () => void) => void;
  /** Present when the viewer may take the agent off this project (its access goes too). */
  onTakeOff?: () => void;
}) {
  const { isDemoMode } = useDemo();
  const [templateKey, setTemplateKey] = useState<string>(row.template_key ?? '');
  const [settings, setSettings] = useState<SettingsValues>(row.settings ?? {});
  const [instructions, setInstructions] = useState(row.instructions ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'save' | 'status' | 'remove' | null>(null);
  const templateChanged = templateKey !== (row.template_key ?? '');
  const schemaFor = (key: string | null) => (key === (row.template_key ?? null) || (!key && !row.template_key) ? row.settings_schema ?? [] : templates?.find((t) => t.key === key)?.schema ?? []);
  const schema = schemaFor(templateKey || null);
  const dirty = templateChanged
    || JSON.stringify(cleanSettings(settings)) !== JSON.stringify(cleanSettings(row.settings ?? {}))
    || instructions !== (row.instructions ?? '');
  const paused = row.status === 'paused';
  const panelId = `assignment-${row.project_id}-${row.agent_id}`;
  const blocked = isDemoMode && !demoWrites;
  const demo = isDemoMode ? { schemaOf: schemaFor } : undefined;
  const templateName = (key: string) => templates?.find((t) => t.key === key)?.label ?? key;

  const pickTemplate = (key: string) => {
    setTemplateKey(key);
    setErrors({});
    // A new template starts its settings over, from its own defaults (the server does the same).
    setSettings(key === (row.template_key ?? '') ? row.settings ?? {} : settingsDefaults(schemaFor(key || null)));
  };

  const save = async () => {
    if (blocked) return void toast('info', DEMO_NOTICE);
    const local = validateSettings(schema, settings);
    if (instructions.length > INSTRUCTIONS_MAX) local.instructions = `Keep instructions under ${INSTRUCTIONS_MAX} characters.`;
    setErrors(local);
    if (Object.keys(local).length) return;
    setBusy('save');
    try {
      await saveAssignment(row.project_id, row.agent_id, {
        ...(templateChanged ? { template_key: templateKey || null } : {}),
        settings: cleanSettings(settings),
        instructions: instructions.trim(),
      }, demo);
      toast('success', templateChanged ? `Saved. ${row.agent_name} now works here as ${templateKey ? templateName(templateKey) : 'no template'}.` : 'Saved');
    } catch (error) {
      setErrors(fieldErrorsFrom(error));
      toast('error', error instanceof Error ? error.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  };

  const setStatus = async (status: 'active' | 'paused') => {
    if (blocked) return void toast('info', DEMO_NOTICE);
    setBusy('status');
    try {
      await saveAssignment(row.project_id, row.agent_id, { status }, demo);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not change it');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (blocked) return void toast('info', DEMO_NOTICE);
    setBusy('remove');
    try {
      await removeAssignment(row.project_id, row.agent_id, isDemoMode);
      onRemoved();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not remove it');
      setBusy(null);
    }
  };

  const title = mode === 'project' ? row.agent_name : row.project_name ?? 'Project';
  const href = mode === 'project' ? `/agent/${row.agent_id}` : `/projects/${row.project_id}?tab=agents`;
  const titleClass = 'truncate text-sm font-semibold text-white';

  return (
    <li className={paused || flags.noAccess ? 'bg-white/[0.01]' : ''}>
      <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
        {mode === 'project' ? (
          <AgentAvatar id={row.agent_id} name={row.agent_name} src={row.avatar_url} presence={paused ? 'paused' : null} size="md" />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            {linked
              ? <Link href={href} className={`${titleClass} rounded hover:text-brand-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500`}>{title}</Link>
              : <span className={titleClass}>{title}</span>}
            {row.agent_role && mode === 'project' && <span className="text-xs text-zinc-400">{roleLabel(row.agent_role)}</span>}
            {paused && <PresencePill presence="paused" />}
            {flags.suspended && <span className="rounded-full bg-red-500/[0.14] px-2 py-0.5 text-[11px] font-medium text-red-300">Suspended</span>}
            {flags.noAccess && <span className="rounded-full bg-amber-500/[0.14] px-2 py-0.5 text-[11px] font-medium text-amber-300">No access</span>}
          </div>
          <p className="mt-0.5 truncate text-xs text-zinc-500">
            {flags.noAccess
              ? 'Not on the project any more, so it cannot work here. Remove the setup, or add it back under project members.'
              : [templateLabel ?? 'No template', settingsSummary(row.settings_schema ?? [], row.settings ?? {}), row.instructions?.trim() ? 'Has instructions' : null].filter(Boolean).join(' · ')}
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
          {(canEdit || onTakeOff) && (
            <RowActionsMenu
              label={`Actions for ${title}`}
              actions={[
                ...(canEdit ? [
                  paused
                    ? { label: 'Resume on this project', icon: <Play size={14} />, onClick: () => void setStatus('active') }
                    : { label: 'Pause on this project', icon: <Pause size={14} />, onClick: () => void setStatus('paused') },
                  {
                    label: 'Remove setup (it keeps access)',
                    icon: <Trash2 size={14} />,
                    divider: true,
                    onClick: () => (paused ? confirmPausedRemove(() => void remove()) : void remove()),
                  },
                ] : []) satisfies RowAction[],
                ...(onTakeOff ? [{ label: 'Take off this project', icon: <LogOut size={14} />, variant: 'danger' as const, divider: !canEdit, onClick: onTakeOff }] : []),
              ]}
            />
          )}
        </div>
      </div>
      {open && (
        <div id={panelId} className="animate-slideDown border-t border-white/[0.04] bg-white/[0.015] px-4 pb-5 pt-4 sm:px-5">
          {templates && canEdit && (
            <div className="mb-4 max-w-sm">
              <Select
                label="Set up as"
                visibleLabel="Set up as"
                value={templateKey}
                onChange={pickTemplate}
                options={[{ value: '', label: 'No template' }, ...templates.map((t) => ({ value: t.key, label: t.label }))]}
                searchable={templates.length > 7}
                disabled={busy !== null}
              />
              {templateChanged && (
                <p className="mt-1.5 text-xs text-amber-300">Its settings start over from {templateKey ? `the ${templateName(templateKey)} template` : 'nothing'}. Save to switch.</p>
              )}
            </div>
          )}
          <SettingsForm schema={schema} values={settings} onChange={setSettings} errors={errors} disabled={!canEdit || busy !== null} idPrefix={panelId} />
          <div className="mt-4">
            <InstructionsField id={`${panelId}-instructions`} value={instructions} onChange={setInstructions} error={errors.instructions} disabled={!canEdit || busy !== null} />
          </div>
          {canEdit && (
            <div className="mt-4 flex items-center justify-end gap-2">
              {dirty && (
                <Button variant="ghost" size="sm" onClick={() => { setTemplateKey(row.template_key ?? ''); setSettings(row.settings ?? {}); setInstructions(row.instructions ?? ''); setErrors({}); }}>
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
