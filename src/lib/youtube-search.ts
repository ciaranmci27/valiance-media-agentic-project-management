/**
 * Search YouTube from the server, without an API key.
 *
 * The radio in the live floor lets you paste a link. Typing what you actually
 * want is the other half of that, and it needs somewhere to look things up.
 *
 * The official route is the Data API, which would mean a Google Cloud project,
 * a key in the environment of every deploy, and a 10,000-unit daily quota that
 * a single search spends 100 of. That is a lot of standing setup for a radio on
 * a side table, so this reads YouTube's own results page instead and pulls the
 * results out of the `ytInitialData` blob the page ships to hydrate itself.
 *
 * The trade is honest: no key and no quota, against a payload shape that is
 * YouTube's to change. Everything here degrades to an empty list rather than
 * throwing when a field moves, and the caller shows "no results" for that. If
 * it ever goes permanently quiet, the fix is either the Data API or accepting
 * links only, and pasting a link keeps working regardless because it never
 * comes through here.
 *
 * Server-only: youtube.com sends no CORS headers, so this cannot run in the
 * browser.
 */

export type YouTubeResult = {
  id: string;
  title: string;
  channel: string | null;
  /** Human-readable, e.g. "3:53". Null for a live stream, which has no length. */
  duration: string | null;
  live: boolean;
  thumbnail: string;
};

const RESULTS_URL = 'https://www.youtube.com/results?search_query=';
const DEFAULT_LIMIT = 6;
const REQUEST_TIMEOUT_MS = 8000;

/** A desktop browser gets the hydration blob; a bare fetch gets a consent shell. */
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/** Only the corners of the payload this reads, all optional by design. */
type TextRuns = { runs?: { text?: string }[]; simpleText?: string };
type VideoRenderer = {
  videoId?: string;
  title?: TextRuns;
  ownerText?: TextRuns;
  longBylineText?: TextRuns;
  lengthText?: TextRuns;
  badges?: { metadataBadgeRenderer?: { style?: string } }[];
};

function text(node: TextRuns | undefined): string | null {
  return node?.runs?.[0]?.text ?? node?.simpleText ?? null;
}

/**
 * Collect every `videoRenderer` in the tree.
 *
 * A walk rather than a path, because results live at a different depth
 * depending on whether YouTube decided to show a shelf, an ad slot or a "people
 * also watched" row above them, and all three move around.
 */
function collectRenderers(node: unknown, into: VideoRenderer[], limit: number): void {
  if (into.length >= limit || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) collectRenderers(child, into, limit);
    return;
  }
  const record = node as Record<string, unknown>;
  const renderer = record.videoRenderer as VideoRenderer | undefined;
  if (renderer?.videoId) into.push(renderer);
  for (const key in record) collectRenderers(record[key], into, limit);
}

/**
 * Pull results out of a YouTube search page.
 *
 * Exported so it can be exercised against saved HTML without a network call.
 */
export function extractResults(html: string, limit = DEFAULT_LIMIT): YouTubeResult[] {
  // `[\s\S]` rather than `.` with the dotAll flag, which this tsconfig's ES2017
  // target does not allow.
  const match = html.match(/var ytInitialData = (\{[\s\S]+?\});<\/script>/);
  if (!match) return [];

  let data: unknown;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return [];
  }

  const renderers: VideoRenderer[] = [];
  collectRenderers(data, renderers, limit * 2);

  const seen = new Set<string>();
  const results: YouTubeResult[] = [];
  for (const renderer of renderers) {
    const id = renderer.videoId;
    const title = text(renderer.title);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    results.push({
      id,
      title,
      channel: text(renderer.ownerText) ?? text(renderer.longBylineText),
      duration: text(renderer.lengthText),
      live: (renderer.badges ?? []).some(
        (b) => b.metadataBadgeRenderer?.style === 'BADGE_STYLE_TYPE_LIVE_NOW'
      ),
      // Built from the id rather than taken from the payload, whose thumbnail
      // URLs are signed and expire.
      thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    });
    if (results.length >= limit) break;
  }
  return results;
}

export async function searchYouTube(query: string, limit = DEFAULT_LIMIT): Promise<YouTubeResult[]> {
  // hl/gl pin the language and region so durations and badges come back in
  // English no matter where the server sits.
  const url = `${RESULTS_URL}${encodeURIComponent(query)}&hl=en&gl=US`;
  const response = await fetch(url, {
    headers: { 'accept-language': 'en-US,en;q=0.9', 'user-agent': DESKTOP_UA },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`YouTube answered ${response.status}`);
  return extractResults(await response.text(), limit);
}
