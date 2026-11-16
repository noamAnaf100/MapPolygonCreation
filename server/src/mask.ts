import { contours } from "d3-contour";
import * as turf from "@turf/turf";
import type { Polygon, Position } from "geojson";
import { ringArea } from "./geo.ts";

const MIN_PART_AREA_PX = 30;

export interface Mask {
  width: number;
  height: number;
  data: Uint8Array;
}

export function maskToPolygons(mask: Mask, minAreaPx = MIN_PART_AREA_PX): Polygon[] {
  const [multi] = contours().size([mask.width, mask.height]).smooth(false).thresholds([0.5])(Array.from(mask.data));
  return multi.coordinates
    .filter((rings) => ringArea(rings[0]) >= minAreaPx)
    .map((rings) => ({
      type: "Polygon" as const,
      coordinates: [rings[0], ...rings.slice(1).filter((hole) => ringArea(hole) >= minAreaPx)],
    }));
}

export function polygonArea(polygon: Polygon): number {
  const [shell, ...holes] = polygon.coordinates;
  return ringArea(shell) - holes.reduce((sum, h) => sum + ringArea(h), 0);
}

export function pickPolygon(polygons: Polygon[], at: Position | null): Polygon | null {
  if (polygons.length === 0) return null;
  const byArea = [...polygons].sort((a, b) => polygonArea(b) - polygonArea(a));
  if (at) {
    const hit = byArea.find((p) => turf.booleanPointInPolygon(turf.point(at), p));
    if (hit) return hit;
  }
  return byArea[0];
}

export function simplifyPx(polygon: Polygon, tolerancePx: number): Polygon {
  if (tolerancePx <= 0) return polygon;
  return turf.simplify(turf.feature(polygon), { tolerance: tolerancePx, highQuality: true }).geometry;
}
