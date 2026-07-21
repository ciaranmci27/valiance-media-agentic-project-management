'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, DollarSign } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import type { TeamMember, TeamMemberHourlyRate } from '@/lib/types';
import { DateInput } from '@/components/ui/inputs/DateInput';
import { NumberInput } from '@/components/ui/inputs/NumberInput';

type PayrollRatesResponse = { rates?: TeamMemberHourlyRate[] };

const money = (value: number) => value.toLocaleString('en-US', {
  style: 'currency',
  currency: 'USD',
});

export function CompensationRateModal({
  isOpen,
  onClose,
  member,
}: {
  isOpen: boolean;
  onClose: () => void;
  member: TeamMember | null;
}) {
  const [rates, setRates] = useState<TeamMemberHourlyRate[]>([]);
  const [amount, setAmount] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!member) return;
    setLoading(true);
    try {
      const response = await fetch('/api/workspace/payroll', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Failed to load compensation rates');
      const data = payload.data as PayrollRatesResponse;
      setRates((data.rates || [])
        .filter((rate) => rate.member_id === member.id)
        .sort((a, b) => b.effective_at.localeCompare(a.effective_at)));
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Failed to load compensation rates');
    } finally {
      setLoading(false);
    }
  }, [member]);

  useEffect(() => {
    if (!isOpen) return;
    setAmount('');
    setEffectiveDate(new Date().toISOString().slice(0, 10));
    void load();
  }, [isOpen, load]);

  const currentRate = useMemo(() => {
    const now = new Date().toISOString();
    return rates.find((rate) => rate.effective_at <= now) || null;
  }, [rates]);

  const scheduleRate = async () => {
    if (!member) return;
    const hourlyRate = Number(amount);
    if (!Number.isFinite(hourlyRate) || hourlyRate < 0 || !effectiveDate) {
      toast('error', 'Enter a valid hourly rate and effective date');
      return;
    }

    setSaving(true);
    try {
      const response = await fetch('/api/workspace/payroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'schedule_rate',
          member_id: member.id,
          hourly_rate: hourlyRate,
          effective_at: `${effectiveDate}T00:00:00.000Z`,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Failed to schedule compensation rate');
      toast('success', `Compensation rate scheduled for ${member.name}`);
      setAmount('');
      await load();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Failed to schedule compensation rate');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={member ? `${member.name} · Compensation` : 'Compensation'} size="lg">
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              <DollarSign size={14} /> Current rate
            </div>
            <p className="mt-2 text-2xl font-semibold tabular-nums text-zinc-900">
              {loading ? 'Loading...' : currentRate ? `${money(Number(currentRate.hourly_rate))}/hr` : 'Not set'}
            </p>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              <CalendarClock size={14} /> Effective since
            </div>
            <p className="mt-2 text-sm font-medium text-zinc-900">
              {currentRate ? new Date(currentRate.effective_at).toLocaleDateString() : 'No active rate'}
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-200 p-4">
          <h3 className="text-sm font-semibold text-zinc-900">Schedule a new rate</h3>
          <p className="mt-1 text-xs text-zinc-500">New time sessions use the rate effective when the session starts. Existing sessions do not change.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <NumberInput label="Hourly rate" min={0} step={0.01} prefix="$" suffix="/hr" value={amount === '' ? '' : Number(amount)} onChange={(value) => setAmount(value === '' ? '' : String(value))} />
            <DateInput label="Effective date" value={effectiveDate} onChange={setEffectiveDate} />
          </div>
          <div className="mt-4 flex justify-end">
            <Button onClick={scheduleRate} disabled={saving || !member}>{saving ? 'Scheduling...' : 'Schedule rate'}</Button>
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-zinc-900">Rate history</h3>
          <div className="mt-2 overflow-hidden rounded-xl border border-zinc-200">
            {loading ? (
              <p className="p-4 text-sm text-zinc-500">Loading rate history...</p>
            ) : rates.length === 0 ? (
              <p className="p-4 text-sm text-zinc-500">No compensation rates have been scheduled.</p>
            ) : rates.map((rate) => (
              <div key={rate.id} className="flex items-center justify-between border-b border-zinc-100 px-4 py-3 last:border-b-0">
                <span className="text-sm text-zinc-600">{new Date(rate.effective_at).toLocaleDateString()}</span>
                <span className="text-sm font-semibold tabular-nums text-zinc-900">{money(Number(rate.hourly_rate))}/hr</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
