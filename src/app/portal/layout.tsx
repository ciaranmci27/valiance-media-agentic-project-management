import { ToastContainer } from '@/components/ui/Toast';

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The client portal is always light and authored against the standard palette.
  // data-theme="dark" pins the subtree to the default token values so a visitor
  // whose OS/app preference sets data-theme="light" on <html> doesn't get the
  // zinc/ink remaps inverting the page (same pattern as the always-dark sidebar).
  return (
    <div data-theme="dark">
      {children}
      <ToastContainer />
    </div>
  );
}
