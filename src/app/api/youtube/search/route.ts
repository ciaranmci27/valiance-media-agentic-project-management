import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { searchYouTube } from '@/lib/youtube-search';

export const dynamic = 'force-dynamic';

/** Longer than this is a paste accident, not a search. */
const MAX_QUERY_LENGTH = 120;

/**
 * Search YouTube for the live floor's radio.
 *
 * Auth-gated to team members for the same reason as `whats-my-ip`: without it
 * this is a public, un-throttled proxy to YouTube running on our address.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const query = request.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (!query) return NextResponse.json({ results: [] });
  if (query.length > MAX_QUERY_LENGTH) {
    return NextResponse.json({ error: 'That search is too long.' }, { status: 400 });
  }

  try {
    return NextResponse.json({ results: await searchYouTube(query) });
  } catch (err) {
    console.error('[api/youtube/search] lookup failed', err);
    return NextResponse.json({ error: 'Search is unavailable right now.' }, { status: 502 });
  }
}
