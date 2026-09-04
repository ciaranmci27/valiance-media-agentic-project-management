import { notFound } from 'next/navigation';
import { BrandLoader } from '@/components/ui/BrandLoader';
import { FILE_STEPS, PORTAL_STEPS } from '@/components/portal/loaderSteps';
import { ThemeParam } from './theme-param';

/**
 * Dev-only stage for the brand loader: renders it on the app surface without
 * a session so the mark, orbit and status sequence can be iterated on.
 * ?steps=workspace|auth|portal|file picks the copy (default workspace) and
 * ?theme=light pins the document to the light theme to show the light mark on
 * the light surface.
 */
const SEQUENCES: Record<string, readonly string[]> = {
  workspace: ['Syncing workspace data', 'Bringing workspace online'],
  auth: ['Verifying your access'],
  portal: PORTAL_STEPS,
  file: FILE_STEPS,
};

export default async function LoaderPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ steps?: string; theme?: string }>;
}) {
  if (process.env.NODE_ENV !== 'development') notFound();
  const { steps, theme } = await searchParams;
  const sequence = SEQUENCES[steps ?? 'workspace'] ?? SEQUENCES.workspace;
  return (
    <div className="min-h-screen bg-surface">
      <ThemeParam theme={theme === 'light' ? 'light' : 'dark'} />
      <div className="min-h-screen flex items-center justify-center px-6">
        <BrandLoader steps={sequence} announcement="Loading preview" />
      </div>
    </div>
  );
}
