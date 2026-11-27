'use client';

/**
 * Settings > Workspace > AI provider plans (Owners only, with AI agents on):
 * what a provider's subscription costs a month, per seat. Agents on a
 * subscription report tokens with no price, so their cost reads as unpriced;
 * with a plan set, Agents > Analytics also shows the subscription's monthly
 * cost and an estimate of the selection's share by unpriced tokens, always
 * labelled as an estimate and never added to measured model cost.
 *
 * Saving a provider that is already listed changes its plan. Each change
 * saves at once and leaves one line.
 */

import { useState } from 'react';
import { Loader2, Plus, Receipt, Trash2 } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { Input } from '@/components/ui/Input';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ProviderPicker } from '@/components/ui/ProviderPicker';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { createClient } from '@/lib/supabase/client';
import { loadRead, useRead } from '@/lib/query-cache';
import { formatMoney } from '@/lib/format';
import { providerPlansRead, type ProviderPlanRow } from '@/lib/agent-analytics-reads';
import { AI_PROVIDER_CHOICES, logoLabel } from '@/lib/logos';

/** A plan's provider in words and logo: a listed one, else the name typed for Other. */
function planProvider(provider: string): { name: string; logo: string } {
  const choice = AI_PROVIDER_CHOICES.find((c) => c.value === provider.trim().toLowerCase());
  return choice ? { name: choice.label, logo: choice.logo ?? choice.value } : { name: logoLabel(provider), logo: provider };
}

export function ProviderPlansSection() {
  const read = useRead(providerPlansRead);
  const plans = read.data ?? [];
  const [provider, setProvider] = useState('');
  const [cost, setCost] = useState('');
  const [seats, setSeats] = useState('1');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [line, setLine] = useState<string | null>(null);

  const refresh = () => loadRead(providerPlansRead, { force: true });

  const save = async () => {
    const name = provider.trim();
    const monthly = Number(cost);
    const seatCount = Number(seats || '1');
    if (!name) return toast('error', 'Pick the provider, or choose Other and type its name as your agents report it');
    if (!Number.isFinite(monthly) || monthly < 0) return toast('error', 'Enter the monthly cost per seat in US dollars');
    if (!Number.isInteger(seatCount) || seatCount < 1) return toast('error', 'Seats is a whole number, 1 or more');
    setSaving(true);
    try {
      const supabase = createClient();
      const existing = plans.find((p) => p.provider.toLowerCase() === name.toLowerCase());
      const fields = { provider: name, monthly_cost_usd: monthly, seats: seatCount, notes: notes.trim() };
      const { error } = existing
        ? await supabase.from('provider_plans').update(fields).eq('id', existing.id)
        : await supabase.from('provider_plans').insert(fields);
      if (error) throw error;
      await refresh();
      setLine(`${existing ? 'Changed' : 'Added'} ${planProvider(name).name}: ${formatMoney(monthly * seatCount)} a month.`);
      setProvider('');
      setCost('');
      setSeats('1');
      setNotes('');
    } catch (error) {
      console.error('Failed to save provider plan', error);
      toast('error', 'Not saved. Only an Owner can change provider plans.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (plan: ProviderPlanRow) => {
    setSaving(true);
    try {
      const { error } = await createClient().from('provider_plans').delete().eq('id', plan.id);
      if (error) throw error;
      await refresh();
      setLine(`Removed ${planProvider(plan.provider).name}.`);
    } catch (error) {
      console.error('Failed to remove provider plan', error);
      toast('error', 'Not removed. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6">
      <SettingsSectionHeader
        icon={Receipt}
        title="AI provider plans"
        description="What a provider's subscription costs a month. Agents > Analytics shows it beside measured model cost, as an estimate shared out by tokens, never added to it."
      />

      {plans.length > 0 && (
        <div className="rounded-lg border border-white/[0.08] divide-y divide-white/[0.06] mb-4 overflow-hidden">
          {plans.map((plan) => (
            <div key={plan.id} className="flex items-center justify-between gap-3 px-3 py-2 bg-surface-raised">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2 text-sm text-zinc-100">
                  <ProviderLogo provider={planProvider(plan.provider).logo} label={planProvider(plan.provider).name} size="sm" decorative />
                  <span className="truncate">
                    {planProvider(plan.provider).name}
                    <span className="text-zinc-400"> · {formatMoney(plan.monthlyCostUsd * plan.seats)} a month</span>
                  </span>
                </div>
                <div className="text-xs text-zinc-400 truncate">
                  {formatMoney(plan.monthlyCostUsd)} per seat · {plan.seats} {plan.seats === 1 ? 'seat' : 'seats'}{plan.notes ? ` · ${plan.notes}` : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void remove(plan)}
                disabled={saving}
                className="p-1.5 rounded-md text-zinc-500 hover:text-rose-400 hover:bg-rose-500/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500"
                aria-label={`Remove ${planProvider(plan.provider).name}`}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <ProviderPicker
        label="Provider"
        choices={AI_PROVIDER_CHOICES}
        value={provider}
        onChange={setProvider}
        disabled={saving}
        other={{ description: 'Any other provider', name: { label: 'Provider name', placeholder: 'As your agents report it, like mistral' } }}
      />
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-[10rem_7rem]">
        <Input label="Per seat, a month" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="200" />
        <Input label="Seats" inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value)} placeholder="1" />
      </div>
      <div className="mt-2 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
        <Input label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Max plan for the builder agent" maxLength={500} />
        <div className="flex items-end">
          <Button onClick={() => void save()} disabled={saving || !provider.trim() || !cost.trim()}>
            {saving ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Plus size={14} className="mr-1" />}
            Save plan
          </Button>
        </div>
      </div>
      <p className="mt-3 text-xs text-zinc-500">
        Plans match your agents&apos; usage by provider. US dollars.
      </p>

      {line && <p role="status" className="mt-3 text-xs text-zinc-400">{line}</p>}
    </section>
  );
}
