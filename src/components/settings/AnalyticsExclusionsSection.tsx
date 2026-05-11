'use client';

/**
 * Admin-managed IP exclusion list for the portal analytics dashboard.
 *
 * Lives in its own settings section (not under Business Info) because it's
 * analytics config, not invoice/billing config — they only share storage on
 * the singleton business_settings row.
 *
 * Save semantics match the rest of the settings sections: edit locally, hit
 * Save, the singleton row is patched.
 */

import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, ShieldOff } from 'lucide-react';
import { useApp } from '@/lib/store';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { useDemo } from '@/lib/demo-context';
import type { ExcludedIp } from '@/lib/types';

/** Lenient validator for the IP-entry form. Accepts IPv4 dotted-quad and
 *  most IPv6 shapes (including '::1'). The portal analytics filter does a
 *  literal string match, so anything more strict here would just reject
 *  legitimate entries from admins who paste their address. */
function isPlausibleIp(value: string): boolean {
  const v = value.trim();
  if (v.length === 0 || v.length > 45) return false;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)) {
    return v.split('.').every((p) => Number(p) >= 0 && Number(p) <= 255);
  }
  if (/^[0-9a-fA-F:]+$/.test(v) && v.includes(':')) return true;
  return false;
}

export function AnalyticsExclusionsSection() {
  const { businessSettings, updateBusinessSettings } = useApp();
  const { isDemoMode } = useDemo();

  const [excludedIps, setExcludedIps] = useState<ExcludedIp[]>([]);
  const [newIp, setNewIp] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [detectingIp, setDetectingIp] = useState(false);
  const [saving, setSaving] = useState(false);
  // The "Detect IP" button hits /api/whats-my-ip which reads the request's
  // IP from forwarded headers. On localhost that's always ::1 / 127.0.0.1,
  // which isn't useful as an exclusion entry — so we hide the button there
  // and let admins paste their IP manually instead.
  const [isLocalhost, setIsLocalhost] = useState(false);

  useEffect(() => {
    if (!businessSettings) return;
    setExcludedIps(businessSettings.excluded_ips ?? []);
  }, [businessSettings?.id]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const host = window.location.hostname;
    setIsLocalhost(host === 'localhost' || host === '127.0.0.1' || host === '::1');
  }, []);

  const isDirty = !!businessSettings && (
    excludedIps.length !== (businessSettings.excluded_ips ?? []).length ||
    excludedIps.some((e, i) => {
      const original = businessSettings.excluded_ips?.[i];
      return !original || original.ip !== e.ip || original.label !== e.label;
    })
  );

  const handleSave = async () => {
    if (!isDirty) return;
    setSaving(true);
    try {
      await updateBusinessSettings({ excluded_ips: excludedIps });
      toast('success', 'Analytics exclusions saved');
    } finally {
      setSaving(false);
    }
  };

  const handleAddIp = () => {
    const ip = newIp.trim();
    const label = newLabel.trim();
    if (!ip) {
      toast('error', 'Enter an IP address');
      return;
    }
    if (!isPlausibleIp(ip)) {
      toast('error', 'That doesn’t look like a valid IP address');
      return;
    }
    if (excludedIps.some((e) => e.ip === ip)) {
      toast('error', 'That IP is already in the list');
      return;
    }
    setExcludedIps([...excludedIps, { ip, label: label || 'Unlabeled' }]);
    setNewIp('');
    setNewLabel('');
  };

  const handleRemoveIp = (ip: string) => {
    setExcludedIps(excludedIps.filter((e) => e.ip !== ip));
  };

  const handleDetectMyIp = async () => {
    setDetectingIp(true);
    try {
      const res = await fetch('/api/whats-my-ip');
      if (!res.ok) {
        toast('error', 'Could not detect your IP');
        return;
      }
      const { ip } = await res.json();
      if (!ip) {
        toast('error', 'Could not detect your IP');
        return;
      }
      const bare = String(ip).replace(/\/(?:32|128)$/, '');
      setNewIp(bare);
    } catch {
      toast('error', 'Could not detect your IP');
    } finally {
      setDetectingIp(false);
    }
  };

  return (
    <section className="bg-white rounded-xl border border-zinc-200 p-4 lg:p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-zinc-100 rounded-lg">
          <ShieldOff className="text-zinc-600" size={20} />
        </div>
        <div>
          <h2 className="font-semibold text-zinc-900">Analytics Exclusions</h2>
          <p className="text-sm text-zinc-500">
            Hide traffic from these IPs in portal analytics
          </p>
        </div>
      </div>

      {excludedIps.length > 0 && (
        <div className="rounded-lg border border-zinc-200 divide-y divide-zinc-100 mb-4 overflow-hidden">
          {excludedIps.map((entry) => (
            <div key={entry.ip} className="flex items-center justify-between gap-3 px-3 py-2 bg-white">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-mono text-zinc-800 truncate">{entry.ip}</div>
                <div className="text-xs text-zinc-500 truncate">{entry.label}</div>
              </div>
              <button
                onClick={() => handleRemoveIp(entry.ip)}
                disabled={isDemoMode}
                className="p-1.5 rounded-md text-zinc-400 hover:text-rose-600 hover:bg-rose-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500"
                aria-label={`Remove ${entry.ip}`}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2">
        <Input
          label="IP address"
          value={newIp}
          onChange={(e) => setNewIp(e.target.value)}
          placeholder="70.188.218.1"
          disabled={isDemoMode}
        />
        <Input
          label="Label"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Developer's home"
          disabled={isDemoMode}
        />
        <div className="flex items-end gap-2">
          {!isLocalhost && (
            <Button
              variant="secondary"
              onClick={handleDetectMyIp}
              disabled={detectingIp || isDemoMode}
            >
              {detectingIp ? <Loader2 size={14} className="animate-spin" /> : 'Detect IP'}
            </Button>
          )}
          <Button onClick={handleAddIp} disabled={!newIp.trim() || isDemoMode}>
            <Plus size={14} className="mr-1" />
            Add
          </Button>
        </div>
      </div>

      <div className="mt-4">
        <Button onClick={handleSave} disabled={!isDirty || saving || isDemoMode}>
          {saving ? <><Loader2 size={14} className="animate-spin mr-1.5" />Saving...</> : 'Save Exclusions'}
        </Button>
      </div>
    </section>
  );
}
