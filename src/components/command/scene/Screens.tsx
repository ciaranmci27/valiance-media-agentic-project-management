'use client';

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { WorkerState } from './behavior';
import type { ScreenKind } from './crew';
import { SCREEN_CANVAS } from './monitorPanel';
import { registerScreen, unregisterScreen } from './screenRegistry';
import { modelKey, type ScreenModel, type ScreenRow, type Tone } from './screenContent';
import { ensureFonts, fontRevision, fontsReady, measure, mono, sans, text } from './screenText';

/**
 * Monitor content: a composed workspace per craft, drawn to a canvas texture.
 *
 * Each agent runs the tool their job actually uses. Greg has an audit pass
 * with a findings ledger, Ashley a board and a spec, Jeff an editor and a
 * terminal, John a diff and the pull request under review. The layout is the
 * craft; watching for a minute should tell you who is who without a label.
 *
 * Two rules divide what is drawn here.
 *
 * **What is true comes from `screenContent`.** Real task titles, PR numbers,
 * commit SHAs, branch names and audit findings arrive as a `ScreenModel` and
 * are drawn as text. This file never decides what is a fact.
 *
 * **What is texture stays obviously texture.** Nothing in the schema stores a
 * diff, a source file or a CI run, so code bodies, diff hunks and log output
 * are seeded noise and are drawn as shapes rather than as fake identifiers. A
 * screen that invented a plausible commit hash would be lying in a way the
 * viewer has no way to check.
 *
 * Motion policy, unchanged from before: cursor blink and machine ambience are
 * always on; content motion is keyed to the agent's real activity, and an
 * agent that is not working gets a dimmed, locked screen rather than invented
 * busywork.
 */

const W = SCREEN_CANVAS.w;
const H = SCREEN_CANVAS.h;

/**
 * Layout unit. Every size below is authored against a 1024-wide canvas, so
 * changing `CANVAS_WIDTH` rescales the whole layout instead of leaving text
 * at half size on a bigger surface.
 */
const U = W / 1024;
const u = (n: number) => n * U;

/* ---------------------------------------------------------------- palette */

const INK = {
  bg: '#0b0e13',
  panel: '#11151c',
  panelHi: '#161b24',
  line: '#1c222b',
  dim: '#3a4350',
  mid: '#5c6878',
  bright: '#aab4c2',
  white: '#e8edf4',
  teal: '#6fa3a3',
  tealDeep: '#41605f',
  copper: '#c5a68f',
  red: '#a35148',
  redBg: '#2a1613',
  green: '#5d9c76',
  greenBg: '#12241a',
  amber: '#d9a13d',
};

const TONE: Record<Tone, string> = {
  dim: INK.dim,
  mid: INK.mid,
  bright: INK.bright,
  teal: INK.teal,
  copper: INK.copper,
  good: INK.green,
  warn: INK.amber,
  bad: INK.red,
};

/* -------------------------------------------------------------------- LOD */

/**
 * How often a screen repaints, by how much of it you can actually see.
 *
 * Previously every screen repainted at a flat 18fps whether it was filling
 * the frame or facing away behind you. That is five canvas repaints and five
 * texture uploads per interval regardless of whether any of them could be
 * seen. Distance is the cheap approximation of how much detail is resolvable,
 * so it drives both the rate and how much gets drawn.
 */
export type Tier = 'near' | 'mid' | 'far' | 'hidden';

const NEAR_M = 2.5;
const MID_M = 6;

const TIER_INTERVAL: Record<Tier, number> = {
  near: 1 / 20,
  mid: 1 / 12,
  far: 1 / 4,
  hidden: Infinity,
};

/** Below `mid` the text is smaller than a screen pixel; bars read better. */
const TIER_TEXT: Record<Tier, boolean> = { near: true, mid: true, far: false, hidden: false };

