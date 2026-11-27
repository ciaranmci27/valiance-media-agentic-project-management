'use client';

import { useEffect, useState } from 'react';
import { Receipt } from 'lucide-react';
import { useApp } from '@/lib/store';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { toast } from '@/components/ui/Toast';
import { useDemo } from '@/lib/demo-context';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { SettingsSaveBar } from '@/components/settings/SettingsSaveBar';
import { useDiscardGuard } from '@/components/ui/useDiscardGuard';

const PAYMENT_INSTRUCTIONS_MAX = 500;
const DEFAULT_NOTES_MAX = 300;

/**
 * Settings > Billing > Invoice details (Client invoicing only): the "From"
 * block, payment terms, instructions and the fallback note every invoice
 * PDF carries. Edit, then Save in the SaveBar (Rule 8); the singleton business_settings row is
 * patched. With Client invoicing off the section is hidden and its stored
 * values stay as they are.
 */
export function InvoiceDetailsSection() {
  const { businessSettings, updateBusinessSettings } = useApp();
  const { isDemoMode } = useDemo();

  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [paymentInstructions, setPaymentInstructions] = useState('');
  const [defaultNotes, setDefaultNotes] = useState('');
  const [saving, setSaving] = useState(false);

  // Fill the form from the saved row: when it arrives, and on Discard.
  const reset = () => {
    if (!businessSettings) return;
    setName(businessSettings.business_name);
    setAddress(businessSettings.business_address);
    setEmail(businessSettings.business_email);
    setPhone(businessSettings.business_phone);
    setPaymentTerms(businessSettings.payment_terms);
    setPaymentInstructions(businessSettings.payment_instructions);
    setDefaultNotes(businessSettings.default_invoice_notes);
  };
  // Only when the row itself arrives; later edits are the form's own.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reset, [businessSettings?.id]);

  const isDirty =
    !!businessSettings &&
    (name !== businessSettings.business_name ||
      address !== businessSettings.business_address ||
      email !== businessSettings.business_email ||
      phone !== businessSettings.business_phone ||
      paymentTerms !== businessSettings.payment_terms ||
      paymentInstructions !== businessSettings.payment_instructions ||
      defaultNotes !== businessSettings.default_invoice_notes);

  const guard = useDiscardGuard(isDirty && !isDemoMode, reset);

  const handleSave = async () => {
    if (!isDirty) return;
    setSaving(true);
    try {
      await updateBusinessSettings({
        business_name: name.trim(),
        business_address: address.trim(),
        business_email: email.trim(),
        business_phone: phone.trim(),
        payment_terms: paymentTerms.trim() || 'Upon receipt',
        payment_instructions: paymentInstructions.trim(),
        default_invoice_notes: defaultNotes.trim(),
      });
      toast('success', 'Invoice details saved');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="glass-card rounded-xl p-4 lg:p-5">
      <SettingsSectionHeader
        icon={Receipt}
        title="Invoice details"
        description="Who the invoice is from, when it is due and how to pay. Every invoice PDF shows these."
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Input
          label="Business name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your business or LLC name"
          disabled={isDemoMode}
        />
        <Input
          label="Billing email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="billing@yourbusiness.com"
          disabled={isDemoMode}
        />
        <Input
          label="Phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="(555) 555-5555"
          disabled={isDemoMode}
        />
        <Input
          label="Payment terms"
          value={paymentTerms}
          onChange={(e) => setPaymentTerms(e.target.value)}
          placeholder="Upon receipt"
          disabled={isDemoMode}
        />
      </div>

      <div className="mt-4">
        <Textarea
          label="Address"
          value={address}
          onChange={setAddress}
          placeholder="123 Main St&#10;Suite 100&#10;City, State 12345"
          rows={3}
          disabled={isDemoMode}
        />
      </div>

      {/* The two lines every invoice ends with, side by side on wide screens (Rule 9). */}
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Textarea
          label="Payment instructions"
          description="Wire details, a payment link or an address."
          value={paymentInstructions}
          onChange={setPaymentInstructions}
          placeholder="Pay online at https://...&#10;Make checks payable to"
          rows={3}
          maxLength={PAYMENT_INSTRUCTIONS_MAX}
          showCharCount
          disabled={isDemoMode}
        />
        <Textarea
          label="Invoice notes"
          description="Used when an invoice has no notes of its own."
          value={defaultNotes}
          onChange={setDefaultNotes}
          placeholder="Thank you for your business!"
          rows={3}
          maxLength={DEFAULT_NOTES_MAX}
          showCharCount
          disabled={isDemoMode}
        />
      </div>

      {guard.dialog}
      {!isDemoMode && (
        <SettingsSaveBar dirty={isDirty} saving={saving} onDiscard={reset} onSave={() => { void handleSave(); }} />
      )}
    </section>
  );
}
