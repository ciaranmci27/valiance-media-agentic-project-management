'use client';

import { useEffect, useState } from 'react';
import { Building2, Loader2 } from 'lucide-react';
import { useApp } from '@/lib/store';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { toast } from '@/components/ui/Toast';
import { useDemo } from '@/lib/demo-context';

const PAYMENT_INSTRUCTIONS_MAX = 500;
const DEFAULT_NOTES_MAX = 300;

export function BusinessInfoSection() {
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

  // Hydrate local form state when the singleton row arrives.
  useEffect(() => {
    if (!businessSettings) return;
    setName(businessSettings.business_name);
    setAddress(businessSettings.business_address);
    setEmail(businessSettings.business_email);
    setPhone(businessSettings.business_phone);
    setPaymentTerms(businessSettings.payment_terms);
    setPaymentInstructions(businessSettings.payment_instructions);
    setDefaultNotes(businessSettings.default_invoice_notes);
  }, [businessSettings?.id]);

  const isDirty = !!businessSettings && (
    name !== businessSettings.business_name ||
    address !== businessSettings.business_address ||
    email !== businessSettings.business_email ||
    phone !== businessSettings.business_phone ||
    paymentTerms !== businessSettings.payment_terms ||
    paymentInstructions !== businessSettings.payment_instructions ||
    defaultNotes !== businessSettings.default_invoice_notes
  );

  const handleSave = async () => {
    if (!isDirty) return;
    setSaving(true);
    try {
      await updateBusinessSettings({
        business_name: name.trim(),
        business_address: address.trim(),
        business_email: email.trim(),
        business_phone: phone.trim(),
        payment_terms: paymentTerms.trim() || 'Upon Receipt',
        payment_instructions: paymentInstructions.trim(),
        default_invoice_notes: defaultNotes.trim(),
      });
      toast('success', 'Business info saved');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="bg-white rounded-xl border border-zinc-200 p-4 lg:p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-brand-50 rounded-lg">
          <Building2 className="text-brand-600" size={20} />
        </div>
        <div>
          <h2 className="font-semibold text-zinc-900">Business Info</h2>
          <p className="text-sm text-zinc-500">Used as the &quot;From&quot; block on invoice PDFs</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Input
          label="Business Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your business or LLC name"
          disabled={isDemoMode}
        />
        <Input
          label="Business Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="billing@yourbusiness.com"
          disabled={isDemoMode}
        />
        <Input
          label="Business Phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="(555) 555-5555"
          disabled={isDemoMode}
        />
        <Input
          label="Default Payment Terms"
          value={paymentTerms}
          onChange={(e) => setPaymentTerms(e.target.value)}
          placeholder="Upon Receipt"
          disabled={isDemoMode}
        />
      </div>

      <div className="mt-4">
        <Textarea
          label="Business Address"
          value={address}
          onChange={setAddress}
          placeholder="123 Main St&#10;Suite 100&#10;City, State 12345"
          rows={3}
          disabled={isDemoMode}
        />
      </div>

      <div className="mt-4">
        <Textarea
          label="Payment Instructions"
          description="Shown at the bottom of every invoice PDF (e.g., wire details, Stripe link, mailing address)."
          value={paymentInstructions}
          onChange={setPaymentInstructions}
          placeholder="Pay online at https://...&#10;Make checks payable to..."
          rows={3}
          maxLength={PAYMENT_INSTRUCTIONS_MAX}
          showCharCount
          disabled={isDemoMode}
        />
      </div>

      <div className="mt-4">
        <Textarea
          label="Default Invoice Notes"
          description="Optional fallback note used when an invoice has no per-invoice notes."
          value={defaultNotes}
          onChange={setDefaultNotes}
          placeholder="Thank you for your business!"
          rows={2}
          maxLength={DEFAULT_NOTES_MAX}
          showCharCount
          disabled={isDemoMode}
        />
      </div>

      <div className="mt-4">
        <Button onClick={handleSave} disabled={!isDirty || saving || isDemoMode}>
          {saving ? <><Loader2 size={14} className="animate-spin mr-1.5" />Saving...</> : 'Save Business Info'}
        </Button>
      </div>
    </section>
  );
}