/**
 * Offsets, as fractions of the repaint interval, spreading each screen's
 * repaint across it instead of stacking them on one frame.
 *
 * They used to share both interval AND phase, so all five crossed the
 * threshold on the same frame: that frame did five repaints and five texture
 * uploads back to back while its neighbours did none, a spike at exactly the
 * cadence of a view that skips while you turn.
 */
const SCREEN_PHASES = [0, 0.5, 0.17, 0.67, 0.34, 0.83];
let screenPhaseSeq = 0;

/**
 * The last frame on which any screen repainted, identified by its clock time.
 *
 * A hard backstop under the phase spread: with per-screen intervals now
 * differing by tier, phases drift and two screens can land on one frame
 * anyway. Deferring the second one costs it a single frame of latency on a
 * surface that updates a few times a second.
 */
let paintedAt = -1;

/* ------------------------------------------------------------- primitives */

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What the screen knows about the person in front of it, plus its own tier. */
export type ScreenState = {
  active: boolean;
  activity: string;
  cursor: { x: number; y: number };
  keystrokes: number;
  scroll: number;
  sinceClick: number;
  tier: Tier;
  /** Wall clock for ambience that should run regardless of activity. */
  t: number;
};

type Drawer = (ctx: CanvasRenderingContext2D, m: ScreenModel, s: ScreenState) => void;

function fill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/**
 * Window chrome: a title bar carrying the real title, and the body rect.
 * Returns the content box so each workspace lays out inside it.
 */
function chrome(
  ctx: CanvasRenderingContext2D,
  m: ScreenModel,
  s: ScreenState
): { x: number; y: number; w: number; h: number } {
  fill(ctx, 0, 0, W, H, INK.bg);
  const barH = u(34);
  fill(ctx, 0, 0, W, barH, INK.panel);
  fill(ctx, 0, barH - u(1), W, u(1), INK.line);

  if (TIER_TEXT[s.tier]) {
    let x = u(16);
    // Three dots, the universal "this is a window" tell.
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i === 0 ? INK.tealDeep : INK.line;
      ctx.beginPath();
      ctx.arc(x + i * u(14), barH / 2, u(4), 0, Math.PI * 2);
      ctx.fill();
    }
    x += u(46);
    x += text(ctx, m.windowTitle, x, barH / 2 + u(5), sans(600, u(14)), INK.white, u(560)) + u(14);
    if (m.subtitle) text(ctx, m.subtitle, x, barH / 2 + u(5), mono(400, u(12)), INK.dim, u(260));
  } else {
    fill(ctx, u(16), u(11), u(180), u(12), INK.line);
    fill(ctx, u(210), u(11), u(90), u(12), INK.dim);
  }

  let top = barH;
  if (m.banner) {
    const h = u(26);
    const bg = m.banner.tone === 'good' ? INK.greenBg : m.banner.tone === 'bad' ? INK.redBg : '#2a220f';
    const fg = m.banner.tone === 'good' ? INK.green : m.banner.tone === 'bad' ? INK.red : INK.amber;
    fill(ctx, 0, top, W, h, bg);
    fill(ctx, 0, top, u(3), h, fg);
    if (TIER_TEXT[s.tier]) text(ctx, m.banner.text, u(16), top + u(18), mono(500, u(12)), fg, W - u(32));
    else fill(ctx, u(16), top + u(9), u(150), u(9), fg);
    top += h;
  }

  const barBottom = u(24);
  return { x: 0, y: top, w: W, h: H - top - barBottom };
}

/** Status bar along the bottom: the real branch, and whether hands are moving. */
function statusBar(ctx: CanvasRenderingContext2D, m: ScreenModel, s: ScreenState) {
  const h = u(24);
  const y = H - h;
  fill(ctx, 0, y, W, h, s.active ? INK.tealDeep : INK.line);
  if (!TIER_TEXT[s.tier]) {
    fill(ctx, u(12), y + u(8), s.activity === 'type' ? u(92) : u(56), u(8), s.active ? INK.bright : INK.mid);
    return;
  }
  const fg = s.active ? INK.white : INK.mid;
  let x = u(14);
  if (m.branch) {
    x += text(ctx, `⎇ ${m.branch}`, x, y + u(16), mono(500, u(12)), fg, u(260)) + u(20);
  }
  text(ctx, s.active ? s.activity : 'idle', x, y + u(16), mono(400, u(12)), s.active ? INK.bright : INK.dim, u(120));
}

