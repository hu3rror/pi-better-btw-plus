/**
 * Fullscreen mouse translation (ADR 0012, spec #37): in fullscreen mode pi's
 * alt-screen consumes every SGR sequence and reroutes mouse events through its
 * component dispatch, delivering normalized `TuiMouseEvent`s to overlay
 * `handleMouse` handlers (local + absolute 0-based coordinates, decoded
 * buttons). The fork's `PointerGesture` classifier speaks raw SGR sequences
 * (1-based screen coords). This module is the pure translation between the
 * two. (The overlay's `handleMouse` adds the mode gate and the result
 * shaping; `srcs/index.ts` guards reporting ownership — see the ADR.)
 *
 * pi's `clickCount` (arrives only on a post-release `click` event and demands
 * pixel-identical press positions) and `wheelDelta` magnitude (already scaled
 * by pi's `fullscreenWheelScrollLines`) are deliberately ignored: the
 * classifier's own multi-click window/tolerance and the `wheelScrollLines`
 * setting stay the single truth, so both TUI modes behave identically. Only
 * the wheel *sign* survives, as direction.
 */
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  MOTION_FLAG,
  WHEEL_DOWN_BUTTON,
  WHEEL_UP_BUTTON,
  type SgrMouseEvent,
} from "./side-chat-mouse.ts";

/**
 * Translate a pi fullscreen mouse event into the SGR vocabulary the gesture
 * classifier consumes; null for events the classifier has no use for (`move`
 * / `click` absorption, non-left drags, middle buttons — the classifier only
 * knows left/right —, direction-less wheels). Screen coordinates shift by +1
 * back into SGR's 1-based space; the caller still returns a handled result
 * for nulls (region-consumption invariant).
 */
export function translateTuiMouseEvent(event: TuiMouseEvent): SgrMouseEvent | null {
  const sgr = (button: number, isRelease: boolean): SgrMouseEvent => ({
    button,
    col: event.screenX + 1,
    row: event.screenY + 1,
    isRelease,
  });
  switch (event.type) {
    case "press":
      if (event.button === "left") return sgr(0, false);
      if (event.button === "right") return sgr(2, false);
      return null;
    case "drag":
      // Only left drags select (isLeftDrag); right/middle drags are absorbed.
      return event.button === "left" ? sgr(MOTION_FLAG, false) : null;
    case "release":
      if (event.button === "left") return sgr(0, true);
      if (event.button === "right") return sgr(2, true);
      return null;
    case "wheel": {
      const delta = event.wheelDelta ?? 0;
      // pi: negative wheelDelta scrolls up (older content) — SGR wheel button 64.
      if (delta < 0) return sgr(WHEEL_UP_BUTTON, false);
      if (delta > 0) return sgr(WHEEL_DOWN_BUTTON, false);
      return null;
    }
    default:
      return null; // move / click: absorbed, never fed to the classifier
  }
}