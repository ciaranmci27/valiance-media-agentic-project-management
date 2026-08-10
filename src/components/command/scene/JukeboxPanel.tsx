'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Loader2, Maximize2, Minimize2, Music, Pause, Play, Search, Volume2, X } from 'lucide-react';
import { HUD_SURFACE } from './hudSurface';
import type { YouTubeResult } from '@/lib/youtube-search';

/**
 * The radio's source: a YouTube embed, with its own volume control.
 *
 * Volume is exactly what the slider says and nothing else. An earlier pass
 * faded it with your distance from the radio, which sounded like a fault
 * rather than a feature. This is a room you stand in and look out of, not one
 * you walk past a speaker in, so all the falloff did was make the music go
 * quiet for no visible reason.
 *
 * The player stays visible whenever a track is loaded, which YouTube's API
 * terms require of an embed, and which also means playback survives walking
 * away from the radio rather than stopping the moment the controls close.
 *
 * (Real spatial audio is not reachable from here in any case: the IFrame
 * player is a cross-origin iframe, and Web Audio's `createMediaElementSource`
 * only accepts a same-origin element, so `THREE.PositionalAudio` could never
 * receive it. That would mean self-hosting audio we hold the rights to.)
 */

/** The subset of the IFrame API this uses. Avoids a dependency for six methods. */
type YouTubePlayer = {
  playVideo: () => void;
  pauseVideo: () => void;
  stopVideo: () => void;
  setVolume: (v: number) => void;
  loadVideoById: (id: string) => void;
  getPlayerState: () => number;
  /** Undocumented but long-standing; the only way to learn what is playing. */
  getVideoData?: () => { title?: string; author?: string } | undefined;
  destroy: () => void;
};

declare global {
  interface Window {
    YT?: {
      Player: new (el: HTMLElement, options: Record<string, unknown>) => YouTubePlayer;
      PlayerState: { PLAYING: number };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

const API_SRC = 'https://www.youtube.com/iframe_api';

/**
 * Loads the IFrame API once per document.
 *
 * The API calls a single global callback when it is ready, so a second copy of
 * this component must not overwrite it, hence one shared promise rather than a
 * per-instance script tag.
 */
let apiReady: Promise<void> | null = null;
function loadYouTubeApi(): Promise<void> {
  if (apiReady) return apiReady;
  apiReady = new Promise<void>((resolve) => {
    if (window.YT?.Player) return resolve();
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    if (!document.querySelector(`script[src="${API_SRC}"]`)) {
      const script = document.createElement('script');
      script.src = API_SRC;
      document.head.appendChild(script);
    }
  });
  return apiReady;
}

/**
 * Pull a video id out of whatever the user pasted.
 *
 * Accepts a bare id, a watch URL, a youtu.be short link, an /embed/ URL and a
 * /shorts/ link, because those are what people actually have in their clipboard.
 */
export function parseVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(url.hostname)) return null;
    const fromQuery = url.searchParams.get('v');
    if (fromQuery && /^[\w-]{11}$/.test(fromQuery)) return fromQuery;
    const path = url.pathname.split('/').filter(Boolean);
    const last = path[path.length - 1];
    return last && /^[\w-]{11}$/.test(last) ? last : null;
  } catch {
    return null;
  }
}

/**
 * The radio's permanent handle, up beside the LIVE badge.
 *
 * Walking across the room to the side table is a nice thing to be able to do
 * and a poor thing to have to do, particularly on a phone, where it means
 * steering with a thumbstick to reach a search box. This is the same panel from
 * anywhere in the room, at any camera mode, without moving.
 *
 * Styled as the badge beside it rather than as a scene control, because that is
 * the row it lives in.
 */
export function RadioButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Radio"
      aria-expanded={open}
      title="Radio"
      className={`pointer-events-auto flex items-center rounded-full border p-2 backdrop-blur-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400 focus-visible:outline-offset-2 ${
        open
          ? 'border-brand-400/40 bg-brand-400/15 text-brand-300'
          : 'border-white/10 bg-black/50 text-zinc-400 hover:text-zinc-100'
      }`}
    >
      <Music size={13} aria-hidden="true" />
    </button>
  );
}

/**
 * The true shape of a video, from the one thumbnail YouTube renders at the
 * source's own aspect ratio.
 *
 * The player letterboxes whatever box it is given, so a fixed 16:9 frame puts
 * pillars down the sides of a vertical Short and bars above and below a 4:3
 * upload. Nothing in the IFrame API reports the video's dimensions, and oEmbed
 * is no help either, answering a flat 200x113 for every video, portrait ones
 * included. But `i.ytimg.com/vi/<id>/oar2.jpg` ("original aspect ratio") is
 * generated at the source's real size: 1920x1080 for a widescreen upload,
 * 1080x1920 for a Short. An `Image` reports that back without needing CORS.
 *
 * Its sibling `oardefault.jpg` only exists for Shorts, so it is not used here.
 * When a thumbnail is missing, YouTube serves a 120x90 grey placeholder rather
 * than a 404, so that exact size is the "no answer" signal, not a 3:4 video.
 */
