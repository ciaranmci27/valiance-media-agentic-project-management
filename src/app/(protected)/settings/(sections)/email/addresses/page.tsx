'use client';

import { EmailSubpage } from '@/components/settings/email/EmailSubpage';
import { YourAddressesSection } from '@/components/settings/email/YourAddressesSection';

export default function EmailAddressesPage() {
  return (
    <EmailSubpage title="Your addresses" need="inbox">
      <YourAddressesSection />
    </EmailSubpage>
  );
}
