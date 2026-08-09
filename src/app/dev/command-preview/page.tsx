import { notFound } from 'next/navigation';
import { PreviewClient } from './preview-client';

/**
 * Dev-only stage for the command scene: renders it with fixture data so the
 * look can be iterated without a session or live events.
 * ?mood=working|idle|blocked|celebrating|reviewing forces every agent into
 * that state. ?tz=<IANA zone> picks which timezone's clock drives the
 * day/night cycle (defaults to America/Phoenix — this developer's own zone —
 * since there's no logged-in member to read a preference from here).
 * ?hour=<0-24> pins the day/night cycle to an exact fractional hour,
 * bypassing the real clock entirely — that's the actual lever for
 * screenshotting a specific time of day on demand.
 */
export default async function CommandPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ mood?: string; tz?: string; hour?: string }>;
}) {
  if (process.env.NODE_ENV !== 'development') notFound();
  const { mood, tz, hour } = await searchParams;
  const parsedHour = hour !== undefined ? Number(hour) : undefined;
  return (
    <PreviewClient
      mood={mood}
      tz={tz}
      hour={parsedHour !== undefined && Number.isFinite(parsedHour) ? parsedHour : undefined}
    />
  );
}
