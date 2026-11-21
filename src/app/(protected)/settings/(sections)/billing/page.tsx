'use client';

import { InvoiceDetailsSection } from '@/components/settings/billing/InvoiceDetailsSection';
import { HourApprovalsSection } from '@/components/settings/billing/HourApprovalsSection';
import { useSettingsAccess } from '@/components/settings/settings-groups';

/** Billing: invoice details (Client invoicing) and hour approvals (Client invoicing or Team pay). */
export default function BillingSettingsPage() {
  const { show } = useSettingsAccess();
  return (
    <>
      {show.invoiceDetails && (
        <div id="invoice-details" className="scroll-mt-6">
          <InvoiceDetailsSection />
        </div>
      )}
      {show.hourApprovals && (
        <div id="hour-approvals" className="scroll-mt-6">
          <HourApprovalsSection />
        </div>
      )}
    </>
  );
}
