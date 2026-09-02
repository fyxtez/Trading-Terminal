import type { ScreenPoint } from "../types/drawing";

export function distanceToSegment(
  point: ScreenPoint,
  start: ScreenPoint,
  end: ScreenPoint,
) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;

  if (dx === 0 && dy === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  const lengthSquared = dx * dx + dy * dy;

  let t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;

  t = Math.max(0, Math.min(1, t));

  const closestX = start.x + t * dx;
  const closestY = start.y + t * dy;

  return Math.hypot(point.x - closestX, point.y - closestY);
}

export function hexToRgba(hex: string, alpha: number) {
  const normalized = hex.replace("#", "");

  const value =
    normalized.length === 3
      ? normalized
          .split("")
          .map((character) => character + character)
          .join("")
      : normalized;

  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

/**
 * Lightens a hex color a small, fixed amount toward white - used to make a
 * SELECTED drawing read as "this exact line, a little brighter" rather
 * than switching to some unrelated highlight color that would make it
 * look like a different object. `amount` is a fraction of the remaining
 * distance to white (0.2 = 20% of the way from the original color to
 * pure white), which keeps this closer to "same color, punchier" than a
 * fixed amount that would only look right on this trader's own default
 * blue but push a red/green drawing's color oddly toward pastel.
 */
export function brightenColor(hex: string, amount = 0.2) {
  const normalized = hex.replace("#", "");

  const value =
    normalized.length === 3
      ? normalized
          .split("")
          .map((character) => character + character)
          .join("")
      : normalized;

  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);

  const lighten = (channel: number) =>
    Math.round(channel + (255 - channel) * amount);

  return `rgb(${lighten(red)}, ${lighten(green)}, ${lighten(blue)})`;
}
