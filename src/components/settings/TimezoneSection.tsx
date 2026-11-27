'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Globe } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Popover } from '@/components/ui/Popover';
import { toast } from '@/components/ui/Toast';
import { browserTimeZone, profileTimeZone } from '@/lib/time-zone';

/**
 * The member's time zone, picked from every zone grouped by UTC offset: the
 * one the app shows times in and saves repeats and schedules in
 * (lib/time-zone). Until it is set, the browser's zone stands in, and the
 * first sign-in saves it.
 */
export function TimezoneSection() {
  const { team, updateTeamMember } = useApp();
  const { teamMemberId } = useAuth();
  const currentMember = team.find((m) => m.id === teamMemberId);

  const [timezone, setTimezone] = useState('UTC');
  const [tzSearch, setTzSearch] = useState('');
  const [tzDropdownOpen, setTzDropdownOpen] = useState(false);

  // Hydrate once per member, as the other personal settings do.
  useEffect(() => {
    if (currentMember?.timezone) {
      setTimezone(currentMember.timezone);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMember?.id]);

  const tzEntries = useMemo(() => {
    let zones: string[];
    try {
      zones = Intl.supportedValuesOf('timeZone');
    } catch {
      zones = [
        'UTC',
        'America/New_York',
        'America/Chicago',
        'America/Denver',
        'America/Phoenix',
        'America/Los_Angeles',
        'America/Anchorage',
        'Pacific/Honolulu',
        'Europe/London',
        'Europe/Berlin',
        'Europe/Paris',
        'Asia/Tokyo',
        'Asia/Shanghai',
        'Asia/Kolkata',
        'Australia/Sydney',
      ];
    }

    const now = Date.now();
    return zones
      .map((tz) => {
        // Extract the UTC offset label (e.g. "GMT-7", "GMT+5:30")
        try {
          const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            timeZoneName: 'shortOffset',
          }).formatToParts(now);
          const raw = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT';
          // Convert "GMT" → "UTC+0", "GMT-7" → "UTC-7", "GMT+5:30" → "UTC+5:30"
          const label = raw === 'GMT' ? 'UTC+0' : raw.replace('GMT', 'UTC');
          // Parse offset to minutes for sorting
          const match = label.match(/UTC([+-])(\d+)(?::(\d+))?/);
          const offsetMin = match
            ? (match[1] === '+' ? 1 : -1) * (parseInt(match[2]) * 60 + parseInt(match[3] || '0'))
            : 0;
          return { id: tz, label, offsetMin };
        } catch {
          return { id: tz, label: 'UTC+0', offsetMin: 0 };
        }
      })
      .sort((a, b) => a.offsetMin - b.offsetMin || a.id.localeCompare(b.id));
  }, []);

  const filteredTzEntries = useMemo(() => {
    const entries = tzSearch
      ? tzEntries.filter((e) => {
          const q = tzSearch.toLowerCase();
          return e.id.toLowerCase().includes(q) || e.label.toLowerCase().includes(q);
        })
      : tzEntries;

    // Group by offset label
    const groups: { label: string; items: typeof entries }[] = [];
    let currentLabel = '';
    for (const entry of entries) {
      if (entry.label !== currentLabel) {
        currentLabel = entry.label;
        groups.push({ label: currentLabel, items: [] });
      }
      groups[groups.length - 1].items.push(entry);
    }
    return groups;
  }, [tzEntries, tzSearch]);

  const handleTimezoneChange = (tz: string) => {
    if (!teamMemberId) return;
    setTimezone(tz);
    setTzDropdownOpen(false);
    setTzSearch('');
    void updateTeamMember(teamMemberId, { timezone: tz, timezone_set: true }).then((saved) => {
      if (saved) toast('success', `Time zone set to ${tz.replace(/_/g, ' ')}`);
    });
  };

  // Not chosen yet: the app uses the browser's zone meanwhile (profileTimeZone).
  const unset = !!currentMember && profileTimeZone(currentMember) !== currentMember.timezone;
  const showingZone = unset ? browserTimeZone() : timezone;

  // Anchor for the portaled timezone dropdown (Popover handles outside-click).
  const tzRef = useRef<HTMLDivElement>(null);

  return (
    <section
      id="timezone"
      className={`rounded-xl border p-4 lg:p-6 scroll-mt-6 ${
        unset
          ? 'bg-amber-500/15 border-amber-500/30'
          : 'bg-surface-raised border-white/[0.08]'
      }`}
    >
      <div className="flex items-center gap-3 mb-4">
        <div
          className={`p-2 rounded-lg ${unset ? 'bg-amber-500/15' : 'bg-emerald-500/15'}`}
        >
          <Globe
            className={unset ? 'text-amber-300' : 'text-emerald-300'}
            size={20}
          />
        </div>
        <div className="flex-1">
          <h2 className="font-semibold text-white">Time zone</h2>
          <p className="text-sm text-zinc-400">
            Times across the app show in this zone, and repeats and schedules you set run in it.
          </p>
        </div>
      </div>

      {unset && (
        <div role="status" className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/15 px-3 py-2.5">
          <p className="text-sm text-amber-300">
            Not set yet, so times show in your browser&apos;s zone, <span className="font-semibold">{showingZone.replace(/_/g, ' ')}</span>. Pick yours below to keep it on every device.
          </p>
        </div>
      )}

      <div className="relative" ref={tzRef}>
        <button
          type="button"
          onClick={() => setTzDropdownOpen(!tzDropdownOpen)}
          className={`w-full md:w-96 flex items-center justify-between px-3 py-2 text-sm border rounded-lg hover:border-white/[0.12] transition-colors text-left ${
            unset
              ? 'bg-surface-raised border-amber-500/30'
              : 'bg-surface-raised border-white/[0.08]'
          }`}
        >
          <span className="text-white">{unset ? 'Pick your time zone' : timezone.replace(/_/g, ' ')}</span>
          <span className="text-zinc-500 text-xs font-mono">
            {tzEntries.find((e) => e.id === showingZone)?.label || 'UTC+0'}
          </span>
        </button>

        <Popover
          anchorRef={tzRef}
          open={tzDropdownOpen}
          onClose={() => {
            setTzDropdownOpen(false);
            setTzSearch('');
          }}
          align="start"
          matchAnchorWidth
          className="bg-surface-raised border border-white/[0.08] rounded-lg shadow-lg"
        >
          <div className="p-2 border-b border-white/[0.06]">
            <input
              type="text"
              value={tzSearch}
              onChange={(e) => setTzSearch(e.target.value)}
              placeholder="Search zones or offset, like UTC-7"
              className="w-full px-3 py-1.5 text-sm bg-white/[0.03] border border-white/[0.08] rounded-md outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500/30"
              autoFocus
            />
          </div>
          <div className="max-h-72 overflow-y-auto">
            {filteredTzEntries.length === 0 ? (
              <p className="px-3 py-2 text-sm text-zinc-500">No matching time zones</p>
            ) : (
              filteredTzEntries.map((group) => (
                <div key={group.label}>
                  <div className="sticky top-0 bg-white/[0.03] px-3 py-1 text-[11px] font-semibold text-zinc-500 uppercase tracking-wide font-mono border-b border-white/[0.06]">
                    {group.label}
                  </div>
                  {group.items.map((entry) => (
                    <button
                      key={entry.id}
                      onClick={() => handleTimezoneChange(entry.id)}
                      className={`w-full text-left px-3 py-1.5 text-sm hover:bg-white/[0.03] transition-colors flex items-center justify-between ${
                        entry.id === timezone
                          ? 'text-brand-300 font-medium bg-brand-500/15'
                          : 'text-zinc-300'
                      }`}
                    >
                      <span>{entry.id.replace(/_/g, ' ')}</span>
                      {entry.id === timezone && (
                        <Check size={14} className="text-brand-300 flex-shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </Popover>
      </div>
    </section>
  );
}
