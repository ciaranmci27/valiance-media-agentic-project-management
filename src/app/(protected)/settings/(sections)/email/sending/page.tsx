'use client';

import { EmailSubpage } from '@/components/settings/email/EmailSubpage';
import { SmtpSection } from '@/components/settings/SmtpSection';

export default function EmailSendingPage() {
  return (
    <EmailSubpage title="Sending" need="smtp">
      {/* Its states can be several cards, hence space-y. */}
      <div id="smtp" className="scroll-mt-6 space-y-6">
        <SmtpSection />
      </div>
    </EmailSubpage>
  );
}
