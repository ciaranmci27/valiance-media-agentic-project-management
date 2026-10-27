'use client';

import { EmailSubpage } from '@/components/settings/email/EmailSubpage';
import { EmailHandlerSection } from '@/components/settings/email/EmailHandlerSection';

export default function EmailHandlerPage() {
  return (
    <EmailSubpage title="Who handles your mail" need="inbox">
      <EmailHandlerSection />
    </EmailSubpage>
  );
}