const PLACEHOLDER = { width: 120, height: 90 };
const DEFAULT_ASPECT = 16 / 9;
/** Tallest the player may get, so a Short cannot make the panel a column. */
const MAX_MEDIA_HEIGHT = 240;

function useVideoAspect(videoId: string | null): number {
  // Stored with the id it was measured from, so a new track shows the default
  // rather than the previous video's shape until its own answer arrives.
  const [measured, setMeasured] = useState<{ id: string; aspect: number } | null>(null);

  useEffect(() => {
    if (!videoId) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      const { naturalWidth: w, naturalHeight: h } = img;
      if (cancelled || !w || !h) return;
      if (w === PLACEHOLDER.width && h === PLACEHOLDER.height) return;
      setMeasured({ id: videoId, aspect: w / h });
    };
    img.src = `https://i.ytimg.com/vi/${videoId}/oar2.jpg`;
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  return measured && measured.id === videoId ? measured.aspect : DEFAULT_ASPECT;
}

export function JukeboxPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [level, setLevel] = useState(70);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<YouTubeResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [minimized, setMinimized] = useState(false);
  // What is playing, for the minimized bar, which has no picture to say it.
  const [title, setTitle] = useState<string | null>(null);
  // Counts searches so a slow one that lands late can be recognised and dropped.
  const searchRun = useRef(0);
  const inputId = useId();
  const levelId = useId();
  const aspect = useVideoAspect(videoId);

  // Landscape fills the panel width; portrait is sized off its height instead
  // and centred, since a full-width vertical video would be 460px tall.
  const mediaStyle = useMemo(
    () => ({
      aspectRatio: String(aspect),
      width: aspect >= 1 ? '100%' : `${Math.round(MAX_MEDIA_HEIGHT * aspect)}px`,
    }),
    [aspect]
  );

  // Mirrored for `onReady` alone. That closure is built by the effect below,
  // which only depends on `videoId`, so reading `level` from it directly would
  // capture whatever the slider said when the track was chosen.
  const levelRef = useRef(level);
  useEffect(() => {
    levelRef.current = level;
  }, [level]);

  // Build the player once a track has been chosen. Not before: an empty player
  // would be a visible black rectangle with nothing in it.
  useEffect(() => {
    if (!videoId || playerRef.current) return;
    let cancelled = false;
    loadYouTubeApi().then(() => {
      if (cancelled || !hostRef.current || !window.YT) return;
      playerRef.current = new window.YT.Player(hostRef.current, {
        videoId,
        // Percentages rather than the API's 640x390 default: the frame around
        // it is what decides the size, and it is not a fixed one.
        width: '100%',
        height: '100%',
        // No YouTube chrome. The panel already has play/pause, volume, a way to
        // change track and a way to close, and a scrubber, a share sheet, a
        // fullscreen button and a wall of related videos on top of that is a
        // lot of interface for a radio on a side table.
        //
        // `controls: 0` takes the whole bottom bar; `iv_load_policy: 3` the
        // annotation layer; `fs: 0` fullscreen; `disablekb: 1` the player's key
        // handlers, which would otherwise fight the scene for the arrow keys.
        // The title and channel that YouTube overlays on hover are not ours to
        // remove, and the embed terms would not allow covering them anyway.
        playerVars: {
          autoplay: 1,
          playsinline: 1,
          controls: 0,
          disablekb: 1,
          fs: 0,
          iv_load_policy: 3,
          rel: 0,
        },
        events: {
          onReady: (e: { target: YouTubePlayer }) => {
            e.target.setVolume(levelRef.current);
            e.target.playVideo();
          },
          onStateChange: (e: { data: number; target: YouTubePlayer }) => {
            setPlaying(e.data === window.YT?.PlayerState.PLAYING);
            // The title arrives with the metadata, which is after `onReady`,
            // so this is the earliest reliable place to read it, and it
            // refreshes itself on every later track.
            const data = e.target.getVideoData?.();
            if (data?.title) setTitle(data.title);
          },
        },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  useEffect(
    () => () => {
      playerRef.current?.destroy();
      playerRef.current = null;
    },
    []
  );

  // The slider, straight through to the player.
  useEffect(() => {
    playerRef.current?.setVolume(level);
  }, [level]);

  const play = useCallback((id: string) => {
    setError(null);
    setInput('');
    setResults([]);
    setTitle(null);
    if (playerRef.current) playerRef.current.loadVideoById(id);
    setVideoId(id);
  }, []);

  /**
   * Off, as opposed to closed.
   *
   * `stopVideo` rather than `destroy`: the player instance stays alive with its
   * host node untouched, so the next track is a `loadVideoById` on something
   * that already exists rather than a rebuild against a node the API took over
   * long ago.
   */
  const turnOff = useCallback(() => {
    playerRef.current?.stopVideo();
    setVideoId(null);
    setMinimized(false);
    setTitle(null);
    setPlaying(false);
  }, []);

  /**
   * One field, two jobs.
   *
   * Anything that parses as a YouTube link plays straight away, because
   * someone who pasted a link has already chosen. Anything else is a search,
   * since a bare title is not a link and there is nothing else it could mean.
   */
  const submit = useCallback(async () => {
    const query = input.trim();
    if (!query) return;

    const id = parseVideoId(query);
    if (id) {
      play(id);
      return;
    }

    const attempt = ++searchRun.current;
    setError(null);
    setSearching(true);
    setResults([]);
    try {
      const response = await fetch(`/api/youtube/search?q=${encodeURIComponent(query)}`);
      const body = (await response.json()) as { results?: YouTubeResult[]; error?: string };
      // A slower earlier search must not overwrite a later one's results.
      if (attempt !== searchRun.current) return;
      if (!response.ok) {
        // The route's own messages are written to be read; its 401 is not.
        setError(
          response.status === 401
            ? 'Your session has expired. Reload the page to search.'
            : (body.error ?? 'Search is unavailable right now.')
        );
        return;
      }
      setResults(body.results ?? []);
      if (!body.results?.length) setError(`Nothing found for "${query}".`);
    } catch {
      if (attempt === searchRun.current) setError('Search is unavailable right now.');
    } finally {
      if (attempt === searchRun.current) setSearching(false);
    }
  }, [input, play]);

  const toggle = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (playing) player.pauseVideo();
    else player.playVideo();
  }, [playing]);

  // Minimized and not being used right now. Walking up to the radio still
  // expands it, and closing that drops back to the bar rather than to the video.
  const compact = minimized && !open && videoId !== null;
  // Nothing loaded and nothing open: the radio is just a prop. Hidden rather
  // than unmounted, for the same reason the frame below is never moved.
  const idle = !videoId && !open;

  return (
    <div
      className={`relative flex flex-col gap-2 ${HUD_SURFACE} ${
        // `max-w-full` against the slot it sits in rather than the viewport:
        // on a narrow phone the bar gives up width instead of running off the
        // right edge, and it does not have to know what else is on screen.
        idle ? 'hidden' : compact ? 'w-[320px] max-w-full p-2' : 'w-[260px] p-3'
      }`}
    >
      {compact ? null : (
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-[0.18em] text-zinc-400">
            <Music size={12} className="text-brand-300" aria-hidden="true" />
            Radio
          </span>
          <span className="flex items-center gap-1">
            {videoId && (
              <button
                type="button"
                onClick={() => {
                  if (minimized) {
                    setMinimized(false);
                  } else {
                    setMinimized(true);
                    onOpenChange(false);
                  }
                }}
                aria-label={minimized ? 'Restore the video' : 'Minimize the radio to a bar'}
                className="-m-1 rounded p-1 text-zinc-500 hover:text-zinc-200 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400"
              >
                {minimized ? (
                  <Maximize2 size={13} aria-hidden="true" />
                ) : (
                  <Minimize2 size={13} aria-hidden="true" />
                )}
              </button>
            )}
            {open && (
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label="Close radio"
                className="-m-1 rounded p-1 text-zinc-500 hover:text-zinc-200 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400"
              >
                <X size={15} aria-hidden="true" />
              </button>
            )}
          </span>
        </div>
      )}

      {/* The player itself, and the one node in here that must never move.
          The IFrame API replaces this element with its own iframe, so React no
          longer owns it: unmounting the subtree it sits in would have React try
          to remove a node that is not there any more, and re-parenting it would
          reload the player and stop the music. Every state this panel has keeps
          it as the same child in the same place, and only restyles it.

          Expanded, the frame takes the video's own aspect ratio, so the picture
          reaches all four edges instead of sitting in bars, and `mx-auto`
          centres a portrait video, which is narrower than the panel.

          Minimized, it shrinks to a pixel and leaves the flow. The audio keeps
          playing because the iframe is still laid out and still in the document
          (this is the one thing an audio-only radio needs, and it is also the
          reason the frame cannot simply be display:none).

          Worth saying plainly: YouTube's embedded-player terms expect the video
          to stay visible, and a minimized bar is a stretch of that. It is a
          judgement call for an internal tool, not something to copy into
          anything public. */}
      <div
        className={
          videoId
            ? compact
              ? 'absolute left-0 top-0 h-px w-px overflow-hidden opacity-0 pointer-events-none'
              : 'mx-auto overflow-hidden rounded-lg'
            : 'hidden'
        }
        style={compact ? undefined : mediaStyle}
        // `inert` rather than `aria-hidden`, which would leave a focusable
        // iframe inside a branch hidden from screen readers. This takes it out
        // of the tab order and the accessibility tree together.
        inert={compact}
      >
        <div ref={hostRef} className="h-full w-full" />
      </div>

      {compact && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggle}
            aria-label={playing ? 'Pause' : 'Play'}
            className="flex-shrink-0 rounded-md border border-white/12 p-1.5 text-zinc-300 hover:bg-white/[0.08] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400"
          >
            {playing ? <Pause size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
          </button>
          <p className="min-w-0 flex-1 truncate text-[11px] text-zinc-200" title={title ?? undefined}>
            {title ?? 'Playing'}
          </p>
          <Volume2 size={12} className="flex-shrink-0 text-zinc-500" aria-hidden="true" />
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={level}
            onChange={(e) => setLevel(Number(e.target.value))}
            aria-label="Volume"
            className="w-14 flex-shrink-0 accent-brand-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400"
          />
          <button
            type="button"
            onClick={() => onOpenChange(true)}
            aria-label="Expand radio"
            className="flex-shrink-0 rounded p-1 text-zinc-500 hover:text-zinc-200 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400"
          >
            <Maximize2 size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={turnOff}
            aria-label="Turn the radio off"
            className="flex-shrink-0 rounded p-1 text-zinc-500 hover:text-zinc-200 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {open && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-1.5">
            <input
              id={inputId}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // The scene listens for single keys; stop a paste-and-type from
                // walking the camera across the room.
                e.stopPropagation();
                if (e.key === 'Enter') void submit();
              }}
              placeholder="Search or paste a link"
              aria-label="Search YouTube, or paste a link"
              className="min-w-0 flex-1 rounded-md border border-white/12 bg-white/[0.06] px-2 py-1.5 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400"
            />
            <button
              type="button"
              onClick={() => void submit()}
              disabled={searching || !input.trim()}
              aria-label="Search or play"
              className="rounded-md border border-white/12 px-2 py-1.5 text-zinc-300 hover:bg-white/[0.08] disabled:opacity-40 disabled:hover:bg-transparent transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400"
            >
              {searching ? (
                <Loader2 size={13} className="animate-spin" aria-hidden="true" />
              ) : (
                <Search size={13} aria-hidden="true" />
              )}
            </button>
          </div>

          {/* Search results, if the field held a search rather than a link.
              Capped in height so a long list scrolls inside the panel instead
              of pushing the radio up over the room. */}
          <div aria-live="polite">
            {error && <p className="text-[10px] leading-snug text-red-400">{error}</p>}
            {results.length > 0 && (
              <ul className="max-h-[168px] -mx-1 overflow-y-auto px-1">
                {results.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => play(r.id)}
                      className="flex w-full items-start gap-2 rounded-md p-1 text-left hover:bg-white/[0.08] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={r.thumbnail}
                        alt=""
                        loading="lazy"
                        className="h-[27px] w-12 flex-shrink-0 rounded object-cover"
                      />
                      <span className="min-w-0">
                        <span className="line-clamp-2 text-[11px] leading-snug text-zinc-200">{r.title}</span>
                        <span className="mt-0.5 flex items-center gap-1.5 text-[9px] text-zinc-500">
                          {r.channel && <span className="truncate">{r.channel}</span>}
                          {r.live ? (
                            <span className="flex-shrink-0 font-mono uppercase text-red-400">Live</span>
                          ) : (
                            r.duration && <span className="flex-shrink-0 font-mono">{r.duration}</span>
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {videoId && (
            <>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={toggle}
                  aria-label={playing ? 'Pause' : 'Play'}
                  className="rounded-md border border-white/12 p-1.5 text-zinc-300 hover:bg-white/[0.08] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400"
                >
                  {playing ? <Pause size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
                </button>
                <label htmlFor={levelId} className="text-[10px] text-zinc-400">
                  Volume
                </label>
                <input
                  id={levelId}
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={level}
                  onChange={(e) => setLevel(Number(e.target.value))}
                  className="min-w-0 flex-1 accent-brand-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-400"
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
