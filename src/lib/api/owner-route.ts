import { NextResponse, type NextRequest } from 'next/server';
import { requireSessionAccess, type SessionAccessResult } from '@/lib/api/access';

/**
 * Shared guards for the Owner-only workspace routes (Settings > Workspace:
 * Features, Brand). Owner by role rather than by a permission: these change
 * the app for everyone.
 */

export function isDemoWorkspace(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === 'true' || process.env.DEMO_MODE === 'true';
}

/** Browsers always send Origin on a write; one naming another site is refused. */
export function foreignOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return request.headers.get('sec-fetch-site') === 'cross-site';
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return true;
  }
  const hosts = [request.nextUrl.host, request.headers.get('host'), request.headers.get('x-forwarded-host')];
  return !hosts.includes(host);
}

/** A signed-in Owner, or the response that refuses everyone else. */
export async function requireOwner(): Promise<{ data: SessionAccessResult; error: null } | { data: null; error: NextResponse }> {
  const auth = await requireSessionAccess();
  if (auth.error) return { data: null, error: auth.error };
  if (auth.data.access.role !== 'owner') {
    return { data: null, error: NextResponse.json({ error: 'Owner access required' }, { status: 403 }) };
  }
  return { data: auth.data, error: null };
}

/** The table or column is not there yet: the migration has not run. */
export function isSchemaMissing(error: { code?: string | null; message?: string | null }): boolean {
  if (['42P01', '42703', 'PGRST205', 'PGRST204'].includes(error.code || '')) return true;
  const message = (error.message || '').toLowerCase();
  return message.includes('does not exist') || message.includes('schema cache');
}

export function migrationMissing() {
  return NextResponse.json({ error: 'Run the latest database migration first.', code: 'MIGRATION_REQUIRED' }, { status: 409 });
}
