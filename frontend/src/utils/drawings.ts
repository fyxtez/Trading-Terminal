import type { Drawing, SavedDrawingSet, ChartPoint } from "../types/drawing";

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isChartPoint = (value: unknown): value is ChartPoint => {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<ChartPoint>;
  return isFiniteNumber(Number(point.time)) && isFiniteNumber(point.price);
};

/**
 * localStorage survives HMR/deploys, so drawing objects can outlive the code
 * shape that created them. Validate persisted data at the boundary instead of
 * letting one stale object crash hit-testing/rendering on every mouse move.
 */
const normalizeDrawing = (value: unknown): Drawing | null => {
  if (!value || typeof value !== "object") return null;

  const drawing = value as Record<string, unknown>;
  if (typeof drawing.id !== "string" || typeof drawing.color !== "string") {
    return null;
  }

  switch (drawing.type) {
    case "vertical":
      return isFiniteNumber(Number(drawing.time)) ? (drawing as unknown as Drawing) : null;
    case "horizontal":
      return isFiniteNumber(drawing.price) ? (drawing as unknown as Drawing) : null;
    case "coordinate-marker":
      return isFiniteNumber(Number(drawing.time)) && isFiniteNumber(drawing.price)
        ? (drawing as unknown as Drawing)
        : null;
    case "trend":
    case "box":
      return isChartPoint(drawing.start) && isChartPoint(drawing.end)
        ? (drawing as unknown as Drawing)
        : null;
    case "text": {
      // Text now anchors two REAL chart points (start = top-left, end =
      // bottom-right), same as trend/box, so the box scales with the chart
      // under zoom instead of staying a fixed on-screen size - font size is
      // clamped separately (see getTextFontSize below) so it stays
      // readable at either extreme. This is a deliberate return to the
      // very first Text schema (which was replaced by a single-anchor +
      // fixed-pixel-box design because it had no font clamp and became a
      // giant/tiny blob under zoom) - this time with that clamp in place.
      // Text saved under the fixed-pixel-box schema (has `width`/`height`,
      // no `end`) can't be converted without a live chart to resolve what
      // those old pixel values meant at the time, so it's dropped rather
      // than guessed at.
      if (
        !isChartPoint(drawing.start) ||
        !isChartPoint(drawing.end) ||
        typeof drawing.text !== "string"
      ) {
        return null;
      }

      // `align` is optional (older saved drawings won't have it) but if
      // present it must be one of the three real values - anything else
      // (corrupt/foreign data) gets stripped rather than trusted, same
      // spirit as every other field validated in this function.
      const align = drawing.align;
      if (align !== undefined && align !== "left" && align !== "center" && align !== "right") {
        const { align: _invalidAlign, ...rest } = drawing;
        return rest as unknown as Drawing;
      }

      return drawing as unknown as Drawing;
    }
    case "pen":
      return Array.isArray(drawing.points) && drawing.points.length > 0 && drawing.points.every(isChartPoint)
        ? (drawing as unknown as Drawing)
        : null;
    default:
      return null;
  }
};

const sanitizeDrawings = (value: unknown): Drawing[] =>
  Array.isArray(value)
    ? value.map(normalizeDrawing).filter((drawing): drawing is Drawing => drawing !== null)
    : [];

export function loadStoredDrawings(storageKey: string): Drawing[] {
  try {
    const raw = localStorage.getItem(storageKey);

    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    const drawings = sanitizeDrawings(parsed);

    // Rewrite only when malformed/stale entries were removed so they do not
    // return on the next reload.
    if (Array.isArray(parsed) && JSON.stringify(drawings) !== JSON.stringify(parsed)) {
      localStorage.setItem(storageKey, JSON.stringify(drawings));
    }

    return drawings;
  } catch (error) {
    console.error("Failed to load drawings", error);
    return [];
  }
}

export function saveDrawings(storageKey: string, drawings: Drawing[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(drawings));
  } catch (error) {
    console.error("Failed to save drawings", error);
  }
}

export function cloneDrawing(drawing: Drawing): Drawing {
  if (drawing.type === "trend" || drawing.type === "box" || drawing.type === "text") {
    return {
      ...drawing,
      start: { ...drawing.start },
      end: { ...drawing.end },
    };
  }

  if (drawing.type === "pen") {
    return {
      ...drawing,
      points: drawing.points.map((point) => ({ ...point })),
    };
  }

  return { ...drawing };
}


export function loadStoredDrawingSets(storageKey: string): SavedDrawingSet[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    let changed = false;
    const sets: SavedDrawingSet[] = [];

    for (const value of parsed) {
      if (!value || typeof value !== "object") {
        changed = true;
        continue;
      }

      const candidate = value as Partial<SavedDrawingSet>;
      if (
        typeof candidate.id !== "string" ||
        typeof candidate.name !== "string" ||
        !Array.isArray(candidate.drawings) ||
        !isFiniteNumber(candidate.createdAt) ||
        !isFiniteNumber(candidate.updatedAt)
      ) {
        changed = true;
        continue;
      }

      const drawings = sanitizeDrawings(candidate.drawings);
      if (JSON.stringify(drawings) !== JSON.stringify(candidate.drawings)) changed = true;

      sets.push({
        id: candidate.id,
        name: candidate.name,
        drawings,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
      });
    }

    if (changed || sets.length !== parsed.length) {
      localStorage.setItem(storageKey, JSON.stringify(sets));
    }

    return sets;
  } catch (error) {
    console.error("Failed to load drawing sets", error);
    return [];
  }
}

export function saveDrawingSets(
  storageKey: string,
  sets: SavedDrawingSet[],
) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(sets));
  } catch (error) {
    console.error("Failed to save drawing sets", error);
  }
}

export function cloneDrawings(drawings: Drawing[]): Drawing[] {
  return drawings.map(cloneDrawing);
}


/**
 * Text has no numeric font-size setting. Its rendered size is derived entirely
 * from the current screen-space size of its chart-anchored bounding box -
 * which now scales freely with zoom/pan (see TextDrawing in types/drawing.ts),
 * so this clamp is what keeps the label readable instead of becoming a giant
 * blob when zoomed way in or an unreadable speck when zoomed way out.
 */
export function getTextFontSize(width: number, height: number, text: string): number {
  const safeTextLength = Math.max(1, text.length);
  const byHeight = height * 0.62;
  const byWidth = width / (safeTextLength * 0.56);
  return Math.max(9, Math.min(56, byHeight, byWidth));
}
