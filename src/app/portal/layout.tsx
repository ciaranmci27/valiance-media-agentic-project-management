import type { Metadata } from 'next';
import { Instrument_Serif } from 'next/font/google';
import { ToastContainer } from '@/components/ui/Toast';
import './portal.css';

// The one accent face in the portal's type system: an italic word in a
// heading. Self-hosted through next/font like DM Sans and DM Mono in the
// root layout; portal.css reads it as --font-instrument-serif.
const instrumentSerif = Instrument_Serif({
  weight: '400',
  style: ['normal', 'italic'],
  subsets: ['latin'],
  variable: '--font-instrument-serif',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Client portal',
  robots: { index: false, follow: false },
};

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // data-theme="dark" pins the shared primitives (Toast, Select, Tooltip,
  // FilePreviewModal, PinInput) to their dark chrome, which is the portal's
  // own palette, whatever theme the visitor's browser has saved for the app.
  return (
    <div data-theme="dark" className={instrumentSerif.variable}>
      {children}
      <ToastContainer />
    </div>
  );
}