/**
 * The body rows: findings, criteria, verdicts. One renderer, because every
 * craft ends up needing "a list of real things with a short tag".
 */
function rowList(
  ctx: CanvasRenderingContext2D,
  rows: ScreenRow[],
  box: { x: number; y: number; w: number; h: number },
  s: ScreenState,
  max: number
) {
  const lineH = u(26);
  const shown = Math.min(rows.length, max, Math.floor(box.h / lineH));
  for (let i = 0; i < shown; i++) {
    const r = rows[i];
    const y = box.y + i * lineH;
    const hot = i === 0 && s.active;
    if (hot) fill(ctx, box.x, y, box.w, lineH - u(3), INK.panelHi);
    const color = TONE[r.tone];
    if (!TIER_TEXT[s.tier]) {
      fill(ctx, box.x + u(10), y + u(9), u(22), u(8), color);
      fill(ctx, box.x + u(42), y + u(9), Math.min(box.w - u(60), u(120) + i * u(37)), u(8), INK.mid);
      continue;
    }
    let x = box.x + u(10);
    if (r.tag) {
      const tagFont = mono(500, u(11));
      const tw = measure(ctx, r.tag, tagFont) + u(10);
      fill(ctx, x, y + u(4), tw, u(15), INK.panel);
      text(ctx, r.tag, x + u(5), y + u(15), tagFont, color, tw);
      x += tw + u(10);
    }
    text(ctx, r.text, x, y + u(15), mono(400, u(13)), r.done ? INK.dim : INK.bright, box.x + box.w - x - u(10));
  }
  if (!rows.length && TIER_TEXT[s.tier]) {
    text(ctx, 'nothing open', box.x + u(10), box.y + u(18), mono(400, u(13)), INK.dim, box.w - u(20));
  }
}

/**
 * A syntax-highlighted line as coloured token bars. Always consumes the same
 * number of random draws regardless of how much it draws, so a partly-written
 * line does not reshuffle the lines below it.
 */
function tokenLine(ctx: CanvasRenderingContext2D, x: number, y: number, rnd: () => number, maxW: number) {
  let cx = x + Math.floor(rnd() * 3) * u(24);
  const n = 2 + Math.floor(rnd() * 5);
  for (let i = 0; i < n; i++) {
    const w = u(24) + rnd() * u(78);
    const roll = rnd();
    if (cx + w <= x + maxW) {
      ctx.fillStyle = roll < 0.3 ? INK.teal : roll < 0.45 ? INK.copper : roll < 0.75 ? INK.mid : INK.dim;
      ctx.fillRect(cx, y, w, u(7));
    }
    cx += w + u(12);
  }
}

/* ------------------------------------------------------------- workspaces */

