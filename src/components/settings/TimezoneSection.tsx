'use client';

import { useEffect, useMemo, useState } from 'react';
import { Globe } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Select, type SelectOption } from '@/components/ui/inputs/Select';
import { toast } from '@/components/ui/Toast';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { browserTimeZone, profileTimeZone } from '@/lib/time-zone';
import { timeZoneChoice, timeZoneChoices, timeZoneKeywords } from '@/lib/time-zone-labels';

/**
 * The member's time zone, shown as a city and its offset ("Phoenix, UTC-7")
 * and searched by city, region, the zone's long name or the offset: the one
 * the app shows times in and saves repeats and schedules in (lib/time-zone).
 * Picking one saves it at once. Until it is set, the browser's zone stands
 * in, and the first sign-in saves it.
 */
export function TimezoneSection() {
  const { team, updateTeamMember } = useApp();
  const { teamMemberId } = useAuth();
  const currentMember = team.find((m) => m.id === teamMemberId);

  const [timezone, setTimezone] = useState('UTC');

  // Hydrate once per member, as the other personal settings do.
  useEffect(() => {
    if (currentMember?.timezone) setTimezone(currentMember.timezone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMember?.id]);

  // Not chosen yet: the app uses the browser's zone meanwhile (profileTimeZone).
  const unset = !!currentMember && profileTimeZone(currentMember) !== currentMember.timezone;

  const options = useMemo<SelectOption[]>(() => {
    const now = Date.now();
    return timeZoneChoices(now, timezone).map((choice) => ({
      value: choice.id,
      label: choice.label,
      detail: [choice.longName, choice.region].filter(Boolean).join(' · ') || undefined,
      keywords: timeZoneKeywords(choice),
    }));
  }, [timezone]);

  const choose = (zone: string) => {
    if (!teamMemberId || (zone === timezone && !unset)) return;
    setTimezone(zone);
    void updateTeamMember(teamMemberId, { timezone: zone, timezone_set: true }).then((saved) => {
      if (saved) toast('success', `Time zone set to ${timeZoneChoice(zone, Date.now()).label}`);
    });
  };

  const browser = timeZoneChoice(browserTimeZone(), Date.now());

  return (
    <section id="timezone" className="glass-card h-full rounded-xl p-4 lg:p-5 scroll-mt-6">
      <SettingsSectionHeader
        icon={Globe}
        title="Time zone"
        description="Times across the app show in this zone, and repeats and schedules you set run in it."
      />
      <div>
        <Select
          ariaLabel="Time zone"
          searchable
          value={unset ? undefined : timezone}
          onChange={choose}
          options={options}
          placeholder="Search a city or offset, like UTC-7"
          emptyText="No time zone matches. Try a city or an offset like UTC+2."
        />
        {unset && (
          <p role="status" className="mt-2 text-xs text-amber-300">
            Not set yet, so times show in your browser&apos;s zone, {browser.label}. Pick yours to keep it on every device.
          </p>
        )}
      </div>
    </section>
  );
}
