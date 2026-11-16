import type { Position } from "geojson";
import type { WandFeature } from "@map-wand/shared";

function inRing([x, y]: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function containsPoint(feature: WandFeature, point: Position): boolean {
  const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  return polygons.some(([shell, ...holes]) => inRing(point, shell) && !holes.some((h) => inRing(point, h)));
}

function segmentDistance([px, py]: number[], [ax, ay]: number[], [bx, by]: number[]): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function edgeDistancePx(feature: WandFeature, point: Position, toScreen: (p: Position) => number[]): number {
  const rings = feature.geometry.type === "Polygon" ? feature.geometry.coordinates : feature.geometry.coordinates.flat();
  const p = toScreen(point);
  let best = Infinity;
  for (const ring of rings) {
    const screen = ring.map(toScreen);
    for (let i = 1; i < screen.length; i++) best = Math.min(best, segmentDistance(p, screen[i - 1], screen[i]));
  }
  return best;
}

export function formatArea(m2: number): string {
  if (m2 >= 1_000_000) return `${(m2 / 1_000_000).toFixed(2)} km²`;
  if (m2 >= 10_000) return `${(m2 / 10_000).toFixed(2)} ha`;
  return `${Math.round(m2).toLocaleString()} m²`;
}
