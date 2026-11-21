'use client';

import { EmailSubpage } from '@/components/settings/email/EmailSubpage';
import { PersonalInboxSection } from '@/components/settings/email/PersonalInboxSection';

export default function YourInboxPage() {
  return (
    <EmailSubpage title="Your inbox" need="mine">
      <PersonalInboxSection />
    </EmailSubpage>
  );
}