/** Greg: tree, a source pane under a travelling scan, and the findings ledger. */
const drawAudit: Drawer = (ctx, m, s) => {
  const box = chrome(ctx, m, s);
  const treeW = u(250);
  const ledgerH = Math.min(box.h * 0.46, u(230));
  const scanTop = box.y;
  const scanH = box.h - ledgerH;

  // File tree.
  fill(ctx, box.x, box.y, treeW, box.h, INK.panel);
  const rnd = mulberry32(21);
  const rowsN = Math.floor(box.h / u(24));
  const hoverRow = Math.floor(s.cursor.y * rowsN);
  const overTree = s.cursor.x < treeW / W;
  for (let i = 0; i < rowsN; i++) {
    const y = box.y + u(10) + i * u(24);
    const depth = Math.floor(rnd() * 3);
    const hot = overTree && i === hoverRow && s.active;
    if (hot) fill(ctx, box.x, y - u(5), treeW, u(21), INK.tealDeep);
    fill(ctx, box.x + u(16) + depth * u(18), y, u(10), u(10), depth === 0 ? INK.teal : INK.dim);
    fill(ctx, box.x + u(34) + depth * u(18), y + u(2), u(80) + rnd() * u(70), u(7), hot ? INK.bright : INK.mid);
  }

  // Source under the lens, with a scan line that only travels while working.
  const srcX = box.x + treeW + u(18);
  const srcW = box.w - treeW - u(30);
  const rnd2 = mulberry32(33);
  const off = (s.scroll * u(60)) % u(24);
  for (let i = 0; i < Math.floor(scanH / u(24)) + 1; i++) {
    tokenLine(ctx, srcX, scanTop + u(14) + i * u(24) - off, rnd2, srcW);
  }
  if (s.active) {
    const y = scanTop + ((s.t * u(80)) % scanH);
    ctx.fillStyle = 'rgba(111, 163, 163, 0.20)';
    ctx.fillRect(srcX - u(6), y, srcW + u(12), u(22));
    fill(ctx, srcX - u(6), y, srcW + u(12), u(1), INK.teal);
  }

  // Findings: his real open suggestions.
  const ly = box.y + box.h - ledgerH;
  fill(ctx, box.x, ly, box.w, ledgerH, INK.panel);
  fill(ctx, box.x, ly, box.w, u(1), INK.line);
  if (TIER_TEXT[s.tier]) {
    text(ctx, 'FINDINGS', box.x + u(14), ly + u(20), mono(500, u(12)), INK.copper, u(200));
  } else {
    fill(ctx, box.x + u(14), ly + u(11), u(90), u(9), INK.copper);
  }
  rowList(ctx, m.rows, { x: box.x + u(4), y: ly + u(32), w: box.w - u(8), h: ledgerH - u(38) }, s, 7);
  statusBar(ctx, m, s);
};

/** Ashley: board columns on the left, the spec being written on the right. */
const drawSpec: Drawer = (ctx, m, s) => {
  const box = chrome(ctx, m, s);
  const boardW = box.w * 0.52;
  const cols = 3;
  const gap = u(12);
  const colW = (boardW - gap * (cols + 1)) / cols;
  const rnd = mulberry32(5);
  const cx = s.cursor.x * W;
  const cy = s.cursor.y * H;

  for (let c = 0; c < cols; c++) {
    const x = box.x + gap + c * (colW + gap);
    fill(ctx, x, box.y + u(8), colW, box.h - u(16), INK.panel);
    if (TIER_TEXT[s.tier]) {
      text(ctx, ['TODO', 'SPEC', 'READY'][c], x + u(10), box.y + u(28), mono(500, u(11)), c === 1 ? INK.teal : INK.mid, colW - u(20));
    } else {
      fill(ctx, x + u(10), box.y + u(20), u(56), u(8), c === 1 ? INK.teal : INK.mid);
    }
    const cards = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < cards; i++) {
      const y = box.y + u(44) + i * u(66);
      if (y + u(54) > box.y + box.h - u(10)) break;
      const hot = s.active && cx > x && cx < x + colW && cy > y && cy < y + u(54);
      const lift = hot ? u(3) + Math.sin(s.t * 6) * u(1.5) : 0;
      fill(ctx, x + u(8), y - lift, colW - u(16), u(54), hot ? INK.panelHi : INK.bg);
      // The card the agent is actually holding carries the real title.
      if (c === 1 && i === 0 && TIER_TEXT[s.tier]) {
        text(ctx, m.windowTitle, x + u(14), y + u(20) - lift, mono(400, u(11)), INK.bright, colW - u(28));
      } else {
        fill(ctx, x + u(14), y + u(12) - lift, colW - u(44), u(7), hot ? INK.bright : INK.mid);
      }
      fill(ctx, x + u(14), y + u(30) - lift, colW - u(34), u(6), INK.dim);
      fill(ctx, x + u(14), y + u(42) - lift, u(26), u(6), i % 2 ? INK.copper : INK.tealDeep);
    }
  }

  // Spec pane: the real task facts, then body text that grows as she types.
  const sx = box.x + boardW + u(10);
  const sw = box.w - boardW - u(22);
  fill(ctx, sx, box.y + u(8), sw, box.h - u(16), INK.panel);
  rowList(ctx, m.rows, { x: sx, y: box.y + u(18), w: sw, h: u(110) }, s, 4);
  const bodyY = box.y + u(140);
  const rnd2 = mulberry32(77);
  const lines = Math.floor((box.h - u(150)) / u(20));
  const written = Math.floor((s.keystrokes / 40) % (lines + 1));
  for (let i = 0; i < lines; i++) {
    const y = bodyY + i * u(20);
    if (i < written) tokenLine(ctx, sx + u(12), y, rnd2, sw - u(24));
    else tokenLine(ctx, sx + u(12), y, rnd2, 0);
  }
  statusBar(ctx, m, s);
};

