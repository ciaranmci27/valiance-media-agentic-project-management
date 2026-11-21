'use client';

import { EmailSubpage } from '@/components/settings/email/EmailSubpage';
import { PersonalInboxesSection } from '@/components/settings/email/PersonalInboxesSection';

export default function PersonalInboxesPage() {
  return (
    <EmailSubpage title="Personal inboxes" need="inbox">
      <PersonalInboxesSection />
    </EmailSubpage>
  );
}
