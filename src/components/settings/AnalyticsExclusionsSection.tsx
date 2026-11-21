'use client';

/**
 * Admin-managed IP exclusion list for the portal analytics dashboard.
 *
 * Lives under Settings > Client portal: it filters portal analytics, so it
 * goes with the portal. It shares storage with the invoice details on the
 * singleton business_settings row, nothing more.
 *
 * Add and remove save at once and leave one line with Undo in place, which
 * puts the list back as it was and saves that.
 */

import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, ShieldOff } from 'lucide-react';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
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

  const excludedIps: ExcludedIp[] = businessSettings?.excluded_ips ?? [];
  const [newIp, setNewIp] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [detectingIp, setDetectingIp] = useState(false);
  const [saving, setSaving] = useState(false);
  // The last change, with the list as it was before it, for Undo.
  const [receipt, setReceipt] = useState<{ text: string; previous: ExcludedIp[] } | null>(null);
  // The "Detect IP" button hits /api/whats-my-ip which reads the request's
  // IP from forwarded headers. On localhost that's always ::1 / 127.0.0.1,
  // which isn't useful as an exclusion entry, so we hide the button there
  // and let admins paste their IP manually instead.
  const [isLocalhost, setIsLocalhost] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const host = window.location.hostname;
    setIsLocalhost(host === 'localhost' || host === '127.0.0.1' || host === '::1');
  }, []);

  /** Saves the list; on success the receipt line offers Undo (none for an undo itself). */
  const save = async (next: ExcludedIp[], text: string | null) => {
    if (saving) return false;
    const previous = excludedIps;
    setSaving(true);
    try {
      const ok = await updateBusinessSettings({ excluded_ips: next });
      if (ok) setReceipt(text ? { text, previous } : null);
      return ok;
    } finally {
      setSaving(false);
    }
  };

  const handleAddIp = async () => {
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
    if (await save([...excludedIps, { ip, label: label || 'Unlabeled' }], `Added ${ip}.`)) {
      setNewIp('');
      setNewLabel('');
    }
  };

  const handleRemoveIp = (ip: string) => {
    void save(excludedIps.filter((e) => e.ip !== ip), `Removed ${ip}.`);
  };

  const handleUndo = () => {
    if (receipt) void save(receipt.previous, null);
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
    <section className="glass-card rounded-xl p-4 lg:p-6">
      <SettingsSectionHeader
        icon={ShieldOff}
        title="Analytics exclusions"
        description="Visits from these IP addresses are left out of every project's portal analytics."
      />
      <p className="-mt-3 mb-5 text-xs text-zinc-500">
        Each project&apos;s portal is switched on from that project&apos;s Client portal tab.
      </p>

      {excludedIps.length > 0 && (
        <div className="rounded-lg border border-white/[0.08] divide-y divide-white/[0.06] mb-4 overflow-hidden">
          {excludedIps.map((entry) => (
            <div key={entry.ip} className="flex items-center justify-between gap-3 px-3 py-2 bg-surface-raised">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-mono text-zinc-100 truncate">{entry.ip}</div>
                <div className="text-xs text-zinc-400 truncate">{entry.label}</div>
              </div>
              <button
                type="button"
                onClick={() => handleRemoveIp(entry.ip)}
                disabled={isDemoMode || saving}
                className="p-1.5 rounded-md text-zinc-500 hover:text-rose-400 hover:bg-rose-500/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-500"
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
          placeholder="192.0.2.1"
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
          <Button onClick={handleAddIp} disabled={!newIp.trim() || isDemoMode || saving}>
            {saving ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Plus size={14} className="mr-1" />}
            Add
          </Button>
        </div>
      </div>

      {receipt && (
        <p role="status" className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
          {receipt.text}
          <button
            type="button"
            onClick={handleUndo}
            disabled={saving || isDemoMode}
            className="rounded font-medium text-brand-300 hover:text-brand-200 hover:underline disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Undo
          </button>
        </p>
      )}
    </section>
  );
}
