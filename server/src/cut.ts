import * as turf from "@turf/turf";
import type { LineString, MultiLineString, Polygon, Position } from "geojson";
import type { WandFeature } from "@map-wand/shared";
import { localFrame, polygonsOf } from "./geo.ts";

const HALF_DISC_SEGMENTS = 48;
const ROAD_CUT_RADIUS_FACTOR = 1.5;
const MIN_ROAD_CUT_RADIUS_M = 15;
const AREA_CUT_RADIUS_FACTOR = 2;
const MIN_ANCHOR_OFFSET_M = 0.5;

type Vec = [number, number];

const sub = (a: Position, b: Position): Vec => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1];
const norm = (a: Vec): Vec | null => {
  const length = Math.hypot(a[0], a[1]);
  return length > 1e-9 ? [a[0] / length, a[1] / length] : null;
};

export function nearestOnLines(lines: Position[][], p: Position): { point: Vec; tangent: Vec } | null {
  let best: { distance: number; point: Vec; tangent: Vec } | null = null;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const segment = sub(line[i], a);
      const lengthSq = dot(segment, segment);
      if (lengthSq === 0) continue;
      const t = Math.max(0, Math.min(1, dot(sub(p, a), segment) / lengthSq));
      const point: Vec = [a[0] + t * segment[0], a[1] + t * segment[1]];
      const distance = Math.hypot(p[0] - point[0], p[1] - point[1]);
      if (!best || distance < best.distance) best = { distance, point, tangent: norm(segment)! };
    }
  }
  return best;
}

function linesOf(centerline: LineString | MultiLineString): Position[][] {
  return centerline.type === "LineString" ? [centerline.coordinates] : centerline.coordinates;
}

function cutGeometry(feature: WandFeature, anchor: Vec, click: Vec, toLocal: (p: Position) => Vec) {
  const { centerline, width_m } = feature.properties;
  if (centerline) {
    const nearest = nearestOnLines(linesOf(centerline).map((l) => l.map(toLocal)), click);
    if (nearest) {
      const along = dot(sub(anchor, nearest.point), nearest.tangent);
      if (Math.abs(along) >= MIN_ANCHOR_OFFSET_M) {
        const farSide: Vec = along > 0 ? [-nearest.tangent[0], -nearest.tangent[1]] : nearest.tangent;
        const radius = Math.max((width_m ?? 0) * ROAD_CUT_RADIUS_FACTOR, MIN_ROAD_CUT_RADIUS_M);
        return { origin: nearest.point, farSide, radius };
      }
    }
  }
  const farSide = norm(sub(click, anchor));
  if (!farSide) return null;
  const [w, s, e, n] = turf.bbox(feature);
  const diagonal = Math.hypot(...sub(toLocal([e, n]), toLocal([w, s])));
  return { origin: click, farSide, radius: Math.max(diagonal * AREA_CUT_RADIUS_FACTOR, 1) };
}

export function halfDisc(origin: Vec, farSide: Vec, radius: number): Vec[] {
  const across: Vec = [-farSide[1], farSide[0]];
  const ring: Vec[] = [];
  for (let i = 0; i <= HALF_DISC_SEGMENTS; i++) {
    const a = (Math.PI * i) / HALF_DISC_SEGMENTS;
    const c = Math.cos(a) * radius;
    const s = Math.sin(a) * radius;
    ring.push([origin[0] + c * across[0] + s * farSide[0], origin[1] + c * across[1] + s * farSide[1]]);
  }
  ring.push(ring[0]);
  return ring;
}

function distanceToPolygon(p: Position, polygon: Polygon): number {
  if (turf.booleanPointInPolygon(turf.point(p), polygon)) return 0;
  return Math.min(
    ...polygon.coordinates.map((ring) => turf.pointToLineDistance(turf.point(p), turf.lineString(ring), { units: "meters" })),
  );
}

export function cutAt(feature: WandFeature, anchor: Position, point: Position): WandFeature | null {
  const frame = localFrame(point);
  const cut = cutGeometry(feature, frame.toLocal(anchor), frame.toLocal(point), frame.toLocal);
  if (!cut) return null;
  const cutter = turf.polygon([halfDisc(cut.origin, cut.farSide, cut.radius).map(frame.toLngLat)]);
  const remaining = turf.difference(turf.featureCollection([turf.feature(feature.geometry), cutter]));
  const pieces = polygonsOf(remaining?.geometry);
  if (pieces.length === 0) return null;
  const kept = pieces.reduce((best, piece) => (distanceToPolygon(anchor, piece) < distanceToPolygon(anchor, best) ? piece : best));
  return {
    ...feature,
    geometry: kept,
    properties: {
      ...feature.properties,
      area_m2: Math.round(turf.area(kept) * 10) / 10,
      cuts: (feature.properties.cuts ?? 0) + 1,
    },
  };
}
