'use client';

import { useEffect, useRef } from 'react';

/**
 * The walking stick, for touch.
 *
 * Its own DOM node deliberately, sitting over the canvas rather than inside it.
 * That is what separates the two gestures without a single line of arbitration:
 * a touch that starts here targets this element and never reaches the canvas's
 * look listeners, and a touch that starts anywhere else never reaches this one.
 * Both can be live at once — steer with one thumb, look with the other.
 *
 * It writes into a ref rather than React state. A thumb produces touchmove at
 * the screen's refresh rate, and re-rendering the tree that often to move a
 * knob 40 pixels would cost more than the scene it sits on; the knob is moved
 * by writing a transform directly, and the scene reads the vector each frame.
 *
 * Bottom-LEFT because the settings sheet rises from the bottom edge and the
 * activity HUD owns the bottom strip on larger screens — and because a stick
 * under the left thumb is the convention every game on this hardware already
 * taught the user.
 */

/** Base diameter and knob diameter, px. The knob travels (BASE - KNOB) / 2. */
const BASE = 116;
const KNOB = 48;
const TRAVEL = (BASE - KNOB) / 2;

/**
 * Deflection below this is treated as zero.
 *
 * A thumb resting on the stick is never exactly centred, and without this the
 * walker creeps continuously — which reads as the scene drifting on its own.
 */
const DEAD_ZONE = 0.12;

export function TouchJoystick({ move }: { move: React.RefObject<{ x: number; y: number }> }) {
  const baseRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const base = baseRef.current;
    const knob = knobRef.current;
    const vector = move.current;
    if (!base || !knob || !vector) return;

    let touchId: number | null = null;
    let centreX = 0;
    let centreY = 0;

    const apply = (clientX: number, clientY: number) => {
      const dx = clientX - centreX;
      const dy = clientY - centreY;
      const distance = Math.hypot(dx, dy);
      const unitX = distance > 0 ? dx / distance : 0;
      const unitY = distance > 0 ? dy / distance : 0;
      const pulled = Math.min(distance, TRAVEL);

      knob.style.transform = `translate3d(${unitX * pulled}px, ${unitY * pulled}px, 0)`;

      // Rescaled past the dead zone so the first millimetre of real movement
      // starts from a standstill instead of jumping to 12% of walking pace.
      const deflection = pulled / TRAVEL;
      const scaled = deflection < DEAD_ZONE ? 0 : (deflection - DEAD_ZONE) / (1 - DEAD_ZONE);
      vector.x = unitX * scaled;
      vector.y = unitY * scaled;
    };

    const release = () => {
      touchId = null;
      knob.style.transform = 'translate3d(0px, 0px, 0)';
      vector.x = 0;
      vector.y = 0;
    };

    const onStart = (e: TouchEvent) => {
      if (touchId !== null) return;
      const touch = e.changedTouches[0];
      if (!touch) return;
      touchId = touch.identifier;
      // Measured per press: the sheet opening or the device rotating moves it.
      const rect = base.getBoundingClientRect();
      centreX = rect.left + rect.width / 2;
      centreY = rect.top + rect.height / 2;
      apply(touch.clientX, touch.clientY);
      e.preventDefault();
    };

    const onMove = (e: TouchEvent) => {
      if (touchId === null) return;
      for (const touch of Array.from(e.changedTouches)) {
        if (touch.identifier !== touchId) continue;
        apply(touch.clientX, touch.clientY);
        e.preventDefault();
        break;
      }
    };

    const onEnd = (e: TouchEvent) => {
      if (touchId === null) return;
      for (const touch of Array.from(e.changedTouches)) {
        if (touch.identifier === touchId) {
          release();
          break;
        }
      }
    };

    base.addEventListener('touchstart', onStart, { passive: false });
    base.addEventListener('touchmove', onMove, { passive: false });
    base.addEventListener('touchend', onEnd, { passive: true });
    base.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      base.removeEventListener('touchstart', onStart);
      base.removeEventListener('touchmove', onMove);
      base.removeEventListener('touchend', onEnd);
      base.removeEventListener('touchcancel', onEnd);
      // Leaving a stale deflection behind would keep the walker moving after
      // the stick has gone.
      vector.x = 0;
      vector.y = 0;
    };
  }, [move]);

  return (
    <div
      ref={baseRef}
      // Decorative: it is an input, but a touch-only one with no keyboard or
      // screen-reader equivalent, so announcing it would only promise
      // something that cannot be delivered. The camera-mode control in the
      // settings sheet is the accessible route to the same view.
      aria-hidden="true"
      style={{ width: BASE, height: BASE, touchAction: 'none' }}
      className="lg:hidden absolute bottom-6 left-4 z-20 rounded-full border border-white/15 bg-black/35 backdrop-blur-sm flex items-center justify-center"
    >
      <div
        ref={knobRef}
        style={{ width: KNOB, height: KNOB }}
        className="rounded-full border border-white/25 bg-white/20 shadow-lg will-change-transform"
      />
    </div>
  );
}