/** Jeff, primary: the editor, tabbed with the real thing he is building. */
const drawCode: Drawer = (ctx, m, s) => {
  const box = chrome(ctx, m, s);
  const lineH = u(24);
  const total = Math.floor((box.h - u(16)) / lineH);
  const CHARS_PER_LINE = 42;
  // The file is written by the hands on the keyboard: `keystrokes` only
  // advances while fingers are actually striking keys, so the text stops
  // growing the moment they break off to think or reach for the mouse.
  const typed = s.keystrokes % (total * CHARS_PER_LINE);
  const written = Math.floor(typed / CHARS_PER_LINE);
  const partial = (typed % CHARS_PER_LINE) / CHARS_PER_LINE;

  // Gutter.
  fill(ctx, box.x, box.y, u(52), box.h, INK.panel);
  const rnd = mulberry32(7);
  for (let i = 0; i < total; i++) {
    const y = box.y + u(14) + i * lineH;
    if (TIER_TEXT[s.tier]) {
      text(ctx, String(i + 1).padStart(3, ' '), box.x + u(12), y + u(8), mono(400, u(11)), INK.dim, u(34));
    } else {
      fill(ctx, box.x + u(14), y, u(20), u(7), INK.dim);
    }
    const x = box.x + u(64);
    const maxW = box.w - u(80);
    if (i < written) tokenLine(ctx, x, y, rnd, maxW);
    else if (i === written) tokenLine(ctx, x, y, rnd, Math.max(u(10), maxW * partial));
    else tokenLine(ctx, x, y, rnd, 0);
  }

  const cy = box.y + u(14) + Math.min(written, total - 1) * lineH;
  const cx = box.x + u(64) + (box.w - u(96)) * partial;
  // Solid while keys are being struck, blinking when the file is at rest.
  if (s.active && (s.activity === 'type' || Math.floor(s.t * 2.2) % 2 === 0)) {
    fill(ctx, cx, cy - u(3), u(9), u(15), INK.bright);
  }
  statusBar(ctx, m, s);
};

/**
 * Jeff, secondary: the terminal.
 *
 * The most animated surface in the room, and the one that most needed to stop
 * being a duplicate of Greg's file tree. Lines are seeded shapes rather than
 * invented command output; what is real is the branch on the prompt and
 * whether the run is currently passing, which comes from the review verdict.
 */
