'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { InvoicePreviewModalView } from '@/components/invoice-pdf/InvoicePreviewModalView';
import { FilePreviewModal } from '@/components/ui/FilePreviewModal';
import { DEFAULT_SECTION_ORDER, type PortalData, type PortalSectionKey } from '@/lib/types';
import { CredentialsSection } from '@/components/portal/CredentialsSection';
import { FilesSection } from '@/components/portal/FilesSection';
import { HoursSection } from '@/components/portal/HoursSection';
import { InvoicesSection } from '@/components/portal/InvoicesSection';
import { PinGate } from '@/components/portal/PinGate';
import { PortalShell } from '@/components/portal/PortalShell';
import { PortalEmpty, PortalError, PortalLoading } from '@/components/portal/PortalStates';
import { ProgressSection } from '@/components/portal/ProgressSection';
import { UpdatesSection } from '@/components/portal/UpdatesSection';
import { downloadFile, type PreviewFile } from '@/components/portal/format';
import { getStoredPin, usePortalData } from '@/components/portal/usePortalData';

// The wide column carries the story of the work. The sidebar keeps the two
// compact reference lists; three cards made it run long past the main column.
const MAIN_SECTIONS = new Set<PortalSectionKey>(['show_progress', 'show_invoices', 'show_hours', 'show_updates']);

// Outer wrapper exists solely to provide a Suspense boundary so the inner
// component can use Next's useSearchParams() without tripping the
// "missing-suspense-with-csr-bailout" build error. The inner component
// holds all the actual page logic.
export default function PortalPage() {
  return (
    <Suspense fallback={null}>
      <PortalPageInner />
    </Suspense>
  );
}

/** Which sections have something to show. A section stays hidden when its
 *  setting is off or, for lists, when there is nothing in it yet. */
function sectionVisibility(data: PortalData): Record<PortalSectionKey, boolean> {
  const { settings, project, hours, invoices } = data;
  const updates = data.updates || [];
  return {
    show_progress: settings.show_progress
      && (project.status === 'completed' || Boolean(project.start_date && project.due_date)),
    show_updates: settings.show_updates && updates.length > 0,
    show_hours: settings.show_hours && hours.entries.length > 0,
    show_files: settings.show_files,
    show_invoices: settings.show_invoices && invoices.length > 0,
    show_credentials: settings.show_credentials,
  };
}

