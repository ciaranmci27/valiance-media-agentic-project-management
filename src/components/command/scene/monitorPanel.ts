/**
 * The geometry of a monitor's display face, and the canvas that fills it.
 *
 * This lives in its own module because two files have to agree about it and
 * they cannot import each other: `DeskStation` builds the lit plane, and
 * `Screens` sizes the canvas drawn onto it. When those two numbers were
 * written independently they disagreed — a 512x300 canvas (aspect 1.707) on a
 * panel of aspect 1.623 could only be fitted by width, which left the lit face
 * short of the bezel top and bottom no matter how thin the bezel got.
 *
 * So the panel is the single source of truth and everything else is derived
 * from it: bezel in, then the canvas resolution chosen to match what is left.
 * Change `PANEL` or `BEZEL` and the canvas follows.
 */

/**
 * The display quad of `computerScreen.glb`, taken from the model's own
 * geometry: the four corners of the single quad it uses for the screen,
 * sampled in the Monitor group's local frame at the render scale of 1.9.
 *
 * The important thing about these numbers is that the quad is RAKED, not
 * axis-aligned — it leans back about 8°, the way a real monitor does. Reading
 * it as a flat face is what went wrong twice:
 *
 *   1. A hand-picked z of +0.075 put the lit face 9.3cm in FRONT of the
 *      panel, hanging in mid-air. The model's stand foot reaches forward to
 *      z = +0.099 while the panel sits back, so a number eyeballed against
 *      the overall bounding box lands nowhere near the glass.
 *   2. Reading only the quad's maximum z (+0.031 — its BOTTOM edge) and
 *      mounting a vertical plane there left the lit face pitched 8° against
 *      the panel behind it, and sized to the axis-aligned y-span (0.4396)
 *      rather than the true slant height (0.4439).
 *
 * Storing the corners instead of a derived summary means the rake, the
 * centre, the slant height and the surface normal all fall out of the same
 * measurement and cannot disagree with each other.
 */
export const PANEL = {
  halfX: 0.3602,
  bottomY: 0.1056,
  bottomZ: 0.0308,
  topY: 0.5452,
  topZ: -0.031,
};

/**
 * The model's own bezel: the raised frame face that surrounds the display
 * quad, read from the same mesh.
 *
 * This is the measurement that settles how big the lit face should be. The
 * monitor is modelled the way a real one is built — a frame face standing
 * 8.3mm proud of a recessed display quad, with a uniform 12.85mm of visible
 * bezel around it. So the glass does not need a bezel of its own; it needs to
 * fill the recess exactly and let the frame be the frame. Insetting it further
 * just stacked a second bezel on top of the model's, which is what made the
 * screen read as too small for the monitor behind it.
 *
 * `chin` is measured in the panel's own plane, not as a difference in world y.
 * On a raked panel those are not the same number — reading it off y gives
 * 11.59mm and a chin that looks lopsided against the 13.94mm brow, when the
 * frame is in fact symmetric.
 */
const FRAME = {
  /** How far the frame face sits in front of the display quad. */
  standoff: 0.0083,
  /** Visible frame around the screen, measured in the panel's plane. */
  chin: 0.01285,
};

/**
 * How far the glass sits in front of the display quad.
 *
 * Enough to never z-fight with it, and well under `FRAME.standoff` so the
 * screen still sits down inside the recess rather than proud of the bezel.
 */
const LIFT = 0.004;

/**
 * Horizontal pixels on a screen canvas. Height is derived, never chosen.
 *
 * 1024 rather than 512 because the screens now draw real text. At 512 across
 * a 0.72m panel a 13px line is about 1.8cm tall on the glass, which is a grey
 * smear from anywhere you would actually stand; at 1024 it is legible from a
 * couple of metres and sharp when you walk up to it. The extra pixels cost
 * upload bandwidth per repaint, which is paid for by the distance-based LOD
 * in `Screens.tsx` cutting how often a distant or unseen screen repaints at
 * all.
 */
const CANVAS_WIDTH = 1024;

const rise = PANEL.topY - PANEL.bottomY;
const run = PANEL.topZ - PANEL.bottomZ;
/** Negative: the top edge sits further back than the bottom. */
const rake = Math.atan2(run, rise);
/** True face height along the slope, which is what the glass has to fit. */
const slant = Math.hypot(rise, run);

/** The recess the glass has to fill: the display quad itself, edge to edge. */
const availW = PANEL.halfX * 2;
const availH = slant;

/**
 * The canvas, sized to the hole it has to fill.
 *
 * Whole pixels cannot hit the opening's aspect exactly, so the fit below
 * absorbs the remainder as a fraction of a millimetre of slack on one axis
 * rather than as stretched content. Rounding DOWN decides which axis: a
 * shorter canvas is proportionally wider than the recess, so the fit is
 * limited by width and the glass meets the side bezels exactly, leaving the
 * sliver at top and bottom where the brow already shadows it.
 */
export const SCREEN_CANVAS = {
  w: CANVAS_WIDTH,
  h: Math.floor(CANVAS_WIDTH / (availW / availH)),
};

const canvasAspect = SCREEN_CANVAS.w / SCREEN_CANVAS.h;

/**
 * The lit face: where to put it, how far to tilt it, and how big it is.
 *
 * `rake` is the rotation about X that lays a plane flat onto the panel — with
 * it applied, the plane's own +Y runs up the panel's slope and its +Z normal
 * points out of the glass. Everything mounted on the screen (the surface
 * itself, the status LED) goes inside one group carrying this rotation, so
 * they are raked together by construction rather than each needing its own
 * correction.
 */
export const SCREEN = (() => {
  const w = Math.min(availW, availH * canvasAspect);
  return {
    w,
    h: w / canvasAspect,
    rake,
    centreY: (PANEL.bottomY + PANEL.topY) / 2 + -Math.sin(rake) * LIFT,
    centreZ: (PANEL.bottomZ + PANEL.topZ) / 2 + Math.cos(rake) * LIFT,
  };
})();

/**
 * The status LED, in the same raked frame as the screen.
 *
 * It belongs on the model's chin, so it is measured off the panel's bottom
 * edge and the frame's own dimensions rather than off the glass — the glass
 * now reaches the full recess, and hanging the LED below *that* would put it
 * over the edge of the monitor.
 */
export const LED = {
  /** Centred in the chin, just below the bottom of the display quad. */
  offsetY: -slant / 2 - FRAME.chin / 2,
  height: FRAME.chin * 0.5,
  /** Centred on the frame face, so it reads as set into the bezel. */
  offsetZ: FRAME.standoff - LIFT,
};