const drawTerminal: Drawer = (ctx, m, s) => {
  const box = chrome(ctx, m, s);
  fill(ctx, box.x, box.y, box.w, box.h, '#080a0e');
  const lineH = u(20);
  const capacity = Math.floor((box.h - u(30)) / lineH);
  // Output only advances while the agent is working; a stopped agent's
  // terminal sits at its last line rather than scrolling forever.
  const emitted = s.active ? Math.floor(s.t * 3.5) : 0;
  const rnd = mulberry32(101 + Math.floor(emitted / capacity));
  const failing = m.banner?.tone === 'bad' || m.banner?.tone === 'warn';

  for (let i = 0; i < capacity; i++) {
    const y = box.y + u(18) + i * lineH;
    const idx = emitted - capacity + i;
    if (idx < 0) continue;
    const roll = rnd();
    const kind = roll < 0.12 ? 'fail' : roll < 0.34 ? 'pass' : 'plain';
    const color = kind === 'fail' && failing ? INK.red : kind === 'pass' ? INK.green : INK.mid;
    if (TIER_TEXT[s.tier]) {
      const mark = kind === 'fail' && failing ? '✕' : kind === 'pass' ? '✓' : '·';
      text(ctx, mark, box.x + u(14), y, mono(500, u(12)), color, u(14));
    } else {
      fill(ctx, box.x + u(14), y - u(8), u(8), u(8), color);
    }
    fill(ctx, box.x + u(34), y - u(7), u(90) + rnd() * (box.w - u(200)), u(7), kind === 'plain' ? INK.dim : color);
  }

  // Prompt line, carrying the real branch.
  const py = box.y + box.h - u(6);
  if (TIER_TEXT[s.tier]) {
    let x = box.x + u(14);
    x += text(ctx, m.branch ? `${m.branch} ❯` : '❯', x, py, mono(500, u(13)), INK.teal, u(240)) + u(10);
    if (s.active && Math.floor(s.t * 2.4) % 2 === 0) fill(ctx, x, py - u(11), u(9), u(14), INK.bright);
  } else {
    fill(ctx, box.x + u(14), py - u(10), u(70), u(9), INK.teal);
  }
  statusBar(ctx, m, s);
};

/** John: the diff on the left, the real pull request on the right. */
const drawReview: Drawer = (ctx, m, s) => {
  const box = chrome(ctx, m, s);
  const panelW = Math.min(box.w * 0.38, u(360));
  const diffW = box.w - panelW;

  const rnd = mulberry32(11);
  const lineH = u(22);
  const rows = Math.floor(box.h / lineH) + 1;
  // The diff moves when he scrolls it, at reading pace, not typing pace.
  const scroll = (s.scroll * u(90)) % lineH;
  for (let i = 0; i < rows; i++) {
    const y = box.y + u(10) + i * lineH - scroll;
    const roll = rnd();
    const kind = roll < 0.22 ? 'del' : roll < 0.44 ? 'add' : 'ctx';
    if (kind !== 'ctx') {
      fill(ctx, box.x, y - u(6), diffW - u(12), lineH - u(2), kind === 'del' ? INK.redBg : INK.greenBg);
      fill(ctx, box.x + u(14), y, u(10), u(9), kind === 'del' ? INK.red : INK.green);
    }
    fill(ctx, box.x + u(40), y, u(120) + rnd() * (diffW - u(220)), u(7), kind === 'ctx' ? INK.dim : INK.mid);
  }

  // Pull request panel: real number, real short SHA, real verdict history.
  const px0 = box.x + diffW;
  fill(ctx, px0, box.y, panelW, box.h, INK.panel);
  fill(ctx, px0, box.y, u(1), box.h, INK.line);
  let y = box.y + u(26);
  if (TIER_TEXT[s.tier]) {
    if (m.pr) {
      const verdictGood = m.pr.verdict === 'approved';
      text(ctx, m.pr.number, px0 + u(14), y, sans(600, u(18)), INK.white, panelW - u(28));
      y += u(24);
      text(ctx, m.pr.sha || 'no sha', px0 + u(14), y, mono(400, u(12)), INK.dim, panelW - u(28));
      y += u(24);
      const label = verdictGood ? 'APPROVED' : 'CHANGES REQUESTED';
      const c = verdictGood ? INK.green : INK.amber;
      fill(ctx, px0 + u(14), y - u(12), u(6), u(14), c);
      text(ctx, label, px0 + u(26), y, mono(500, u(12)), c, panelW - u(44));
      y += u(20);
      text(ctx, `round ${m.pr.round}`, px0 + u(26), y, mono(400, u(11)), INK.dim, panelW - u(44));
      y += u(24);
    } else {
      text(ctx, 'no PR in review', px0 + u(14), y, mono(400, u(13)), INK.dim, panelW - u(28));
      y += u(24);
    }
  } else {
    fill(ctx, px0 + u(14), y - u(14), u(80), u(14), INK.bright);
    fill(ctx, px0 + u(14), y + u(10), u(120), u(8), INK.dim);
    y += u(40);
  }
  rowList(ctx, m.rows, { x: px0, y: y, w: panelW, h: box.y + box.h - y }, s, 6);
  statusBar(ctx, m, s);
};

