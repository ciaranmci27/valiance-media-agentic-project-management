'use client';

import { useMemo } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { buildInvoiceData } from '@/lib/invoice-pdf/buildInvoiceData';
import { DEFAULT_INVOICE_PDF_OPTIONS, type InvoicePdfOptions } from '@/lib/invoice-pdf/types';
import { InvoicePreviewModalView } from '@/components/invoice-pdf/InvoicePreviewModalView';

interface InvoicePreviewModalProps {
  invoiceId: string | null;
  onClose: () => void;
}

export function InvoicePreviewModal({ invoiceId, onClose }: InvoicePreviewModalProps) {
  const {
    projectInvoices, getProject, getPrimaryClient, getContact, getPortalSettings,
    businessSettings, updateProject, team, getTimeEntriesByProject,
  } = useApp();
  const { teamMemberId } = useAuth();
  const currentMember = team.find(m => m.id === teamMemberId);
  const senderName = currentMember?.name ?? '';

  const invoice = invoiceId ? projectInvoices.find(i => i.id === invoiceId) : null;
  const project = invoice ? getProject(invoice.project_id) : undefined;
  // Stable identity so the pdfData useMemo doesn't refire on every parent
  // render. getTimeEntriesByProject returns a fresh array each call.
  const timeEntries = useMemo(
    () => (invoice ? getTimeEntriesByProject(invoice.project_id) : []),
    [invoice, getTimeEntriesByProject],
  );
  const projectInvoiceRows = useMemo(
    () => (invoice ? projectInvoices.filter(i => i.project_id === invoice.project_id) : []),
    [invoice, projectInvoices],
  );

  // Toggles live on the project so each client/project can have its own
  // invoice presentation. Falls back to defaults for projects predating the
  // column or for missing keys.
  const options = useMemo<InvoicePdfOptions>(() => ({
    ...DEFAULT_INVOICE_PDF_OPTIONS,
    ...(project?.invoice_pdf_options ?? {}),
  }), [project?.invoice_pdf_options]);

  const toggleOption = (key: keyof InvoicePdfOptions) => {
    if (!project) return;
    updateProject(project.id, {
      invoice_pdf_options: { ...options, [key]: !options[key] },
    });
  };

  const resetOptions = () => {
    if (!project) return;
    updateProject(project.id, {
      invoice_pdf_options: { ...DEFAULT_INVOICE_PDF_OPTIONS },
    });
  };

  const primaryClientLink = invoice ? getPrimaryClient(invoice.project_id) : undefined;
  const primaryContact = primaryClientLink ? getContact(primaryClientLink.contact_id) : undefined;
  const portalSettings = invoice ? getPortalSettings(invoice.project_id) : undefined;
  const portalUrl = portalSettings?.enabled && portalSettings.token && invoice && typeof window !== 'undefined'
    ? `${window.location.origin}/portal/${portalSettings.token}?invoice=${encodeURIComponent(invoice.invoice_number)}`
    : null;

  const pdfData = useMemo(() => {
    if (!invoice) return null;
    return buildInvoiceData({
      invoice,
      project,
      primaryContact,
      businessSettings,
      senderName,
      options,
      logoUrl: typeof window !== 'undefined' ? `${window.location.origin}/api/logo` : '/api/logo',
      portalUrl,
      timeEntries,
      projectInvoices: projectInvoiceRows,
      team,
    });
  }, [invoice, project, primaryContact, businessSettings, senderName, options, portalUrl, timeEntries, projectInvoiceRows, team]);

  const clientLabel = pdfData?.billTo.company || pdfData?.billTo.name || 'Client';

  return (
    <InvoicePreviewModalView
      isOpen={!!invoiceId}
      onClose={onClose}
      pdfData={pdfData}
      invoiceNumber={invoice?.invoice_number ?? ''}
      clientLabel={clientLabel}
      invoiceDate={invoice?.date ?? ''}
      customizer={{ options, toggleOption, resetOptions }}
    />
  );
}
