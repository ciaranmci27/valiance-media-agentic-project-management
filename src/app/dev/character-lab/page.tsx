import { notFound } from 'next/navigation';
import { LabClient } from './lab-client';

/**
 * Dev-only rig inspector: renders each candidate character playing a chosen
 * clip on a plain backdrop, with its measured height printed. Exists so
 * character choices are made by looking at them, not by reading a manifest.
 */
export default async function CharacterLabPage({
  searchParams,
}: {
  searchParams: Promise<{ clip?: string }>;
}) {
  if (process.env.NODE_ENV !== 'development') notFound();
  const { clip } = await searchParams;
  return <LabClient clip={clip} />;
}
