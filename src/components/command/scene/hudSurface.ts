/**
 * The glass every floating HUD panel is made of.
 *
 * One string rather than three copies: the activity log, the crew bar and the
 * radio sit in the same corner of the same view, and the moment their tints
 * differ by even 10% opacity you can see it. They had drifted to bg-black/45
 * with a small blur, bg-black/55 with a normal one, and bg-black/75 before
 * this. Anything that wants to be one of those panels uses this and adds only
 * its own size and padding.
 *
 * The darker of the two previous tints won, because the radio carries a video
 * and readable controls over a room that is bright in the daytime.
 *
 * Tailwind picks these classes up from this file the same as from any JSX,
 * because it scans source text; a constant is not invisible to it.
 */
export const HUD_SURFACE = 'rounded-xl border border-white/[0.07] bg-black/55 backdrop-blur';
