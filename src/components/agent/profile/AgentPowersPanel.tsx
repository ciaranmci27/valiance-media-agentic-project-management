'use client';

import { useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { apiScopesFor, isModuleEnabled } from '@/lib/access-control';
import { invalidateTables } from '@/lib/query-cache';
import { workspaceApi } from '@/lib/agent-workspace';
import type { AgentPowersView } from '@/lib/api/agent-powers';
import type { GrantLimits } from '@/lib/permission-grid';
import { PermissionGrid } from '@/components/access/PermissionGrid';
import { TaskPanelShell } from '@/components/tasks/TaskPanelShell';
import { PanelHeader } from '@/components/ui/PanelHeader';
import { SaveBar } from '@/components/ui/SaveBar';
import { useDiscardGuard } from '@/components/ui/useDiscardGuard';
import { toast } from '@/components/ui/Toast';
import { DEMO_NOTICE } from '@/components/agent/profile/LimitsPanel';

/**
 * What an agent may do, edited in the side panel (DESIGN.md Rules 1, 10
 * and 19): the one PermissionGrid, ticked with the agent's one list (its
 * keys and its own powers together). Saving puts the list on every live key
 * and takes away an own power left out (PUT .../powers). A power the agent's
 * role lacks is locked unless you are an Owner (who gives it with the save);
 * what you do not hold yourself is locked too.
 */
export function AgentPowersPanel({ agentId, agentName, powers, onClose }: {
  agentId: string;
  agentName: string;
  powers: AgentPowersView;
  onClose: () => void;
}) {
  const { access } = useAuth();
  const { isDemoMode } = useDemo();
  const [value, setValue] = useState<string[]>(() => [...powers.scopes]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = value.length !== powers.scopes.length || value.some((scope) => !powers.scopes.includes(scope));
  // Out of step, Save shows at once (to line the keys up), but only a real edit asks before closing.
  const dirty = changed || powers.out_of_step;
  const guard = useDiscardGuard(changed && !saving, onClose, `What ${agentName} may do is not saved. Leaving discards it.`);
  const limits = useMemo<GrantLimits>(() => ({
    channel: 'api',
    holderIsAgent: true,
    // An Owner gives what the role lacks with the save; anyone else gives only what it holds.
    holderHolds: powers.can_give_beyond_role ? null : powers.held,
    holderName: agentName,
    editorHolds: isDemoMode ? null : apiScopesFor(access),
  }), [access, agentName, isDemoMode, powers.can_give_beyond_role, powers.held]);

  const save = async () => {
    if (value.length === 0) { setError(`Choose at least one thing ${agentName} may do.`); return; }
    if (isDemoMode) { toast('info', DEMO_NOTICE); onClose(); return; }
    setSaving(true);
    setError(null);
    try {
      await workspaceApi(`/api/workspace/agents/${encodeURIComponent(agentId)}/powers`, { method: 'PUT', body: { scopes: value } });
      invalidateTables(['api_keys', 'team_member_permissions']);
      toast('success', powers.live_keys.length > 1 ? `Saved on all ${powers.live_keys.length} keys` : 'Saved');
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <TaskPanelShell
      labelledBy="agent-powers-title"
      onClose={guard.requestClose}
      after={guard.dialog}
      header={<PanelHeader id="agent-powers-title" title={`What ${agentName} may do`} onClose={guard.requestClose} />}
      footer={(
        <SaveBar
          placement="panel"
          dirty={dirty}
          saving={saving}
          onDiscard={() => { setValue([...powers.scopes]); setError(null); if (!powers.out_of_step) onClose(); }}
          onSave={() => void save()}
          message={error ?? (powers.out_of_step ? 'Saving lines up every key' : 'Unsaved changes')}
        />
      )}
    >
      <div className="space-y-4 px-5 py-4">
        <p className="text-sm text-zinc-300">
          One list for {agentName}: every key it has carries exactly this, so nothing it was given hides off its keys.
          {powers.live_keys.length > 1 ? ` It has ${powers.live_keys.length} working keys; saving updates them all.` : ''}
        </p>
        {powers.out_of_step && (
          <p role="status" className="rounded-lg bg-amber-500/[0.14] px-3.5 py-2.5 text-sm text-amber-300">
            Its keys and its powers differ now. This list shows them together; saving puts it on every key.
          </p>
        )}
        {error && <p role="alert" className="rounded-lg bg-red-500/[0.12] px-3.5 py-2.5 text-sm text-red-300">{error}</p>}
        <PermissionGrid
          value={value}
          onChange={(next) => { setValue(next); if (error) setError(null); }}
          limits={limits}
          label={`What ${agentName} may do`}
          isAreaVisible={(area) => area.module === 'core' || isDemoMode || isModuleEnabled(access, area.module)}
        />
      </div>
    </TaskPanelShell>
  );
}