const DRAWERS: Record<ScreenKind, Drawer> = {
  audit: drawAudit,
  spec: drawSpec,
  code: drawCode,
  terminal: drawTerminal,
  review: drawReview,
};

/**
 * The dimmed, locked state of a screen whose agent is not working.
 *
 * Drawn over the finished frame rather than instead of it, so the workspace
 * is still faintly visible the way a real screen is behind a lock. The point
 * is that an idle agent's monitor must not animate: the database's silence is
 * respected here exactly as it is in `behavior.ts`.
 */
function drawAsleep(ctx: CanvasRenderingContext2D, s: ScreenState) {
  ctx.fillStyle = 'rgba(8, 10, 14, 0.72)';
  ctx.fillRect(0, 0, W, H);
  const cx = W / 2;
  const cy = H / 2;
  const pulse = 0.35 + Math.sin(s.t * 1.1) * 0.12;
  ctx.strokeStyle = `rgba(92, 104, 120, ${pulse})`;
  ctx.lineWidth = u(2);
  ctx.beginPath();
  ctx.arc(cx, cy, u(26), 0, Math.PI * 2);
  ctx.stroke();
  fill(ctx, cx - u(9), cy - u(4), u(18), u(15), `rgba(92, 104, 120, ${pulse + 0.15})`);
}

