'use client';

import { useState } from 'react';
import { useApp } from '@/lib/store';
import { useBrand } from '@/lib/brand/context';
import { DEFAULT_BRAND } from '@/lib/brand';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { StepFrame, type WizardStepProps } from '../StepFrame';

/**
 * Step 3, with Client invoicing on: who invoices are from and when they are
 * due. The same business_settings fields as Settings > Billing > Invoice
 * details, which keeps the rest (phone, instructions, notes).
 */
export function BillingStep({ onNext, onSkip, onBack }: WizardStepProps) {
  const { businessSettings, updateBusinessSettings } = useApp();
  const brand = useBrand();
  const [name, setName] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [terms, setTerms] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | undefined>();

  // Prefilled from what is saved; a new workspace starts from its brand name.
  const nameValue = name ?? (businessSettings?.business_name || (brand.name !== DEFAULT_BRAND.name ? brand.name : ''));
  const emailValue = email ?? businessSettings?.business_email ?? '';
  const addressValue = address ?? businessSettings?.business_address ?? '';
  const termsValue = terms ?? businessSettings?.payment_terms ?? 'Upon Receipt';

  const submit = async () => {
    if (!businessSettings) {
      onNext();
      return;
    }
    const cleanEmail = emailValue.trim();
    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setEmailError('Check the email address.');
      return;
    }
    setEmailError(undefined);
    const updates = {
      business_name: nameValue.trim(),
      business_email: cleanEmail,
      business_address: addressValue.trim(),
      payment_terms: termsValue.trim() || 'Upon Receipt',
    };
    const unchanged = updates.business_name === businessSettings.business_name
      && updates.business_email === businessSettings.business_email
      && updates.business_address === businessSettings.business_address
      && updates.payment_terms === businessSettings.payment_terms;
    if (unchanged) {
      onNext();
      return;
    }
    setSaving(true);
    setError(null);
    const ok = await updateBusinessSettings(updates);
    setSaving(false);
    if (!ok) {
      setError('Not saved. Check your connection and try again.');
      return;
    }
    onNext();
  };

  return (
    <StepFrame
      title="Who invoices are from"
      description="Every invoice shows these. Phone, payment instructions and a default note are in Settings > Billing."
      onSubmit={() => { void submit(); }}
      onBack={onBack}
      onSkip={onSkip}
      busy={saving}
      error={error}
    >
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <TextInput label="Business name" value={nameValue} onChange={setName} placeholder="Your business or LLC name" autoComplete="organization" />
        <TextInput label="Billing email" type="email" value={emailValue} onChange={setEmail} placeholder="billing@yourbusiness.com" autoComplete="email" error={emailError} />
        <div className="sm:col-span-2">
          <Textarea label="Address" value={addressValue} onChange={setAddress} placeholder={'123 Main St\nCity, State 12345'} rows={3} />
        </div>
        <TextInput
          label="Payment terms"
          value={termsValue}
          onChange={setTerms}
          placeholder="Upon Receipt"
          description="For example Net 15 or Net 30."
        />
      </div>
    </StepFrame>
  );
}