function PortalPageInner() {
  const params = useParams();
  const token = (params.token as string).toLowerCase();
  const portal = usePortalData(token);
  const { data, pinRequired, track } = portal;

  // File preview. Emitting file_preview from an effect keeps the tracking in
  // one place so every call-site (project files, update attachments) gets it.
  const [previewFile, setPreviewFile] = useState<PreviewFile | null>(null);
  useEffect(() => {
    if (!previewFile || !data || pinRequired) return;
    track('file_preview', previewFile.id ? { file_id: previewFile.id } : {});
  }, [previewFile, data, pinRequired, track]);

  const handleDownload = useCallback((file: PreviewFile & { id: string }) => {
    track('file_download', { file_id: file.id });
    downloadFile(file.file_url, file.name);
  }, [track]);

  // Invoice preview deep-linking via ?invoice=INV-001 search param so clients
  // can share a link to a specific invoice. Resolves to actual invoice data
  // when the portal payload is loaded.
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const activeInvoiceNumber = searchParams.get('invoice');
  const activeInvoice = activeInvoiceNumber && data
    ? data.invoices.find(i => i.invoice_number === activeInvoiceNumber) ?? null
    : null;
  const activePdfData = activeInvoice && data ? data.invoice_pdfs?.[activeInvoice.id] ?? null : null;
  const activePdfError = activeInvoice && data ? data.invoice_pdf_errors?.[activeInvoice.id] ?? null : null;

  // Opening pushes a new history entry so the browser back button closes the
  // modal, the conventional deep-linkable modal behaviour.
  const openInvoice = useCallback((invoiceNumber: string) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set('invoice', invoiceNumber);
    router.push(`${pathname}?${next.toString()}`, { scroll: false });
  }, [router, searchParams, pathname]);

  // Fires once each time an invoice opens. The ref is cleared whenever the
  // modal closes so closing and reopening the same invoice in one session
  // counts as a fresh view; only back-to-back state changes that resolve to
  // the same id (e.g. a deep-link refresh that keeps it open) are deduped.
  const lastInvoiceTrackedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!data || pinRequired) return;
    if (!activeInvoice) {
      lastInvoiceTrackedRef.current = null;
      return;
    }
    if (lastInvoiceTrackedRef.current === activeInvoice.id) return;
    lastInvoiceTrackedRef.current = activeInvoice.id;
    track('invoice_view', { invoice_id: activeInvoice.id, invoice_number: activeInvoice.invoice_number });
  }, [activeInvoice, data, pinRequired, track]);

  // Closing replaces (no extra history entry) so users don't end up with a
  // pile of modal-open/close states cluttering their back stack.
  const closeInvoice = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete('invoice');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [router, searchParams, pathname]);

  if (portal.phase !== 'done') {
    return <PortalLoading leaving={portal.phase === 'leaving'} onLeft={portal.onLoaderLeft} />;
  }

  if (portal.error) {
    return (
      <PortalError
        title="Portal unavailable"
        message={portal.error}
      />
    );
  }

  if (pinRequired) {
    return (
      <PinGate
        projectName={portal.branding?.project_name}
        logoUrl={portal.branding?.logo_url || undefined}
        pin={portal.pin}
        onChange={portal.changePin}
        onComplete={portal.submitPin}
        error={portal.pinError}
        submitting={portal.pinSubmitting}
        pinRef={portal.pinRef}
      />
    );
  }

  if (!data) return null;

  const visible = sectionVisibility(data);
  const order = (data.settings.section_order ?? DEFAULT_SECTION_ORDER).filter(key => visible[key]);
  const mainOrder = order.filter(key => MAIN_SECTIONS.has(key));
  const asideOrder = order.filter(key => !MAIN_SECTIONS.has(key));
  const hasAside = asideOrder.length > 0;


  const storedPin = getStoredPin(token) || undefined;

  const renderSection = (key: PortalSectionKey) => {
    switch (key) {
      case 'show_progress':
        return <ProgressSection key={key} project={data.project} progress={data.progress} />;
      case 'show_updates':
        return (
          <UpdatesSection
            key={key}
            updates={data.updates || []}
            onPreview={setPreviewFile}
            onDownload={handleDownload}
          />
        );
      case 'show_hours':
        return (
          <HoursSection
            key={key}
            entries={data.hours.entries}
            totalHours={data.hours.total_hours}
          />
        );
      case 'show_files':
        return (
          <FilesSection
            key={key}
            files={portal.localFiles}
            uploading={portal.fileUploading}
            onUpload={portal.uploadFile}
            onPreview={setPreviewFile}
            onDownload={handleDownload}
          />
        );
      case 'show_invoices':
        return (
          <InvoicesSection
            key={key}
            invoices={data.invoices}
            billing={data.billing}
            onOpen={openInvoice}
          />
        );
      case 'show_credentials':
        return (
          <CredentialsSection
            key={key}
            token={token}
            pin={storedPin}
            credentialsSubmitted={data.credentials_submitted}
          />
        );
      default:
        return null;
    }
  };

  return (
    <PortalShell
      projectName={data.project.name}
      welcomeMessage={data.settings.welcome_message}
      logoUrl={data.settings.logo_url || undefined}
    >
      {order.length > 0 ? (
        // One column on phones, in section order with the aside after the main
        // cards. From lg the lists take eight columns and the aside four; when
        // one side is empty the other is centred rather than left hanging.
        <div className="vm-fade grid grid-cols-1 gap-6 lg:grid-cols-12">
          {mainOrder.length > 0 && (
            <div className={`flex min-w-0 flex-col gap-6 lg:gap-8 ${hasAside ? 'lg:col-span-8' : 'lg:col-span-8 lg:col-start-3'}`}>
              {mainOrder.map(renderSection)}
            </div>
          )}
          {/* The aside is not sticky: a sidebar taller than the viewport would pin
              itself and leave its own bottom unreachable while the page scrolled. */}
          {hasAside && (
            <aside
              className={`flex min-w-0 flex-col gap-6 lg:gap-8 ${
                mainOrder.length > 0 ? 'lg:col-span-4 lg:self-start' : 'lg:col-span-6 lg:col-start-4'
              }`}
            >
              {asideOrder.map(renderSection)}
            </aside>
          )}
        </div>
      ) : (
        <PortalEmpty />
      )}

      <FilePreviewModal
        isOpen={!!previewFile}
        onClose={() => setPreviewFile(null)}
        file={previewFile}
      />

      {/* Invoice preview, opened via the ?invoice=INV-001 deep link or a row click. */}
      <InvoicePreviewModalView
        appearance="themed"
        isOpen={!!activeInvoice}
        onClose={closeInvoice}
        pdfData={activePdfData}
        integrityError={activePdfError}
        invoiceNumber={activeInvoice?.invoice_number ?? ''}
        clientLabel={activePdfData?.billTo.company || activePdfData?.billTo.name || data.project.name || 'Client'}
        invoiceDate={activeInvoice?.date ?? ''}
        onDownload={() => activeInvoice && track('invoice_pdf_download', {
          invoice_id: activeInvoice.id,
          invoice_number: activeInvoice.invoice_number,
        })}
      />
    </PortalShell>
  );
}