/** The pointer itself, drawn last so it sits over everything. */
function drawCursor(ctx: CanvasRenderingContext2D, s: ScreenState) {
  const x = s.cursor.x * W;
  const y = s.cursor.y * H;
  const k = u(1);
  if (s.sinceClick < 0.5) {
    const f = s.sinceClick / 0.5;
    ctx.strokeStyle = `rgba(160, 200, 220, ${(1 - f) * 0.8})`;
    ctx.lineWidth = u(2);
    ctx.beginPath();
    ctx.arc(x, y, u(6) + f * u(26), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = '#0b0e13';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y + 26 * k);
  ctx.lineTo(x + 7 * k, y + 19 * k);
  ctx.lineTo(x + 16 * k, y + 18 * k);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#eef3f7';
  ctx.beginPath();
  ctx.moveTo(x + 2 * k, y + 4 * k);
  ctx.lineTo(x + 2 * k, y + 21 * k);
  ctx.lineTo(x + 7 * k, y + 16 * k);
  ctx.lineTo(x + 13 * k, y + 16 * k);
  ctx.closePath();
  ctx.fill();
}

/* ----------------------------------------------------------------- surface */

/**
 * The lit face of a monitor.
 *
 * Repaint cadence and detail come from how far away the camera is and whether
 * it can see this screen at all, so a wall of monitors costs roughly what the
 * ones you are looking at cost.
 */
export function ScreenSurface({
  kind,
  model,
  worker,
  active,
  width,
  height,
  brightness = 1,
  label,
}: {
  kind: ScreenKind;
  /** The facts this screen may state. See `screenContent`. */
  model: ScreenModel;
  /** The person at this desk; the screen is a readout of what they do. */
  worker: WorkerState;
  active: boolean;
  width: number;
  height: number;
  brightness?: number;
  /** Shown on the focus prompt when this screen is being looked at. */
  label: string;
}) {
  const screenIndex = useRef(screenPhaseSeq++ % SCREEN_PHASES.length);
  const tint = useMemo(() => new THREE.Color(brightness, brightness, brightness), [brightness]);
  const meshRef = useRef<THREE.Mesh>(null);

  const { texture, ctx } = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const context = canvas.getContext('2d')!;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return { texture: tex, ctx: context };
  }, []);

  const nextDraw = useRef(SCREEN_PHASES[screenIndex.current] * TIER_INTERVAL.mid);
  const drawnAtRevision = useRef(-1);
  const drawnKey = useRef('');
  const state = useRef<ScreenState>({
    active,
    activity: 'type',
    cursor: { x: 0.5, y: 0.5 },
    keystrokes: 0,
    scroll: 0,
    sinceClick: 99,
    tier: 'mid',
    t: 0,
  });

  // Scratch, reused: this runs every frame on every screen.
  const worldPos = useRef(new THREE.Vector3());
  const normal = useRef(new THREE.Vector3());
  const toCamera = useRef(new THREE.Vector3());
  const camForward = useRef(new THREE.Vector3());

  useFrame(({ clock, camera }) => {
    ensureFonts();
    const mesh = meshRef.current;
    if (!mesh) return;
    const t = clock.elapsedTime;

    // ---- Tier ----
    mesh.getWorldPosition(worldPos.current);
    toCamera.current.subVectors(camera.position, worldPos.current);
    const distance = toCamera.current.length();
    normal.current.set(0, 0, 1).transformDirection(mesh.matrixWorld);
    camera.getWorldDirection(camForward.current);
    // Facing away, or behind the camera: nothing to draw for.
    const facing = normal.current.dot(toCamera.current) > 0;
    // `toCamera` points screen -> camera, so camera -> screen is its negation.
    // Comparing against that rather than mutating `worldPos` keeps the scratch
    // vectors meaning one thing each for the whole frame.
    const inFront = camForward.current.dot(toCamera.current) < 0;
    const tier: Tier = !facing || !inFront ? 'hidden' : distance < NEAR_M ? 'near' : distance < MID_M ? 'mid' : 'far';
    state.current.tier = tier;

    const interval = TIER_INTERVAL[tier];
    if (!Number.isFinite(interval)) return;

    // Repaint when the content changed, when the font finally arrived, or on
    // the tier's own cadence for the parts that animate.
    const key = modelKey(model);
    const stale = key !== drawnKey.current || fontRevision() !== drawnAtRevision.current;
    if (!stale && t < nextDraw.current) return;
    // One repaint per frame across all screens; the loser waits a frame.
    if (paintedAt === t) return;
    if (!fontsReady() && TIER_TEXT[tier]) return;
    paintedAt = t;
    // Advance from the deadline, not from now, so a late frame does not drag
    // this screen's phase into another's.
    nextDraw.current = Math.max(t, nextDraw.current + interval);
    drawnKey.current = key;
    drawnAtRevision.current = fontRevision();

    const s = state.current;
    s.active = active && model.awake;
    s.activity = worker.activity;
    s.cursor.x = worker.cursor.x;
    s.cursor.y = worker.cursor.y;
    s.keystrokes = worker.keystrokes;
    s.scroll = worker.scroll;
    s.sinceClick = worker.sinceClick;
    s.t = t;

    DRAWERS[kind](ctx, model, s);
    if (!model.awake) drawAsleep(ctx, s);
    else if (s.active && tier === 'near') drawCursor(ctx, s);
    texture.needsUpdate = true;
  });

  // Register for look-at focus once mounted. An effect rather than a ref
  // callback: an inline ref callback is a new function every render, so React
  // would tear it down and re-run it with null on each one, churning the
  // registry for a mesh that never changed.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    registerScreen(mesh, label);
    return () => unregisterScreen(mesh);
  }, [label]);

  return (
    <mesh ref={meshRef} position={[0, 0, 0]}>
      <planeGeometry args={[width, height]} />
      {/* Memoised: an inline `new THREE.Color(...)` here is a fresh object on
          every render, which makes R3F reassign the material's colour each
          time for a value that never changes. */}
      <meshBasicMaterial map={texture} toneMapped={false} color={tint} />
    </mesh>
  );
}
