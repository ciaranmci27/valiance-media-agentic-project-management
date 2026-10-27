'use client';

import { EmailSubpage } from '@/components/settings/email/EmailSubpage';
import { MailRulesSection } from '@/components/settings/email/MailRulesSection';

export default function MailRulesPage() {
  return (
    <EmailSubpage title="Mail rules" need="inbox">
      <MailRulesSection />
    </EmailSubpage>
  );
}
